"""Voiceprints (SpeechBrain ECAPA-TDNN embeddings).

Used for:
- recognising "me" (and voices the user chose to remember) in in-person meetings;
- re-checking Nemotron's speaker turns: two turns with very different voiceprints are split
  into different speakers, two speakers with near-identical voiceprints are merged.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np
import torch

from .models import is_downloaded, model_path, verify

SR = 16000
# A saved voice is recognised at this cosine similarity or more. ECAPA on call audio: the same person
# scores 0.45–0.75 (a bit lower across calls, different microphones), other people ≤ 0.30.
MATCH_SIM = 0.45
# …and only when no other person's saved voice is nearly as close (otherwise it's a guess).
MATCH_MARGIN = 0.05


class VoiceEncoder:
    def __init__(self) -> None:
        if not is_downloaded("ecapa"):
            raise RuntimeError("model ecapa is not downloaded")
        verify("ecapa")
        from speechbrain.inference.speaker import EncoderClassifier

        path = str(model_path("ecapa"))
        self.enc = EncoderClassifier.from_hparams(source=path, savedir=path, run_opts={"device": "cpu"})
        self.lock = threading.Lock()

    def embed(self, audio: np.ndarray) -> np.ndarray:
        with self.lock, torch.inference_mode():
            emb = self.enc.encode_batch(torch.from_numpy(audio.astype(np.float32))[None])
        v = emb.squeeze().cpu().numpy().astype(np.float32)
        return v / (np.linalg.norm(v) + 1e-9)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / ((np.linalg.norm(a) * np.linalg.norm(b)) + 1e-9))


class VoiceprintStore:
    """Named voiceprints saved as JSON next to the app's settings."""

    def __init__(self, path: Path):
        self.path = path
        self.items: dict[str, dict] = {}
        if path.exists():
            self.items = json.loads(path.read_text(encoding="utf-8"))

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.items, ensure_ascii=False), encoding="utf-8")

    def put(self, key: str, name: str, embedding: np.ndarray, is_me: bool = False, auto: bool = False) -> None:
        """Save a voice. `auto`: learned without a click (1:1 call named after the calendar guest);
        the user saving the same key later makes it hers."""
        old = self.items.get(key)
        if old:  # running average keeps the print stable as more audio is seen
            n = old.get("n", 1)
            merged = (np.array(old["embedding"]) * n + embedding) / (n + 1)
            embedding = merged / (np.linalg.norm(merged) + 1e-9)
            is_me = is_me or old.get("isMe", False)
            auto = auto and old.get("auto", False)
        self.items[key] = {
            "name": name, "embedding": embedding.round(5).tolist(), "isMe": is_me,
            "n": (old.get("n", 1) + 1) if old else 1,
        }
        if auto:
            self.items[key]["auto"] = True
        self.save()

    def remove(self, key: str) -> None:
        self.items.pop(key, None)
        self.save()

    def scores(self, embedding: np.ndarray, exclude_me: bool = False) -> list[tuple[str, float]]:
        """(key, similarity) for every saved voice, best first."""
        out = [
            (key, cosine(embedding, np.array(item["embedding"], dtype=np.float32)))
            for key, item in self.items.items()
            if not (exclude_me and item.get("isMe"))
        ]
        return sorted(out, key=lambda x: -x[1])

    def match(self, embedding: np.ndarray, threshold: float = MATCH_SIM, margin: float = MATCH_MARGIN,
              exclude_me: bool = False) -> tuple[str, float] | None:
        """The saved voice this embedding is, or None. Two saved voices of different people both close
        to it (within `margin`) is a guess, not a recognition: None."""
        ranked = [s for s in self.scores(embedding, exclude_me) if s[1] >= threshold]
        if not ranked:
            return None
        best = ranked[0]
        for key, sim in ranked[1:]:
            if best[1] - sim < margin and not self._same_person(best[0], key):
                return None
        return best

    def _same_person(self, a: str, b: str) -> bool:
        x, y = self.items.get(a, {}), self.items.get(b, {})
        return bool(x.get("isMe") and y.get("isMe")) or (x.get("name") or "").strip().lower() == (y.get("name") or "").strip().lower()

    def assign(self, centroids: dict[str, np.ndarray], threshold: float = MATCH_SIM, margin: float = MATCH_MARGIN,
               exclude_me: bool = False) -> dict[str, str]:
        """Names for the speakers of one recording: {label: voiceprint key}. Each saved voice goes to at
        most one speaker (the most similar), so two people in one call are never both called "Roi"."""
        hits = []
        for label, emb in centroids.items():
            hit = self.match(emb, threshold, margin, exclude_me)
            if hit:
                hits.append((hit[1], label, hit[0]))
        out: dict[str, str] = {}
        used: set[str] = set()
        for _, label, key in sorted(hits, reverse=True):
            if key not in used:
                out[label] = key
                used.add(key)
        return out
