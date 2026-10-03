"""The two handover points between the oracle and the chain side (event facts, sighting reports), with dev stubs.

Identity is not an interface any more: the oracle verifies wallet signatures itself (see signatures.py).
Swapping in real implementations happens in ONE call, from code outside the oracle (e.g. main.py):

    from app.oracle.interfaces import install
    install(event_source=ChainEventSource(), sighting_sink=SolanaSightingSink())

Oracle code reads `providers.event_source` / `providers.sighting_sink` at call time, so nothing else changes.
"""

import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel, Field

log = logging.getLogger("app.oracle")


# 1. Event facts ------------------------------------------------------------------------------------


class EventInfo(BaseModel):
    event_id: str = Field(min_length=1, max_length=64)
    organizer: str = Field(min_length=1, max_length=64)
    start_ts: int  # unix seconds
    end_ts: int  # unix seconds
    min_seen_secs: int = Field(ge=0)
    # Display fields for GET /api/v1/events/{id}; optional so a source can fill what it knows.
    name: str | None = Field(default=None, max_length=120)
    venue: str | None = Field(default=None, max_length=120)
    reward_lamports: int | None = Field(default=None, ge=0)
    max_payouts: int | None = Field(default=None, ge=1)
    # The event's oracle keys (base58) and how many of them must see a wallet before the program pays. Empty list =
    # unknown (the dev stand-in), which also turns off the "is this oracle one of the event's?" check on joins.
    oracles: list[str] = Field(default_factory=list, max_length=3)
    threshold: int = Field(default=1, ge=1)


class EventSource(Protocol):
    async def get(self, event_id: str) -> EventInfo | None: ...


class DevEventSource:
    """In-memory events, filled through POST /api/oracle/dev/events (ENV=dev only)."""

    def __init__(self) -> None:
        self._events: dict[str, EventInfo] = {}

    async def get(self, event_id: str) -> EventInfo | None:
        return self._events.get(event_id)

    def put(self, info: EventInfo) -> None:
        self._events[info.event_id] = info


# 2. Reporting sightings ----------------------------------------------------------------------------
#
# The oracle is a SENSOR, not a judge: it reports "I see wallet W at event E now" and the presence_pay program
# decides whether that pays (dwell time on the chain clock, oracle threshold, window, cap, once per wallet). The
# oracle keeps reporting a recognised wallet every few seconds until a report comes back paid.

SIGHTING_GAP_SECS = 60  # as in lib.rs: a longer gap between two reports restarts the dwell time


class SightingRejected(Exception):
    """The chain will never accept a sighting of this wallet at this event (payout cap reached, event ended, this
    oracle is not one of the event's oracles, ...). The oracle stops reporting the wallet."""


@dataclass(frozen=True)
class SightingResult:
    paid: bool  # the wallet has been paid for this event (by this report or an earlier one)
    tx: str | None = None  # the payout transaction; always set when paid


class SightingSink(Protocol):
    """A sink may also carry `oracle_pubkey: str | None`, the base58 key it reports with. The join endpoint uses it
    to refuse joins for events that list other oracles; a sink without it (the dev stand-in) skips that check."""

    async def report(self, event_id: str, wallet: str) -> SightingResult:
        """Report that `wallet` is seen now. Idempotent: a wallet already paid returns paid=True with that payout's
        tx. Raise SightingRejected when reporting again cannot help; any other exception means "retry later"."""


@dataclass
class _DevSighting:
    first_seen: float
    last_seen: float
    tx: str | None = None


@dataclass
class DevSightingSink:
    """In-memory stand-in for the program (no oracle key): the same rules with one oracle (threshold 1): dwell
    `last_seen - first_seen >= min_seen_secs`, a gap over SIGHTING_GAP_SECS restarts it, only within the event's
    window, at most `max_payouts` payouts, once per wallet."""

    clock: Callable[[], float] = time.time
    events: Callable[[str], Awaitable[EventInfo | None]] | None = None  # default: providers.event_source.get
    _seen: dict[tuple[str, str], _DevSighting] = field(default_factory=dict)

    async def report(self, event_id: str, wallet: str) -> SightingResult:
        info = await (self.events or providers.event_source.get)(event_id)
        if info is None:
            raise SightingRejected("no such event")
        now = self.clock()
        if now < info.start_ts:
            raise RuntimeError("NotStarted")  # retryable, as on chain
        if now > info.end_ts:
            raise SightingRejected("Ended")
        key = (event_id, wallet)
        s = self._seen.get(key)
        if s is not None and s.tx is not None:
            return SightingResult(paid=True, tx=s.tx)
        if s is None or now - s.last_seen > SIGHTING_GAP_SECS:
            s = self._seen[key] = _DevSighting(first_seen=now, last_seen=now)
        s.last_seen = now
        if s.last_seen - s.first_seen < info.min_seen_secs:
            return SightingResult(paid=False)
        paid = sum(1 for (e, _), v in self._seen.items() if e == event_id and v.tx is not None)
        if info.max_payouts is not None and paid >= info.max_payouts:
            raise SightingRejected("CapReached")
        s.tx = f"dev-{secrets.token_hex(16)}"
        log.info("dev payout event_id=%s wallet=%s tx=%s status=sent", event_id, wallet, s.tx)
        return SightingResult(paid=True, tx=s.tx)


# The single swap point -----------------------------------------------------------------------------


@dataclass
class Providers:
    event_source: EventSource
    sighting_sink: SightingSink


providers = Providers(event_source=DevEventSource(), sighting_sink=DevSightingSink())


def install(*, event_source: EventSource | None = None, sighting_sink: SightingSink | None = None) -> None:
    if event_source is not None:
        providers.event_source = event_source
    if sighting_sink is not None:
        providers.sighting_sink = sighting_sink
