"""Client for the presence_pay Solana program (contracts/presence_pay).

Instructions are built by hand (Anchor discriminator = sha256("global:<name>")[:8] + Borsh args), so no anchorpy.
Account layouts mirror contracts/presence_pay/lib.rs; changing them there means changing them here.
"""

from __future__ import annotations

import hashlib
import json
import struct
from dataclasses import dataclass
from pathlib import Path

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

# #[error_code] in lib.rs, numbered from 6000 by Anchor.
PROGRAM_ERRORS = [
    "BadTimes", "BadAmounts", "Overflow", "AlreadyStarted",
    "NotStarted", "Ended", "CapReached", "EventRunning",
]


def _disc(namespace: str, name: str) -> bytes:
    return hashlib.sha256(f"{namespace}:{name}".encode()).digest()[:8]


CONFIG_DISC = _disc("account", "Config")
EVENT_DISC = _disc("account", "Event")
RECEIPT_DISC = _disc("account", "Receipt")

_CONFIG_FMT = "<32s32s32sQB"
_EVENT_FMT = "<32sQqqQQIIIB"


def load_keypair(path: str | Path) -> Keypair:
    """A keypair file in solana-keygen / Playground format (JSON array of 64 numbers)."""
    return keypair_from_json(Path(path).expanduser().read_text())


def keypair_from_json(text: str) -> Keypair:
    return Keypair.from_bytes(bytes(json.loads(text)))


def explorer_tx(sig: Signature | str) -> str:
    return f"https://explorer.solana.com/tx/{sig}?cluster={CLUSTER}"


def explorer_address(addr: Pubkey | str) -> str:
    return f"https://explorer.solana.com/address/{addr}?cluster={CLUSTER}"


# PDAs -----------------------------------------------------------------------------------------------


def config_pda() -> Pubkey:
    return Pubkey.find_program_address([b"config"], PROGRAM_ID)[0]


def event_pda(organizer: Pubkey, event_id: int) -> Pubkey:
    return Pubkey.find_program_address([b"event", bytes(organizer), event_id.to_bytes(8, "little")], PROGRAM_ID)[0]


def receipt_pda(event: Pubkey, attendee: Pubkey) -> Pubkey:
    return Pubkey.find_program_address([b"paid", bytes(event), bytes(attendee)], PROGRAM_ID)[0]


# Account data ---------------------------------------------------------------------------------------


@dataclass
class Config:
    admin: Pubkey
    oracle: Pubkey
    treasury: Pubkey
    fee: int

    @classmethod
    def decode(cls, data: bytes) -> Config:
        if data[:8] != CONFIG_DISC:
            raise ValueError("not a Config account")
        admin, oracle, treasury, fee, _ = struct.unpack_from(_CONFIG_FMT, data, 8)
        return cls(Pubkey(admin), Pubkey(oracle), Pubkey(treasury), fee)


@dataclass
class Event:
    address: Pubkey
    organizer: Pubkey
    event_id: int
    start: int  # unix seconds
    end: int  # unix seconds
    reward: int  # lamports
    fee: int  # lamports, frozen at creation
    max_paid: int
    paid_count: int
    min_seen_secs: int
    balance: int  # lamports in the vault, account rent included

    @classmethod
    def decode(cls, address: Pubkey, data: bytes, balance: int) -> Event:
        if data[:8] != EVENT_DISC or len(data) < 8 + struct.calcsize(_EVENT_FMT):
            raise ValueError("not an Event account")
        org, eid, start, end, reward, fee, max_paid, paid, min_seen, _ = struct.unpack_from(_EVENT_FMT, data, 8)
        return cls(address, Pubkey(org), eid, start, end, reward, fee, max_paid, paid, min_seen, balance)


class PresenceError(Exception):
    """A program or transaction error with a readable code: AlreadyPaid, Unauthorized, NotStarted, Ended,
    CapReached, ... or TransactionFailed for anything unrecognised."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def _program_error(text: str) -> PresenceError:
    # A failed `init` of the Receipt (the System Program's AccountAlreadyInUse, custom error 0).
    if "already in use" in text or "Custom(0)" in text:
        return PresenceError("AlreadyPaid", "this wallet was already paid for this event")
    if "ConstraintHasOne" in text or "Custom(2001)" in text:
        return PresenceError("Unauthorized", "the signer is not the oracle/admin stored in Config")
    for i, name in enumerate(PROGRAM_ERRORS):
        code = 6000 + i
        if f"custom program error: {hex(code)}" in text or f"Custom({code})" in text or f"Error Code: {name}" in text:
            return PresenceError(name)
    return PresenceError("TransactionFailed", text)


# Client ---------------------------------------------------------------------------------------------


class PresenceChain:
    def __init__(self, rpc_url: str = RPC_URL) -> None:
        self.client = AsyncClient(rpc_url, commitment=Confirmed)

    async def close(self) -> None:
        await self.client.close()

    async def __aenter__(self) -> PresenceChain:
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

    async def list_events(self, organizer: Pubkey | None = None) -> list[Event]:
        filters: list = [MemcmpOpts(offset=0, bytes=base58.b58encode(EVENT_DISC).decode())]
        if organizer:
            filters.append(MemcmpOpts(offset=8, bytes=str(organizer)))
        resp = await self.client.get_program_accounts(PROGRAM_ID, encoding="base64", filters=filters)
        return [Event.decode(a.pubkey, bytes(a.account.data), a.account.lamports) for a in resp.value]

    async def is_paid(self, event: Pubkey, attendee: Pubkey) -> bool:
        return (await self.client.get_account_info(receipt_pda(event, attendee))).value is not None

    async def payout_tx(self, event: Pubkey, attendee: Pubkey) -> Signature | None:
        """The transaction that paid `attendee` for `event` (the one that created its Receipt), if any."""
        if not await self.is_paid(event, attendee):
            return None
        sigs = (await self.client.get_signatures_for_address(receipt_pda(event, attendee), limit=1000)).value
        ok = [s for s in sigs if s.err is None]
        return ok[-1].signature if ok else None  # newest first -> the oldest successful one is the payout

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

    async def pay_attendee(self, oracle: Keypair, event: Pubkey, attendee: Pubkey) -> Signature:
        """Pay `attendee` the event's reward. Raises PresenceError("AlreadyPaid") when already paid."""
        if await self.is_paid(event, attendee):
            raise PresenceError("AlreadyPaid", "this wallet was already paid for this event")
        cfg = await self.get_config()
        if cfg is None:
            raise PresenceError("TransactionFailed", "program Config not initialised")
        ix = Instruction(
            PROGRAM_ID,
            _disc("global", "pay_attendee"),
            [
                AccountMeta(oracle.pubkey(), is_signer=True, is_writable=True),
                AccountMeta(config_pda(), is_signer=False, is_writable=False),
                AccountMeta(event, is_signer=False, is_writable=True),
                AccountMeta(receipt_pda(event, attendee), is_signer=False, is_writable=True),
                AccountMeta(attendee, is_signer=False, is_writable=True),
                AccountMeta(cfg.treasury, is_signer=False, is_writable=True),
                AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
            ],
        )
        return await self._send([ix], oracle)

    async def close_receipts(self, oracle: Keypair, event: Pubkey, attendees: list[Pubkey]) -> list[Signature]:
        """After the event's end: close Receipts (rent back to the oracle), 10 per transaction."""
        sigs = []
        for i in range(0, len(attendees), 10):
            ixs = [
                Instruction(
                    PROGRAM_ID,
                    _disc("global", "close_receipt"),
                    [
                        AccountMeta(oracle.pubkey(), is_signer=True, is_writable=True),
                        AccountMeta(config_pda(), is_signer=False, is_writable=False),
                        AccountMeta(receipt_pda(event, a), is_signer=False, is_writable=True),
                    ],
                )
                for a in attendees[i : i + 10]
            ]
            sigs.append(await self._send(ixs, oracle))
        return sigs

    # Organizer instructions (signed by the organizer's wallet in the web app; here for tests and demos)

    async def create_event(
        self,
        organizer: Keypair,
        event_id: int,
        start: int,
        end: int,
        reward: int,
        max_paid: int,
        min_seen_secs: int,
    ) -> tuple[Pubkey, Signature]:
        event = event_pda(organizer.pubkey(), event_id)
        data = _disc("global", "create_event") + struct.pack("<QqqQII", event_id, start, end, reward, max_paid, min_seen_secs)
        ix = Instruction(
            PROGRAM_ID,
            data,
            [
                AccountMeta(organizer.pubkey(), is_signer=True, is_writable=True),
                AccountMeta(config_pda(), is_signer=False, is_writable=False),
                AccountMeta(event, is_signer=False, is_writable=True),
                AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
            ],
        )
        return event, await self._send([ix], organizer)

    async def withdraw_remaining(self, organizer: Keypair, event: Pubkey) -> Signature:
        ix = Instruction(
            PROGRAM_ID,
            _disc("global", "withdraw_remaining"),
            [
                AccountMeta(organizer.pubkey(), is_signer=True, is_writable=True),
                AccountMeta(event, is_signer=False, is_writable=True),
            ],
        )
        return await self._send([ix], organizer)

    # Admin instructions -----------------------------------------------------------------------------

    async def update_config(self, admin: Keypair, oracle: Pubkey, treasury: Pubkey, fee: int) -> Signature:
        ix = Instruction(
            PROGRAM_ID,
            _disc("global", "update_config") + bytes(oracle) + bytes(treasury) + struct.pack("<Q", fee),
            [
                AccountMeta(admin.pubkey(), is_signer=True, is_writable=False),
                AccountMeta(config_pda(), is_signer=False, is_writable=True),
            ],
        )
        return await self._send([ix], admin)

    async def transfer_sol(self, sender: Keypair, to: Pubkey, lamports: int) -> Signature:
        ix = transfer(TransferParams(from_pubkey=sender.pubkey(), to_pubkey=to, lamports=lamports))
        return await self._send([ix], sender)
