import pytest
from fakes import kps_for

from app.oracle.liveness import (
    LIVENESS_MIN_YAW_RANGE,
    passes_head_turn,
    yaw_proxy,
    yaw_range,
)

BOX = [100.0, 100.0, 300.0, 340.0]


@pytest.mark.parametrize("yaw", [-0.3, 0.0, 0.12, 0.4])
def test_yaw_proxy_recovers_planted_yaw(yaw):
    assert yaw_proxy(kps_for(BOX, yaw)) == pytest.approx(yaw, abs=1e-5)


def test_small_turn_fails_large_turn_passes():
    assert LIVENESS_MIN_YAW_RANGE == 0.15
    small = [kps_for(BOX, y) for y in (0.0, 0.03, 0.05)]
    large = [kps_for(BOX, y) for y in (-0.10, 0.0, 0.15)]
    assert yaw_range(small) == pytest.approx(0.05, abs=1e-5)
    assert yaw_range(large) == pytest.approx(0.25, abs=1e-5)
    assert not passes_head_turn(small)
    assert passes_head_turn(large)
