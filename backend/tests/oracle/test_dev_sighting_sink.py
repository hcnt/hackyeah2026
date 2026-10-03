"""The in-memory stand-in for the program (used without an oracle key): the program's rules with one oracle."""

import asyncio

import pytest
from fakes import FakeClock

from app.oracle.interfaces import DevSightingSink, EventInfo, SightingRejected


def make(min_seen: int = 3, max_payouts: int | None = 2, start: int = 1_000, end: int = 2_000):
    clock = FakeClock(1_000.0)
    info = EventInfo(event_id="ev", organizer="org", start_ts=start, end_ts=end, min_seen_secs=min_seen,
                     max_payouts=max_payouts)

    async def events(event_id):
        return info if event_id == "ev" else None

    return DevSightingSink(clock=clock, events=events), clock


def report(sink, wallet="A", event_id="ev"):
    return asyncio.run(sink.report(event_id, wallet))


def test_no_payout_before_dwell_then_exactly_one():
    sink, clock = make(min_seen=3)
    assert not report(sink).paid  # first sighting at 1000
    clock.advance(2.9)
    assert not report(sink).paid
    clock.advance(0.1)  # 3.0 s after the first sighting
    paid = report(sink)
    assert paid.paid and paid.tx and paid.tx.startswith("dev-")
    clock.advance(5)
    assert report(sink) == paid  # idempotent: same tx, no second payout


def test_min_seen_zero_pays_on_first_sighting():
    sink, _ = make(min_seen=0)
    assert report(sink).paid


def test_gap_restarts_dwell():
    sink, clock = make(min_seen=3)
    report(sink)
    clock.advance(61)  # longer than the 60 s gap: a new run starts here
    assert not report(sink).paid
    clock.advance(2)
    assert not report(sink).paid
    clock.advance(1)
    assert report(sink).paid


def test_cap_reached_is_rejected():
    sink, _ = make(min_seen=0, max_payouts=1)
    assert report(sink, "A").paid
    with pytest.raises(SightingRejected, match="CapReached"):
        report(sink, "B")


def test_window():
    sink, clock = make(min_seen=0, start=1_010)
    with pytest.raises(RuntimeError) as e:  # not started: retryable, not a rejection
        report(sink)
    assert not isinstance(e.value, SightingRejected)
    clock.advance(2_000)
    with pytest.raises(SightingRejected, match="Ended"):
        report(sink)
    with pytest.raises(SightingRejected):
        report(sink, event_id="nope")
