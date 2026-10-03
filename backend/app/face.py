"""Spike page gallery (in memory, manual testing only). The face model itself lives in app.oracle.face."""

import threading
import time

import numpy as np

from app.oracle.face import (
    MATCH_THRESHOLD,
    DetectedFace,
    analyze,
    decode_jpeg,
    get_model,
)

__all__ = ["MATCH_THRESHOLD", "DetectedFace", "Gallery", "analyze", "decode_jpeg", "gallery", "get_model", "recognize_frame"]


class Gallery:
    """Enrolled people: name -> embedding. Thread-safe; inference runs in a threadpool."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._people: dict[str, np.ndarray] = {}

    def add(self, name: str, embedding: np.ndarray) -> None:
        with self._lock:
            self._people[name] = embedding

    def remove(self, name: str) -> bool:
        with self._lock:
            return self._people.pop(name, None) is not None

    def names(self) -> list[str]:
        with self._lock:
            return sorted(self._people)

    def match(self, embedding: np.ndarray) -> tuple[str | None, float]:
        with self._lock:
            if not self._people:
                return None, 0.0
            names = list(self._people)
            sims = np.stack([self._people[n] for n in names]) @ embedding
        best = int(np.argmax(sims))
        score = float(sims[best])
        return (names[best] if score >= MATCH_THRESHOLD else None), score


gallery = Gallery()


def recognize_frame(data: bytes) -> dict:
    """Decode one JPEG frame, detect every face and match each against the gallery."""
    started = time.perf_counter()
    img = decode_jpeg(data)
    faces = []
    for f in analyze(img):
        name, score = gallery.match(f.embedding)
        faces.append({"bbox": f.bbox, "det_score": round(f.det_score, 3), "name": name, "score": round(score, 3)})
    h, w = img.shape[:2]
    return {"width": w, "height": h, "faces": faces, "ms": round((time.perf_counter() - started) * 1000)}
