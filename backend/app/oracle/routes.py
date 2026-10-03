"""Oracle API v1 (contract: docs/oracle-api.md), mounted under /api: HTTP routes under /api/v1, dev helper under
/api/oracle/dev."""

import asyncio
import base64
import binascii
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated

import numpy as np
from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    WebSocket,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.websockets import WebSocketDisconnect

from app.config import Settings, get_settings
from app.oracle.consent import CONSENT_TEXTS
from app.oracle.errors import OracleError, OracleRoute, invalid_request
from app.oracle.face import normalize
from app.oracle.interfaces import DevEventSource, EventInfo, providers
from app.oracle.quality import check_photo
from app.oracle.runtime import (
    CAMERA_MIN_FRAME_INTERVAL,
    STAGE_MIN_FRAME_INTERVAL,
    STAGE_STATS_INTERVAL,
    StageClient,
    get_state,
)

log = logging.getLogger("app.oracle")

DUPLICATE_FACE_COSINE = 0.50
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_IMAGE_SIDE = 1280
PURGE_INTERVAL_SECS = 60


async def _purge_loop() -> None:
    while True:
        await asyncio.sleep(PURGE_INTERVAL_SECS)
        try:
            get_state().purge()
        except Exception:
            log.exception("purge failed status=error")


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    task = asyncio.create_task(_purge_loop())
    try:
        yield
    finally:
        task.cancel()


router = APIRouter(lifespan=lifespan)
v1 = APIRouter(prefix="/v1", tags=["oracle"], route_class=OracleRoute)

# Request bodies ------------------------------------------------------------------------------------


class TestRequest(BaseModel):
    image: str


class Signed(BaseModel):
    wallet: str = Field(min_length=1, max_length=64)
    signed_at: str = Field(min_length=1, max_length=40)
    signature: str = Field(min_length=1, max_length=128)


class Consent(BaseModel):
    version: str = Field(min_length=1, max_length=64)
    accepted: bool


class SubmitRequest(Signed):
    consent: Consent
    image: str


async def _body[M: BaseModel](request: Request, model: type[M]) -> M:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise OracleError(413, "too_large", "The request body is over 4 MB.")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise OracleError(413, "too_large", "The request body is over 4 MB.")
        chunks.append(chunk)
    try:
        return model.model_validate(json.loads(b"".join(chunks)))
    except (ValueError, ValidationError) as e:  # JSONDecodeError is a ValueError
        raise invalid_request("The request body is malformed or has wrong field types.") from e


def _b64(image: str) -> bytes:
    try:
        return base64.b64decode(image, validate=True)
    except (binascii.Error, ValueError) as e:
        raise invalid_request("An image is not valid base64.") from e


def _decode_image(data: bytes) -> np.ndarray:
    try:
        img = get_state().engine.decode(data)
    except ValueError as e:
        raise invalid_request("An image is not a decodable JPEG.") from e
    shape = getattr(img, "shape", (0, 0))
    if max(shape[0], shape[1]) > MAX_IMAGE_SIDE:
        raise invalid_request(f"Images must be at most {MAX_IMAGE_SIDE} px on the long side.")
    return img


async def _event(event_id: str) -> EventInfo:
    info = await providers.event_source.get(event_id)
    if info is None:
        raise OracleError(404, "event_not_found", "No such event.")
    return info


def own_oracle_pubkey() -> str | None:
    """The key this oracle reports sightings with, or None when the installed sink has none (dev stand-in)."""
    return getattr(providers.sighting_sink, "oracle_pubkey", None)


def _listed_oracle(info: EventInfo) -> None:
    """Joins only for events that list this oracle: another oracle's event would never pay on our reports, so the
    face signature would be stored for nothing. Skipped when either side is unknown (dev stand-in)."""
    me = own_oracle_pubkey()
    if me and info.oracles and me not in info.oracles:
        raise OracleError(409, "not_an_oracle_for_event", "This oracle is not one of the event's oracles.")


def _not_ended(info: EventInfo) -> None:
    if info.end_ts < get_state().wall_clock():
        raise OracleError(409, "event_ended", "This event is over.")


# Dev ----------------------------------------------------------------------------------------------


@router.post("/oracle/dev/events")
async def dev_create_event(info: EventInfo, settings: Annotated[Settings, Depends(get_settings)]) -> EventInfo:
    source = providers.event_source
    if settings.env != "dev" or not isinstance(source, DevEventSource):
        raise HTTPException(404, "Not Found")
    source.put(info)
    return info


# Test a photo --------------------------------------------------------------------------------------


def _test_photo(data: bytes) -> dict:
    img = _decode_image(data)
    check = check_photo(img, get_state().engine.detect(img))
    return {"ok": check.ok, "issues": check.issues, "face": check.face_json()}


@v1.post("/events/{event_id}/attendance/test")
async def attendance_test(event_id: str, request: Request) -> dict:
    body = await _body(request, TestRequest)
    return await asyncio.to_thread(_test_photo, _b64(body.image))


# Submit / leave / status ---------------------------------------------------------------------------


def _analyze_submit(data: bytes) -> np.ndarray:
    """Worker thread: quality-check the photo, then embed. Raises OracleError(photo_rejected)."""
    engine = get_state().engine
    img = _decode_image(data)
    check = check_photo(img, engine.detect(img))
    if not check.ok:
        raise OracleError(422, "photo_rejected", check.issues[0]["message"], issues=check.issues)
    return normalize(engine.embed(img, [check.face])[0])


@v1.post("/events/{event_id}/attendance", status_code=201)
async def attendance_submit(
    event_id: str, request: Request, settings: Annotated[Settings, Depends(get_settings)]
) -> JSONResponse:
    body = await _body(request, SubmitRequest)
    image = _b64(body.image)
    state = get_state()
    proof = state.signatures.verify(
        action="join", event_id=event_id, wallet=body.wallet, signed_at=body.signed_at,
        signature=body.signature, consent_version=body.consent.version,
    )
    info = await _event(event_id)
    _not_ended(info)
    _listed_oracle(info)
    if body.consent.accepted is not True or body.consent.version not in settings.oracle_consent_versions:
        raise OracleError(422, "consent_required", "Please accept the current consent to join.")

    emb = await asyncio.to_thread(_analyze_submit, image)
    del image
    other, score = state.guestlists.best_other(event_id, emb, exclude_wallet=body.wallet)
    if other is not None and score >= DUPLICATE_FACE_COSINE:
        log.info("join event_id=%s wallet=%s status=duplicate_face", event_id, body.wallet)
        raise OracleError(409, "face_already_registered", "This face is already registered for this event.")
    state.guestlists.put(event_id, info.end_ts, body.wallet, emb, proof)
    log.info("join event_id=%s wallet=%s status=on_list", event_id, body.wallet)
    return JSONResponse({"status": "on_list", "event_id": event_id, "wallet": body.wallet}, status_code=201)


@v1.post("/events/{event_id}/attendance/leave")
async def attendance_leave(event_id: str, request: Request) -> dict:
    body = await _body(request, Signed)
    get_state().signatures.verify(
        action="leave", event_id=event_id, wallet=body.wallet, signed_at=body.signed_at, signature=body.signature
    )
    info = await _event(event_id)
    _not_ended(info)
    get_state().guestlists.remove(event_id, body.wallet)
    log.info("leave event_id=%s wallet=%s status=not_joined", event_id, body.wallet)
    return {"status": "not_joined", "event_id": event_id, "wallet": body.wallet}


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@v1.get("/events/{event_id}")
async def event_details(event_id: str, settings: Annotated[Settings, Depends(get_settings)]) -> dict:
    """What a client shows before "I'm going": the event, whether joining is open, counts and the consent text."""
    info = await _event(event_id)
    state = get_state()
    now = state.wall_clock()
    ledger = state.ledgers.get(event_id)
    paid = ledger.paid_count() if ledger is not None else 0
    version = settings.oracle_consent_versions[-1]
    return {
        "event_id": info.event_id,
        "name": info.name,
        "venue": info.venue,
        "organizer": info.organizer,
        "starts_at": _iso(info.start_ts),
        "ends_at": _iso(info.end_ts),
        "status": "ended" if info.end_ts < now else "live" if info.start_ts <= now else "upcoming",
        "joining_open": info.end_ts >= now,
        "min_seen_secs": info.min_seen_secs,
        "reward_lamports": info.reward_lamports,
        "max_payouts": info.max_payouts,
        # Convenience only: clients discover the oracles (and their URLs) from the chain, not from us.
        "oracles": info.oracles,
        "threshold": info.threshold,
        "going": state.guestlists.count(event_id),
        "paid": paid,
        "spots_left": max(info.max_payouts - paid, 0) if info.max_payouts is not None else None,
        "consent": {"version": version, "text": CONSENT_TEXTS[version]},
    }


@v1.get("/events/{event_id}/attendance/{wallet}")
async def attendance_status(event_id: str, wallet: str) -> dict:
    await _event(event_id)
    state = get_state()
    ledger = state.ledgers.get(event_id)
    tx = ledger.paid_tx(wallet) if ledger is not None else None
    if tx is not None:
        return {"status": "paid", "tx": tx}
    if state.guestlists.has(event_id, wallet):
        return {"status": "on_list", "tx": None}
    return {"status": "not_joined", "tx": None}


# Organizer: camera + stage tokens -----------------------------------------------------------------


@v1.post("/events/{event_id}/camera-token")
async def camera_token(event_id: str, request: Request) -> dict:
    body = await _body(request, Signed)
    get_state().signatures.verify(
        action="camera-token", event_id=event_id, wallet=body.wallet, signed_at=body.signed_at,
        signature=body.signature,
    )
    info = await _event(event_id)
    if body.wallet != info.organizer:
        raise OracleError(403, "not_organizer", "Only the event's organizer can pair a camera.")
    _not_ended(info)
    camera, stage = get_state().issue_tokens(info)
    log.info("camera token issued event_id=%s status=ok", event_id)
    return {"camera_token": camera, "stage_token": stage, "camera_path": f"/camera/{camera}"}


# WebSockets ---------------------------------------------------------------------------------------


@v1.websocket("/camera/{token}")
async def camera_ws(ws: WebSocket, token: str) -> None:
    await ws.accept()
    state = get_state()
    rt, code = state.resolve_camera(token)
    if rt is None:
        await ws.close(code=code or 4401)
        return
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            rt, code = state.resolve_camera(token)
            if rt is None:
                await ws.close(code=code or 4404)
                return
            data = msg.get("bytes")
            if not data:
                await ws.send_json({"type": "error", "message": "send each frame as a binary JPEG message"})
                continue
            if len(data) > MAX_BODY_BYTES:
                await ws.send_json({"type": "error", "message": "frame over 4 MB"})
                continue
            started = time.monotonic()
            try:
                img = await asyncio.to_thread(state.engine.decode, data)
            except ValueError:
                await ws.send_json({"type": "error", "message": "not a decodable image"})
                continue
            if max(img.shape[0], img.shape[1]) > MAX_IMAGE_SIDE:
                await ws.send_json({"type": "error", "message": f"frame larger than {MAX_IMAGE_SIDE} px"})
                continue
            faces = rt.submit_frame(token, img, data)
            # Pace the phone: the next frame is sent when this ack arrives.
            await asyncio.sleep(max(0.0, CAMERA_MIN_FRAME_INTERVAL - (time.monotonic() - started)))
            await ws.send_json({"type": "ack", "faces": len(faces), "ms": rt.last_ms.get(token, 0)})
    except WebSocketDisconnect:
        return


@v1.websocket("/events/{event_id}/live")
async def stage_ws(ws: WebSocket, event_id: str, stage_token: Annotated[str, Query()] = "") -> None:
    await ws.accept()
    state = get_state()
    rt, code = state.resolve_stage(event_id, stage_token)
    if rt is None:
        await ws.close(code=code or 4401)
        return
    client = StageClient()
    rt.stage_clients.add(client)

    async def drain_incoming() -> None:
        with contextlib.suppress(WebSocketDisconnect):
            while (await ws.receive())["type"] != "websocket.disconnect":
                pass

    async def push() -> None:
        last_frame = 0.0
        next_stats = time.monotonic()
        while True:
            now = time.monotonic()
            live, code = state.resolve_stage(event_id, stage_token)
            if live is None:
                await ws.close(code=code or 4404)
                return
            while client.events:
                await ws.send_json(client.events.popleft())
            if client.frame is not None and now - last_frame >= STAGE_MIN_FRAME_INTERVAL:
                frame, client.frame = client.frame, None
                await ws.send_json(frame)
                last_frame = now
            if now >= next_stats:
                await ws.send_json(rt.stats())
                next_stats = now + STAGE_STATS_INTERVAL
            timeout = next_stats - time.monotonic()
            if client.frame is not None:
                timeout = min(timeout, last_frame + STAGE_MIN_FRAME_INTERVAL - time.monotonic())
            client.wake.clear()
            if client.events:
                continue
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(client.wake.wait(), timeout=max(timeout, 0.0))

    tasks = [asyncio.create_task(drain_incoming()), asyncio.create_task(push())]
    try:
        _done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await t
    finally:
        rt.stage_clients.discard(client)


router.include_router(v1)
