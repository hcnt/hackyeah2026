"""Head-turn liveness check from the 5 SCRFD keypoints.

Yaw proxy per frame: (nose_x - eyes_mid_x) / eye_distance. About 0 for a frontal face, sign follows
the turn direction. The three join frames must span at least LIVENESS_MIN_YAW_RANGE.
"""

from collections.abc import Sequence

import numpy as np

LIVENESS_MIN_YAW_RANGE = 0.15


def yaw_proxy(kps: np.ndarray) -> float:
    kps = np.asarray(kps, np.float64).reshape(5, 2)
    left_eye, right_eye, nose = kps[0], kps[1], kps[2]
    eye_distance = float(np.linalg.norm(right_eye - left_eye))
    if eye_distance < 1e-6:
        return 0.0
    return float((nose[0] - (left_eye[0] + right_eye[0]) / 2) / eye_distance)


def yaw_range(kpss: Sequence[np.ndarray]) -> float:
    yaws = [yaw_proxy(k) for k in kpss]
    return max(yaws) - min(yaws)


def passes_head_turn(kpss: Sequence[np.ndarray]) -> bool:
    return yaw_range(kpss) >= LIVENESS_MIN_YAW_RANGE
