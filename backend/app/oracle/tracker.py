"""Face tracks across frames (box overlap) and identification by a rolling vote of match results.

Pure and synchronous; times come from the caller so tests can drive a fake clock.
A track keeps only wallet ids from past matches, never embeddings.
"""

from collections import Counter, deque
from dataclasses import dataclass, field

IOU_THRESHOLD = 0.3
TRACK_MAX_AGE_SECS = 1.5
IDENTIFIED_REEMBED_SECS = 1.0
VOTE_WINDOW = 5
VOTES_NEEDED = 3


def iou(a: list[float], b: list[float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    return inter / (area_a + area_b - inter)


@dataclass
class Track:
    id: int
    bbox: list[float]
    first_seen: float
    last_seen: float
    last_embed: float | None = None
    results: deque = field(default_factory=lambda: deque(maxlen=VOTE_WINDOW))
    wallet: str | None = None
    identified_at: float | None = None

    def needs_embedding(self, now: float) -> bool:
        if self.wallet is None or self.last_embed is None:
            return True
        return now - self.last_embed >= IDENTIFIED_REEMBED_SECS

    def record(self, wallet: str | None, now: float) -> None:
        """Add one match result (wallet at/above threshold, or None) and re-run the vote."""
        self.results.append(wallet)
        self.last_embed = now
        votes = Counter(w for w in self.results if w is not None)
        winner = next((w for w, n in votes.most_common(1) if n >= VOTES_NEEDED), None)
        if winner != self.wallet:
            self.wallet = winner
            self.identified_at = now if winner is not None else None

    def seen_secs(self, now: float) -> float:
        return now - self.identified_at if self.identified_at is not None else 0.0


class Tracker:
    def __init__(self) -> None:
        self.tracks: list[Track] = []
        self._next_id = 1
        self._last_update: float | None = None

    def update(self, bboxes: list[list[float]], now: float) -> list[Track]:
        """Associate this frame's boxes to tracks; returns the track for each box, in order."""
        # With slow frames (CPU under load) a fixed window would drop every track before it is seen again.
        max_age = TRACK_MAX_AGE_SECS
        if self._last_update is not None:
            max_age = max(max_age, 3 * (now - self._last_update))
        self._last_update = now
        self.tracks = [t for t in self.tracks if now - t.last_seen <= max_age]
        pairs = sorted(
            ((iou(t.bbox, b), ti, bi) for ti, t in enumerate(self.tracks) for bi, b in enumerate(bboxes)),
            reverse=True,
        )
        assigned: dict[int, Track] = {}
        used_tracks: set[int] = set()
        for score, ti, bi in pairs:
            if score < IOU_THRESHOLD:
                break
            if ti in used_tracks or bi in assigned:
                continue
            used_tracks.add(ti)
            assigned[bi] = self.tracks[ti]
        out: list[Track] = []
        for bi, box in enumerate(bboxes):
            track = assigned.get(bi)
            if track is None:
                track = Track(id=self._next_id, bbox=list(box), first_seen=now, last_seen=now)
                self._next_id += 1
                self.tracks.append(track)
            track.bbox = list(box)
            track.last_seen = now
            out.append(track)
        return out
