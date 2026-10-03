import asyncio

import numpy as np
from fakes import FakeClock, FakeEngine, RecordingSink, near, unit

from app.oracle.interfaces import EventInfo
from app.oracle.runtime import OracleState
from app.oracle.tracker import Track, Tracker, iou

DT = 0.5
B_BOX = [800.0, 100.0, 1000.0, 340.0]


class Scenario:
    def __init__(self, min_seen: int = 2, fail_times: int = 0, seed: int = 0) -> None:
        self.rng = np.random.default_rng(seed)
        self.clock = FakeClock(100.0)
        self.engine = FakeEngine()
        self.sink = RecordingSink(self.clock, fail_times=fail_times)
        self.state = OracleState(
            engine=self.engine, clock=self.clock, wall_clock=FakeClock(1_000_000.0), sink=lambda: self.sink
        )
        info = EventInfo(event_id="ev", organizer="org", start_ts=0, end_ts=2_000_000, min_seen_secs=min_seen)
        self.rt = self.state.runtime_for(info)
        self.a = unit(self.rng)  # enrolled
        self.b = unit(self.rng)  # NOT enrolled
        self.state.guestlists.put("ev", info.end_ts, "A", self.a, "Ola")
        self.n = 0
        self.outputs: list[list[dict]] = []

    def a_box(self, x: float) -> list[float]:
        return [x, 100.0, x + 200.0, 340.0]

    async def frame(self, faces: list[tuple[list[float], np.ndarray]]) -> list[dict]:
        self.n += 1
        key = self.engine.set(f"f{self.n}".encode(), [(box, 0.0, emb) for box, emb in faces])
        out = await self.rt.process_frame("cam", key)
        self.outputs.append(out)
        await asyncio.sleep(0)
        self.clock.advance(DT)
        return out

    async def a_and_b(self, x: float, a_emb: np.ndarray | None = None) -> list[dict]:
        a_emb = near(self.a, self.rng) if a_emb is None else a_emb
        return await self.frame([(self.a_box(x), a_emb), (B_BOX, near(self.b, self.rng))])

    def tracker(self) -> Tracker:
        return self.rt.trackers["cam"]


def test_iou_basics():
    assert iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert iou([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0
    assert abs(iou([0, 0, 10, 10], [5, 0, 15, 10]) - 1 / 3) < 1e-9


def test_walking_one_track_one_payment_b_never_paid():
    async def run():
        s = Scenario(min_seen=2)
        a_ids = set()
        for i in range(14):
            x = 100.0 + 15 * i  # walking right
            await s.a_and_b(x)
            a_track = next(t for t in s.tracker().tracks if t.bbox[0] == x)
            a_ids.add(a_track.id)
        await s.rt.wait_payouts()
        return s, a_ids

    s, a_ids = asyncio.run(run())
    assert len(a_ids) == 1, "A must keep one track while walking"
    assert len(s.tracker().tracks) == 2
    assert [(e, w) for e, w, _ in s.sink.calls] == [("ev", "A")]
    # identified on frame 3 (t=101.0), paid once seen_secs >= 2 -> first frame at t=103.0
    assert s.sink.calls[0][2] >= 103.0
    # B is always unknown, with no name
    for out in s.outputs:
        b = next(f for f in out if f["bbox"][0] == B_BOX[0])
        assert b["state"] == "unknown" and b["name"] is None and b["seen_secs"] == 0.0
    last_a = next(f for f in s.outputs[-1] if f["bbox"][0] != B_BOX[0])
    assert last_a["state"] == "paid" and last_a["name"] == "Ola"
    # cost control: once A is identified it is embedded at most once per second (every 2nd frame at DT=0.5),
    # while B (unknown) is embedded every frame -> some frames embed only one face.
    assert 1 in s.engine.embed_calls
    assert s.rt.ledger.paid_tx("A") == "tx-A-1"


def test_flicker_two_of_five_does_not_identify():
    t = Track(id=1, bbox=[0, 0, 1, 1], first_seen=0, last_seen=0)
    for i, w in enumerate(["A", None, None, "A", None]):
        t.record(w, float(i))
    assert t.wallet is None
    t.record("A", 5.0)  # window now [None, None, A, None, A] -> still 2
    assert t.wallet is None
    t.record("A", 6.0)  # [None, A, None, A, A] -> 3 of 5
    assert t.wallet == "A" and t.identified_at == 6.0


def test_flicker_in_runtime_never_pays():
    async def run():
        s = Scenario(min_seen=0)
        for i in range(20):
            matched = i % 5 in (0, 3)  # 2 of every 5 frames match A
            emb = near(s.a, s.rng) if matched else unit(s.rng)
            await s.a_and_b(100.0, emb)
        await s.rt.wait_payouts()
        return s

    s = asyncio.run(run())
    assert s.sink.calls == []


def test_leave_and_reenter_does_not_pay_twice():
    async def run():
        s = Scenario(min_seen=1)
        for _ in range(8):
            await s.a_and_b(100.0)
        await s.rt.wait_payouts()
        assert len(s.sink.successes) == 1
        for _ in range(5):  # 2.5 s with only B -> A's track is dropped
            await s.frame([(B_BOX, near(s.b, s.rng))])
        assert len(s.tracker().tracks) == 1
        for _ in range(10):  # A re-enters elsewhere -> new track, identified again
            await s.a_and_b(400.0)
        await s.rt.wait_payouts()
        return s

    s = asyncio.run(run())
    assert len(s.sink.calls) == 1
    last_a = next(f for f in s.outputs[-1] if f["bbox"][0] == 400.0)
    assert last_a["state"] == "paid"


def test_failed_payout_retried_not_before_5s_exactly_one_success():
    async def run():
        s = Scenario(min_seen=1, fail_times=1)
        for _ in range(30):
            await s.a_and_b(100.0)
        await s.rt.wait_payouts()
        return s

    s = asyncio.run(run())
    assert len(s.sink.calls) == 2
    assert s.sink.successes == [("ev", "A")]
    assert s.sink.calls[1][2] - s.sink.calls[0][2] >= 5.0


def test_many_frames_in_flight_still_one_pay_call():
    """Two cameras on one event; a slow sink keeps the payout pending across many frames."""

    async def run():
        s = Scenario(min_seen=0)
        gate = asyncio.Event()
        calls = []

        class SlowSink:
            async def pay(self, event_id, wallet):
                calls.append(wallet)
                await gate.wait()
                return "tx-slow"

        s.state.sink = lambda: SlowSink()
        for i in range(12):
            key = s.engine.set(f"m{i}".encode(), [(s.a_box(100.0), 0.0, near(s.a, s.rng))])
            await asyncio.gather(s.rt.process_frame("cam1", key), s.rt.process_frame("cam2", key))
            await asyncio.sleep(0)
            s.clock.advance(DT)
        gate.set()
        await s.rt.wait_payouts()
        return s, calls

    s, calls = asyncio.run(run())
    assert calls == ["A"]
    assert s.rt.ledger.paid_tx("A") == "tx-slow"


def test_slow_frames_keep_tracks():
    from app.oracle.tracker import Tracker

    tr = Tracker()
    box = [10.0, 10.0, 60.0, 60.0]
    first = tr.update([box], now=0.0)[0]
    # Frames 4 s apart (much slower than the 1.5 s base window): the same person keeps the same track.
    assert tr.update([box], now=4.0)[0] is first
    assert tr.update([box], now=8.0)[0] is first
