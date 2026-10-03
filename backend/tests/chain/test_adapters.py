"""The Solana-backed EventSource and PayoutSink against a fake chain client (no network)."""

import asyncio

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature

from app.chain.adapters import ChainEventSource, SolanaPayoutSink
from app.chain.presence_chain import Event, PresenceError
from app.oracle.interfaces import PayoutRejected

EVENT = Keypair().pubkey()
ORGANIZER = Keypair().pubkey()
WALLET = str(Keypair().pubkey())
PAID_TX = Signature.new_unique()


def chain_event(address: Pubkey = EVENT) -> Event:
    return Event(
        address=address, organizer=ORGANIZER, event_id=1, start=1_000, end=2_000, reward=10_000_000,
        fee=2_000_000, max_paid=3, paid_count=0, min_seen_secs=3, balance=0,
    )


class FakeChain:
    def __init__(self, events: dict[Pubkey, Event] | None = None, pay_error: str | None = None,
                 paid_tx: Signature | None = PAID_TX) -> None:
        self.events = events if events is not None else {EVENT: chain_event()}
        self.pay_error = pay_error
        self.paid_tx = paid_tx
        self.get_calls = 0

    async def get_event(self, event: Pubkey) -> Event | None:
        self.get_calls += 1
        return self.events.get(event)

    async def pay_attendee(self, oracle: Keypair, event: Pubkey, attendee: Pubkey) -> Signature:
        if self.pay_error:
            raise PresenceError(self.pay_error)
        return Signature.new_unique()

    async def payout_tx(self, event: Pubkey, attendee: Pubkey) -> Signature | None:
        return self.paid_tx


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
    assert info.name is None and info.venue is None


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


def test_pay_returns_tx():
    tx = asyncio.run(SolanaPayoutSink(FakeChain(), Keypair()).pay(str(EVENT), WALLET))
    assert tx and tx != str(PAID_TX)


def test_already_paid_returns_the_original_payout():
    sink = SolanaPayoutSink(FakeChain(pay_error="AlreadyPaid"), Keypair())
    assert asyncio.run(sink.pay(str(EVENT), WALLET)) == str(PAID_TX)


def test_already_paid_but_tx_not_visible_yet_is_retryable():
    sink = SolanaPayoutSink(FakeChain(pay_error="AlreadyPaid", paid_tx=None), Keypair())
    with pytest.raises(PresenceError):
        asyncio.run(sink.pay(str(EVENT), WALLET))


@pytest.mark.parametrize("code", ["CapReached", "Ended"])
def test_permanent_errors_are_rejected(code):
    sink = SolanaPayoutSink(FakeChain(pay_error=code), Keypair())
    with pytest.raises(PayoutRejected):
        asyncio.run(sink.pay(str(EVENT), WALLET))


@pytest.mark.parametrize("code", ["NotStarted", "Unauthorized", "TransactionFailed"])
def test_other_errors_stay_retryable(code):
    sink = SolanaPayoutSink(FakeChain(pay_error=code), Keypair())
    with pytest.raises(PresenceError):
        asyncio.run(sink.pay(str(EVENT), WALLET))


def test_invalid_wallet_is_rejected():
    with pytest.raises(PayoutRejected):
        asyncio.run(SolanaPayoutSink(FakeChain(), Keypair()).pay(str(EVENT), "nope"))
