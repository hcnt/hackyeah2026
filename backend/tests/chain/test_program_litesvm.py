"""The compiled presence_pay program (contracts/presence_pay/lib.rs) run in LiteSVM, with the chain clock warped.

Skipped unless PRESENCE_SO points at a built presence_pay.so (`cargo build-sbf`, see contracts/presence_pay/README.md).
The program id is PRESENCE_SO_PROGRAM_ID, or else the pubkey of `presence_pay-keypair.json` next to the .so; it must
equal the `declare_id!` the .so was built with. Instructions come from the backend client's own builders, so this
also checks that the client and the program agree on discriminators, Borsh layouts and account order.
"""

import json
import os
from pathlib import Path

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from app.chain.presence_chain import (
    SIGHTING_GAP_SECS,
    Event,
    OracleInfo,
    Sighting,
    _program_error,
    attendee_paid,
    close_oracle_ix,
    close_sighting_ix,
    create_event_ix,
    event_pda,
    init_config_ix,
    oracle_info_pda,
    register_oracle_ix,
    report_sighting_ix,
    sighting_pda,
    update_oracle_ix,
    withdraw_remaining_ix,
)

SO = os.environ.get("PRESENCE_SO", "")
pytestmark = pytest.mark.skipif(not SO or not Path(SO).is_file(), reason="PRESENCE_SO (a built presence_pay.so) not set")

FEE = 2_000_000
REWARD = 10_000_000
START = 1_000_000
END = START + 3_600
TX_FEE = 5_000  # LiteSVM's default fee per signature


def _program_id() -> Pubkey:
    explicit = os.environ.get("PRESENCE_SO_PROGRAM_ID")
    if explicit:
        return Pubkey.from_string(explicit)
    kp_file = Path(SO).with_name("presence_pay-keypair.json")
    return Keypair.from_bytes(bytes(json.loads(kp_file.read_text()))).pubkey()


class Chain:
    def __init__(self) -> None:
        from solders.litesvm import LiteSVM

        self.pid = _program_id()
        self.svm = LiteSVM()
        self.svm.add_program(self.pid, Path(SO).read_bytes())
        self.admin, self.organizer, self.oracle, self.oracle2, self.outsider = (Keypair() for _ in range(5))
        for kp in (self.admin, self.organizer, self.oracle, self.oracle2, self.outsider):
            self.svm.airdrop(kp.pubkey(), 100 * 10**9)
        self.treasury = Keypair().pubkey()
        self.next_id = 1
        self.set_time(START - 100)
        self.ok(self.send([init_config_ix(self.admin.pubkey(), self.treasury, FEE, self.pid)], self.admin))

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

    def create_event(self, oracles=None, threshold=1, min_seen=3, max_paid=3, start=START, end=END):
        oracles = [self.oracle.pubkey()] if oracles is None else oracles
        eid, self.next_id = self.next_id, self.next_id + 1
        ix = create_event_ix(
            self.organizer.pubkey(), eid, oracles, threshold, start, end, REWARD, max_paid, min_seen, self.pid
        )
        return self.send([ix], self.organizer), event_pda(self.organizer.pubkey(), eid, self.pid)

    def event(self, address: Pubkey) -> Event:
        acc = self.svm.get_account(address)
        return Event.decode(address, bytes(acc.data), acc.lamports)

    def report(self, event: Pubkey, attendee: Pubkey, at: int, oracle: Keypair | None = None):
        oracle = oracle or self.oracle
        self.set_time(at)
        return self.send([report_sighting_ix(oracle.pubkey(), self.event(event), attendee, self.pid)], oracle)

    def sighting(self, event: Pubkey, attendee: Pubkey) -> Sighting | None:
        acc = self.svm.get_account(sighting_pda(event, attendee, self.pid))
        return Sighting.decode(bytes(acc.data)) if acc is not None and acc.lamports > 0 else None


@pytest.fixture
def chain() -> Chain:
    return Chain()


def rent(chain: Chain, address: Pubkey) -> int:
    return chain.svm.minimum_balance_for_rent_exemption(len(chain.svm.get_account(address).data))


def test_create_event_funds_escrow_and_freezes_terms(chain):
    res, ev_addr = chain.create_event(oracles=[chain.oracle.pubkey(), chain.oracle2.pubkey()], threshold=2)
    chain.ok(res)
    ev = chain.event(ev_addr)
    assert ev.oracles == [chain.oracle.pubkey(), chain.oracle2.pubkey()] and ev.threshold == 2
    assert (ev.treasury, ev.fee, ev.reward, ev.max_paid, ev.paid_count) == (chain.treasury, FEE, REWARD, 3, 0)
    assert ev.balance == rent(chain, ev_addr) + 3 * (REWARD + FEE)


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
    attendee = Keypair().pubkey()
    vault = chain.balance(ev_addr)
    t0 = START + 10

    chain.ok(chain.report(ev_addr, attendee, t0))
    s = chain.sighting(ev_addr, attendee)
    assert (s.first_seen, s.last_seen, s.reporters, s.paid, s.payer) == (t0, t0, 1, False, chain.oracle.pubkey())
    chain.ok(chain.report(ev_addr, attendee, t0 + 2))
    assert chain.balance(attendee) == 0 and not chain.sighting(ev_addr, attendee).paid

    res = chain.ok(chain.report(ev_addr, attendee, t0 + 3))  # dwell 3 s on the chain clock
    assert attendee_paid(res.logs(), ev_addr, attendee)
    assert chain.balance(attendee) == REWARD
    assert chain.balance(chain.treasury) == FEE
    assert chain.balance(ev_addr) == vault - REWARD - FEE
    assert chain.event(ev_addr).paid_count == 1 and chain.sighting(ev_addr, attendee).paid

    for dt in (4, 10, 100):  # later sightings are successful no-ops
        res = chain.ok(chain.report(ev_addr, attendee, t0 + dt))
        assert not attendee_paid(res.logs(), ev_addr, attendee)
    assert (chain.balance(attendee), chain.balance(chain.treasury)) == (REWARD, FEE)
    assert chain.event(ev_addr).paid_count == 1


def test_min_seen_zero_threshold_1_pays_on_first_sighting(chain):
    _, ev_addr = chain.create_event(min_seen=0)
    attendee = Keypair().pubkey()
    chain.ok(chain.report(ev_addr, attendee, START))  # start <= now: the first second counts
    assert chain.balance(attendee) == REWARD


def test_threshold_2_of_2_needs_both_oracles(chain):
    _, ev_addr = chain.create_event(oracles=[chain.oracle.pubkey(), chain.oracle2.pubkey()], threshold=2, min_seen=3)
    attendee = Keypair().pubkey()
    t0 = START + 10
    for dt in (0, 5, 10, 20):  # one oracle, long past the dwell: never pays
        chain.ok(chain.report(ev_addr, attendee, t0 + dt))
    s = chain.sighting(ev_addr, attendee)
    assert s.reporters == 0b01 and not s.paid and chain.balance(attendee) == 0
    chain.ok(chain.report(ev_addr, attendee, t0 + 21, oracle=chain.oracle2))
    s = chain.sighting(ev_addr, attendee)
    assert s.reporters == 0b11 and s.paid
    assert chain.balance(attendee) == REWARD and chain.balance(chain.treasury) == FEE


def test_non_oracle_signer_rejected(chain):
    _, ev_addr = chain.create_event(min_seen=0)
    attendee = Keypair().pubkey()
    assert chain.code(chain.report(ev_addr, attendee, START + 10, oracle=chain.outsider)) == "NotOracle"
    assert chain.sighting(ev_addr, attendee) is None and chain.balance(attendee) == 0


def test_sighting_outside_the_window_rejected(chain):
    _, ev_addr = chain.create_event(min_seen=0)
    attendee = Keypair().pubkey()
    assert chain.code(chain.report(ev_addr, attendee, START - 1)) == "NotStarted"
    assert chain.code(chain.report(ev_addr, attendee, END + 1)) == "Ended"
    assert chain.sighting(ev_addr, attendee) is None
    chain.ok(chain.report(ev_addr, attendee, END))  # end is inclusive
    assert chain.balance(attendee) == REWARD


def test_gap_over_60s_restarts_the_dwell(chain):
    _, ev_addr = chain.create_event(min_seen=3)
    attendee = Keypair().pubkey()
    t0 = START + 10
    chain.ok(chain.report(ev_addr, attendee, t0))
    t1 = t0 + SIGHTING_GAP_SECS + 1  # gone for 61 s
    chain.ok(chain.report(ev_addr, attendee, t1))
    s = chain.sighting(ev_addr, attendee)
    assert (s.first_seen, s.last_seen, s.paid) == (t1, t1, False)
    chain.ok(chain.report(ev_addr, attendee, t1 + 2))
    assert chain.balance(attendee) == 0
    chain.ok(chain.report(ev_addr, attendee, t1 + 3))
    assert chain.balance(attendee) == REWARD


def test_gap_of_exactly_60s_keeps_the_dwell(chain):
    _, ev_addr = chain.create_event(min_seen=3)
    attendee = Keypair().pubkey()
    chain.ok(chain.report(ev_addr, attendee, START + 10))
    chain.ok(chain.report(ev_addr, attendee, START + 10 + SIGHTING_GAP_SECS))
    assert chain.balance(attendee) == REWARD


def test_cap_reached_returns_error_and_reverts(chain):
    _, ev_addr = chain.create_event(min_seen=0, max_paid=1)
    a, b = Keypair().pubkey(), Keypair().pubkey()
    chain.ok(chain.report(ev_addr, a, START + 10))
    vault = chain.balance(ev_addr)
    assert chain.code(chain.report(ev_addr, b, START + 11)) == "CapReached"
    assert chain.balance(b) == 0 and chain.balance(ev_addr) == vault
    assert chain.sighting(ev_addr, b) is None  # the whole transaction, incl. the Sighting's creation, reverted


def test_close_sighting_only_after_end_returns_rent_to_payer(chain):
    _, ev_addr = chain.create_event(min_seen=0)
    attendee = Keypair().pubkey()
    chain.ok(chain.report(ev_addr, attendee, START + 10))
    sighting = sighting_pda(ev_addr, attendee, chain.pid)
    sighting_rent = chain.balance(sighting)
    assert sighting_rent > 0
    close = close_sighting_ix(chain.oracle.pubkey(), ev_addr, attendee, chain.pid)

    chain.set_time(END)
    assert chain.code(chain.send([close], chain.oracle)) == "EventRunning"
    chain.set_time(END + 1)
    other = close_sighting_ix(chain.oracle2.pubkey(), ev_addr, attendee, chain.pid)
    assert chain.code(chain.send([other], chain.oracle2)) == "Unauthorized"  # has_one = payer

    # Works after the organizer closed the Event: the end is stored in the Sighting.
    chain.ok(chain.send([withdraw_remaining_ix(chain.organizer.pubkey(), ev_addr, chain.pid)], chain.organizer))
    assert chain.svm.get_account(ev_addr) is None or chain.balance(ev_addr) == 0
    before = chain.balance(chain.oracle.pubkey())
    chain.ok(chain.send([close], chain.oracle))
    assert chain.balance(chain.oracle.pubkey()) == before + sighting_rent - TX_FEE
    assert chain.sighting(ev_addr, attendee) is None


def test_withdraw_remaining_after_end_returns_the_rest(chain):
    _, ev_addr = chain.create_event(min_seen=0, max_paid=3)
    chain.ok(chain.report(ev_addr, Keypair().pubkey(), START + 10))  # one of three paid
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


# Oracle registry ------------------------------------------------------------------------------------


def oracle_info(chain: Chain, oracle: Pubkey) -> OracleInfo | None:
    acc = chain.svm.get_account(oracle_info_pda(oracle, chain.pid))
    return OracleInfo.decode(bytes(acc.data)) if acc is not None and acc.lamports > 0 else None


def test_register_oracle_publishes_name_and_url_paid_by_the_oracle(chain):
    me = chain.oracle
    before = chain.balance(me.pubkey())
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "OnSight", "https://hackyeah.kindhome.io", chain.pid)], me))
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "OnSight", "https://hackyeah.kindhome.io")
    info_addr = oracle_info_pda(me.pubkey(), chain.pid)
    assert chain.balance(me.pubkey()) == before - rent(chain, info_addr) - TX_FEE
    # Once per key: a second register fails (the account exists), and the entry is unchanged.
    res = chain.send([register_oracle_ix(me.pubkey(), "Other", "https://other.example", chain.pid)], me)
    assert chain.code(res) == "TransactionFailed"
    assert oracle_info(chain, me.pubkey()).name == "OnSight"


def test_update_oracle_only_by_its_owner(chain):
    me, other = chain.oracle, chain.outsider
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "OnSight", "https://a.example", chain.pid)], me))
    chain.ok(chain.send([update_oracle_ix(me.pubkey(), "OnSight 2", "http://b.example:8000", chain.pid)], me))
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "OnSight 2", "http://b.example:8000")

    mine = oracle_info_pda(me.pubkey(), chain.pid)
    hijack = update_oracle_ix(other.pubkey(), "Evil", "https://evil.example", chain.pid, info=mine)
    assert chain.code(chain.send([hijack], other)) == "Unauthorized"  # has_one = oracle
    steal = close_oracle_ix(other.pubkey(), chain.pid, info=mine)
    assert chain.code(chain.send([steal], other)) == "Unauthorized"
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "OnSight 2", "http://b.example:8000")


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
    assert chain.code(chain.send([update_oracle_ix(me.pubkey(), name, url, chain.pid)], me)) == code


def test_limits_are_inclusive(chain):
    me = chain.oracle
    url = "https://" + "a" * 120  # exactly 128 bytes
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "x" * 32, url, chain.pid)], me))
    assert oracle_info(chain, me.pubkey()) == OracleInfo(me.pubkey(), "x" * 32, url)


def test_close_oracle_returns_rent(chain):
    me = chain.oracle
    chain.ok(chain.send([register_oracle_ix(me.pubkey(), "OnSight", "https://a.example", chain.pid)], me))
    info_rent = chain.balance(oracle_info_pda(me.pubkey(), chain.pid))
    assert info_rent > 0
    before = chain.balance(me.pubkey())
    chain.ok(chain.send([close_oracle_ix(me.pubkey(), chain.pid)], me))
    assert chain.balance(me.pubkey()) == before + info_rent - TX_FEE
    assert oracle_info(chain, me.pubkey()) is None
