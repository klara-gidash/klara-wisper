"""Live utterance segmentation with Silero VAD.

A Segmenter is fed 16 kHz float32 audio of any chunk size and reports utterances as
(start_sample, end_sample) in absolute stream positions. It keeps only the audio it may
still need (the open utterance plus a short look-back), so memory stays flat in long meetings.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch
from silero_vad import VADIterator, load_silero_vad

SR = 16000
WINDOW = 512  # samples per Silero step at 16 kHz


@dataclass
class Utterance:
    start: int
    end: int
    audio: np.ndarray
    forced: bool = False  # cut because it hit max length, not at a pause

    @property
    def seconds(self) -> float:
        return (self.end - self.start) / SR


class Segmenter:
    def __init__(
        self,
        min_silence_ms: int = 500,
        max_utterance_s: float = 20.0,
        pad_ms: int = 150,
        threshold: float = 0.5,
        min_utterance_s: float = 0.3,
    ) -> None:
        self.model = load_silero_vad()  # one model per stream: Silero keeps internal state
        self.it = VADIterator(
            self.model, threshold=threshold, sampling_rate=SR,
            min_silence_duration_ms=min_silence_ms, speech_pad_ms=pad_ms,
        )
        self.max_len = int(max_utterance_s * SR)
        self.min_len = int(min_utterance_s * SR)
        self.pending = np.zeros(0, dtype=np.float32)  # < WINDOW samples not yet given to VAD
        self.data = np.zeros(0, dtype=np.float32)     # retained audio
        self.base = 0                                  # absolute index of data[0]
        self.total = 0                                 # absolute samples received
        self.speech_start: int | None = None

    @property
    def speaking(self) -> bool:
        return self.speech_start is not None

    def slice(self, start: int, end: int) -> np.ndarray:
        a, b = max(start - self.base, 0), max(end - self.base, 0)
        return self.data[a:b].copy()

    def feed(self, samples: np.ndarray) -> tuple[list[Utterance], list[bool]]:
        """Returns (finished utterances, speaking-state changes)."""
        self.data = np.concatenate([self.data, samples])
        self.total += len(samples)
        buf = np.concatenate([self.pending, samples])
        done: list[Utterance] = []
        changes: list[bool] = []
        n = len(buf) // WINDOW * WINDOW
        for i in range(0, n, WINDOW):
            ev = self.it(torch.from_numpy(buf[i : i + WINDOW]))
            if ev and "start" in ev and self.speech_start is None:
                self.speech_start = int(ev["start"])
                changes.append(True)
            elif ev and "end" in ev and self.speech_start is not None:
                u = self._close(int(ev["end"]))
                if u:
                    done.append(u)
                changes.append(False)
            if self.speech_start is not None:
                pos = self.total - len(buf) + i + WINDOW
                if pos - self.speech_start >= self.max_len:
                    done.append(self._force_cut(pos))
        self.pending = buf[n:]
        self._trim()
        return done, changes

    def flush(self) -> Utterance | None:
        """Close the open utterance at end of stream (or at release of the dictation key)."""
        if self.speech_start is None:
            return None
        u = self._close(self.total)
        self.it.reset_states()
        return u

    def flush_all(self, since: int) -> Utterance | None:
        """Everything from `since` to now, regardless of VAD (used for the dictation tail)."""
        self.it.reset_states()
        self.speech_start = None
        if self.total - since < self.min_len:
            return None
        return Utterance(since, self.total, self.slice(since, self.total))

    def _close(self, end: int) -> Utterance | None:
        start, self.speech_start = self.speech_start, None
        if start is None or end - start < self.min_len:
            return None
        return Utterance(start, end, self.slice(start, end))

    def _force_cut(self, pos: int) -> Utterance:
        """Cut a long utterance at the quietest 100 ms of its last 3 seconds."""
        start = self.speech_start or 0
        look = self.slice(max(pos - 3 * SR, start), pos)
        hop = SR // 10
        if len(look) >= 2 * hop:
            energy = [float(np.mean(look[j : j + hop] ** 2)) for j in range(0, len(look) - hop, hop)]
            cut = pos - len(look) + int(np.argmin(energy)) * hop + hop // 2
        else:
            cut = pos
        self.speech_start = cut
        return Utterance(start, cut, self.slice(start, cut), forced=True)

    def _trim(self) -> None:
        keep_from = self.speech_start if self.speech_start is not None else self.total - SR
        keep_from = max(keep_from - SR, self.base)  # 1 s look-back for padding
        drop = keep_from - self.base
        if drop > 0:
            self.data = self.data[drop:]
            self.base += drop
