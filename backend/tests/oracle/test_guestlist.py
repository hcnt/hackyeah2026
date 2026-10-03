import numpy as np
from fakes import FakeClock, near, unit

from app.oracle.guestlist import GuestLists


def test_round_trip_encrypted_and_destroyed_after_end():
    rng = np.random.default_rng(1)
    clock = FakeClock(1000.0)
    gl = GuestLists(wall_clock=clock)
    a, b = unit(rng), unit(rng)
    gl.put("ev", 2000, "walletA", a)
    gl.put("ev", 2000, "walletB", b)

    # stored bytes are ciphertext, not the float32 plaintext
    nonce, ct = gl.raw_entry("ev", "walletA")
    assert a.astype(np.float32).tobytes() not in ct
    assert ct[: 512 * 4] != a.astype(np.float32).tobytes()
    assert len(nonce) == 12

    # round trip: a noisy probe of A matches A; B's own vector matches B
    res = gl.match("ev", np.stack([near(a, rng), b, unit(rng)]), threshold=0.40)
    assert res[0][0] == "walletA" and res[0][1] > 0.8
    assert res[1][0] == "walletB" and res[1][1] > 0.99
    assert res[2][0] is None
    assert gl.has("ev", "walletA")
    assert gl.count("ev") == 2
    assert gl.best_other("ev", a, exclude_wallet="walletA")[0] == "walletB"

    # after the end: purge drops key + entries; lookups return nothing
    clock.advance(1001)
    assert gl.purge() == ["ev"]
    assert not gl.has_key("ev")
    assert gl.count("ev") == 0
    assert gl.match("ev", a[None, :], 0.40) == [(None, 0.0)]
    assert gl.raw_entry("ev", "walletA") is None
    assert not gl.has("ev", "walletA")


def test_ended_event_is_dropped_lazily_without_purge():
    rng = np.random.default_rng(2)
    clock = FakeClock(1000.0)
    gl = GuestLists(wall_clock=clock)
    gl.put("ev", 1500, "w", unit(rng))
    clock.advance(600)
    assert not gl.has("ev", "w")  # lazy check on access
    assert not gl.has_key("ev")


def test_rejoin_replaces_and_remove_deletes():
    rng = np.random.default_rng(3)
    gl = GuestLists(wall_clock=FakeClock(0))
    a1, a2 = unit(rng), unit(rng)
    gl.put("ev", 10, "w", a1)
    n1, _ = gl.raw_entry("ev", "w")
    gl.put("ev", 10, "w", a2)
    n2, _ = gl.raw_entry("ev", "w")
    assert n1 != n2  # fresh nonce per entry write
    assert gl.count("ev") == 1
    assert gl.match("ev", a2[None, :], 0.4)[0][0] == "w"
    assert gl.remove("ev", "w")
    assert gl.count("ev") == 0
