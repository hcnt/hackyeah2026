"""The two handover points between the oracle and the wallet side, with dev stubs.

Identity is not an interface any more: the oracle verifies wallet signatures itself (see signatures.py).
Swapping in real implementations happens in ONE call, from code outside the oracle (e.g. main.py):

    from app.oracle.interfaces import install
    install(event_source=ChainEventSource(), payout_sink=SolanaPayoutSink())

Oracle code reads `providers.event_source` / `providers.payout_sink` at call time, so nothing else changes.
"""

import logging
import secrets
from dataclasses import dataclass
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


# 2. Paying -----------------------------------------------------------------------------------------


class PayoutSink(Protocol):
    async def pay(self, event_id: str, wallet: str) -> str:
        """Send the payout; return the tx signature. Idempotent. Raise on failure (the oracle retries)."""


class DevPayoutSink:
    def __init__(self) -> None:
        self._paid: dict[tuple[str, str], str] = {}

    async def pay(self, event_id: str, wallet: str) -> str:
        tx = self._paid.setdefault((event_id, wallet), f"dev-{secrets.token_hex(16)}")
        log.info("dev payout event_id=%s wallet=%s tx=%s status=sent", event_id, wallet, tx)
        return tx


# The single swap point -----------------------------------------------------------------------------


@dataclass
class Providers:
    event_source: EventSource
    payout_sink: PayoutSink


providers = Providers(event_source=DevEventSource(), payout_sink=DevPayoutSink())


def install(*, event_source: EventSource | None = None, payout_sink: PayoutSink | None = None) -> None:
    if event_source is not None:
        providers.event_source = event_source
    if payout_sink is not None:
        providers.payout_sink = payout_sink
