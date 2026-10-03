import base64
import itertools
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest
from fakes import FakeEngine, near, textured, unit
from fastapi.testclient import TestClient
from solders.keypair import Keypair
from starlette.websockets import WebSocketDisconnect

from app.config import Settings, get_settings
from app.main import app
from app.oracle import interfaces
from app.oracle.interfaces import DevEventSource, DevPayoutSink
from app.oracle.runtime import OracleState, set_state
from app.oracle.signatures import build_message

BOX = [100.0, 100.0, 300.0, 340.0]
CONSENT = "2026-10-03"


_offset = itertools.count()


def now_iso() -> str:
    """A distinct signed_at per call: ed25519 is deterministic, so the same message signs to the same (reused)
    signature."""
    return (datetime.now(UTC) - timedelta(seconds=next(_offset) % 240)).strftime("%Y-%m-%dT%H:%M:%SZ")


def b64(key: bytes) -> str:
    return base64.b64encode(key).decode()


def signed(kp: Keypair, action: str, event_id: str = "ev1", consent: str | None = None, signed_at: str | None = None):
    signed_at = signed_at or now_iso()
    wallet = str(kp.pubkey())
    msg = build_message(action, event_id, wallet, signed_at, consent)
    return {"wallet": wallet, "signed_at": signed_at, "signature": str(kp.sign_message(msg.encode()))}


@pytest.fixture
def env():
    rng = np.random.default_rng(7)
    engine = FakeEngine()
    set_state(OracleState(engine=engine))
    old = interfaces.providers.event_source, interfaces.providers.payout_sink
    interfaces.providers.event_source = DevEventSource()
    interfaces.providers.payout_sink = DevPayoutSink()
    org = Keypair()
    event = {"event_id": "ev1", "organizer": str(org.pubkey()), "start_ts": 0, "end_ts": 4_000_000_000,
             "min_seen_secs": 0}
    with TestClient(app) as client:
        assert client.post("/api/oracle/dev/events", json=event).status_code == 200
        yield client, engine, rng, org, event
    app.dependency_overrides.clear()
    interfaces.providers.event_source, interfaces.providers.payout_sink = old
    set_state(None)


def photo_for(engine, rng, person, key, scene=None):
    """A base64 'photo' whose fake detection is `scene`, by default one straight face close to `person`."""
    return b64(engine.set(key.encode(), scene if scene is not None else [(BOX, 0.0, near(person, rng))]))


def submit(client, kp, image, event_id="ev1", consent=CONSENT, accepted=True, first_name="Ola", **sig):
    body = signed(kp, "join", event_id, consent, **sig) | {
        "consent": {"version": consent, "accepted": accepted}, "first_name": first_name, "image": image}
    return client.post(f"/api/v1/events/{event_id}/attendance", json=body)


def status(client, kp, event_id="ev1"):
    return client.get(f"/api/v1/events/{event_id}/attendance/{kp.pubkey()}")


def err(r):
    return r.json()["error"]["code"]


def test_submit_happy_path_status_and_leave(env):
    client, engine, rng, _, _ = env
    kp = Keypair()
    assert status(client, kp).json() == {"status": "not_joined", "tx": None}
    r = submit(client, kp, photo_for(engine, rng, unit(rng), "a"))
    assert r.status_code == 201, r.text
    assert r.json() == {"status": "on_list", "event_id": "ev1", "wallet": str(kp.pubkey())}
    assert status(client, kp).json() == {"status": "on_list", "tx": None}
    r = client.post("/api/v1/events/ev1/attendance/leave", json=signed(kp, "leave"))
    assert r.status_code == 200
    assert r.json() == {"status": "not_joined", "event_id": "ev1", "wallet": str(kp.pubkey())}
    assert status(client, kp).json()["status"] == "not_joined"


def test_malformed_body_400(env):
    client, _, _, _, _ = env
    kp = Keypair()
    body = signed(kp, "join", "ev1", CONSENT) | {"consent": {"version": CONSENT, "accepted": True}, "first_name": "Ola"}
    assert err(client.post("/api/v1/events/ev1/attendance", json=body)) == "invalid_request"  # no image
    r = client.post("/api/v1/events/ev1/attendance", content=b"{not json", headers={"content-type": "application/json"})
    assert r.status_code == 400 and err(r) == "invalid_request" and "message" in r.json()["error"]
    assert client.post("/api/v1/events/ev1/attendance/test", json={}).status_code == 400


def test_body_over_4mb_413(env):
    client, _, _, _, _ = env
    r = client.post("/api/v1/events/ev1/attendance/test", json={"image": "A" * (4 * 1024 * 1024)})
    assert r.status_code == 413 and err(r) == "too_large"


def test_zero_or_two_faces_photo_rejected_with_issues(env):
    client, engine, rng, _, _ = env
    p = unit(rng)
    r = submit(client, Keypair(), photo_for(engine, rng, p, "none", scene=[]))
    assert r.status_code == 422
    e = r.json()["error"]
    assert e["code"] == "photo_rejected" and e["message"].startswith("We can't find a face")
    assert [i["code"] for i in e["issues"]] == ["no_face"]
    two = [(BOX, 0.0, near(p, rng)), ([350, 100, 550, 340], 0.0, unit(rng))]
    r = submit(client, Keypair(), photo_for(engine, rng, p, "two", scene=two))
    assert err(r) == "photo_rejected" and [i["code"] for i in r.json()["error"]["issues"]] == ["multiple_faces"]


def test_turned_head_rejected(env):
    client, engine, rng, _, _ = env
    r = submit(client, Keypair(), photo_for(engine, rng, unit(rng), "w", scene=[(BOX, 0.3, unit(rng))]))
    assert err(r) == "photo_rejected"
    assert [i["code"] for i in r.json()["error"]["issues"]] == ["wrong_pose"]


def test_duplicate_face_of_other_wallet_409_rejoin_same_wallet_ok(env):
    client, engine, rng, _, _ = env
    p = unit(rng)
    k1, k2 = Keypair(), Keypair()
    assert submit(client, k1, photo_for(engine, rng, p, "a")).status_code == 201
    r = submit(client, k2, photo_for(engine, rng, p, "b"))
    assert r.status_code == 409 and err(r) == "face_already_registered"
    assert submit(client, k1, photo_for(engine, rng, p, "c")).status_code == 201


def test_consent_required(env):
    client, engine, rng, _, _ = env
    photo = photo_for(engine, rng, unit(rng), "c")
    r = submit(client, Keypair(), photo, accepted=False)
    assert r.status_code == 422 and err(r) == "consent_required"
    r = submit(client, Keypair(), photo, consent="1999-01-01")
    assert r.status_code == 422 and err(r) == "consent_required"


def test_unknown_event_404_and_ended_event_409(env):
    client, engine, rng, _, event = env
    photo = photo_for(engine, rng, unit(rng), "e")
    r = submit(client, Keypair(), photo, event_id="nope")
    assert r.status_code == 404 and err(r) == "event_not_found"
    assert err(client.get("/api/v1/events/nope/attendance/x")) == "event_not_found"
    client.post("/api/oracle/dev/events", json=event | {"end_ts": 1})
    r = submit(client, Keypair(), photo)
    assert r.status_code == 409 and err(r) == "event_ended"


def test_camera_token_only_for_organizer_and_fixed_pair(env):
    client, _, _, org, _ = env
    r = client.post("/api/v1/events/ev1/camera-token", json=signed(Keypair(), "camera-token"))
    assert r.status_code == 403 and err(r) == "not_organizer"
    r1 = client.post("/api/v1/events/ev1/camera-token", json=signed(org, "camera-token")).json()
    assert r1["camera_path"] == f"/camera/{r1['camera_token']}"
    assert len(r1["camera_token"]) >= 40 and r1["stage_token"] != r1["camera_token"]
    r2 = client.post("/api/v1/events/ev1/camera-token", json=signed(org, "camera-token")).json()
    assert r1 == r2  # same pair until the event ends


def test_signature_action_is_bound(env):
    """A leave signature cannot be used as a camera-token signature (message differs)."""
    client, _, _, org, _ = env
    r = client.post("/api/v1/events/ev1/camera-token", json=signed(org, "leave"))
    assert r.status_code == 401 and err(r) == "bad_signature"


def test_dev_endpoint_rejected_when_not_dev(env):
    client, _, _, _, event = env
    app.dependency_overrides[get_settings] = lambda: Settings(env="prod")
    assert client.post("/api/oracle/dev/events", json=event).status_code == 404


def test_attendance_test_endpoint(env):
    client, engine, rng, _, _ = env
    good = engine.set(b"t-good", [(BOX, 0.0, unit(rng))])
    r = client.post("/api/v1/events/ev1/attendance/test", json={"image": b64(good)})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["issues"] == []
    assert body["face"]["bbox"] == BOX and body["face"]["confidence"] == 0.9 and body["face"]["yaw"] == 0.0
    dark = engine.set(b"t-dark", [(BOX, 0.0, unit(rng))], image=textured(mean=30.0))
    body = client.post("/api/v1/events/ev1/attendance/test", json={"image": b64(dark)}).json()
    assert body["ok"] is False and [i["code"] for i in body["issues"]] == ["too_dark"]
    empty = engine.set(b"t-empty", [])
    body = client.post("/api/v1/events/ev1/attendance/test", json={"image": b64(empty)}).json()
    assert body == {"ok": False, "issues": [{"code": "no_face", "message": "We can't find a face — look at the camera"}],
                    "face": None}
    r = client.post("/api/v1/events/ev1/attendance/test", json={"image": b64(b"bad")})
    assert r.status_code == 400 and err(r) == "invalid_request"
    r = client.post("/api/v1/events/ev1/attendance/test", json={"image": "***"})
    assert r.status_code == 400


def test_cors_only_on_v1(env):
    client, _, _, _, _ = env
    h = {"Origin": "https://widget.example", "Access-Control-Request-Method": "POST"}
    r = client.options("/api/v1/events/ev1/attendance/test", headers=h)
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "*"
    r = client.get("/api/health", headers={"Origin": "https://widget.example"})
    assert "access-control-allow-origin" not in r.headers


def test_spike_errors_keep_fastapi_shape(env):
    client, _, _, _, _ = env
    r = client.delete("/api/spike/people/nobody")
    assert r.status_code == 404 and r.json() == {"detail": "No such person."}


def test_camera_ws_bad_frame_errors_and_stays_open_then_stage_gets_payout(env):
    client, engine, rng, org, _ = env
    p = unit(rng)
    kp = Keypair()
    assert submit(client, kp, photo_for(engine, rng, p, "a")).status_code == 201
    tokens = client.post("/api/v1/events/ev1/camera-token", json=signed(org, "camera-token")).json()
    frame = engine.set(b"scene", [(BOX, 0.0, near(p, rng)), ([350, 100, 550, 340], 0.0, unit(rng))])
    with client.websocket_connect(f"/api/v1/events/ev1/live?stage_token={tokens['stage_token']}") as stage:
        assert stage.receive_json()["type"] == "stats"
        with client.websocket_connect(f"/api/v1/camera/{tokens['camera_token']}") as cam:
            cam.send_bytes(b"bad frame")
            assert cam.receive_json() == {"type": "error", "message": "not a decodable image"}
            cam.send_text("hello")
            assert cam.receive_json()["type"] == "error"
            # Socket still open. Acks come back at once and report the most recently recognised frame, so the
            # first ones may say 0 faces; recognition catches up in the background (3 matches identify,
            # min_seen_secs=0 pays).
            for _ in range(8):
                cam.send_bytes(frame)
                ack = cam.receive_json()
                assert ack["type"] == "ack"
            assert ack["faces"] == 2
        payout = None
        for _ in range(20):
            msg = stage.receive_json()
            if msg["type"] == "frame":
                for f in msg["faces"]:
                    if f["state"] == "unknown":
                        assert f["name"] is None and f["seen_secs"] == 0 and "score" not in f
            if msg["type"] == "payout":
                payout = msg
                break
        assert payout is not None and payout["wallet"] == str(kp.pubkey()) and payout["name"] == "Ola"
        assert payout["tx"].startswith("dev-") and payout["at"].endswith("Z")
    assert status(client, kp).json() == {"status": "paid", "tx": payout["tx"]}


def test_ws_close_codes(env):
    client, _, _, org, event = env
    for url in ("/api/v1/camera/not-a-token", "/api/v1/events/ev1/live?stage_token=nope"):
        with client.websocket_connect(url) as ws:
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_json()
            assert e.value.code == 4401
    tokens = client.post("/api/v1/events/ev1/camera-token", json=signed(org, "camera-token")).json()
    client.post("/api/oracle/dev/events", json=event | {"end_ts": 1})  # event ends
    from app.oracle.runtime import get_state

    get_state().events["ev1"].info = get_state().events["ev1"].info.model_copy(update={"end_ts": 1})
    for url in (f"/api/v1/camera/{tokens['camera_token']}", f"/api/v1/events/ev1/live?stage_token={tokens['stage_token']}"):
        with client.websocket_connect(url) as ws:
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_json()
            assert e.value.code == 4404


def test_event_details_counts_status_and_consent(env):
    client, engine, rng, _, event = env
    r = client.get("/api/v1/events/nope")
    assert r.status_code == 404 and err(r) == "event_not_found"
    full = {**event, "event_id": "ev2", "name": "HackYeah Day 2 Opening", "venue": "Tauron Arena",
            "reward_lamports": 50_000_000, "max_payouts": 100}
    assert client.post("/api/oracle/dev/events", json=full).status_code == 200
    d = client.get("/api/v1/events/ev2").json()
    assert d["name"] == "HackYeah Day 2 Opening" and d["venue"] == "Tauron Arena"
    assert d["status"] == "live" and d["joining_open"] is True
    assert d["starts_at"] == "1970-01-01T00:00:00Z" and d["ends_at"].endswith("Z")
    assert (d["going"], d["paid"], d["spots_left"], d["max_payouts"]) == (0, 0, 100, 100)
    assert d["consent"]["version"] == CONSENT and "face signature" in d["consent"]["text"]
    kp = Keypair()
    assert submit(client, kp, photo_for(engine, rng, unit(rng), "a"), event_id="ev2").status_code == 201
    assert client.get("/api/v1/events/ev2").json()["going"] == 1
    # Display fields are optional: the minimal event from the fixture still answers, with nulls.
    d = client.get("/api/v1/events/ev1").json()
    assert d["name"] is None and d["spots_left"] is None
    ended = {**event, "event_id": "ev3", "start_ts": 0, "end_ts": 1}
    assert client.post("/api/oracle/dev/events", json=ended).status_code == 200
    d = client.get("/api/v1/events/ev3").json()
    assert d["status"] == "ended" and d["joining_open"] is False


def test_slow_recognition_does_not_slow_the_video(env):
    import time

    client, engine, rng, org, _ = env
    calls = []
    real_detect = engine.detect

    def slow_detect(img):
        calls.append(1)
        time.sleep(0.4)  # recognition far slower than the camera
        return real_detect(img)

    engine.detect = slow_detect
    tokens = client.post("/api/v1/events/ev1/camera-token", json=signed(org, "camera-token")).json()
    frame = engine.set(b"slow", [(BOX, 0.0, unit(rng))])
    with client.websocket_connect(f"/api/v1/events/ev1/live?stage_token={tokens['stage_token']}") as stage:
        assert stage.receive_json()["type"] == "stats"
        with client.websocket_connect(f"/api/v1/camera/{tokens['camera_token']}") as cam:
            started = time.monotonic()
            for _ in range(10):
                cam.send_bytes(frame)
                assert cam.receive_json()["type"] == "ack"
            elapsed = time.monotonic() - started
        frames = 0
        while frames < 5:
            if stage.receive_json()["type"] == "frame":
                frames += 1
    # 10 frames at <= 10 fps take ~1 s; recognising each (0.4 s) in line would take >= 4 s.
    assert elapsed < 2.0, elapsed
    assert len(calls) < 10  # frames that arrived during recognition were skipped, not queued
