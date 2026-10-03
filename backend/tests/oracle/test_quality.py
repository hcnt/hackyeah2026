import cv2
import numpy as np
import pytest
from fakes import kps_for, textured

from app.oracle.face import RawFace
from app.oracle.quality import check_photo, pose_ok

BOX = [100.0, 100.0, 300.0, 340.0]  # eye distance 80 px with kps_for


def face(bbox=BOX, yaw=0.0, score=0.9) -> RawFace:
    return RawFace(bbox=list(bbox), kps=kps_for(bbox, yaw), det_score=score)


def codes(img, faces, step="straight"):
    return [i["code"] for i in check_photo(img, faces, step).issues]


def test_good_photo_has_no_issues():
    c = check_photo(textured(), [face()], "straight")
    assert c.ok and c.face_json() == {"bbox": BOX, "confidence": 0.9, "yaw": 0.0}


def test_each_issue_code():
    img = textured()
    assert codes(img, []) == ["no_face"]
    assert codes(img, [face(), face([350, 100, 600, 380])]) == ["multiple_faces"]
    assert codes(img, [face(score=0.5)]) == ["low_confidence"]
    assert codes(img, [face([100, 100, 220, 250])]) == ["too_small"]  # eye distance 48 px
    assert codes(img, [face([10, 100, 210, 340])]) == ["out_of_frame"]  # 5% margin of 640 = 32 px
    assert codes(cv2.GaussianBlur(img, (0, 0), 6), [face()]) == ["blurry"]
    assert codes(textured(mean=30.0), [face()]) == ["too_dark"]
    assert codes(textured(mean=230.0), [face()]) == ["too_bright"]
    assert codes(img, [face(yaw=0.2)], "straight") == ["wrong_pose"]


def test_multiple_faces_reports_largest():
    c = check_photo(textured(), [face(), face([350, 100, 600, 400])], "straight")
    assert c.face_json()["bbox"] == [350, 100, 600, 400]


def test_uniform_dark_image_is_dark_and_blurry():
    img = np.full((480, 640, 3), 20, np.uint8)
    assert codes(img, [face()]) == ["blurry", "too_dark"]


@pytest.mark.parametrize(
    ("step", "yaw", "ok"),
    [("straight", 0.09, True), ("straight", -0.11, False), ("left", -0.2, True), ("left", 0.2, False),
     ("left", -0.36, False), ("right", 0.35, True), ("right", 0.05, False)],
)
def test_pose_bands(step, yaw, ok):
    assert pose_ok(step, yaw) is ok
