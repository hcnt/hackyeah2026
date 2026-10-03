"""Client for the presence_pay Solana program (contracts/presence_pay).

Instructions are built by hand (Anchor discriminator = sha256("global:<name>")[:8] + Borsh args), so no anchorpy.
Account layouts mirror contracts/presence_pay/lib.rs; changing them there means changing them here.
Each Event carries its own oracles (1-3, with an M-of-N threshold) and treasury, fixed at creation; Config only holds
defaults for new events.

The oracle is a sensor: it sends report_sighting ("I see wallet W now") and the PROGRAM decides when to pay (dwell
time on the chain clock, oracle threshold, window, cap, once per wallet). There is no instruction that pays directly.
"""

from __future__ import annotations

import base64
import hashlib
import json
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Self

import base58
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.core import RPCException
from solana.rpc.models import MemcmpOpts, TxOpts
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.system_program import ID as SYSTEM_PROGRAM_ID
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction

from app.config import get_settings

_settings = get_settings()
PROGRAM_ID = Pubkey.from_string(_settings.presence_program_id)
RPC_URL = _settings.solana_rpc_url
CLUSTER = _settings.solana_cluster
LAMPORTS_PER_SOL = 1_000_000_000

# #[error_code] in lib.rs, numbered from 6000 by Anchor (new variants are appended, never renumbered).
PROGRAM_ERRORS = [
    "BadTimes", "BadAmounts", "Overflow", "AlreadyStarted",
    "NotStarted", "Ended", "CapReached", "EventRunning",
    "BadOracles", "BadThreshold", "NotOracle",
]
MAX_ORACLES = 3
SIGHTING_GAP_SECS = 60  # lib.rs: a longer gap between two reports restarts the dwell time


def _disc(namespace: str, name: str) -> bytes:
    return hashlib.sha256(f"{namespace}:{name}".encode()).digest()[:8]


CONFIG_DISC = _disc("account", "Config")
EVENT_DISC = _disc("account", "Event")
SIGHTING_DISC = _disc("account", "Sighting")
ATTENDEE_PAID_DISC = _disc("event", "AttendeePaid")

_CONFIG_FMT = "<32s32sQB"  # admin, treasury, fee, bump
# organizer, oracles[3], oracle_count, threshold, treasury, event_id, start, end, reward, fee, max_paid, paid_count,
# min_seen_secs, bump
_EVENT_FMT = "<32s96sBB32sQqqQQIIIB"
_SIGHTING_FMT = "<qqB?32sqB"  # first_seen, last_seen, reporters, paid, payer, event_end, bump
EVENT_ORGANIZER_OFFSET = 8
EVENT_ORACLES_OFFSET = 8 + 32  # slot i at EVENT_ORACLES_OFFSET + 32 * i
DEFAULT_PUBKEY = Pubkey.default()


def load_keypair(path: str | Path) -> Keypair:
    """A keypair file in solana-keygen / Playground format (JSON array of 64 numbers)."""
    return keypair_from_json(Path(path).expanduser().read_text())


def keypair_from_json(text: str) -> Keypair:
    return Keypair.from_bytes(bytes(json.loads(text)))


def explorer_tx(sig: Signature | str) -> str:
    return f"https://explorer.solana.com/tx/{sig}?cluster={CLUSTER}"


def explorer_address(addr: Pubkey | str) -> str:
    return f"https://explorer.solana.com/address/{addr}?cluster={CLUSTER}"


# PDAs (program_id is a parameter only so tests can run a locally built copy under another id) -------------


def config_pda(program_id: Pubkey = PROGRAM_ID) -> Pubkey:
    return Pubkey.find_program_address([b"config"], program_id)[0]


def event_pda(organizer: Pubkey, event_id: int, program_id: Pubkey = PROGRAM_ID) -> Pubkey:
    return Pubkey.find_program_address([b"event", bytes(organizer), event_id.to_bytes(8, "little")], program_id)[0]


def sighting_pda(event: Pubkey, attendee: Pubkey, program_id: Pubkey = PROGRAM_ID) -> Pubkey:
    return Pubkey.find_program_address([b"sighting", bytes(event), bytes(attendee)], program_id)[0]


# Account data ---------------------------------------------------------------------------------------


@dataclass
class Config:
    """Defaults copied into each Event at creation; changing them never touches existing events."""

    admin: Pubkey
    treasury: Pubkey
    fee: int

    @classmethod
    def decode(cls, data: bytes) -> Config:
        if data[:8] != CONFIG_DISC:
            raise ValueError("not a Config account")
        admin, treasury, fee, _ = struct.unpack_from(_CONFIG_FMT, data, 8)
        return cls(Pubkey(admin), Pubkey(treasury), fee)


@dataclass
class Event:
    address: Pubkey
    organizer: Pubkey
    oracles: list[Pubkey]  # the keys allowed to report sightings (1-3), chosen by the organizer
    threshold: int  # how many DIFFERENT oracles must report a wallet before the program pays
    treasury: Pubkey  # receives the fee, frozen from Config at creation
    event_id: int
    start: int  # unix seconds
    end: int  # unix seconds
    reward: int  # lamports
    fee: int  # lamports, frozen at creation
    max_paid: int
    paid_count: int
    min_seen_secs: int  # dwell time the program requires, on the chain clock
    balance: int  # lamports in the vault, account rent included

    @classmethod
    def decode(cls, address: Pubkey, data: bytes, balance: int) -> Event:
        if data[:8] != EVENT_DISC or len(data) < 8 + struct.calcsize(_EVENT_FMT):
            raise ValueError("not an Event account")
        (org, oracles, count, threshold, treasury, eid, start, end, reward, fee, max_paid, paid, min_seen, _) = (
            struct.unpack_from(_EVENT_FMT, data, 8)
        )
        if not 1 <= count <= MAX_ORACLES:
            raise ValueError("not an Event account")
        slots = [Pubkey(oracles[32 * i : 32 * (i + 1)]) for i in range(count)]
        return cls(
            address, Pubkey(org), slots, threshold, Pubkey(treasury), eid, start, end, reward, fee, max_paid, paid,
            min_seen, balance,
        )


@dataclass
class Sighting:
    """One wallet's presence at one event, as the program records it from the oracles' reports."""

    first_seen: int  # start of the current run of reports (chain clock)
    last_seen: int
    reporters: int  # bitmask over the event's oracle slots
    paid: bool
    payer: Pubkey  # the oracle that paid the rent; only it can close the account after the end
    event_end: int

    @classmethod
    def decode(cls, data: bytes) -> Sighting:
        if data[:8] != SIGHTING_DISC or len(data) < 8 + struct.calcsize(_SIGHTING_FMT):
            raise ValueError("not a Sighting account")
        first, last, reporters, paid, payer, event_end, _ = struct.unpack_from(_SIGHTING_FMT, data, 8)
        return cls(first, last, reporters, paid, Pubkey(payer), event_end)


def attendee_paid(logs: list[str] | None, event: Pubkey, attendee: Pubkey) -> bool:
    """True when the transaction logs carry the program's AttendeePaid event for this event and wallet."""
    want = ATTENDEE_PAID_DISC + bytes(event) + bytes(attendee)
    for line in logs or []:
        if line.startswith("Program data: "):
            try:
                if base64.b64decode(line.removeprefix("Program data: ")).startswith(want):
                    return True
            except ValueError:
                continue
    return False


# Instruction builders (pure, so they are testable without a network) ------------------------------------


def report_sighting_ix(oracle: Pubkey, ev: Event, attendee: Pubkey, program_id: Pubkey = PROGRAM_ID) -> Instruction:
    """report_sighting: "oracle sees attendee now". The treasury is the event's own (has_one = treasury)."""
    return Instruction(
        program_id,
        _disc("global", "report_sighting"),
        [
            AccountMeta(oracle, is_signer=True, is_writable=True),
            AccountMeta(ev.address, is_signer=False, is_writable=True),
            AccountMeta(sighting_pda(ev.address, attendee, program_id), is_signer=False, is_writable=True),
            AccountMeta(attendee, is_signer=False, is_writable=True),
            AccountMeta(ev.treasury, is_signer=False, is_writable=True),
            AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        ],
    )


def close_sighting_ix(payer: Pubkey, event: Pubkey, attendee: Pubkey, program_id: Pubkey = PROGRAM_ID) -> Instruction:
    return Instruction(
        program_id,
        _disc("global", "close_sighting"),
        [
            AccountMeta(payer, is_signer=True, is_writable=True),
            AccountMeta(sighting_pda(event, attendee, program_id), is_signer=False, is_writable=True),
        ],
    )


def create_event_ix(
    organizer: Pubkey, event_id: int, oracles: list[Pubkey], threshold: int, start: int, end: int, reward: int,
    max_paid: int, min_seen_secs: int, program_id: Pubkey = PROGRAM_ID,
) -> Instruction:
    # Borsh: Vec<Pubkey> = u32 length + the keys.
    data = (
        _disc("global", "create_event")
        + struct.pack("<QI", event_id, len(oracles))
        + b"".join(bytes(o) for o in oracles)
        + struct.pack("<BqqQII", threshold, start, end, reward, max_paid, min_seen_secs)
    )
    return Instruction(
        program_id,
        data,
        [
            AccountMeta(organizer, is_signer=True, is_writable=True),
            AccountMeta(config_pda(program_id), is_signer=False, is_writable=False),
            AccountMeta(event_pda(organizer, event_id, program_id), is_signer=False, is_writable=True),
            AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        ],
    )


def init_config_ix(admin: Pubkey, treasury: Pubkey, fee: int, program_id: Pubkey = PROGRAM_ID) -> Instruction:
    return Instruction(
        program_id,
        _disc("global", "init_config") + bytes(treasury) + struct.pack("<Q", fee),
        [
            AccountMeta(admin, is_signer=True, is_writable=True),
            AccountMeta(config_pda(program_id), is_signer=False, is_writable=True),
            AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        ],
    )


def withdraw_remaining_ix(organizer: Pubkey, event: Pubkey, program_id: Pubkey = PROGRAM_ID) -> Instruction:
    return Instruction(
        program_id,
        _disc("global", "withdraw_remaining"),
        [
            AccountMeta(organizer, is_signer=True, is_writable=True),
            AccountMeta(event, is_signer=False, is_writable=True),
        ],
    )


class PresenceError(Exception):
    """A program or transaction error with a readable code: NoEvent, NotOracle, NotStarted, Ended, CapReached,
    Unauthorized, ... or TransactionFailed for anything unrecognised."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def _program_error(text: str) -> PresenceError:
    if "ConstraintHasOne" in text or "Custom(2001)" in text:
        return PresenceError("Unauthorized", "the signer or treasury is not the one stored in the Event/Sighting/Config")
    for i, name in enumerate(PROGRAM_ERRORS):
        code = 6000 + i
        if f"custom program error: {hex(code)}" in text or f"Custom({code})" in text or f"Error Code: {name}" in text:
            return PresenceError(name)
    return PresenceError("TransactionFailed", text)


# Client ---------------------------------------------------------------------------------------------

PAYOUT_TX_SCAN = 25  # at most this many transactions on a Sighting are inspected to find the payout


class PresenceChain:
    def __init__(self, rpc_url: str = RPC_URL) -> None:
        self.client = AsyncClient(rpc_url, commitment=Confirmed)

    async def close(self) -> None:
        await self.client.close()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    # Reads (free, no key) ---------------------------------------------------------------------------

    async def get_config(self) -> Config | None:
        acc = (await self.client.get_account_info(config_pda())).value
        return Config.decode(bytes(acc.data)) if acc else None

    async def get_event(self, event: Pubkey) -> Event | None:
        """The Event at `event`, or None when there is no account or it is not an Event of this program."""
        acc = (await self.client.get_account_info(event)).value
        if acc is None or acc.owner != PROGRAM_ID:
            return None
        try:
            return Event.decode(event, bytes(acc.data), acc.lamports)
        except ValueError:
            return None

    async def list_events(self, organizer: Pubkey | None = None, oracle: Pubkey | None = None) -> list[Event]:
        """Events of this program, optionally only an organizer's and/or those listing `oracle` in any slot
        (one memcmp query per oracle slot, merged)."""
        base: list = [MemcmpOpts(offset=0, bytes=base58.b58encode(EVENT_DISC).decode())]
        if organizer:
            base.append(MemcmpOpts(offset=EVENT_ORGANIZER_OFFSET, bytes=str(organizer)))
        queries = (
            [[*base, MemcmpOpts(offset=EVENT_ORACLES_OFFSET + 32 * i, bytes=str(oracle))] for i in range(MAX_ORACLES)]
            if oracle
            else [base]
        )
        found: dict[Pubkey, Event] = {}
        for filters in queries:
            resp = await self.client.get_program_accounts(PROGRAM_ID, encoding="base64", filters=filters)
            for a in resp.value:
                ev = Event.decode(a.pubkey, bytes(a.account.data), a.account.lamports)
                if oracle is None or oracle in ev.oracles:  # a stale slot beyond oracle_count never matches
                    found[a.pubkey] = ev
        return list(found.values())

    async def get_sighting(self, event: Pubkey, attendee: Pubkey) -> Sighting | None:
        acc = (await self.client.get_account_info(sighting_pda(event, attendee))).value
        if acc is None or acc.owner != PROGRAM_ID:
            return None
        return Sighting.decode(bytes(acc.data))

    async def is_paid(self, event: Pubkey, attendee: Pubkey) -> bool:
        s = await self.get_sighting(event, attendee)
        return s is not None and s.paid

    async def tx_paid(self, sig: Signature, event: Pubkey, attendee: Pubkey) -> bool:
        """Whether transaction `sig` is the one in which the program paid `attendee` for `event`."""
        resp = await self.client.get_transaction(sig, commitment=Confirmed, max_supported_transaction_version=0)
        tx = resp.value
        meta = tx.transaction.meta if tx is not None else None
        return meta is not None and meta.err is None and attendee_paid(meta.log_messages, event, attendee)

    async def payout_tx(self, event: Pubkey, attendee: Pubkey) -> Signature | None:
        """The transaction in which the program paid `attendee` for `event` (the report_sighting whose logs carry
        AttendeePaid), if paid and visible. Reports after the payout are no-ops, so it is among the oldest."""
        if not await self.is_paid(event, attendee):
            return None
        sigs = (await self.client.get_signatures_for_address(sighting_pda(event, attendee), limit=1000)).value
        ok = [s.signature for s in reversed(sigs) if s.err is None]  # oldest first
        for sig in ok[:PAYOUT_TX_SCAN]:
            if await self.tx_paid(sig, event, attendee):
                return sig
        return None

    async def get_balance(self, address: Pubkey) -> int:
        return (await self.client.get_balance(address)).value

    # Sending ----------------------------------------------------------------------------------------

    async def _send(self, ixs: list[Instruction], payer: Keypair, *signers: Keypair) -> Signature:
        latest = (await self.client.get_latest_blockhash()).value
        tx = Transaction.new_signed_with_payer(ixs, payer.pubkey(), [payer, *signers], latest.blockhash)
        try:
            sig = (await self.client.send_transaction(tx, opts=TxOpts(preflight_commitment=Confirmed))).value
        except RPCException as exc:
            raise _program_error(str(exc)) from exc
        # Raises if the blockhash expires before confirmation (the tx was dropped): safe to retry.
        resp = await self.client.confirm_transaction(
            sig, commitment=Confirmed, last_valid_block_height=latest.last_valid_block_height
        )
        status = resp.value[0]
        # Preflight passed but the tx failed on-chain (e.g. a race for the last payout slot).
        if status is not None and status.err is not None:
            raise _program_error(str(status.err))
        return sig

    # Oracle instructions ----------------------------------------------------------------------------

    async def report_sighting(
        self, oracle: Keypair, event: Pubkey, attendee: Pubkey, ev: Event | None = None
    ) -> Signature:
        """Report "`oracle` sees `attendee` now"; the program pays once its rules hold. Raises
        PresenceError("NoEvent") when there is no such Event, PresenceError("NotOracle") when `oracle` is not one of
        the event's oracles, and the program's errors (NotStarted, Ended, CapReached, ...). A report for a wallet
        already paid is a successful no-op. Pass `ev` when the caller has just read the event, to save an RPC call."""
        if ev is None:
            ev = await self.get_event(event)
        if ev is None or ev.address != event:
            raise PresenceError("NoEvent", f"no presence_pay Event at {event}")
        if oracle.pubkey() not in ev.oracles:
            raise PresenceError("NotOracle", f"{oracle.pubkey()} is not one of the event's oracles")
        return await self._send([report_sighting_ix(oracle.pubkey(), ev, attendee)], oracle)

    async def close_sightings(self, payer: Keypair, event: Pubkey, attendees: list[Pubkey]) -> list[Signature]:
        """After the event's end: close Sightings whose rent `payer` paid (rent back to it), 10 per transaction."""
        sigs = []
        for i in range(0, len(attendees), 10):
            ixs = [close_sighting_ix(payer.pubkey(), event, a) for a in attendees[i : i + 10]]
            sigs.append(await self._send(ixs, payer))
        return sigs

    # Organizer instructions (signed by the organizer's wallet in the web app; here for tests and demos)

    async def create_event(
        self,
        organizer: Keypair,
        event_id: int,
        oracles: list[Pubkey],
        threshold: int,
        start: int,
        end: int,
        reward: int,
        max_paid: int,
        min_seen_secs: int,
    ) -> tuple[Pubkey, Signature]:
        """Create and fund an Event whose sightings only `oracles` can report; the program pays once `threshold`
        of them reported a wallet for `min_seen_secs`. Treasury and fee come from Config."""
        event = event_pda(organizer.pubkey(), event_id)
        ix = create_event_ix(
            organizer.pubkey(), event_id, oracles, threshold, start, end, reward, max_paid, min_seen_secs
        )
        return event, await self._send([ix], organizer)

    async def withdraw_remaining(self, organizer: Keypair, event: Pubkey) -> Signature:
        return await self._send([withdraw_remaining_ix(organizer.pubkey(), event)], organizer)

    # Admin instructions -----------------------------------------------------------------------------

    async def init_config(self, admin: Keypair, treasury: Pubkey, fee: int) -> Signature:
        return await self._send([init_config_ix(admin.pubkey(), treasury, fee)], admin)

    async def update_config(self, admin: Keypair, treasury: Pubkey, fee: int) -> Signature:
        """Change the treasury/fee for events created from now on; existing events keep theirs."""
        ix = Instruction(
            PROGRAM_ID,
            _disc("global", "update_config") + bytes(treasury) + struct.pack("<Q", fee),
            [
                AccountMeta(admin.pubkey(), is_signer=True, is_writable=False),
                AccountMeta(config_pda(), is_signer=False, is_writable=True),
            ],
        )
        return await self._send([ix], admin)

    async def transfer_sol(self, sender: Keypair, to: Pubkey, lamports: int) -> Signature:
        ix = transfer(TransferParams(from_pubkey=sender.pubkey(), to_pubkey=to, lamports=lamports))
        return await self._send([ix], sender)
