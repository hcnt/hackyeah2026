"""The Solana-backed EventSource and SightingSink against a fake chain client (no network)."""

import asyncio

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature

from app.chain.adapters import ChainEventSource, SolanaSightingSink
from app.chain.presence_chain import Event, PresenceError
from app.oracle.interfaces import SightingRejected, SightingResult
from app.oracle.signatures import JoinProof, build_message

EVENT = Keypair().pubkey()
ORGANIZER = Keypair().pubkey()
ORACLE = Keypair()
ORACLE_PK = ORACLE.pubkey()
WALLET = str(Keypair().pubkey())
PAID_TX = Signature.new_unique()
_MSG = build_message("join", str(EVENT), WALLET, "2026-10-03T12:00:00Z", "2026-10-03").encode()
PROOF = JoinProof(message=_MSG, signature=bytes(range(64)))  # the sink does not check it; the program does


def chain_event(
    address: Pubkey = EVENT, oracles: list[Pubkey] | None = None, name: str = "HackYeah 2026", venue: str = "Kraków"
) -> Event:
    return Event(
        address=address, organizer=ORGANIZER, oracles=[ORACLE_PK] if oracles is None else oracles, threshold=1,
        event_id=1, start=1_000, end=2_000, reward=10_000_000, fee=2_000_000, max_paid=3,
        paid_count=0, min_seen_secs=3, balance=0, name=name, venue=venue,
    )


class FakeChain:
    """`pays_after`: the report number (1-based) at which the fake program pays; None = never. `paid_tx`: what
    payout_tx finds on the Sighting's history; `ours_paid`: whether our own report's logs carry AttendeePaid."""

    def __init__(self, events: dict[Pubkey, Event] | None = None, report_error: str | None = None,
                 pays_after: int | None = 1, already_paid: bool = False, paid_tx: Signature | None = PAID_TX,
                 ours_paid: bool = True) -> None:
        self.events = events if events is not None else {EVENT: chain_event()}
        self.report_error = report_error
        self.pays_after = pays_after
        self.paid = already_paid
        self.paid_tx = paid_tx
        self.ours_paid = ours_paid
        self.get_calls = 0
        self.report_calls: list[Event | None] = []
        self.proofs: list[JoinProof] = []
        self.sent: list[Signature] = []

    async def get_event(self, event: Pubkey) -> Event | None:
        self.get_calls += 1
        return self.events.get(event)

    async def is_paid(self, event: Pubkey, attendee: Pubkey) -> bool:
        return self.paid

    async def report_sighting(
        self, oracle: Keypair, event: Pubkey, attendee: Pubkey, proof: JoinProof, ev: Event | None = None
    ) -> Signature:
        self.report_calls.append(ev)
        self.proofs.append(proof)
        if self.report_error:
            raise PresenceError(self.report_error)
        if self.pays_after is not None and len(self.report_calls) >= self.pays_after:
            self.paid = True
        sig = Signature.new_unique()
        self.sent.append(sig)
        return sig

    async def tx_paid(self, sig: Signature, event: Pubkey, attendee: Pubkey) -> bool:
        return self.ours_paid and sig in self.sent

    async def payout_tx(self, event: Pubkey, attendee: Pubkey) -> Signature | None:
        return self.paid_tx if self.paid else None


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def test_event_maps_chain_fields():
    info = asyncio.run(ChainEventSource(FakeChain()).get(str(EVENT)))
    assert info is not None
    assert (info.event_id, info.organizer) == (str(EVENT), str(ORGANIZER))
    assert (info.start_ts, info.end_ts, info.min_seen_secs) == (1_000, 2_000, 3)
    assert (info.reward_lamports, info.max_payouts) == (10_000_000, 3)
    assert (info.name, info.venue) == ("HackYeah 2026", "Kraków")  # from the Event account
    assert (info.oracles, info.threshold) == ([str(ORACLE_PK)], 1)


def test_event_with_empty_venue_maps_to_none():
    chain = FakeChain(events={EVENT: chain_event(name="n" * 64, venue="")})
    info = asyncio.run(ChainEventSource(chain).get(str(EVENT)))
    assert (info.name, info.venue) == ("n" * 64, None)


def test_event_maps_all_oracles_and_threshold():
    two = Keypair().pubkey()
    ev = chain_event(oracles=[ORACLE_PK, two])
    ev.threshold = 2
    info = asyncio.run(ChainEventSource(FakeChain(events={EVENT: ev})).get(str(EVENT)))
    assert (info.oracles, info.threshold) == ([str(ORACLE_PK), str(two)], 2)


def test_sink_exposes_its_oracle_key():
    assert SolanaSightingSink(FakeChain(), ORACLE).oracle_pubkey == str(ORACLE_PK)


@pytest.mark.parametrize("event_id", ["not-base58-0OIl", "", str(Keypair().pubkey())])
def test_bad_or_unknown_event_is_none(event_id):
    assert asyncio.run(ChainEventSource(FakeChain()).get(event_id)) is None


def test_event_cached_for_ttl_and_unknown_not_cached():
    chain, clock = FakeChain(), Clock()
    source = ChainEventSource(chain, ttl=5.0, clock=clock)

    async def run():
        await source.get(str(EVENT))
        await source.get(str(EVENT))
        clock.t = 6.0
        await source.get(str(EVENT))
        missing = str(Keypair().pubkey())
        await source.get(missing)
        await source.get(missing)

    asyncio.run(run())
    assert chain.get_calls == 4  # EVENT twice (before and after the TTL), the missing one every time


def report(sink, wallet=WALLET, proof=PROOF):
    return asyncio.run(sink.report(str(EVENT), wallet, proof))


def test_report_that_pays_returns_our_tx():
    chain = FakeChain(pays_after=1)
    result = report(SolanaSightingSink(chain, ORACLE))
    assert result == SightingResult(paid=True, tx=str(chain.sent[0]))


def test_report_not_yet_paid():
    chain = FakeChain(pays_after=None)
    assert report(SolanaSightingSink(chain, ORACLE)) == SightingResult(paid=False)
    assert len(chain.report_calls) == 1


def test_report_until_the_program_pays():
    chain = FakeChain(pays_after=3)
    sink = SolanaSightingSink(chain, ORACLE)
    results = [report(sink) for _ in range(3)]
    assert [r.paid for r in results] == [False, False, True]
    assert results[2].tx == str(chain.sent[2])


def test_already_paid_returns_the_original_payout_without_sending():
    chain = FakeChain(already_paid=True)
    assert report(SolanaSightingSink(chain, ORACLE)) == SightingResult(paid=True, tx=str(PAID_TX))
    assert chain.report_calls == []


def test_paid_by_another_oracles_report_finds_that_tx():
    chain = FakeChain(pays_after=1, ours_paid=False)  # our report landed, but someone else's paid
    assert report(SolanaSightingSink(chain, ORACLE)) == SightingResult(paid=True, tx=str(PAID_TX))


def test_already_paid_but_tx_not_visible_yet_is_retryable():
    sink = SolanaSightingSink(FakeChain(already_paid=True, paid_tx=None), ORACLE)
    with pytest.raises(PresenceError):
        report(sink)


@pytest.mark.parametrize("code", ["CapReached", "Ended", "NotOracle", "NoEvent", "BadJoinProof"])
def test_permanent_errors_are_rejected(code):
    sink = SolanaSightingSink(FakeChain(report_error=code), ORACLE)
    with pytest.raises(SightingRejected):
        report(sink)


@pytest.mark.parametrize("code", ["NotStarted", "Unauthorized", "TransactionFailed"])
def test_other_errors_stay_retryable(code):
    sink = SolanaSightingSink(FakeChain(report_error=code), ORACLE)
    with pytest.raises(PresenceError):
        report(sink)


def test_invalid_wallet_is_rejected():
    with pytest.raises(SightingRejected):
        report(SolanaSightingSink(FakeChain(), ORACLE), "nope")


def test_report_passes_the_event_it_read():
    chain = FakeChain()
    report(SolanaSightingSink(chain, ORACLE))
    assert chain.report_calls == [chain.events[EVENT]]


def test_any_listed_oracle_slot_may_report():
    chain = FakeChain(events={EVENT: chain_event(oracles=[Keypair().pubkey(), ORACLE_PK])})
    assert report(SolanaSightingSink(chain, ORACLE)).paid


def test_event_without_this_oracle_is_rejected_without_sending():
    chain = FakeChain(events={EVENT: chain_event(oracles=[Keypair().pubkey(), Keypair().pubkey()])})
    with pytest.raises(SightingRejected, match="not one of the event's oracles"):
        report(SolanaSightingSink(chain, ORACLE))
    assert chain.report_calls == []


def test_missing_event_is_rejected_without_sending():
    chain = FakeChain(events={})
    with pytest.raises(SightingRejected):
        report(SolanaSightingSink(chain, ORACLE))
    assert chain.report_calls == []


def test_report_forwards_the_join_proof_unchanged():
    chain = FakeChain(pays_after=None)
    sink = SolanaSightingSink(chain, ORACLE)
    other = JoinProof(message=b"Attend Now\nAction: join\n...", signature=bytes(64))
    report(sink)
    report(sink, proof=other)
    assert chain.proofs[0] is PROOF and chain.proofs[1] is other


def test_bad_join_proof_from_the_program_is_a_rejection():
    sink = SolanaSightingSink(FakeChain(report_error="BadJoinProof"), ORACLE)
    with pytest.raises(SightingRejected, match="BadJoinProof"):
        report(sink)
