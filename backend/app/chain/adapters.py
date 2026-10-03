"""The oracle's EventSource and SightingSink backed by the presence_pay program on Solana.

Installed from main.py when ORACLE_KEYPAIR is set; otherwise the oracle keeps its in-memory dev stubs.
"""

import logging
import time
from collections.abc import Callable

from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature

from app.chain.presence_chain import PresenceChain, PresenceError
from app.oracle.interfaces import EventInfo, SightingRejected, SightingResult
from app.oracle.signatures import JoinProof

log = logging.getLogger("app.chain")

EVENT_CACHE_SECS = 5.0
# Errors that no retry can fix. NotStarted, Unauthorized and transport errors stay retryable.
PERMANENT_ERRORS = {"CapReached", "Ended", "NotOracle", "NoEvent", "BadJoinProof"}


def _pubkey(value: str) -> Pubkey | None:
    try:
        return Pubkey.from_string(value)
    except ValueError:
        return None


class ChainEventSource:
    """Event facts read from the Event account whose address is the event_id, name and venue included (set by the organizer)."""

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
            oracles=[str(o) for o in ev.oracles],
            threshold=ev.threshold,
            name=ev.name or None,
            venue=ev.venue or None,
        )
        self._cache[event_id] = (self.clock(), info)
        return info


class SolanaSightingSink:
    """Sends report_sighting signed by the oracle key, only for events that list that key among their oracles.
    The program decides whether a report pays; this only relays its verdict."""

    def __init__(self, chain: PresenceChain, oracle: Keypair) -> None:
        self.chain = chain
        self.oracle = oracle
        self.oracle_pubkey = str(oracle.pubkey())  # read by the join endpoint (see SightingSink)

    async def report(self, event_id: str, wallet: str, proof: JoinProof) -> SightingResult:
        event, attendee = _pubkey(event_id), _pubkey(wallet)
        if event is None or attendee is None:
            raise SightingRejected("event_id or wallet is not a valid address")
        if await self.chain.is_paid(event, attendee):
            # Idempotent, and free: e.g. an earlier report paid but its confirmation timed out, or another oracle's
            # report paid. No transaction is sent.
            return await self._paid(event, attendee, None)
        ev = await self.chain.get_event(event)
        if ev is None:
            # No account (never created, or closed by withdraw_remaining) or not an Event of this program.
            raise SightingRejected("no presence_pay Event at this address")
        if self.oracle.pubkey() not in ev.oracles:
            # The organizer chose other oracles for this event: the program would reject our signature anyway.
            raise SightingRejected(f"this oracle's key {self.oracle.pubkey()} is not one of the event's oracles")
        try:
            sig = await self.chain.report_sighting(self.oracle, event, attendee, proof, ev)
        except PresenceError as e:
            if e.code in PERMANENT_ERRORS:
                raise SightingRejected(e.code) from e
            raise
        if not await self.chain.is_paid(event, attendee):
            return SightingResult(paid=False)
        return await self._paid(event, attendee, sig)

    async def _paid(self, event: Pubkey, attendee: Pubkey, ours: Signature | None) -> SightingResult:
        """The payout tx: ours when its logs carry AttendeePaid, else found on the Sighting's history."""
        if ours is not None and await self.chain.tx_paid(ours, event, attendee):
            return SightingResult(paid=True, tx=str(ours))
        tx = await self.chain.payout_tx(event, attendee)
        if tx is None:
            # Paid, but the paying transaction is not visible to this RPC yet: retry later (a read, no tx sent).
            raise PresenceError("PayoutTxNotVisible")
        return SightingResult(paid=True, tx=str(tx))
