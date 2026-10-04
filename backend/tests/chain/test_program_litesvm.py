"""The compiled on_sight program (contracts/on_sight/lib.rs) run in LiteSVM, with the chain clock warped.

Skipped unless PRESENCE_SO points at a built on_sight.so (`cargo build-sbf` in an Anchor project with contracts/on_sight/lib.rs).
The program id is PRESENCE_SO_PROGRAM_ID, or else the pubkey of `on_sight-keypair.json` next to the .so; it must
equal the `declare_id!` the .so was built with. Instructions come from the backend client's own builders, so this
also checks that the client and the program agree on discriminators, Borsh layouts and account order.
"""

import json
import os
import struct
from pathlib import Path

import pytest
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer

from app.chain.presence_chain import (
    FEE_LAMPORTS,
    SIGHTING_GAP_SECS,
    Attendance,
    Event,
    OracleInfo,
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
    withdraw_remaining_ix,
)
from app.oracle.signatures import JoinProof, build_message

SO = os.environ.get("PRESENCE_SO", "")
pytestmark = pytest.mark.skipif(not SO or not Path(SO).is_file(), reason="PRESENCE_SO (a built on_sight.so) not set")

FEE = FEE_LAMPORTS  # frozen into every Event at creation
REWARD = 10_000_000
START = 1_000_000
END = START + 3_600
TX_FEE = 5_000  # LiteSVM's default fee per signature
REPORT_TX_FEE = 2 * TX_FEE  # a report pays for the oracle's signature and the ed25519-verified join signature


def signed_join(event: Pubkey, kp: Keypair, action: str = "join", wallet: Pubkey | None = None) -> JoinProof:
    """A proof as the widget makes it: `kp` signs the `action` message for `wallet` (default its own address)."""
    message = build_message(
        action, str(event), str(wallet or kp.pubkey()), "2026-10-03T12:00:00Z", "2026-10-03"
    ).encode()
    return JoinProof(message=message, signature=bytes(kp.sign_message(message)))


def _program_id() -> Pubkey:
    explicit = os.environ.get("PRESENCE_SO_PROGRAM_ID")
    if explicit:
        return Pubkey.from_string(explicit)
    kp_file = Path(SO).with_name("on_sight-keypair.json")
    return Keypair.from_bytes(bytes(json.loads(kp_file.read_text()))).pubkey()


class Chain:
    def __init__(self) -> None:
        from solders.litesvm import LiteSVM

        self.pid = _program_id()
        self.svm = LiteSVM()
        self.svm.add_program(self.pid, Path(SO).read_bytes())
        self.organizer, self.oracle, self.oracle2, self.outsider = (Keypair() for _ in range(4))
        for kp in (self.organizer, self.oracle, self.oracle2, self.outsider):
            self.svm.airdrop(kp.pubkey(), 100 * 10**9)
        self.attendees: dict[Pubkey, Keypair] = {}
        self.next_id = 1
        self.set_time(START - 100)

    # plumbing -------------------------------------------------------------------------------------

    def set_time(self, t: int) -> None:
        from solders.clock import Clock

        c = self.svm.get_clock()
        self.svm.set_clock(Clock(c.slot, c.epoch_start_timestamp, c.epoch, c.leader_schedule_epoch, t))

    def send(self, ixs, payer: Keypair, *signers: Keypair):
        from solders.transaction import Transaction

        self.svm.expire_blockhash()  # identical repeated transactions would otherwise be deduplicated
        tx = Transaction.new_signed_with_payer(ixs, payer.pubkey(), [payer, *signers], self.svm.latest_blockhash())
        return self.svm.send_transaction(tx)

    @staticmethod
    def ok(res):
        from solders.transaction_metadata import TransactionMetadata

        assert isinstance(res, TransactionMetadata), f"{res.err()}\n" + "\n".join(res.meta().logs())
        return res

    @staticmethod
    def code(res) -> str:
        from solders.transaction_metadata import FailedTransactionMetadata

        assert isinstance(res, FailedTransactionMetadata), "expected the transaction to fail"
        return _program_error(f"{res.err()}\n" + "\n".join(res.meta().logs())).code

    def balance(self, pk: Pubkey) -> int:
        acc = self.svm.get_account(pk)
        return acc.lamports if acc is not None else 0

    # program --------------------------------------------------------------------------------------

    def create_event(
        self, oracles=None, threshold=1, min_seen=3, max_paid=3, start=START, end=END, name="HackYeah 2026",
        venue="Kraków",
    ):
        oracles = [self.oracle.pubkey()] if oracles is None else oracles
        eid, self.next_id = self.next_id, self.next_id + 1
        ix = create_event_ix(
            self.organizer.pubkey(), eid, oracles, threshold, start, end, REWARD, max_paid, min_seen, name, venue,
            program_id=self.pid,
        )
        return self.send([ix], self.organizer), event_pda(self.organizer.pubkey(), eid, self.pid)

    def event(self, address: Pubkey) -> Event:
        acc = self.svm.get_account(address)
        return Event.decode(address, bytes(acc.data), acc.lamports)

    def attendee(self) -> Pubkey:
        """A new attendee wallet (unfunded, so its balance is exactly what the program paid it); its keypair is kept
        to sign the join message that every report carries."""
        kp = Keypair()
        self.attendees[kp.pubkey()] = kp
        return kp.pubkey()

    def report(
        self, event: Pubkey, attendee: Pubkey, at: int, oracle: Keypair | None = None, proof: JoinProof | None = None
    ):
        """report_sighting as the oracle sends it: the attendee's own signed join (or `proof`), then the report."""
        oracle = oracle or self.oracle
        proof = proof or signed_join(event, self.attendees[attendee])
        self.set_time(at)
        return self.send(report_sighting_ixs(oracle.pubkey(), self.event(event), attendee, proof, self.pid), oracle)

    def report_ix(self, event: Pubkey, attendee: Pubkey, oracle: Keypair | None = None):
        return report_sighting_ix((oracle or self.oracle).pubkey(), self.event(event), attendee, self.pid)

    def attendance(self, event: Pubkey, attendee: Pubkey) -> Attendance | None:
        acc = self.svm.get_account(attendance_pda(event, attendee, self.pid))
        return Attendance.decode(bytes(acc.data)) if acc is not None and acc.lamports > 0 else None


@pytest.fixture
def chain() -> Chain:
    return Chain()


def rent(chain: Chain, address: Pubkey) -> int:
    return chain.svm.minimum_balance_for_rent_exemption(len(chain.svm.get_account(address).data))


EVENT_ACCOUNT_LEN = 8 + 183 + 2 * (4 + 64)  # 8 + Event::INIT_SPACE: the strings are allocated at their max length


def test_create_event_funds_escrow_and_freezes_terms(chain):
    res, ev_addr = chain.create_event(oracles=[chain.oracle.pubkey(), chain.oracle2.pubkey()], threshold=2)
    chain.ok(res)
    ev = chain.event(ev_addr)
    assert ev.oracles == [chain.oracle.pubkey(), chain.oracle2.pubkey()] and ev.threshold == 2
    assert (ev.fee, ev.reward, ev.max_paid, ev.paid_count) == (FEE, REWARD, 3, 0)
    assert ev.balance == rent(chain, ev_addr) + 3 * (REWARD + FEE)
    assert (ev.name, ev.venue) == ("HackYeah 2026", "Kraków")


# Event name and venue ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "venue"),
    [
        ("HackYeah 2026", "Kraków"),
        ("Zażółć gęślą jaźń 🎉", "Tauron Arena, Kraków"),
        ("x", ""),  # an empty venue is fine
        ("n" * 64, "v" * 64),  # exactly 64 bytes each
        ("ą" * 32, "ś" * 32),  # 64 bytes, 32 characters
        ("a" * 62 + "ł", ""),  # 64 bytes with a trailing 2-byte character
    ],
)
def test_name_and_venue_are_stored_and_decoded(chain, name, venue):
    res, ev_addr = chain.create_event(name=name, venue=venue)
    chain.ok(res)
    ev = chain.event(ev_addr)
    assert (ev.name, ev.venue) == (name, venue)
    data = bytes(chain.svm.get_account(ev_addr).data)
    assert len(data) == EVENT_ACCOUNT_LEN  # fixed size whatever the text, zero padding after it
    assert data[8 + 183 + 4 + len(name.encode()) + 4 + len(venue.encode()) :] == bytes(
        128 - len(name.encode()) - len(venue.encode())
    )
    # fixed-size fields did not move
    assert (ev.organizer, ev.oracles, ev.reward, ev.max_paid) == (
        chain.organizer.pubkey(), [chain.oracle.pubkey()], REWARD, 3,
    )


@pytest.mark.parametrize(
    ("name", "venue"),
    [
        ("", "Kraków"),  # empty name
        ("n" * 65, ""),  # 65-byte name
        ("ą" * 32 + "a", ""),  # 65 bytes but 33 characters: the limit is in bytes
        ("HackYeah", "v" * 65),  # 65-byte venue
        ("Hack\nYeah", ""),  # control character in the name
        ("Hack\tYeah", ""),
        ("HackYeah", "Kra\x00ków"),  # control character in the venue
        ("HackYeah", "Kraków\x7f"),  # DEL
        ("HackYeah", "Kraków\u0085"),  # C1 control (NEL)
    ],
)
def test_bad_name_or_venue_is_bad_event_text_and_creates_nothing(chain, name, venue):
    before = chain.balance(chain.organizer.pubkey())
    res, ev_addr = chain.create_event(name=name, venue=venue)
    assert chain.code(res) == "BadEventText"
    assert chain.svm.get_account(ev_addr) is None or chain.balance(ev_addr) == 0
    assert chain.balance(chain.organizer.pubkey()) == before - TX_FEE  # no budget left the organizer


def test_event_account_size_and_rent(chain):
    res, ev_addr = chain.create_event()
    chain.ok(res)
    size = len(chain.svm.get_account(ev_addr).data)
    assert size == EVENT_ACCOUNT_LEN == 327
    assert rent(chain, ev_addr) == chain.svm.minimum_balance_for_rent_exemption(327)


@pytest.mark.parametrize(
    ("oracles", "threshold", "code"),
    [
        ("none", 1, "BadOracles"),
        ("four", 1, "BadOracles"),
        ("dup", 1, "BadOracles"),
        ("default", 1, "BadOracles"),
        ("one", 0, "BadThreshold"),
        ("two", 3, "BadThreshold"),
    ],
)
def test_create_event_validates_oracles_and_threshold(chain, oracles, threshold, code):
    a, b = chain.oracle.pubkey(), chain.oracle2.pubkey()
    lists = {"none": [], "four": [a, b, Keypair().pubkey(), Keypair().pubkey()], "dup": [a, a], "default": [a, Pubkey.default()],
             "one": [a], "two": [a, b]}
    res, _ = chain.create_event(oracles=lists[oracles], threshold=threshold)
    assert chain.code(res) == code


def test_threshold_1_pays_after_dwell_exactly_once(chain):
    res, ev_addr = chain.create_event(min_seen=3)
    chain.ok(res)
    attendee = chain.attendee()
    vault = chain.balance(ev_addr)
    t0 = START + 10

    chain.ok(chain.report(ev_addr, attendee, t0))
    s = chain.attendance(ev_addr, attendee)
    assert (s.first_seen, s.last_seen, s.reporters, s.paid, s.payer) == (t0, t0, 1, False, chain.oracle.pubkey())
    chain.ok(chain.report(ev_addr, attendee, t0 + 2))
    assert chain.balance(attendee) == 0 and not chain.attendance(ev_addr, attendee).paid

    oracle_before = chain.balance(chain.oracle.pubkey())
    res = chain.ok(chain.report(ev_addr, attendee, t0 + 3))  # dwell 3 s on the chain clock
    assert attendee_paid(res.logs(), ev_addr, attendee)
    assert chain.balance(attendee) == REWARD
    assert chain.balance(chain.oracle.pubkey()) == oracle_before + FEE - REPORT_TX_FEE  # the reporting oracle earns it
    assert chain.balance(ev_addr) == vault - REWARD - FEE
    assert chain.event(ev_addr).paid_count == 1 and chain.attendance(ev_addr, attendee).paid

    for dt in (4, 10, 100):  # later sightings are successful no-ops: no second reward, no second fee
        before = chain.balance(chain.oracle.pubkey())
        res = chain.ok(chain.report(ev_addr, attendee, t0 + dt))
        assert not attendee_paid(res.logs(), ev_addr, attendee)
        assert chain.balance(chain.oracle.pubkey()) == before - REPORT_TX_FEE
    assert chain.balance(attendee) == REWARD
    assert chain.event(ev_addr).paid_count == 1


def test_min_seen_zero_threshold_1_pays_on_first_sighting(chain):
    _, ev_addr = chain.create_event(min_seen=0)
    attendee = chain.attendee()
    chain.ok(chain.report(ev_addr, attendee, START))  # start <= now: the first second counts
    assert chain.balance(attendee) == REWARD


def test_threshold_2_of_2_needs_both_oracles(chain):
    _, ev_addr = chain.create_event(oracles=[chain.oracle.pubkey(), chain.oracle2.pubkey()], threshold=2, min_seen=3)
    attendee = chain.attendee()
    t0 = START + 10
    for dt in (0, 5, 10, 20):  # one oracle, long past the dwell: never pays
        chain.ok(chain.report(ev_addr, attendee, t0 + dt))
    s = chain.attendance(ev_addr, attendee)
    assert s.reporters == 0b01 and not s.paid and chain.balance(attendee) == 0
    first, second = chain.balance(chain.oracle.pubkey()), chain.balance(chain.oracle2.pubkey())
    chain.ok(chain.report(ev_addr, attendee, t0 + 21, oracle=chain.oracle2))
    s = chain.attendance(ev_addr, attendee)
    assert s.reporters == 0b11 and s.paid
    assert chain.balance(attendee) == REWARD
    # The fee goes to the oracle whose report paid (oracle2), not to the one that reported first.
    assert chain.balance(chain.oracle2.pubkey()) == second + FEE - REPORT_TX_FEE
    assert chain.balance(chain.oracle.pubkey()) == first


def test_threshold_2_of_2_fee_goes_to_whichever_oracle_completes_it(chain):
    _, ev_addr = chain.create_event(oracles=[chain.oracle.pubkey(), chain.oracle2.pubkey()], threshold=2, min_seen=0)
    attendee = chain.attendee()
    chain.ok(chain.report(ev_addr, attendee, START + 10, oracle=chain.oracle2))  # creates the Attendance, no payout
    first, second = chain.balance(chain.oracle.pubkey()), chain.balance(chain.oracle2.pubkey())
    chain.ok(chain.report(ev_addr, attendee, START + 11, oracle=chain.oracle))
    assert chain.balance(attendee) == REWARD
    assert chain.balance(chain.oracle.pubkey()) == first + FEE - REPORT_TX_FEE
    assert chain.balance(chain.oracle2.pubkey()) == second


def test_non_oracle_signer_rejected(chain):
    _, ev_addr = chain.create_event(min_seen=0)
    attendee = chain.attendee()
    assert chain.code(chain.report(ev_addr, attendee, START + 10, oracle=chain.outsider)) == "NotOracle"
    assert chain.attendance(ev_addr, attendee) is None and chain.balance(attendee) == 0


def test_sighting_outside_the_window_rejected(chain):
    _, ev_addr = chain.create_event(min_seen=0)
    attendee = chain.attendee()
    assert chain.code(chain.report(ev_addr, attendee, START - 1)) == "NotStarted"
    assert chain.code(chain.report(ev_addr, attendee, END + 1)) == "Ended"
    assert chain.attendance(ev_addr, attendee) is None
    chain.ok(chain.report(ev_addr, attendee, END))  # end is inclusive
    assert chain.balance(attendee) == REWARD


def test_gap_over_60s_restarts_the_dwell(chain):
    _, ev_addr = chain.create_event(min_seen=3)
    attendee = chain.attendee()
    t0 = START + 10
    chain.ok(chain.report(ev_addr, attendee, t0))
    t1 = t0 + SIGHTING_GAP_SECS + 1  # gone for 61 s
    chain.ok(chain.report(ev_addr, attendee, t1))
    s = chain.attendance(ev_addr, attendee)
    assert (s.first_seen, s.last_seen, s.paid) == (t1, t1, False)
    chain.ok(chain.report(ev_addr, attendee, t1 + 2))
    assert chain.balance(attendee) == 0
    chain.ok(chain.report(ev_addr, attendee, t1 + 3))
    assert chain.balance(attendee) == REWARD


def test_gap_of_exactly_60s_keeps_the_dwell(chain):
    _, ev_addr = chain.create_event(min_seen=3)
    attendee = chain.attendee()
    chain.ok(chain.report(ev_addr, attendee, START + 10))
    chain.ok(chain.report(ev_addr, attendee, START + 10 + SIGHTING_GAP_SECS))
    assert chain.balance(attendee) == REWARD


def test_cap_reached_returns_error_and_reverts(chain):
    _, ev_addr = chain.create_event(min_seen=0, max_paid=1)
    a, b = chain.attendee(), chain.attendee()
    chain.ok(chain.report(ev_addr, a, START + 10))
    vault = chain.balance(ev_addr)
    assert chain.code(chain.report(ev_addr, b, START + 11)) == "CapReached"
    assert chain.balance(b) == 0 and chain.balance(ev_addr) == vault
    assert chain.attendance(ev_addr, b) is None  # the whole transaction, incl. the Attendance's creation, reverted


def test_close_attendance_only_after_end_returns_rent_to_payer(chain):
    _, ev_addr = chain.create_event(min_seen=0)
    attendee = chain.attendee()
    chain.ok(chain.report(ev_addr, attendee, START + 10))
    attendance = attendance_pda(ev_addr, attendee, chain.pid)
    attendance_rent = chain.balance(attendance)
    assert attendance_rent > 0
    close = close_attendance_ix(chain.oracle.pubkey(), ev_addr, attendee, chain.pid)

    chain.set_time(END)
    assert chain.code(chain.send([close], chain.oracle)) == "EventRunning"
    chain.set_time(END + 1)
    other = close_attendance_ix(chain.oracle2.pubkey(), ev_addr, attendee, chain.pid)
    assert chain.code(chain.send([other], chain.oracle2)) == "Unauthorized"  # has_one = payer

    # Works after the organizer closed the Event: the end is stored in the Attendance.
    chain.ok(chain.send([withdraw_remaining_ix(chain.organizer.pubkey(), ev_addr, chain.pid)], chain.organizer))
    assert chain.svm.get_account(ev_addr) is None or chain.balance(ev_addr) == 0
    before = chain.balance(chain.oracle.pubkey())
    chain.ok(chain.send([close], chain.oracle))
    assert chain.balance(chain.oracle.pubkey()) == before + attendance_rent - TX_FEE
    assert chain.attendance(ev_addr, attendee) is None


def test_withdraw_remaining_after_end_returns_the_rest(chain):
    _, ev_addr = chain.create_event(min_seen=0, max_paid=3)
    chain.ok(chain.report(ev_addr, chain.attendee(), START + 10))  # one of three paid
    withdraw = withdraw_remaining_ix(chain.organizer.pubkey(), ev_addr, chain.pid)
    chain.set_time(START + 20)
    assert chain.code(chain.send([withdraw], chain.organizer)) == "EventRunning"
    chain.set_time(END + 1)
    left = chain.balance(ev_addr)
    assert left == rent(chain, ev_addr) + 2 * (REWARD + FEE)
    before = chain.balance(chain.organizer.pubkey())
    chain.ok(chain.send([withdraw], chain.organizer))
    assert chain.balance(chain.organizer.pubkey()) == before + left - TX_FEE
    assert chain.balance(ev_addr) == 0


# Join proof (the attendee's signed join, checked on chain) --------------------------------------------


def assert_nothing_happened(chain: Chain, ev_addr: Pubkey, attendee: Pubkey, vault: int) -> None:
    assert chain.attendance(ev_addr, attendee) is None
    assert chain.balance(attendee) == 0
    assert chain.balance(ev_addr) == vault and chain.event(ev_addr).paid_count == 0


def joined_event(chain: Chain):
    """An event that pays on the first sighting, so any report that gets through would pay at once."""
    res, ev_addr = chain.create_event(min_seen=0)
    chain.ok(res)
    attendee = chain.attendee()
    chain.set_time(START + 10)
    return ev_addr, attendee, chain.balance(ev_addr)


def ed25519_data(signer: Pubkey, signature: bytes, message: bytes, indexes=(0xFFFF, 0xFFFF, 0xFFFF)) -> bytes:
    """Ed25519SigVerify data with one signature laid out as ed25519_verify_ix does, but with chosen instruction
    indexes for the signature, the pubkey and the message."""
    sig_ix, pk_ix, msg_ix = indexes
    offsets = struct.pack("<7H", 48, sig_ix, 16, pk_ix, 112, len(message), msg_ix)
    return bytes([1, 0]) + offsets + bytes(signer) + signature + message


def test_legit_join_proof_pays_exactly_once(chain):
    ev_addr, attendee, vault = joined_event(chain)
    before = chain.balance(chain.oracle.pubkey())
    res = chain.ok(chain.report(ev_addr, attendee, START + 10))
    assert attendee_paid(res.logs(), ev_addr, attendee)
    attendance_rent = chain.balance(attendance_pda(ev_addr, attendee, chain.pid))  # first report: the oracle pays it
    assert chain.balance(chain.oracle.pubkey()) == before + FEE - attendance_rent - REPORT_TX_FEE
    chain.ok(chain.report(ev_addr, attendee, START + 11))  # a second report is a no-op, not a second payout
    assert chain.balance(attendee) == REWARD
    assert chain.balance(ev_addr) == vault - REWARD - FEE and chain.event(ev_addr).paid_count == 1


def test_report_without_ed25519_instruction_is_bad_join_proof(chain):
    ev_addr, attendee, vault = joined_event(chain)
    assert chain.code(chain.send([chain.report_ix(ev_addr, attendee)], chain.oracle)) == "BadJoinProof"
    assert_nothing_happened(chain, ev_addr, attendee, vault)
    chain.ok(chain.report(ev_addr, attendee, START + 10))  # the same wallet with its proof still gets paid
    assert chain.balance(attendee) == REWARD


def test_join_signed_for_another_event_is_bad_join_proof(chain):
    ev_addr, attendee, vault = joined_event(chain)
    other_ev = chain.create_event(min_seen=0)[1]
    proof = signed_join(other_ev, chain.attendees[attendee])
    assert proof.valid_for(str(other_ev), str(attendee))
    assert chain.code(chain.report(ev_addr, attendee, START + 10, proof=proof)) == "BadJoinProof"
    assert_nothing_happened(chain, ev_addr, attendee, vault)


def test_join_for_this_wallet_signed_by_another_key_fails_the_transaction(chain):
    # The message is the right join for this event and wallet, but an impostor signed it. The ed25519 instruction
    # names the attendee's key, so the native precompile itself rejects the signature and fails the whole
    # transaction before the program runs: the error is the precompile's (not BadJoinProof). What matters is that it
    # fails and nothing is paid.
    ev_addr, attendee, vault = joined_event(chain)
    forged = signed_join(ev_addr, Keypair(), wallet=attendee)
    assert forged.message.startswith(f"Attend Now\nAction: join\nEvent: {ev_addr}\nWallet: {attendee}\n".encode())
    res = chain.report(ev_addr, attendee, START + 10, proof=forged)
    assert chain.code(res) == "TransactionFailed"
    # Instruction 0 (the ed25519 check) failed with PrecompileError::InvalidSignature (= 2); the program never ran.
    assert "InstructionError((0," in str(res.err()) and "InstructionErrorCustom(2)" in str(res.err())
    assert_nothing_happened(chain, ev_addr, attendee, vault)


def test_another_attendees_valid_join_is_bad_join_proof(chain):
    ev_addr, attendee, vault = joined_event(chain)
    other = chain.attendee()
    other_proof = signed_join(ev_addr, chain.attendees[other])
    ixs = [ed25519_verify_ix(other, other_proof.signature, other_proof.message), chain.report_ix(ev_addr, attendee)]
    assert chain.code(chain.send(ixs, chain.oracle)) == "BadJoinProof"
    assert_nothing_happened(chain, ev_addr, attendee, vault)
    assert chain.attendance(ev_addr, other) is None and chain.balance(other) == 0


def test_message_that_is_not_a_join_is_bad_join_proof(chain):
    ev_addr, attendee, vault = joined_event(chain)
    other = signed_join(ev_addr, chain.attendees[attendee], action="camera-token")
    assert other.message.startswith(b"Attend Now\nAction: camera-token\n")
    assert chain.code(chain.report(ev_addr, attendee, START + 10, proof=other)) == "BadJoinProof"
    assert_nothing_happened(chain, ev_addr, attendee, vault)


@pytest.mark.parametrize("field", [0, 1, 2])  # signature, pubkey, message instruction index
def test_ed25519_offsets_into_another_instruction_are_bad_join_proof(chain, field):
    # Index 0 is the ed25519 instruction itself, so the precompile verifies the signature successfully; only the
    # program's own rule (every index must be u16::MAX) rejects it.
    ev_addr, attendee, vault = joined_event(chain)
    proof = signed_join(ev_addr, chain.attendees[attendee])
    indexes = [0xFFFF, 0xFFFF, 0xFFFF]
    indexes[field] = 0
    data = ed25519_data(attendee, proof.signature, proof.message, tuple(indexes))
    template = ed25519_verify_ix(attendee, proof.signature, proof.message)
    assert bytes(template.data) == ed25519_data(attendee, proof.signature, proof.message)
    ed_ix = Instruction(template.program_id, data, [])
    assert chain.code(chain.send([ed_ix, chain.report_ix(ev_addr, attendee)], chain.oracle)) == "BadJoinProof"
    assert_nothing_happened(chain, ev_addr, attendee, vault)


def test_ed25519_not_immediately_before_the_report_is_bad_join_proof(chain):
    ev_addr, attendee, vault = joined_event(chain)
    proof = signed_join(ev_addr, chain.attendees[attendee])
    ed_ix, report_ix = report_sighting_ixs(chain.oracle.pubkey(), chain.event(ev_addr), attendee, proof, chain.pid)
    hop = transfer(TransferParams(from_pubkey=chain.oracle.pubkey(), to_pubkey=chain.outsider.pubkey(), lamports=1))
    assert chain.code(chain.send([ed_ix, hop, report_ix], chain.oracle)) == "BadJoinProof"
    assert_nothing_happened(chain, ev_addr, attendee, vault)


def test_valid_proof_from_a_non_oracle_is_still_not_oracle(chain):
    ev_addr, attendee, vault = joined_event(chain)
    assert chain.code(chain.report(ev_addr, attendee, START + 10, oracle=chain.outsider)) == "NotOracle"
    # The oracle check comes first: without any proof a non-oracle is still NotOracle, not BadJoinProof.
    bare = chain.report_ix(ev_addr, attendee, oracle=chain.outsider)
    assert chain.code(chain.send([bare], chain.outsider)) == "NotOracle"
    assert_nothing_happened(chain, ev_addr, attendee, vault)


# Oracle registry ------------------------------------------------------------------------------------


def oracle_info(chain: Chain, oracle: Pubkey) -> OracleInfo | None:
    acc = chain.svm.get_account(oracle_info_pda(oracle, chain.pid))
    return OracleInfo.decode(bytes(acc.data)) if acc is not None and acc.lamports > 0 else None


def test_register_oracle_publishes_name_and_url_paid_by_the_oracle(chain):
    me = chain.oracle
    before = chain.balance(me.pubkey())
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "OnSight", "https://onsight.site", chain.pid)], me))
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "OnSight", "https://onsight.site")
    info_addr = oracle_info_pda(me.pubkey(), chain.pid)
    assert chain.balance(me.pubkey()) == before - rent(chain, info_addr) - TX_FEE


def test_register_oracle_again_updates_the_entry_without_new_rent(chain):
    me = chain.oracle
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "OnSight", "https://a.example", chain.pid)], me))
    info_addr = oracle_info_pda(me.pubkey(), chain.pid)
    info_rent = chain.balance(info_addr)
    before = chain.balance(me.pubkey())
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "OnSight 2", "http://b.example:8000", chain.pid)], me))
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "OnSight 2", "http://b.example:8000")
    assert chain.balance(me.pubkey()) == before - TX_FEE  # the account exists: only the tx fee
    assert chain.balance(info_addr) == info_rent


def test_another_key_cannot_overwrite_an_oracles_entry(chain):
    me, other = chain.oracle, chain.outsider
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "OnSight", "https://a.example", chain.pid)], me))
    mine = oracle_info_pda(me.pubkey(), chain.pid)
    assert oracle_info_pda(other.pubkey(), chain.pid) != mine  # another signer derives another PDA

    hijack = register_oracle_ix(other.pubkey(), "Evil", "https://evil.example", chain.pid, info=mine)
    res = chain.send([hijack], other)
    assert chain.code(res) == "TransactionFailed"
    assert "ConstraintSeeds" in "\n".join(res.meta().logs())  # seeds = ["oracle", signer] does not match
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "OnSight", "https://a.example")

    # Registering under its own key is fine and leaves the first oracle's entry alone.
    chain.ok(chain.send([register_oracle_ix(other.pubkey(), "Other", "https://other.example", chain.pid)], other))
    assert oracle_info(chain, other.pubkey()) == OracleInfo(other.pubkey(), "Other", "https://other.example")
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "OnSight", "https://a.example")


@pytest.mark.parametrize(
    ("name", "url", "code"),
    [
        ("", "https://a.example", "BadName"),
        ("x" * 33, "https://a.example", "BadName"),
        ("On\nSight", "https://a.example", "BadName"),
        ("OnSight", "ftp://a.example", "BadUrl"),
        ("OnSight", "a.example", "BadUrl"),
        ("OnSight", "https://", "BadUrl"),
        ("OnSight", "https://a b.example", "BadUrl"),
        ("OnSight", "https://" + "a" * 121, "BadUrl"),  # 129 bytes
    ],
)
def test_register_and_update_validate_name_and_url(chain, name, url, code):
    me = chain.oracle
    assert chain.code(chain.send([register_oracle_ix(me.pubkey(), name, url, chain.pid)], me)) == code
    assert oracle_info(chain, me.pubkey()) is None
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "OnSight", "https://a.example", chain.pid)], me))
    assert chain.code(chain.send([register_oracle_ix(me.pubkey(), name, url, chain.pid)], me)) == code  # update
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "OnSight", "https://a.example")


def test_limits_are_inclusive(chain):
    me = chain.oracle
    url = "https://" + "a" * 120  # exactly 128 bytes
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "x" * 32, url, chain.pid)], me))
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "x" * 32, url)
