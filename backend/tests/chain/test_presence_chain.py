"""Account decoding and instruction building of the on_sight client, offline."""

import asyncio
import base64
import hashlib
import struct

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import ID as SYSTEM_PROGRAM_ID
from solders.sysvar import INSTRUCTIONS as INSTRUCTIONS_SYSVAR

from app.chain.presence_chain import (
    EVENT_NAME_OFFSET,
    EVENT_ORACLES_OFFSET,
    FEE_LAMPORTS,
    PROGRAM_ERRORS,
    PROGRAM_ID,
    Attendance,
    Event,
    OracleInfo,
    PresenceChain,
    PresenceError,
    _program_error,
    attendance_pda,
    attendee_paid,
    close_attendance_ix,
    create_event_ix,
    ed25519_verify_ix,
    event_pda,
    oracle_info_pda,
    register_oracle_ix,
    report_sighting_ix,
    report_sighting_ixs,
)
from app.oracle.signatures import JoinProof, build_message

ADDRESS = Keypair().pubkey()
ORGANIZER = Keypair().pubkey()
ORACLE = Keypair().pubkey()
ORACLE2 = Keypair().pubkey()
ATTENDEE_KP = Keypair()
ATTENDEE = ATTENDEE_KP.pubkey()
ED25519_PROGRAM = Pubkey.from_string("Ed25519SigVerify111111111111111111111111111")
SYSVAR_INSTRUCTIONS = Pubkey.from_string("Sysvar1nstructions1111111111111111111111111")


def signed_join(event: Pubkey, kp: Keypair) -> JoinProof:
    """A join as the widget signs it (same as tests/oracle/fakes.signed_join, which this package cannot import)."""
    message = build_message("join", str(event), str(kp.pubkey()), "2026-10-03T12:00:00Z", "2026-10-03").encode()
    return JoinProof(message=message, signature=bytes(kp.sign_message(message)))


PROOF = signed_join(ADDRESS, ATTENDEE_KP)


def disc(namespace: str, name: str) -> bytes:
    return hashlib.sha256(f"{namespace}:{name}".encode()).digest()[:8]


FIXED_EVENT_LEN = 8 + 32 + 96 + 2 + 8 * 5 + 4 * 3 + 1
EVENT_ACCOUNT_LEN = FIXED_EVENT_LEN + (4 + 64) * 2  # 8 + Event::INIT_SPACE: both strings at their max length


def borsh(text: str) -> bytes:
    raw = text.encode()
    return struct.pack("<I", len(raw)) + raw


def event_bytes(
    oracles: list[Pubkey] | None = None, threshold: int = 1, name: str = "HackYeah 2026", venue: str = "Kraków",
    pad: bool = True,
) -> bytes:
    # lib.rs order: organizer, oracles[3], oracle_count, threshold, event_id, start, end, reward, fee, max_paid,
    # paid_count, min_seen_secs, bump, name, venue; the account is allocated for the max lengths, the tail is zeros.
    oracles = [ORACLE, ORACLE2] if oracles is None else oracles
    slots = b"".join(bytes(o) for o in oracles) + bytes(32) * (3 - len(oracles))
    raw = disc("account", "Event") + (
        bytes(ORGANIZER) + slots + bytes([len(oracles), threshold])
        + struct.pack("<QqqQQIIIB", 7, 1_000, 2_000, 10_000_000, 2_000_000, 3, 1, 5, 254)
        + borsh(name) + borsh(venue)
    )
    return raw + bytes(EVENT_ACCOUNT_LEN - len(raw)) if pad else raw


def test_event_decode_reads_oracle_slots_threshold_and_fee():
    data = event_bytes(threshold=2)
    assert len(data) == EVENT_ACCOUNT_LEN == 8 + 183 + 136
    assert EVENT_NAME_OFFSET == FIXED_EVENT_LEN
    assert data[EVENT_ORACLES_OFFSET : EVENT_ORACLES_OFFSET + 32] == bytes(ORACLE)
    assert data[EVENT_ORACLES_OFFSET + 32 : EVENT_ORACLES_OFFSET + 64] == bytes(ORACLE2)
    ev = Event.decode(ADDRESS, data, balance=123)
    assert (ev.address, ev.organizer) == (ADDRESS, ORGANIZER)
    assert ev.oracles == [ORACLE, ORACLE2] and ev.threshold == 2  # unused slot 3 is not listed
    assert (ev.event_id, ev.start, ev.end) == (7, 1_000, 2_000)
    assert (ev.reward, ev.fee, ev.max_paid, ev.paid_count, ev.min_seen_secs, ev.balance) == (
        10_000_000, 2_000_000, 3, 1, 5, 123,
    )
    assert (ev.name, ev.venue) == ("HackYeah 2026", "Kraków")


@pytest.mark.parametrize(
    ("name", "venue"),
    [("HackYeah 2026", "Kraków"), ("x", ""), ("Zażółć gęślą jaźń", "Łódź, ul. Piotrkowska 1"), ("n" * 64, "v" * 64),
     ("ą" * 32, "ś" * 32)],
)
def test_event_decode_reads_name_and_venue_from_their_length_prefixes(name, venue):
    for pad in (True, False):  # zero padding after short strings, or an exact-length account
        ev = Event.decode(ADDRESS, event_bytes(name=name, venue=venue, pad=pad), 0)
        assert (ev.name, ev.venue) == (name, venue)
        assert (ev.event_id, ev.min_seen_secs) == (7, 5)  # fixed fields unaffected


def _with_tail(tail: bytes) -> bytes:
    return event_bytes(pad=False)[:FIXED_EVENT_LEN] + tail


@pytest.mark.parametrize(
    "data",
    [
        b"",
        event_bytes(pad=False)[:FIXED_EVENT_LEN - 1],
        disc("account", "Config") + event_bytes()[8:],
        event_bytes(oracles=[]),
        _with_tail(b""),  # no name at all
        _with_tail(struct.pack("<I", 65) + b"x" * 65 + borsh("") + bytes(200)),  # name > 64 bytes
        _with_tail(borsh("x") + struct.pack("<I", 65) + b"v" * 65 + bytes(200)),  # venue > 64 bytes
        _with_tail(borsh("x") + struct.pack("<I", 5) + b"ab"),  # venue truncated
        _with_tail(struct.pack("<I", 2) + b"\xff\xfe" + borsh("") + bytes(200)),  # bad UTF-8
    ],
)
def test_event_decode_rejects_short_foreign_or_oracleless_data(data):
    with pytest.raises(ValueError):
        Event.decode(ADDRESS, data, 0)


def test_attendance_decode():
    payer = Keypair().pubkey()
    data = disc("account", "Attendance") + struct.pack("<qqB?", 1_000, 1_003, 0b11, True) + bytes(payer) + struct.pack(
        "<qB", 2_000, 253
    )
    assert Attendance.decode(data) == Attendance(1_000, 1_003, 3, True, payer, 2_000)
    with pytest.raises(ValueError):
        Attendance.decode(data[:-1])
    with pytest.raises(ValueError):  # the pre-rename discriminator is not an Attendance
        Attendance.decode(disc("account", "Sighting") + data[8:])


def test_fee_constant_mirrors_lib_rs():
    assert FEE_LAMPORTS == 2_000_000


def sample_event() -> Event:
    return Event.decode(ADDRESS, event_bytes(), 0)


def test_report_sighting_ix_accounts_in_lib_rs_order():
    ix = report_sighting_ix(ORACLE, sample_event(), ATTENDEE)
    assert ix.program_id == PROGRAM_ID
    assert bytes(ix.data) == disc("global", "report_sighting")
    keys = [m.pubkey for m in ix.accounts]
    assert keys == [ORACLE, ADDRESS, attendance_pda(ADDRESS, ATTENDEE), ATTENDEE, SYSTEM_PROGRAM_ID, SYSVAR_INSTRUCTIONS]
    assert [m.is_signer for m in ix.accounts] == [True, False, False, False, False, False]
    assert [m.is_writable for m in ix.accounts] == [True, True, True, True, False, False]


def test_attendance_pda_seeds():
    expected = Pubkey.find_program_address([b"attendance", bytes(ADDRESS), bytes(ATTENDEE)], PROGRAM_ID)[0]
    assert attendance_pda(ADDRESS, ATTENDEE) == expected


def test_close_attendance_ix():
    ix = close_attendance_ix(ORACLE, ADDRESS, ATTENDEE)
    assert bytes(ix.data) == disc("global", "close_attendance")
    assert [m.pubkey for m in ix.accounts] == [ORACLE, attendance_pda(ADDRESS, ATTENDEE)]
    assert [m.is_signer for m in ix.accounts] == [True, False]


def test_create_event_ix_borsh_layout():
    ix = create_event_ix(ORGANIZER, 7, [ORACLE, ORACLE2], 2, 1_000, 2_000, 10_000_000, 3, 5, "HackYeah", "Kraków")
    data = bytes(ix.data)
    assert data[:8] == disc("global", "create_event")
    assert struct.unpack_from("<QI", data, 8) == (7, 2)  # event_id, Vec length
    assert data[20:52] == bytes(ORACLE) and data[52:84] == bytes(ORACLE2)
    assert struct.unpack_from("<BqqQII", data, 84) == (2, 1_000, 2_000, 10_000_000, 3, 5)
    strings = 84 + 1 + 8 + 8 + 8 + 4 + 4
    # name and venue are the last two args: Borsh Strings, length in BYTES ("Kraków" is 7 bytes, 6 characters)
    assert data[strings:] == struct.pack("<I", 8) + b"HackYeah" + struct.pack("<I", 7) + "Kraków".encode()
    assert [m.pubkey for m in ix.accounts] == [ORGANIZER, event_pda(ORGANIZER, 7), SYSTEM_PROGRAM_ID]


def test_program_error_codes_are_appended():
    # lib.rs PresenceError in declaration order (AlreadyStarted was removed with update_event_times).
    assert PROGRAM_ERRORS == [
        "BadTimes", "BadAmounts", "Overflow", "NotStarted", "Ended", "CapReached", "EventRunning",
        "BadOracles", "BadThreshold", "NotOracle", "BadName", "BadUrl", "BadJoinProof", "BadEventText",
    ]
    assert _program_error("Custom(6013)").code == "BadEventText"
    assert _program_error("custom program error: 0x177d").code == "BadEventText"  # 0x177d = 6013
    assert _program_error("Custom(6012)").code == "BadJoinProof"
    assert _program_error("custom program error: 0x177c").code == "BadJoinProof"  # 0x177c = 6012
    assert _program_error("Program log: AnchorError ... Error Code: BadJoinProof. Error Number: 6012.").code == (
        "BadJoinProof"
    )
    assert _program_error("Custom(6011)").code == "BadUrl"
    assert _program_error("custom program error: 0x1775").code == "CapReached"  # 0x1775 = 6005
    assert _program_error("Custom(6009)").code == "NotOracle"
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
        asyncio.run(chain.report_sighting(Keypair(), ADDRESS, ATTENDEE, PROOF))
    assert e.value.code == "NotOracle" and chain.sent == []


def test_report_sighting_without_event_is_noevent():
    chain = OfflineChain(None)
    with pytest.raises(PresenceError) as e:
        asyncio.run(chain.report_sighting(Keypair(), ADDRESS, ATTENDEE, PROOF))
    assert e.value.code == "NoEvent" and chain.sent == []


def test_report_sighting_from_any_listed_oracle_is_signed_by_that_oracle():
    oracle = Keypair()
    ev = Event.decode(ADDRESS, event_bytes(oracles=[ORACLE, oracle.pubkey()], threshold=2), 0)
    chain = OfflineChain(ev)
    asyncio.run(chain.report_sighting(oracle, ADDRESS, ATTENDEE, PROOF))
    (ixs,) = chain.sent
    assert ixs[1].accounts[0].pubkey == oracle.pubkey()
    assert [m.pubkey for m in ixs[1].accounts].count(oracle.pubkey()) == 1  # the fee goes to the signer, no treasury


def check_ed25519_layout(ix, signer: Pubkey, proof: JoinProof) -> None:
    assert ix.program_id == ED25519_PROGRAM and list(ix.accounts) == []
    data = bytes(ix.data)
    assert data[:2] == bytes([1, 0])
    assert struct.unpack_from("<7H", data, 2) == (48, 0xFFFF, 16, 0xFFFF, 112, len(proof.message), 0xFFFF)
    assert data[16:48] == bytes(signer)
    assert data[48:112] == proof.signature
    assert data[112:] == proof.message
    assert len(data) == 112 + len(proof.message)


def test_report_sighting_sends_ed25519_check_then_report():
    oracle = Keypair()
    ev = Event.decode(ADDRESS, event_bytes(oracles=[oracle.pubkey()]), 0)
    chain = OfflineChain(ev)
    asyncio.run(chain.report_sighting(oracle, ADDRESS, ATTENDEE, PROOF))
    (ixs,) = chain.sent
    assert len(ixs) == 2
    check_ed25519_layout(ixs[0], ATTENDEE, PROOF)
    assert ixs[1] == report_sighting_ix(oracle.pubkey(), ev, ATTENDEE)
    assert ixs == report_sighting_ixs(oracle.pubkey(), ev, ATTENDEE, PROOF)


def test_report_ix_ends_with_the_read_only_instructions_sysvar():
    last = report_sighting_ix(ORACLE, sample_event(), ATTENDEE).accounts[-1]
    assert last.pubkey == SYSVAR_INSTRUCTIONS == INSTRUCTIONS_SYSVAR
    assert (last.is_signer, last.is_writable) == (False, False)


def test_ed25519_verify_ix_layout_and_signature_actually_verifies():
    ix = ed25519_verify_ix(ATTENDEE, PROOF.signature, PROOF.message)
    check_ed25519_layout(ix, ATTENDEE, PROOF)
    assert PROOF.valid_for(str(ADDRESS), str(ATTENDEE))


@pytest.mark.parametrize("sig", [b"", bytes(63), bytes(65)])
def test_ed25519_verify_ix_rejects_a_non_64_byte_signature(sig):
    with pytest.raises(ValueError):
        ed25519_verify_ix(ATTENDEE, sig, PROOF.message)


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
        disc("account", "Attendance") + bytes(200),  # another account type
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
    other = Keypair().pubkey()
    assert register_oracle_ix(ORACLE, "x", "https://a.example", info=other).accounts[1].pubkey == other


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
