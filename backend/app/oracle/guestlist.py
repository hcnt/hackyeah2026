"""Per-event guest lists with embeddings encrypted under a per-event key that lives only in memory.

Each event gets a random AES-256-GCM key. Each entry's embedding is encrypted with its own nonce and
bound to (event_id, wallet) through the associated data. Embeddings are decrypted only inside `match`
and `best_other`. Once an event has ended (end_ts < now) its key and entries are dropped, either by
the periodic `purge` or lazily on the next access, so an ended event behaves as if it never existed.
Not thread-safe by design: used only from the event loop.
"""

import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

EMBEDDING_DIM = 512


@dataclass
class _Entry:
    nonce: bytes
    ciphertext: bytes


@dataclass
class _EventList:
    end_ts: int
    key: bytes = field(default_factory=lambda: AESGCM.generate_key(bit_length=256))
    entries: dict[str, _Entry] = field(default_factory=dict)


def _aad(event_id: str, wallet: str) -> bytes:
    return f"{event_id}\x00{wallet}".encode()


class GuestLists:
    def __init__(self, wall_clock: Callable[[], float] = time.time) -> None:
        self._wall_clock = wall_clock
        self._events: dict[str, _EventList] = {}

    # internals

    def _get(self, event_id: str) -> _EventList | None:
        ev = self._events.get(event_id)
        if ev is not None and ev.end_ts < self._wall_clock():
            self.drop(event_id)
            return None
        return ev

    def _decrypt_all(self, event_id: str, ev: _EventList, exclude: str | None = None) -> tuple[list[str], np.ndarray]:
        aes = AESGCM(ev.key)
        wallets = [w for w in ev.entries if w != exclude]
        if not wallets:
            return [], np.zeros((0, EMBEDDING_DIM), np.float32)
        rows = [
            np.frombuffer(aes.decrypt(ev.entries[w].nonce, ev.entries[w].ciphertext, _aad(event_id, w)), np.float32)
            for w in wallets
        ]
        return wallets, np.stack(rows)

    # writes

    def put(self, event_id: str, end_ts: int, wallet: str, embedding: np.ndarray) -> None:
        if end_ts < self._wall_clock():
            raise ValueError("event has ended")
        ev = self._get(event_id)
        if ev is None:
            ev = self._events[event_id] = _EventList(end_ts=end_ts)
        ev.end_ts = end_ts
        plaintext = np.asarray(embedding, np.float32).reshape(EMBEDDING_DIM).tobytes()
        nonce = os.urandom(12)
        ciphertext = AESGCM(ev.key).encrypt(nonce, plaintext, _aad(event_id, wallet))
        ev.entries[wallet] = _Entry(nonce=nonce, ciphertext=ciphertext)

    def remove(self, event_id: str, wallet: str) -> bool:
        ev = self._get(event_id)
        return ev is not None and ev.entries.pop(wallet, None) is not None

    def drop(self, event_id: str) -> None:
        ev = self._events.pop(event_id, None)
        if ev is not None:
            ev.entries.clear()
            ev.key = b""

    def purge(self) -> list[str]:
        now = self._wall_clock()
        ended = [eid for eid, ev in self._events.items() if ev.end_ts < now]
        for eid in ended:
            self.drop(eid)
        return ended

    # reads

    def has(self, event_id: str, wallet: str) -> bool:
        ev = self._get(event_id)
        return ev is not None and wallet in ev.entries

    def count(self, event_id: str) -> int:
        ev = self._get(event_id)
        return len(ev.entries) if ev else 0

    def match(self, event_id: str, embeddings: np.ndarray, threshold: float) -> list[tuple[str | None, float]]:
        """For each embedding row: (best wallet if cosine >= threshold else None, best cosine)."""
        embeddings = np.asarray(embeddings, np.float32).reshape(-1, EMBEDDING_DIM)
        ev = self._get(event_id)
        if ev is None or not ev.entries or len(embeddings) == 0:
            return [(None, 0.0)] * len(embeddings)
        wallets, gallery = self._decrypt_all(event_id, ev)
        sims = embeddings @ gallery.T  # (n, m)
        del gallery
        out: list[tuple[str | None, float]] = []
        for row in sims:
            best = int(np.argmax(row))
            score = float(row[best])
            out.append((wallets[best] if score >= threshold else None, score))
        return out

    def best_other(self, event_id: str, embedding: np.ndarray, exclude_wallet: str) -> tuple[str | None, float]:
        """Closest entry belonging to a wallet other than `exclude_wallet` (for the duplicate-face check)."""
        ev = self._get(event_id)
        if ev is None:
            return None, 0.0
        wallets, gallery = self._decrypt_all(event_id, ev, exclude=exclude_wallet)
        if not wallets:
            return None, 0.0
        sims = gallery @ np.asarray(embedding, np.float32).reshape(EMBEDDING_DIM)
        best = int(np.argmax(sims))
        return wallets[best], float(sims[best])

    def raw_entry(self, event_id: str, wallet: str) -> tuple[bytes, bytes] | None:
        """(nonce, ciphertext) of an entry; for tests that check what is held in memory."""
        ev = self._get(event_id)
        entry = ev.entries.get(wallet) if ev else None
        return (entry.nonce, entry.ciphertext) if entry else None

    def has_key(self, event_id: str) -> bool:
        return event_id in self._events
