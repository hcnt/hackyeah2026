"""One end-to-end check with the real buffalo_l model on insightface's sample image t1 (6 faces)."""

import asyncio
from pathlib import Path

import pytest
from fakes import DUMMY_PROOF, FakeClock, RecordingSink

MODEL_DIR = Path.home() / ".insightface" / "models" / "buffalo_l"
pytestmark = pytest.mark.skipif(not MODEL_DIR.exists(), reason="buffalo_l model not downloaded")


def test_t1_enrol_one_face_exactly_one_payout_others_unknown():
    from insightface.data import get_image

    from app.oracle.face import InsightFaceEngine
    from app.oracle.interfaces import EventInfo
    from app.oracle.runtime import OracleState

    engine = InsightFaceEngine()
    img = get_image("t1")
    faces = engine.detect(img)
    assert len(faces) == 6

    # enrol face 0 from a crop around it (a different image than the camera frames)
    x1, y1, x2, y2 = (int(v) for v in faces[0].bbox)
    w, h = x2 - x1, y2 - y1
    crop = img[max(0, y1 - h // 2) : y2 + h // 2, max(0, x1 - w // 2) : x2 + w // 2].copy()
    crop_faces = engine.detect(crop)
    assert len(crop_faces) == 1
    enrolled = engine.embed(crop, crop_faces)[0]

    clock = FakeClock(0.0)
    sink = RecordingSink(clock, min_seen=1)  # the simulated program: 1 s dwell, as in the event
    state = OracleState(engine=engine, clock=clock, sink=lambda: sink)
    info = EventInfo(event_id="ev", organizer="org", start_ts=0, end_ts=4_000_000_000, min_seen_secs=1)
    rt = state.runtime_for(info)
    state.guestlists.put("ev", info.end_ts, "W", enrolled, DUMMY_PROOF)

    async def run():
        outs = []
        for _ in range(8):
            outs.append(await rt.process_frame("cam", img))
            await asyncio.sleep(0)
            clock.advance(0.5)
        await rt.wait_payouts()
        return outs

    outs = asyncio.run(run())
    assert sink.successes == [("ev", "W")]  # exactly one payout, after the dwell
    last = outs[-1]
    assert len(last) == 6
    states = sorted(f["state"] for f in last)
    assert states == ["paid"] + ["unknown"] * 5
    for f in last:
        if f["state"] == "unknown":
            assert f["name"] is None
        else:
            assert f["name"] == "W"
