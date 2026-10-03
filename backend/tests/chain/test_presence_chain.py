"""Account decoding and instruction building of the presence_pay client, offline."""

import asyncio
import hashlib
import struct

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import ID as SYSTEM_PROGRAM_ID

from app.chain.presence_chain import (
    EVENT_ORACLE_OFFSET,
    PROGRAM_ID,
    Config,
    Event,
    PresenceChain,
    PresenceError,
    close_receipt_ix,
    config_pda,
    create_event_ix,
    event_pda,
    pay_attendee_ix,
    receipt_pda,
)

ADDRESS = Keypair().pubkey()
ORGANIZER = Keypair().pubkey()
ORACLE = Keypair().pubkey()
TREASURY = Keypair().pubkey()
ATTENDEE = Keypair().pubkey()


def disc(namespace: str, name: str) -> bytes:
    return hashlib.sha256(f"{namespace}:{name}".encode()).digest()[:8]


def event_bytes() -> bytes:
    # lib.rs order: organizer, oracle, treasury, event_id, start, end, reward, fee, max_paid, paid_count,
    # min_seen_secs, bump
    return disc("account", "Event") + (
        bytes(ORGANIZER) + bytes(ORACLE) + bytes(TREASURY)
        + struct.pack("<QqqQQIIIB", 7, 1_000, 2_000, 10_000_000, 2_000_000, 3, 1, 5, 254)
    )


def test_event_decode_reads_oracle_and_treasury_after_organizer():
    data = event_bytes()
    assert len(data) == 8 + 32 * 3 + 8 * 5 + 4 * 3 + 1
    assert data[EVENT_ORACLE_OFFSET : EVENT_ORACLE_OFFSET + 32] == bytes(ORACLE)
    ev = Event.decode(ADDRESS, data, balance=123)
    assert (ev.address, ev.organizer, ev.oracle, ev.treasury) == (ADDRESS, ORGANIZER, ORACLE, TREASURY)
    assert (ev.event_id, ev.start, ev.end) == (7, 1_000, 2_000)
    assert (ev.reward, ev.fee, ev.max_paid, ev.paid_count, ev.min_seen_secs, ev.balance) == (
        10_000_000, 2_000_000, 3, 1, 5, 123,
    )


@pytest.mark.parametrize("data", [b"", event_bytes()[:-1], disc("account", "Config") + event_bytes()[8:]])
def test_event_decode_rejects_short_or_foreign_data(data):
    with pytest.raises(ValueError):
        Event.decode(ADDRESS, data, 0)


def test_config_decode_has_no_oracle():
    admin = Keypair().pubkey()
    data = disc("account", "Config") + bytes(admin) + bytes(TREASURY) + struct.pack("<QB", 2_000_000, 255)
    assert Config.decode(data) == Config(admin=admin, treasury=TREASURY, fee=2_000_000)


def sample_event() -> Event:
    return Event.decode(ADDRESS, event_bytes(), 0)


def test_pay_attendee_ix_has_no_config_and_uses_the_events_treasury():
    ix = pay_attendee_ix(ORACLE, sample_event(), ATTENDEE)
    assert ix.program_id == PROGRAM_ID
    assert bytes(ix.data) == disc("global", "pay_attendee")
    keys = [m.pubkey for m in ix.accounts]
    assert keys == [ORACLE, ADDRESS, receipt_pda(ADDRESS, ATTENDEE), ATTENDEE, TREASURY, SYSTEM_PROGRAM_ID]
    assert config_pda() not in keys
    assert [m.is_signer for m in ix.accounts] == [True, False, False, False, False, False]
    assert [m.is_writable for m in ix.accounts] == [True, True, True, True, True, False]


def test_close_receipt_ix_has_no_config():
    ix = close_receipt_ix(ORACLE, ADDRESS, ATTENDEE)
    assert [m.pubkey for m in ix.accounts] == [ORACLE, receipt_pda(ADDRESS, ATTENDEE)]


def test_create_event_ix_puts_the_oracle_after_event_id():
    ix = create_event_ix(ORGANIZER, 7, ORACLE, 1_000, 2_000, 10_000_000, 3, 5)
    data = bytes(ix.data)
    assert data[:8] == disc("global", "create_event")
    assert struct.unpack_from("<Q", data, 8) == (7,)
    assert data[16:48] == bytes(ORACLE)
    assert struct.unpack_from("<qqQII", data, 48) == (1_000, 2_000, 10_000_000, 3, 5)
    assert len(data) == 48 + 8 + 8 + 8 + 4 + 4
    assert [m.pubkey for m in ix.accounts] == [ORGANIZER, config_pda(), event_pda(ORGANIZER, 7), SYSTEM_PROGRAM_ID]


class OfflineChain(PresenceChain):
    """PresenceChain with reads faked and sending recorded, so pay_attendee's own checks run offline."""

    def __init__(self, ev: Event | None) -> None:  # no AsyncClient
        self.ev = ev
        self.sent: list = []

    async def is_paid(self, event: Pubkey, attendee: Pubkey) -> bool:
        return False

    async def get_event(self, event: Pubkey) -> Event | None:
        return self.ev

    async def _send(self, ixs, payer, *signers):
        self.sent.append(ixs)
        return "sig"


def test_pay_attendee_refuses_an_event_of_another_oracle():
    chain = OfflineChain(sample_event())  # its oracle is ORACLE, not this keypair
    with pytest.raises(PresenceError) as e:
        asyncio.run(chain.pay_attendee(Keypair(), ADDRESS, ATTENDEE))
    assert e.value.code == "Unauthorized" and chain.sent == []


def test_pay_attendee_without_event_is_noevent():
    chain = OfflineChain(None)
    with pytest.raises(PresenceError) as e:
        asyncio.run(chain.pay_attendee(Keypair(), ADDRESS, ATTENDEE))
    assert e.value.code == "NoEvent" and chain.sent == []


def test_pay_attendee_sends_with_the_events_treasury():
    oracle = Keypair()
    ev = Event.decode(ADDRESS, event_bytes(), 0)
    ev.oracle = oracle.pubkey()
    chain = OfflineChain(ev)
    asyncio.run(chain.pay_attendee(oracle, ADDRESS, ATTENDEE))
    (ixs,) = chain.sent
    assert ixs[0].accounts[4].pubkey == TREASURY
