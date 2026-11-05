"""Speaker diarization with NVIDIA Nemotron-3-Diarization (Transformers).

Two modes:
- StreamingDiarizer: fed live audio, keeps per-frame speaker probabilities (~1 s latency).
- Diarizer.offline(): one pass over a whole recording at the end of a meeting (best accuracy).

Frame rate of the output is 100 frames per second (10 ms); up to 8 speakers.
"""

from __future__ import annotations

import os
import threading

import numpy as np
import torch
from transformers import AutoModelForAudioFrameClassification, AutoProcessor

from .models import is_downloaded, model_path, verify

SR = 16000
FPS = 100  # output frames per second


def _device() -> str:
    pref = os.environ.get("KLARA_DIAR_DEVICE")
    if pref:
        return pref
    return "cpu"


class Diarizer:
    """Holds the model; thread-safe because inference runs under a lock."""

    def __init__(self) -> None:
        if not is_downloaded("nemotron-diarization"):
            raise RuntimeError("model nemotron-diarization is not downloaded")
        verify("nemotron-diarization")
        path = str(model_path("nemotron-diarization"))
        self.processor = AutoProcessor.from_pretrained(path)
        self.device = _device()
        self.model = AutoModelForAudioFrameClassification.from_pretrained(path).to(self.device).eval()
        self.lock = threading.Lock()

    def _run(self, inputs, speaker_cache=None):
        inputs = inputs.to(self.device, dtype=self.model.dtype)
        with self.lock, torch.inference_mode():
            out = self.model(**inputs, speaker_cache=speaker_cache) if speaker_cache is not None or "num_lookahead_frames" in inputs else self.model(**inputs)
        return out

    def offline(self, audio: np.ndarray) -> np.ndarray:
        """Return speaker probabilities [frames, 8] for a whole recording."""
        if len(audio) < SR // 2:
            return np.zeros((0, 8), dtype=np.float32)
        inputs = self.processor(audio.astype(np.float32), sampling_rate=SR)
        out = self._run(inputs)
        return out.logits[0].float().sigmoid().cpu().numpy()

    def offline_windows(self, audio: np.ndarray, window_s: float = 120.0):
        """Speaker probabilities for a long recording, window by window: yields (offset_s, probs).

        Speaker indices are only consistent inside a window (voiceprints tie windows together).
        The model lock is released between windows, so a new recording isn't held up.
        """
        step = int(window_s * SR)
        for start in range(0, len(audio), step):
            chunk = audio[start : start + step]
            if len(chunk) >= SR:
                yield start / SR, self.offline(chunk)

    def streaming(self, mode: str = "low_latency") -> "StreamingDiarizer":
        return StreamingDiarizer(self, mode)


class StreamingDiarizer:
    def __init__(self, diarizer: Diarizer, mode: str):
        self.d = diarizer
        self.p = diarizer.processor
        self.p.set_streaming_mode(mode)
        self.audio = np.zeros(0, dtype=np.float32)
        self.base = 0  # absolute sample index of audio[0]; older audio is dropped as chunks complete
        self.first = True
        self.step = 0
        self.start = 0
        self.cache = None
        self.chunks: list[np.ndarray] = []
        self.finished = False

    @property
    def probs(self) -> np.ndarray:
        return np.concatenate(self.chunks) if self.chunks else np.zeros((0, 8), dtype=np.float32)

    def feed(self, samples: np.ndarray) -> int:
        """Append audio; run every chunk that is now complete. Returns number of chunks run."""
        self.audio = np.concatenate([self.audio, samples.astype(np.float32)])
        ran = 0
        while True:
            if self.first:
                n = self.p.num_samples_first_audio_chunk
                if len(self.audio) < n:
                    break
                chunk, first = self.audio[:n], True
            else:
                n = self.p.num_samples_per_audio_chunk
                a = self.start - self.base
                if a + n > len(self.audio):
                    break
                chunk, first = self.audio[a : a + n], False
            self._run_chunk(chunk, first=first, last=False)
            self.first = False
            self.step += self.p.num_mel_frames_per_step
            self.start = self.p.audio_chunk_start(self.step)
            ran += 1
        # Keep only what the next chunk still needs (the full recording is read from disk at the end).
        drop = max(0, min(self.start, len(self.audio) + self.base) - self.base) if not self.first else 0
        if drop:
            self.audio = self.audio[drop:]
            self.base += drop
        return ran

    def finish(self) -> np.ndarray:
        if not self.finished and len(self.audio) > 0:
            tail = self.audio if self.first else self.audio[max(self.start - self.base, 0) :]
            if len(tail) > self.d.processor.feature_extractor.win_length:
                self._run_chunk(tail, first=self.first, last=True)
            self.finished = True
        return self.probs

    def _run_chunk(self, chunk: np.ndarray, *, first: bool, last: bool) -> None:
        inputs = self.p(chunk, sampling_rate=SR, is_streaming=True, is_first_audio_chunk=first, is_last_audio_chunk=last)
        out = self.d._run(inputs, speaker_cache=self.cache)
        self.cache = out.speaker_cache
        self.chunks.append(out.logits[0].float().sigmoid().cpu().numpy())


def speaker_for(probs: np.ndarray, start: float, end: float, min_activity: float = 0.3) -> int | None:
    """Dominant speaker index for a time range, or None if nobody is clearly active."""
    a, b = int(start * FPS), max(int(end * FPS), int(start * FPS) + 1)
    window = probs[a:b]
    if len(window) == 0:
        return None
    mean = window.mean(axis=0)
    best = int(mean.argmax())
    return best if mean[best] >= min_activity else None


def segments(probs: np.ndarray, threshold: float = 0.5, min_dur: float = 0.2) -> list[dict]:
    """Speaker turns [{start, end, speaker}] from frame probabilities."""
    out: list[dict] = []
    if len(probs) == 0:
        return out
    active = probs > threshold
    for spk in range(probs.shape[1]):
        col = np.concatenate([[False], active[:, spk], [False]]).astype(np.int8)
        d = np.diff(col)
        for s, e in zip(np.where(d == 1)[0], np.where(d == -1)[0]):
            if (e - s) / FPS >= min_dur:
                out.append({"start": round(s / FPS, 2), "end": round(e / FPS, 2), "speaker": spk})
    out.sort(key=lambda x: (x["start"], x["speaker"]))
    return out
