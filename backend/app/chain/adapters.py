"""The oracle's EventSource and PayoutSink backed by the presence_pay program on Solana.

Installed from main.py when ORACLE_KEYPAIR is set; otherwise the oracle keeps its in-memory dev stubs.
"""

import logging
import time
from collections.abc import Callable

from solders.keypair import Keypair
from solders.pubkey import Pubkey

from app.chain.presence_chain import PresenceChain, PresenceError
from app.oracle.interfaces import EventInfo, PayoutRejected

log = logging.getLogger("app.chain")

EVENT_CACHE_SECS = 5.0
# Program errors that no retry can fix. NotStarted, Unauthorized (a misconfigured oracle key) and transport
# errors stay retryable.
PERMANENT_ERRORS = {"CapReached", "Ended"}


def _pubkey(value: str) -> Pubkey | None:
    try:
        return Pubkey.from_string(value)
    except ValueError:
        return None


class ChainEventSource:
    """Event facts read from the Event account whose address is the event_id. Name and venue are not on-chain."""

    def __init__(
        self, chain: PresenceChain, ttl: float = EVENT_CACHE_SECS, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.chain = chain
        self.ttl = ttl
        self.clock = clock
        # Every API request reads its event; the cache keeps that off the public RPC's rate limit.
        self._cache: dict[str, tuple[float, EventInfo]] = {}

    async def get(self, event_id: str) -> EventInfo | None:
        hit = self._cache.get(event_id)
        if hit is not None and self.clock() - hit[0] < self.ttl:
            return hit[1]
        address = _pubkey(event_id)
        if address is None:
            return None
        ev = await self.chain.get_event(address)
        if ev is None:
            return None  # not cached: an event created a moment ago shows up on the next request
        info = EventInfo(
            event_id=event_id,
            organizer=str(ev.organizer),
            start_ts=ev.start,
            end_ts=ev.end,
            min_seen_secs=ev.min_seen_secs,
            reward_lamports=ev.reward,
            max_payouts=ev.max_paid,
        )
        self._cache[event_id] = (self.clock(), info)
        return info


class SolanaPayoutSink:
    """Sends pay_attendee signed by the oracle key, only for events whose on-chain oracle is that key."""

    def __init__(self, chain: PresenceChain, oracle: Keypair) -> None:
        self.chain = chain
        self.oracle = oracle

    async def pay(self, event_id: str, wallet: str) -> str:
        event, attendee = _pubkey(event_id), _pubkey(wallet)
        if event is None or attendee is None:
            raise PayoutRejected("event_id or wallet is not a valid address")
        ev = await self.chain.get_event(event)
        if ev is None:
            # No account (never created, or closed by withdraw_remaining) or not an Event of this program.
            raise PayoutRejected("no presence_pay Event at this address")
        if ev.oracle != self.oracle.pubkey():
            # The organizer chose another oracle for this event: the program would reject our signature anyway.
            raise PayoutRejected(f"event oracle {ev.oracle} is not this oracle's key {self.oracle.pubkey()}")
        try:
            return str(await self.chain.pay_attendee(self.oracle, event, attendee, ev))
        except PresenceError as e:
            if e.code == "AlreadyPaid":
                # Idempotent: e.g. an earlier attempt landed but its confirmation timed out.
                tx = await self.chain.payout_tx(event, attendee)
                if tx is None:
                    raise  # the receipt exists but its tx is not visible yet: retry later
                return str(tx)
            if e.code in PERMANENT_ERRORS:
                raise PayoutRejected(e.code) from e
            raise
