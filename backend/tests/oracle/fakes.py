"""Injected ground truth for oracle tests: a fake face engine, synthetic embeddings, a fake clock and sinks."""

import numpy as np

from app.oracle.face import RawFace, normalize
from app.oracle.interfaces import SightingResult

DIM = 512


def unit(rng: np.random.Generator) -> np.ndarray:
    return normalize(rng.standard_normal(DIM).astype(np.float32))


def near(v: np.ndarray, rng: np.random.Generator, sigma: float = 0.02) -> np.ndarray:
    """A noisy copy of v; sigma=0.02 gives cosine ~0.9 with v."""
    return normalize(v + sigma * rng.standard_normal(DIM).astype(np.float32))


def kps_for(bbox: list[float], yaw: float) -> np.ndarray:
    """Five keypoints inside bbox whose yaw proxy equals `yaw` (eye distance = 40% of box width)."""
    x1, y1, x2, y2 = bbox
    w, h = x2 - x1, y2 - y1
    d = 0.4 * w
    cx = x1 + w / 2
    le, re = (cx - d / 2, y1 + 0.35 * h), (cx + d / 2, y1 + 0.35 * h)
    nose = (cx + yaw * d, y1 + 0.55 * h)
    return np.array([le, re, nose, (cx - d / 3, y1 + 0.75 * h), (cx + d / 3, y1 + 0.75 * h)], np.float32)


def textured(h: int = 480, w: int = 640, mean: float = 128.0, seed: int = 0) -> np.ndarray:
    """A sharp mid-brightness BGR image (noise texture: high Laplacian variance)."""
    rng = np.random.default_rng(seed)
    img = np.clip(mean + 40 * rng.standard_normal((h, w)), 0, 255).astype(np.uint8)
    return np.repeat(img[:, :, None], 3, axis=2)


class FakeEngine:
    """Frames are byte keys. `scenes[key]` = list of (bbox, yaw, embedding[, det_score]); `images[key]` is the
    decoded pixel array (default: `textured()`). b"bad..." or an unknown key fails to decode."""

    def __init__(self) -> None:
        self.scenes: dict[bytes, list[tuple]] = {}
        self.images: dict[bytes, np.ndarray] = {}
        self._key_of: dict[int, bytes] = {}
        self._emb: dict[int, np.ndarray] = {}
        self.embed_calls: list[int] = []

    def set(self, key: bytes, faces: list[tuple], image: np.ndarray | None = None) -> bytes:
        self.scenes[key] = faces
        img = textured() if image is None else image
        self.images[key] = img
        self._key_of[id(img)] = key
        return key

    def decode(self, data: bytes) -> np.ndarray:
        if data.startswith(b"bad") or data not in self.scenes:
            raise ValueError("not a decodable image")
        return self.images[data]

    def detect(self, img) -> list[RawFace]:
        key = img if isinstance(img, bytes) else self._key_of[id(img)]
        out = []
        for bbox, yaw, emb, *rest in self.scenes[key]:
            f = RawFace(bbox=list(bbox), kps=kps_for(bbox, yaw), det_score=rest[0] if rest else 0.9)
            self._emb[id(f)] = emb
            out.append(f)
        return out

    def embed(self, img, faces: list[RawFace]) -> np.ndarray:
        self.embed_calls.append(len(faces))
        if not faces:
            return np.zeros((0, DIM), np.float32)
        return np.stack([self._emb[id(f)] for f in faces])


class FakeClock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


class RecordingSink:
    """A stand-in for the program, written independently of the code under test: pays a wallet once its reports
    span >= `min_seen` seconds of the fake clock (a gap > 60 s restarts it). Records every report() call with the
    fake-clock time; fails the first `fail_times` calls."""

    def __init__(self, clock: FakeClock, min_seen: float = 0, fail_times: int = 0) -> None:
        self.clock = clock
        self.min_seen = min_seen
        self.fail_times = fail_times
        self.calls: list[tuple[str, str, float]] = []
        self.successes: list[tuple[str, str]] = []  # payouts
        self.paid_at: list[float] = []
        self._first: dict[tuple[str, str], float] = {}
        self._last: dict[tuple[str, str], float] = {}
        self._tx: dict[tuple[str, str], str] = {}

    async def report(self, event_id: str, wallet: str) -> SightingResult:
        now = self.clock()
        self.calls.append((event_id, wallet, now))
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("chain unavailable")
        key = (event_id, wallet)
        if key in self._tx:
            return SightingResult(paid=True, tx=self._tx[key])
        if key not in self._first or now - self._last[key] > 60:
            self._first[key] = now
        self._last[key] = now
        if now - self._first[key] < self.min_seen:
            return SightingResult(paid=False)
        self.successes.append(key)
        self.paid_at.append(now)
        self._tx[key] = f"tx-{wallet}-{len(self.successes)}"
        return SightingResult(paid=True, tx=self._tx[key])
