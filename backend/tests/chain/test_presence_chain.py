"""Account decoding and instruction building of the presence_pay client, offline."""

import asyncio
import base64
import hashlib
import struct

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import ID as SYSTEM_PROGRAM_ID

from app.chain.presence_chain import (
    EVENT_ORACLES_OFFSET,
    PROGRAM_ERRORS,
    PROGRAM_ID,
    Config,
    Event,
    OracleInfo,
    PresenceChain,
    PresenceError,
    Sighting,
    _program_error,
    attendee_paid,
    close_oracle_ix,
    close_sighting_ix,
    config_pda,
    create_event_ix,
    event_pda,
    oracle_info_pda,
    register_oracle_ix,
    report_sighting_ix,
    sighting_pda,
    update_oracle_ix,
)

ADDRESS = Keypair().pubkey()
ORGANIZER = Keypair().pubkey()
ORACLE = Keypair().pubkey()
ORACLE2 = Keypair().pubkey()
TREASURY = Keypair().pubkey()
ATTENDEE = Keypair().pubkey()


def disc(namespace: str, name: str) -> bytes:
    return hashlib.sha256(f"{namespace}:{name}".encode()).digest()[:8]


def event_bytes(oracles: list[Pubkey] | None = None, threshold: int = 1) -> bytes:
    # lib.rs order: organizer, oracles[3], oracle_count, threshold, treasury, event_id, start, end, reward, fee,
    # max_paid, paid_count, min_seen_secs, bump
    oracles = [ORACLE, ORACLE2] if oracles is None else oracles
    slots = b"".join(bytes(o) for o in oracles) + bytes(32) * (3 - len(oracles))
    return disc("account", "Event") + (
        bytes(ORGANIZER) + slots + bytes([len(oracles), threshold]) + bytes(TREASURY)
        + struct.pack("<QqqQQIIIB", 7, 1_000, 2_000, 10_000_000, 2_000_000, 3, 1, 5, 254)
    )


def test_event_decode_reads_oracle_slots_threshold_and_treasury():
    data = event_bytes(threshold=2)
    assert len(data) == 8 + 32 + 96 + 2 + 32 + 8 * 5 + 4 * 3 + 1
    assert data[EVENT_ORACLES_OFFSET : EVENT_ORACLES_OFFSET + 32] == bytes(ORACLE)
    assert data[EVENT_ORACLES_OFFSET + 32 : EVENT_ORACLES_OFFSET + 64] == bytes(ORACLE2)
    ev = Event.decode(ADDRESS, data, balance=123)
    assert (ev.address, ev.organizer, ev.treasury) == (ADDRESS, ORGANIZER, TREASURY)
    assert ev.oracles == [ORACLE, ORACLE2] and ev.threshold == 2  # unused slot 3 is not listed
    assert (ev.event_id, ev.start, ev.end) == (7, 1_000, 2_000)
    assert (ev.reward, ev.fee, ev.max_paid, ev.paid_count, ev.min_seen_secs, ev.balance) == (
        10_000_000, 2_000_000, 3, 1, 5, 123,
    )


@pytest.mark.parametrize(
    "data",
    [b"", event_bytes()[:-1], disc("account", "Config") + event_bytes()[8:], event_bytes(oracles=[])],
)
def test_event_decode_rejects_short_foreign_or_oracleless_data(data):
    with pytest.raises(ValueError):
        Event.decode(ADDRESS, data, 0)


def test_sighting_decode():
    payer = Keypair().pubkey()
    data = disc("account", "Sighting") + struct.pack("<qqB?", 1_000, 1_003, 0b11, True) + bytes(payer) + struct.pack(
        "<qB", 2_000, 253
    )
    assert Sighting.decode(data) == Sighting(1_000, 1_003, 3, True, payer, 2_000)
    with pytest.raises(ValueError):
        Sighting.decode(data[:-1])


def test_config_decode_has_no_oracle():
    admin = Keypair().pubkey()
    data = disc("account", "Config") + bytes(admin) + bytes(TREASURY) + struct.pack("<QB", 2_000_000, 255)
    assert Config.decode(data) == Config(admin=admin, treasury=TREASURY, fee=2_000_000)


def sample_event() -> Event:
    return Event.decode(ADDRESS, event_bytes(), 0)


def test_report_sighting_ix_accounts_in_lib_rs_order():
    ix = report_sighting_ix(ORACLE, sample_event(), ATTENDEE)
    assert ix.program_id == PROGRAM_ID
    assert bytes(ix.data) == disc("global", "report_sighting")
    keys = [m.pubkey for m in ix.accounts]
    assert keys == [ORACLE, ADDRESS, sighting_pda(ADDRESS, ATTENDEE), ATTENDEE, TREASURY, SYSTEM_PROGRAM_ID]
    assert config_pda() not in keys
    assert [m.is_signer for m in ix.accounts] == [True, False, False, False, False, False]
    assert [m.is_writable for m in ix.accounts] == [True, True, True, True, True, False]


def test_sighting_pda_seeds():
    expected = Pubkey.find_program_address([b"sighting", bytes(ADDRESS), bytes(ATTENDEE)], PROGRAM_ID)[0]
    assert sighting_pda(ADDRESS, ATTENDEE) == expected


def test_close_sighting_ix():
    ix = close_sighting_ix(ORACLE, ADDRESS, ATTENDEE)
    assert bytes(ix.data) == disc("global", "close_sighting")
    assert [m.pubkey for m in ix.accounts] == [ORACLE, sighting_pda(ADDRESS, ATTENDEE)]
    assert [m.is_signer for m in ix.accounts] == [True, False]


def test_create_event_ix_borsh_layout():
    ix = create_event_ix(ORGANIZER, 7, [ORACLE, ORACLE2], 2, 1_000, 2_000, 10_000_000, 3, 5)
    data = bytes(ix.data)
    assert data[:8] == disc("global", "create_event")
    assert struct.unpack_from("<QI", data, 8) == (7, 2)  # event_id, Vec length
    assert data[20:52] == bytes(ORACLE) and data[52:84] == bytes(ORACLE2)
    assert struct.unpack_from("<BqqQII", data, 84) == (2, 1_000, 2_000, 10_000_000, 3, 5)
    assert len(data) == 84 + 1 + 8 + 8 + 8 + 4 + 4
    assert [m.pubkey for m in ix.accounts] == [ORGANIZER, config_pda(), event_pda(ORGANIZER, 7), SYSTEM_PROGRAM_ID]


def test_program_error_codes_are_appended():
    assert PROGRAM_ERRORS[6] == "CapReached"
    assert PROGRAM_ERRORS[8:] == ["BadOracles", "BadThreshold", "NotOracle", "BadName", "BadUrl"]
    assert _program_error("Custom(6012)").code == "BadUrl"
    assert _program_error("custom program error: 0x1776").code == "CapReached"  # 0x1776 = 6006
    assert _program_error("Custom(6010)").code == "NotOracle"
    assert _program_error("Error Code: ConstraintHasOne").code == "Unauthorized"
    assert _program_error("something else").code == "TransactionFailed"


def test_attendee_paid_matches_the_event_log_of_this_wallet_only():
    payload = disc("event", "AttendeePaid") + bytes(ADDRESS) + bytes(ATTENDEE) + struct.pack("<Q", 10_000_000)
    logs = ["Program log: Instruction: ReportSighting", "Program data: " + base64.b64encode(payload).decode()]
    assert attendee_paid(logs, ADDRESS, ATTENDEE)
    assert not attendee_paid(logs, ADDRESS, Keypair().pubkey())
    assert not attendee_paid(["Program log: Instruction: ReportSighting"], ADDRESS, ATTENDEE)
    assert not attendee_paid(None, ADDRESS, ATTENDEE)


class OfflineChain(PresenceChain):
    """PresenceChain with reads faked and sending recorded, so report_sighting's own checks run offline."""

    def __init__(self, ev: Event | None) -> None:  # no AsyncClient
        self.ev = ev
        self.sent: list = []

    async def get_event(self, event: Pubkey) -> Event | None:
        return self.ev

    async def _send(self, ixs, payer, *signers):
        self.sent.append(ixs)
        return "sig"


def test_report_sighting_refuses_an_event_that_does_not_list_the_oracle():
    chain = OfflineChain(sample_event())  # its oracles are ORACLE and ORACLE2, not this keypair
    with pytest.raises(PresenceError) as e:
        asyncio.run(chain.report_sighting(Keypair(), ADDRESS, ATTENDEE))
    assert e.value.code == "NotOracle" and chain.sent == []


def test_report_sighting_without_event_is_noevent():
    chain = OfflineChain(None)
    with pytest.raises(PresenceError) as e:
        asyncio.run(chain.report_sighting(Keypair(), ADDRESS, ATTENDEE))
    assert e.value.code == "NoEvent" and chain.sent == []


def test_report_sighting_from_any_listed_oracle_uses_the_events_treasury():
    oracle = Keypair()
    ev = Event.decode(ADDRESS, event_bytes(oracles=[ORACLE, oracle.pubkey()], threshold=2), 0)
    chain = OfflineChain(ev)
    asyncio.run(chain.report_sighting(oracle, ADDRESS, ATTENDEE))
    (ixs,) = chain.sent
    assert ixs[0].accounts[0].pubkey == oracle.pubkey() and ixs[0].accounts[4].pubkey == TREASURY


# Oracle registry ----------------------------------------------------------------------------------


def oracle_info_bytes(oracle: Pubkey, name: str, url: str, pad_to: int = 8 + 32 + 4 + 32 + 4 + 128 + 1) -> bytes:
    # lib.rs: oracle, name (Borsh String), url (Borsh String), bump; the account is sized for the max lengths and the
    # tail is zero padding.
    raw = (
        disc("account", "OracleInfo") + bytes(oracle)
        + struct.pack("<I", len(name.encode())) + name.encode()
        + struct.pack("<I", len(url.encode())) + url.encode() + bytes([253])
    )
    return raw + bytes(pad_to - len(raw))


def test_oracle_info_decode_reads_padded_account_and_round_trips():
    data = oracle_info_bytes(ORACLE, "OnSight", "https://hackyeah.kindhome.io")
    info = OracleInfo.decode(data)
    assert info == OracleInfo(ORACLE, "OnSight", "https://hackyeah.kindhome.io")
    assert OracleInfo.decode(info.encode()) == info
    assert data.startswith(info.encode(bump=253))
    utf8 = OracleInfo(ORACLE, "Óracle łódź", "https://example.com/ścieżka")
    assert OracleInfo.decode(utf8.encode()) == utf8


@pytest.mark.parametrize(
    "data",
    [
        b"",
        disc("account", "Sighting") + bytes(200),  # another account type
        disc("account", "OracleInfo") + bytes(ORACLE) + struct.pack("<I", 33) + b"x" * 33 + bytes(200),  # name > 32
        disc("account", "OracleInfo") + bytes(ORACLE) + struct.pack("<I", 7) + b"OnSight",  # truncated before url
        disc("account", "OracleInfo") + bytes(ORACLE) + struct.pack("<I", 2) + b"\xff\xfe" + bytes(200),  # bad UTF-8
    ],
)
def test_oracle_info_decode_rejects_bad_data(data):
    with pytest.raises(ValueError):
        OracleInfo.decode(data)


def test_oracle_registry_instructions():
    info = oracle_info_pda(ORACLE)
    assert info == Pubkey.find_program_address([b"oracle", bytes(ORACLE)], PROGRAM_ID)[0]
    reg = register_oracle_ix(ORACLE, "OnSight", "https://a.example")
    assert reg.data == (
        disc("global", "register_oracle") + struct.pack("<I", 7) + b"OnSight" + struct.pack("<I", 17)
        + b"https://a.example"
    )
    assert [(m.pubkey, m.is_signer, m.is_writable) for m in reg.accounts] == [
        (ORACLE, True, True), (info, False, True), (SYSTEM_PROGRAM_ID, False, False)]
    upd = update_oracle_ix(ORACLE, "OnSight", "https://a.example")
    assert upd.data[:8] == disc("global", "update_oracle") and upd.data[8:] == reg.data[8:]
    assert [(m.pubkey, m.is_signer, m.is_writable) for m in upd.accounts] == [(ORACLE, True, False), (info, False, True)]
    close = close_oracle_ix(ORACLE)
    assert close.data == disc("global", "close_oracle")
    assert [(m.pubkey, m.is_signer, m.is_writable) for m in close.accounts] == [(ORACLE, True, True), (info, False, True)]


class _Acc:
    def __init__(self, data: bytes, owner: Pubkey = PROGRAM_ID) -> None:
        self.data, self.owner = data, owner


class _Resp:
    def __init__(self, value) -> None:
        self.value = value


class FakeRpc:
    def __init__(self, accounts: dict[Pubkey, _Acc]) -> None:
        self.accounts = accounts
        self.calls: list[list[Pubkey]] = []

    async def get_multiple_accounts(self, keys):
        self.calls.append(list(keys))
        return _Resp([self.accounts.get(k) for k in keys])


def test_get_oracle_infos_one_call_in_order_with_none_for_missing_or_foreign():
    a, b, c, d = (Keypair().pubkey() for _ in range(4))
    rpc = FakeRpc({
        oracle_info_pda(a): _Acc(oracle_info_bytes(a, "A", "https://a.example")),
        oracle_info_pda(c): _Acc(oracle_info_bytes(c, "C", "https://c.example"), owner=Keypair().pubkey()),
        oracle_info_pda(d): _Acc(oracle_info_bytes(a, "D", "https://d.example")),  # data claims another oracle
    })
    chain = PresenceChain.__new__(PresenceChain)
    chain.client = rpc
    infos = asyncio.run(chain.get_oracle_infos([a, b, c, d]))
    assert infos == [OracleInfo(a, "A", "https://a.example"), None, None, None]
    assert rpc.calls == [[oracle_info_pda(k) for k in (a, b, c, d)]]
    assert asyncio.run(chain.get_oracle_infos([])) == [] and len(rpc.calls) == 1
