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
            self.items = json.loads(path.read_text())

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.items, ensure_ascii=False))

    def put(self, key: str, name: str, embedding: np.ndarray, is_me: bool = False) -> None:
        old = self.items.get(key)
        if old:  # running average keeps the print stable as more audio is seen
            n = old.get("n", 1)
            merged = (np.array(old["embedding"]) * n + embedding) / (n + 1)
            embedding = merged / (np.linalg.norm(merged) + 1e-9)
            is_me = is_me or old.get("isMe", False)
        self.items[key] = {
            "name": name, "embedding": embedding.round(5).tolist(), "isMe": is_me,
            "n": (old.get("n", 1) + 1) if old else 1,
        }
        self.save()

    def remove(self, key: str) -> None:
        self.items.pop(key, None)
        self.save()

    def match(self, embedding: np.ndarray, threshold: float = 0.45) -> tuple[str, float] | None:
        best: tuple[str, float] | None = None
        for key, item in self.items.items():
            sim = cosine(embedding, np.array(item["embedding"], dtype=np.float32))
            if sim >= threshold and (best is None or sim > best[1]):
                best = (key, sim)
        return best
