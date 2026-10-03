"""Photo quality checks shared by `attendance/test` and `attendance` (submit): one face, looking straight at
the camera, sharp, well lit, big enough and inside the frame.

Yaw proxy from the 5 SCRFD keypoints: (nose_x - eyes_mid_x) / eye_distance, about 0 for a frontal face.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from app.oracle.face import RawFace

MIN_DET_SCORE = 0.75
MIN_EYE_DISTANCE_PX = 60.0
FRAME_MARGIN = 0.05
MIN_LAPLACIAN_VAR = 60.0
BLUR_FACE_SIZE = 112  # px, the size the recognition model sees
MIN_BRIGHTNESS = 70.0
MAX_BRIGHTNESS = 200.0
STRAIGHT_MAX_ABS_YAW = 0.15

ISSUE_MESSAGES = {
    "no_face": "We can't find a face — look at the camera",
    "multiple_faces": "Make sure only you are in the frame",
    "low_confidence": "We can't see your face clearly",
    "too_small": "Move closer",
    "out_of_frame": "Center your face in the oval",
    "blurry": "Hold still — the photo is blurry",
    "too_dark": "Too dark — face a light",
    "too_bright": "Too bright — move away from the light",
    "wrong_pose": "Look straight at the camera",
}

@dataclass
class PhotoCheck:
    issues: list[dict]
    face: RawFace | None
    yaw: float | None

    @property
    def ok(self) -> bool:
        return not self.issues

    def face_json(self) -> dict | None:
        if self.face is None:
            return None
        return {
            "bbox": [round(float(v), 1) for v in self.face.bbox],
            "confidence": round(float(self.face.det_score), 3),
            "yaw": round(float(self.yaw or 0.0), 3),
        }


def _issue(code: str) -> dict:
    return {"code": code, "message": ISSUE_MESSAGES[code]}


def yaw_proxy(kps: np.ndarray) -> float:
    kps = np.asarray(kps, np.float64).reshape(5, 2)
    left_eye, right_eye, nose = kps[0], kps[1], kps[2]
    eye_distance = float(np.linalg.norm(right_eye - left_eye))
    if eye_distance < 1e-6:
        return 0.0
    return float((nose[0] - (left_eye[0] + right_eye[0]) / 2) / eye_distance)


def pose_ok(yaw: float) -> bool:
    return abs(yaw) < STRAIGHT_MAX_ABS_YAW


def check_photo(img: np.ndarray, faces: list[RawFace]) -> PhotoCheck:
    """All issues found, in the order of the contract's table. With 2+ faces only `multiple_faces` is
    reported and `face` is the largest one."""
    if not faces:
        return PhotoCheck([_issue("no_face")], None, None)
    if len(faces) > 1:
        largest = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        return PhotoCheck([_issue("multiple_faces")], largest, yaw_proxy(largest.kps))

    face = faces[0]
    yaw = yaw_proxy(face.kps)
    issues: list[dict] = []
    h, w = img.shape[:2]
    x1, y1, x2, y2 = face.bbox
    kps = np.asarray(face.kps, np.float64).reshape(5, 2)

    if face.det_score < MIN_DET_SCORE:
        issues.append(_issue("low_confidence"))
    if float(np.linalg.norm(kps[1] - kps[0])) < MIN_EYE_DISTANCE_PX:
        issues.append(_issue("too_small"))
    mx, my = FRAME_MARGIN * w, FRAME_MARGIN * h
    if x1 < mx or y1 < my or x2 > w - mx or y2 > h - my:
        issues.append(_issue("out_of_frame"))

    cx1, cy1 = max(0, int(x1)), max(0, int(y1))
    cx2, cy2 = min(w, int(np.ceil(x2))), min(h, int(np.ceil(y2)))
    if cx2 - cx1 >= 3 and cy2 - cy1 >= 3:
        crop = img[cy1:cy2, cx1:cx2]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
        # Measure sharpness at a fixed face size: Laplacian variance falls with scale, so a large face would
        # otherwise read as blurry and a tiny one as sharp.
        norm = cv2.resize(gray, (BLUR_FACE_SIZE, BLUR_FACE_SIZE), interpolation=cv2.INTER_AREA)
        if float(cv2.Laplacian(norm, cv2.CV_64F).var()) < MIN_LAPLACIAN_VAR:
            issues.append(_issue("blurry"))
        brightness = float(gray.mean())
        if brightness < MIN_BRIGHTNESS:
            issues.append(_issue("too_dark"))
        elif brightness > MAX_BRIGHTNESS:
            issues.append(_issue("too_bright"))
    if not pose_ok(yaw):
        issues.append(_issue("wrong_pose"))
    return PhotoCheck(issues, face, yaw)
