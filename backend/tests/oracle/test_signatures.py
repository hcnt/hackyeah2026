import pytest
from fakes import FakeClock
from solders.keypair import Keypair

from app.oracle.errors import OracleError
from app.oracle.signatures import SignatureVerifier, build_message

T0 = 1_791_108_723.0  # 2026-10-04T10:12:03Z
SIGNED_AT = "2026-10-04T10:12:03Z"


def make(kp: Keypair, action="join", event="EV", consent="2026-10-03", signed_at=SIGNED_AT):
    wallet = str(kp.pubkey())
    sig = kp.sign_message(build_message(action, event, wallet, signed_at, consent).encode())
    return {"action": action, "event_id": event, "wallet": wallet, "signed_at": signed_at, "signature": str(sig),
            "consent_version": consent}


def code(verifier, **kw) -> str | None:
    try:
        verifier.verify(**kw)
    except OracleError as e:
        return e.code
    return None


def test_message_format_matches_contract():
    assert build_message("join", "E", "W", "T", "C") == "Attend Now\nAction: join\nEvent: E\nWallet: W\nConsent: C\nTime: T"
    assert build_message("leave", "E", "W", "T") == "Attend Now\nAction: leave\nEvent: E\nWallet: W\nTime: T"


def test_valid_then_reused():
    v = SignatureVerifier(wall_clock=FakeClock(T0 + 10))
    kw = make(Keypair())
    assert code(v, **kw) is None
    assert code(v, **kw) == "signature_reused"


def test_wrong_key():
    v = SignatureVerifier(wall_clock=FakeClock(T0))
    kw = make(Keypair())
    kw["wallet"] = str(Keypair().pubkey())
    assert code(v, **kw) == "bad_signature"


@pytest.mark.parametrize(("offset", "expected"), [(301, "signature_expired"), (299, None), (-59, None), (-61, "signature_expired")])
def test_time_window(offset, expected):
    """now = signed_at + offset: at most 5 min in the past, at most 1 min in the future."""
    v = SignatureVerifier(wall_clock=FakeClock(T0 + offset))
    assert code(v, **make(Keypair())) == expected


@pytest.mark.parametrize("field", ["event_id", "consent_version", "signed_at", "action"])
def test_tampered_field(field):
    v = SignatureVerifier(wall_clock=FakeClock(T0))
    kw = make(Keypair())
    kw[field] = {"event_id": "OTHER", "consent_version": "1999", "signed_at": "2026-10-04T10:12:04Z",
                 "action": "leave"}[field]
    assert code(v, **kw) == "bad_signature"


def test_garbage_encodings_are_bad_signature_and_bad_time_is_invalid():
    v = SignatureVerifier(wall_clock=FakeClock(T0))
    kw = make(Keypair())
    assert code(v, **(kw | {"signature": "notbase58!!"})) == "bad_signature"
    assert code(v, **(kw | {"wallet": "xx"})) == "bad_signature"
    assert code(v, **(kw | {"signed_at": "yesterday"})) == "invalid_request"
    assert code(v, **(kw | {"signed_at": "2026-10-04T10:12:03"})) == "invalid_request"  # no timezone


def test_reuse_memory_is_pruned_after_window():
    clock = FakeClock(T0)
    v = SignatureVerifier(wall_clock=clock)
    assert code(v, **make(Keypair())) is None
    clock.advance(400)
    assert code(v, **make(Keypair(), signed_at="2026-10-04T10:18:43Z")) is None
    assert len(v._used) == 1
