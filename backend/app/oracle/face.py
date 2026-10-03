"""Face detection + recognition: SCRFD and ArcFace from InsightFace's buffalo_l pack on CPU (onnxruntime).

The oracle talks to faces only through `FaceEngine` (decode / detect / embed), so tests can inject a fake.
`InsightFaceEngine` is the real one. Inference is serialised with one lock: onnxruntime sessions are
thread-safe, but SCRFD keeps a shared anchor cache, and one lock keeps the CPU from being oversubscribed.
"""

import threading
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

import cv2
import numpy as np
from insightface.app import FaceAnalysis
from insightface.utils import face_align

from app.config import get_settings

# Cosine similarity at or above which a face counts as an enrolled person. ArcFace (buffalo_l)
# same-person pairs typically score 0.5-0.8 and different people below 0.3.
MATCH_THRESHOLD = 0.40

_JPEG_MAGIC = b"\xff\xd8\xff"
_inference_lock = threading.Lock()


@dataclass
class RawFace:
    """One detection, before recognition."""

    bbox: list[float]  # x1, y1, x2, y2 in image pixels
    kps: np.ndarray  # (5, 2): left eye, right eye, nose, left mouth corner, right mouth corner
    det_score: float


@dataclass
class DetectedFace:
    bbox: list[float]
    det_score: float
    embedding: np.ndarray  # L2-normalised, 512-d


class FaceEngine(Protocol):
    def decode(self, data: bytes) -> Any:
        """Decode an uploaded frame; raise ValueError if it is not a usable JPEG."""

    def detect(self, img: Any) -> list[RawFace]: ...

    def embed(self, img: Any, faces: list[RawFace]) -> np.ndarray:
        """L2-normalised embeddings, shape (len(faces), 512), one row per face in order."""


def normalize(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    if v.ndim == 1:
        return v / max(float(np.linalg.norm(v)), 1e-12)
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)


@lru_cache
def get_model() -> FaceAnalysis:
    if get_settings().oracle_device == "cuda":
        # onnxruntime-gpu finds the pip-installed CUDA/cuDNN libraries only after this; without it, it silently
        # falls back to the CPU.
        import onnxruntime

        onnxruntime.preload_dlls()
        providers, ctx_id = ["CUDAExecutionProvider", "CPUExecutionProvider"], 0
    else:
        providers, ctx_id = ["CPUExecutionProvider"], -1
    model = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"], providers=providers)
    model.prepare(ctx_id=ctx_id, det_size=(640, 640))
    return model


def decode_jpeg(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not a decodable image")
    return img


class InsightFaceEngine:
    def decode(self, data: bytes) -> np.ndarray:
        if not data.startswith(_JPEG_MAGIC):
            raise ValueError("not a JPEG image")
        return decode_jpeg(data)

    def warmup(self) -> None:
        get_model()

    def detect(self, img: np.ndarray) -> list[RawFace]:
        model = get_model()
        with _inference_lock:
            bboxes, kpss = model.det_model.detect(img, max_num=0, metric="default")
        return [
            RawFace(bbox=[float(v) for v in bboxes[i, :4]], kps=np.asarray(kpss[i], np.float32), det_score=float(bboxes[i, 4]))
            for i in range(bboxes.shape[0])
        ]

    def embed(self, img: np.ndarray, faces: list[RawFace]) -> np.ndarray:
        if not faces:
            return np.zeros((0, 512), np.float32)
        rec = get_model().models["recognition"]
        crops = [face_align.norm_crop(img, landmark=f.kps, image_size=rec.input_size[0]) for f in faces]
        with _inference_lock:
            feats = rec.get_feat(crops)
        return normalize(feats)


def analyze(img: np.ndarray) -> list[DetectedFace]:
    """Detect + embed every face (used by the spike page)."""
    engine = InsightFaceEngine()
    faces = engine.detect(img)
    embs = engine.embed(img, faces)
    return [DetectedFace(bbox=f.bbox, det_score=f.det_score, embedding=e) for f, e in zip(faces, embs, strict=True)]
