"""Wallet signatures (Solana `signMessage`, ed25519 over the UTF-8 message, base58 signature).

Checks, in order: signature valid for `wallet` (401 bad_signature), `signed_at` no more than 5 min in the past
and 1 min in the future (401 signature_expired), signature not seen before (401 signature_reused). A signature
is consumed as soon as it passes the first two checks, even if the request then fails for another reason.

A verified join is kept as a JoinProof: the oracle sends it with every sighting report, and the on_sight program
checks it on chain, so no oracle can report a wallet that never signed up for the event.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from solders.pubkey import Pubkey
from solders.signature import Signature

from app.oracle.errors import OracleError, invalid_request

MAX_AGE_SECS = 5 * 60
MAX_FUTURE_SECS = 60


def build_message(action: str, event_id: str, wallet: str, signed_at: str, consent_version: str | None = None) -> str:
    lines = ["Attend Now", f"Action: {action}", f"Event: {event_id}", f"Wallet: {wallet}"]
    if action == "join":
        lines.append(f"Consent: {consent_version}")
    lines.append(f"Time: {signed_at}")
    return "\n".join(lines)


def join_prefix(event_id: str, wallet: str) -> bytes:
    """The start of a join message for this event and wallet; the program requires the signed message to begin
    with exactly these bytes (lib.rs, check_join_proof)."""
    return f"Attend Now\nAction: join\nEvent: {event_id}\nWallet: {wallet}\n".encode()


@dataclass(frozen=True)
class JoinProof:
    """A wallet's signed join message: ed25519 `signature` (64 bytes) over the UTF-8 `message`."""

    message: bytes
    signature: bytes

    def valid_for(self, event_id: str, wallet: str) -> bool:
        """The program's check, off chain: signed by `wallet`, and a join for `event_id` by `wallet`."""
        try:
            pubkey = Pubkey.from_string(wallet)
            sig = Signature.from_bytes(self.signature)
        except ValueError:
            return False
        return self.message.startswith(join_prefix(event_id, wallet)) and sig.verify(pubkey, self.message)


def parse_signed_at(signed_at: str) -> float:
    try:
        dt = datetime.fromisoformat(signed_at)
    except ValueError as e:
        raise invalid_request("signed_at must be an ISO 8601 UTC timestamp.") from e
    if dt.tzinfo is None:
        raise invalid_request("signed_at must carry a timezone (use Z for UTC).")
    return dt.timestamp()


class SignatureVerifier:
    def __init__(self, wall_clock: Callable[[], float] = time.time) -> None:
        self._wall_clock = wall_clock
        self._used: dict[bytes, float] = {}  # signature bytes -> forget after (unix seconds)

    def verify(
        self, *, action: str, event_id: str, wallet: str, signed_at: str, signature: str,
        consent_version: str | None = None,
    ) -> JoinProof:
        """Raises OracleError unless the signature is valid, fresh and unused; returns the signed message."""
        ts = parse_signed_at(signed_at)
        message = build_message(action, event_id, wallet, signed_at, consent_version).encode()
        try:
            pubkey = Pubkey.from_string(wallet)
            sig = Signature.from_string(signature)
        except ValueError as e:
            raise OracleError(401, "bad_signature", "The signature does not verify for this wallet.") from e
        if not sig.verify(pubkey, message):
            raise OracleError(401, "bad_signature", "The signature does not verify for this wallet.")
        now = self._wall_clock()
        if ts < now - MAX_AGE_SECS or ts > now + MAX_FUTURE_SECS:
            raise OracleError(401, "signature_expired", "The signature has expired; sign again.")
        self._used = {k: exp for k, exp in self._used.items() if exp >= now}
        key = bytes(sig)
        if key in self._used:
            raise OracleError(401, "signature_reused", "This signature was already used; sign again.")
        self._used[key] = ts + MAX_AGE_SECS + 1
        return JoinProof(message=message, signature=key)
