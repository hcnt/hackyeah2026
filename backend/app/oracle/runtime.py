"""Oracle state in this process: per-event runtime (camera trackers, stage clients), sighting/payout ledger, tokens.

Everything here runs on the event loop; model inference is pushed to threads with asyncio.to_thread.
Logs carry only event_id, wallet / track id, tx signature and status.
"""

import asyncio
import base64
import logging
import secrets
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.oracle.face import MATCH_THRESHOLD, FaceEngine, InsightFaceEngine
from app.oracle.guestlist import GuestLists
from app.oracle.interfaces import EventInfo, SightingRejected, SightingSink, providers
from app.oracle.signatures import SignatureVerifier
from app.oracle.tracker import Tracker

log = logging.getLogger("app.oracle")

# A recognised wallet is reported to the sighting sink at once and then every SIGHTING_INTERVAL_SECS while it stays
# recognised and unpaid; a failed report is retried on the same cadence. The program decides when that pays.
SIGHTING_INTERVAL_SECS = 2.0
STAGE_MIN_FRAME_INTERVAL = 0.1  # <= 10 fps per stage client
CAMERA_MIN_FRAME_INTERVAL = 0.1  # the camera's ack is paced to <= 10 fps
STAGE_STATS_INTERVAL = 3.0


# Sightings and payouts -----------------------------------------------------------------------------


@dataclass
class PayoutRecord:
    status: str  # "pending" (report in flight) | "reporting" | "failed" | "paid" | "rejected"
    tx: str | None = None
    next_at: float = 0.0  # no new report before this (monotonic clock)


class PayoutLedger:
    """Per-event sighting state. `try_begin` is a synchronous check-and-set on the event loop, so at most one
    report is in flight per wallet, none starts before the interval since the last one, and none once the wallet is
    paid or rejected."""

    def __init__(self) -> None:
        self.records: dict[str, PayoutRecord] = {}

    def try_begin(self, wallet: str, now: float) -> bool:
        rec = self.records.get(wallet)
        if rec is not None and (rec.status in ("pending", "paid", "rejected") or now < rec.next_at):
            return False
        self.records[wallet] = PayoutRecord(status="pending")
        return True

    def reported(self, wallet: str, started: float) -> None:
        """The report landed but the program has not paid yet: report again one interval after this one began."""
        self.records[wallet] = PayoutRecord(status="reporting", next_at=started + SIGHTING_INTERVAL_SECS)

    def succeed(self, wallet: str, tx: str) -> None:
        self.records[wallet] = PayoutRecord(status="paid", tx=tx)

    def fail(self, wallet: str, started: float) -> None:
        self.records[wallet] = PayoutRecord(status="failed", next_at=started + SIGHTING_INTERVAL_SECS)

    def reject(self, wallet: str) -> None:
        self.records[wallet] = PayoutRecord(status="rejected")

    def paid_tx(self, wallet: str) -> str | None:
        rec = self.records.get(wallet)
        return rec.tx if rec is not None and rec.status == "paid" else None

    def paid_count(self) -> int:
        return sum(1 for r in self.records.values() if r.status == "paid")


# Stage clients -------------------------------------------------------------------------------------


@dataclass(eq=False)
class StageClient:
    events: deque = field(default_factory=deque)  # payout messages, never dropped
    frame: dict | None = None  # latest frame only; older ones are replaced
    wake: asyncio.Event = field(default_factory=asyncio.Event)


# Per-event runtime ---------------------------------------------------------------------------------


class EventRuntime:
    def __init__(self, state: "OracleState", info: EventInfo, ledger: PayoutLedger) -> None:
        self.state = state
        self.info = info
        self.ledger = ledger
        self.trackers: dict[str, Tracker] = {}
        self.stage_clients: set[StageClient] = set()
        self._tasks: set[asyncio.Task] = set()
        # Video and recognition run at different speeds: every camera frame is relayed to the stage at once
        # with the newest known boxes, while one worker per camera recognises the latest frame whenever it is
        # free (frames that arrive meanwhile are skipped, never queued).
        self._latest: dict[str, Any] = {}
        self._new_frame: dict[str, asyncio.Event] = {}
        self._workers: dict[str, asyncio.Task] = {}
        self.last_faces: dict[str, list[dict]] = {}
        self.last_ms: dict[str, int] = {}

    @property
    def event_id(self) -> str:
        return self.info.event_id

    def ended(self) -> bool:
        return self.info.end_ts < self.state.wall_clock()

    async def process_frame(self, camera_token: str, img: Any, jpeg: bytes | None = None) -> list[dict]:
        """Detect, track, identify, report sightings. Returns the stage face list for this frame."""
        engine = self.state.engine
        guests = self.state.guestlists
        faces = await asyncio.to_thread(engine.detect, img)
        now = self.state.clock()
        tracker = self.trackers.setdefault(camera_token, Tracker())
        tracks = tracker.update([f.bbox for f in faces], now)

        need = [i for i, t in enumerate(tracks) if t.needs_embedding(now)]
        if need:
            embs = await asyncio.to_thread(engine.embed, img, [faces[i] for i in need])
            results = guests.match(self.event_id, embs, MATCH_THRESHOLD)
            del embs
            for i, (wallet, _score) in zip(need, results, strict=True):
                tracks[i].record(wallet, now)

        out: list[dict] = []
        for t in tracks:
            wallet = t.wallet if t.wallet is not None and guests.has(self.event_id, t.wallet) else None
            if wallet is None:
                out.append({"bbox": _round_box(t.bbox), "state": "unknown", "name": None, "seen_secs": 0.0})
                continue
            seen = t.seen_secs(now)  # display only: the program measures the dwell time on the chain clock
            # The program rejects sightings outside the event's window, so don't send them.
            if self.info.start_ts <= self.state.wall_clock() <= self.info.end_ts:
                self._maybe_report(wallet, now)
            state = "paid" if self.ledger.paid_tx(wallet) else "tracking"
            out.append(
                {
                    "bbox": _round_box(t.bbox),
                    "state": state,
                    "name": short_wallet(wallet),
                    "seen_secs": round(seen, 1),
                }
            )

        if jpeg is not None and self.stage_clients:
            h, w = _shape(img)
            self._push_frame(
                {"type": "frame", "jpeg": base64.b64encode(jpeg).decode(), "width": w, "height": h, "faces": out}
            )
        return out

    def submit_frame(self, camera_token: str, img: Any, jpeg: bytes) -> list[dict]:
        """Relay the frame to the stage now, with the newest boxes, and hand it to the camera's recognition
        worker. Returns the faces of the most recently recognised frame."""
        faces = self.last_faces.get(camera_token, [])
        if self.stage_clients:
            h, w = _shape(img)
            self._push_frame(
                {"type": "frame", "jpeg": base64.b64encode(jpeg).decode(), "width": w, "height": h, "faces": faces}
            )
        self._latest[camera_token] = img
        self._new_frame.setdefault(camera_token, asyncio.Event()).set()
        worker = self._workers.get(camera_token)
        if worker is None or worker.done():
            self._workers[camera_token] = asyncio.create_task(self._recognise_loop(camera_token))
        return faces

    async def _recognise_loop(self, camera_token: str) -> None:
        signal = self._new_frame[camera_token]
        while True:
            await signal.wait()
            signal.clear()
            img = self._latest.pop(camera_token, None)
            if img is None:
                continue
            started = time.perf_counter()
            try:
                self.last_faces[camera_token] = await self.process_frame(camera_token, img)
            except Exception as e:  # noqa: BLE001 - a bad frame must not stop recognition for this camera
                log.warning("frame failed event_id=%s status=error error=%s", self.event_id, type(e).__name__)
                continue
            self.last_ms[camera_token] = round((time.perf_counter() - started) * 1000)

    async def idle(self) -> None:
        """Wait until every camera's worker has recognised the latest frame (tests)."""
        while any(t in self._latest or self._new_frame[t].is_set() for t in self._new_frame):
            await asyncio.sleep(0.01)

    def _maybe_report(self, wallet: str, now: float) -> None:
        if not self.ledger.try_begin(wallet, now):
            return
        task = asyncio.create_task(self._report(wallet, short_wallet(wallet), now))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _report(self, wallet: str, name: str, started: float) -> None:
        proof = self.state.guestlists.join_proof(self.event_id, wallet)
        if proof is None:  # the event ended between the match and this report
            self.ledger.fail(wallet, started)
            return
        try:
            result = await self.state.sink().report(self.event_id, wallet, proof)
        except SightingRejected as e:
            self.ledger.reject(wallet)
            log.warning("sighting event_id=%s wallet=%s status=rejected reason=%s", self.event_id, wallet, e)
            return
        except Exception as e:  # noqa: BLE001 - any sink failure means "retry on the next interval"
            self.ledger.fail(wallet, started)
            log.warning("sighting event_id=%s wallet=%s status=failed error=%s", self.event_id, wallet, type(e).__name__)
            return
        if not result.paid or result.tx is None:
            self.ledger.reported(wallet, started)
            log.info("sighting event_id=%s wallet=%s status=reported", self.event_id, wallet)
            return
        self.ledger.succeed(wallet, result.tx)
        log.info("payout event_id=%s wallet=%s tx=%s status=paid", self.event_id, wallet, result.tx)
        at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        self._push_event({"type": "payout", "wallet": wallet, "name": name, "tx": result.tx, "at": at})

    async def wait_payouts(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    def stats(self) -> dict:
        return {"type": "stats", "going": self.state.guestlists.count(self.event_id), "paid": self.ledger.paid_count()}

    def _push_frame(self, msg: dict) -> None:
        for c in self.stage_clients:
            c.frame = msg
            c.wake.set()

    def _push_event(self, msg: dict) -> None:
        for c in self.stage_clients:
            c.events.append(msg)
            c.wake.set()

    def close(self) -> None:
        for worker in self._workers.values():
            worker.cancel()
        self._workers.clear()
        self._latest.clear()
        self.trackers.clear()
        for c in self.stage_clients:
            c.wake.set()


def short_wallet(wallet: str) -> str:
    """How a recognised attendee is labelled on the stage screen: 7xKX…9fQa."""
    return f"{wallet[:4]}…{wallet[-4:]}" if len(wallet) > 10 else wallet


def _round_box(b: list[float]) -> list[float]:
    return [round(float(v), 1) for v in b]


def _shape(img: Any) -> tuple[int, int]:
    shape = getattr(img, "shape", None)
    return (int(shape[0]), int(shape[1])) if shape is not None and len(shape) >= 2 else (0, 0)


# Process-wide state --------------------------------------------------------------------------------


class OracleState:
    def __init__(
        self,
        engine: FaceEngine | None = None,
        guestlists: GuestLists | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        sink: Callable[[], SightingSink] = lambda: providers.sighting_sink,
    ) -> None:
        self.engine: FaceEngine = engine or InsightFaceEngine()
        self.wall_clock = wall_clock
        self.guestlists = guestlists or GuestLists(wall_clock=wall_clock)
        self.clock = clock
        self.sink = sink
        self.events: dict[str, EventRuntime] = {}
        # Payout ledgers outlive the runtime: they hold only wallet + tx, and /me still answers "paid".
        self.ledgers: dict[str, PayoutLedger] = {}
        self.signatures = SignatureVerifier(wall_clock=wall_clock)
        # token -> event_id. One fixed (camera, stage) pair per event until it ends.
        self.camera_tokens: dict[str, str] = {}
        self.stage_tokens: dict[str, str] = {}
        self.event_tokens: dict[str, tuple[str, str]] = {}
        # Tokens of ended events, so a late reconnect gets 4404 (event ended) rather than 4401.
        self.retired_tokens: set[str] = set()

    def ledger(self, event_id: str) -> PayoutLedger:
        return self.ledgers.setdefault(event_id, PayoutLedger())

    def runtime_for(self, info: EventInfo) -> EventRuntime:
        rt = self.events.get(info.event_id)
        if rt is None:
            rt = self.events[info.event_id] = EventRuntime(self, info, self.ledger(info.event_id))
        else:
            rt.info = info
        return rt

    def issue_tokens(self, info: EventInfo) -> tuple[str, str]:
        """The event's (camera, stage) token pair; the same pair on every call until the event ends."""
        self.runtime_for(info)
        pair = self.event_tokens.get(info.event_id)
        if pair is None:
            pair = (secrets.token_urlsafe(32), secrets.token_urlsafe(32))
            self.event_tokens[info.event_id] = pair
            self.camera_tokens[pair[0]] = info.event_id
            self.stage_tokens[pair[1]] = info.event_id
        return pair

    def _live(self, event_id: str) -> EventRuntime | None:
        rt = self.events.get(event_id)
        if rt is not None and rt.ended():
            self.drop_event(event_id)
            return None
        return rt

    def resolve_camera(self, token: str) -> tuple[EventRuntime | None, int | None]:
        """(runtime, None) when valid, else (None, close code): 4401 token invalid, 4404 event gone/ended."""
        event_id = self.camera_tokens.get(token)
        if event_id is None:
            return None, (4404 if token in self.retired_tokens else 4401)
        rt = self._live(event_id)
        return (rt, None) if rt is not None else (None, 4404)

    def resolve_stage(self, event_id: str, token: str) -> tuple[EventRuntime | None, int | None]:
        if token in self.retired_tokens:
            return None, 4404
        if not token or self.stage_tokens.get(token) != event_id:
            return None, 4401
        rt = self._live(event_id)
        return (rt, None) if rt is not None else (None, 4404)

    def drop_event(self, event_id: str) -> None:
        self.guestlists.drop(event_id)
        pair = self.event_tokens.pop(event_id, None)
        if pair is not None:
            self.retired_tokens.update(pair)
            self.camera_tokens.pop(pair[0], None)
            self.stage_tokens.pop(pair[1], None)
        rt = self.events.pop(event_id, None)
        if rt is not None:
            rt.close()
        log.info("event destroyed event_id=%s status=ended", event_id)

    def purge(self) -> None:
        ended = set(self.guestlists.purge())
        ended |= {eid for eid, rt in self.events.items() if rt.ended()}
        for eid in ended:
            self.drop_event(eid)


_state: OracleState | None = None


def get_state() -> OracleState:
    global _state
    if _state is None:
        _state = OracleState()
    return _state


def set_state(state: OracleState | None) -> None:
    global _state
    _state = state
