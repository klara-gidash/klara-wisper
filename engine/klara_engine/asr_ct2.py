"""Whisper on CTranslate2 (faster-whisper): the ASR backend for Windows (and any non-Apple machine).

Same contract as asr.WhisperASR: one utterance (<= 30 s, 16 kHz float32 mono) in, one Transcript
out, one encoder pass per call (CTranslate2 reuses the encoder output for language detection and
for every temperature fallback). The default model is ivrit.ai's Hebrew large-v3-turbo converted
to CTranslate2; like the MLX version it is always forced to Hebrew.

Device: CPU with int8 weights by default (works on every PC). KLARA_ASR_DEVICE=cuda uses an
NVIDIA GPU (float16), which needs the CUDA 12 cuBLAS/cuDNN runtime.
"""

from __future__ import annotations

import os
import time

import numpy as np
from faster_whisper import WhisperModel

from .asr_common import asr_language
from .asr_common import SAMPLE_RATE, Transcript, _he_en, build_prompt, choose_language, clean
from .models import is_downloaded, model_path, verify

N_SAMPLES = 30 * SAMPLE_RATE


def _threads() -> int:
    # Leave cores for the app, VAD and the browser running the call.
    return max(2, min(8, (os.cpu_count() or 4) - 2))


class CT2WhisperASR:
    def __init__(self, model_key: str = "whisper-ivrit-turbo-ct2"):
        if not is_downloaded(model_key):
            raise RuntimeError(f"model {model_key} is not downloaded")
        verify(model_key)
        self.model_key = model_key
        device = os.environ.get("KLARA_ASR_DEVICE", "cpu")
        compute = os.environ.get("KLARA_ASR_COMPUTE", "float16" if device == "cuda" else "int8")
        self.model = WhisperModel(
            str(model_path(model_key)), device=device, compute_type=compute,
            cpu_threads=_threads(), num_workers=1, local_files_only=True,
        )
        self.forced_lang = "he" if "ivrit" in model_key or asr_language() == "he" else None
        self.warmup()

    def warmup(self) -> None:
        self.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))

    def build_prompt(self, lang: str, mixed: bool, vocabulary: list[str], previous: tuple[str, str] | None) -> str | None:
        return build_prompt(lang, mixed, vocabulary, previous)

    def detect(self, audio: np.ndarray) -> dict[str, float]:
        _, _, probs = self.model.detect_language(audio[:N_SAMPLES].astype(np.float32))
        return dict(probs)

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        vocabulary: list[str] | None = None,
        previous: tuple[str, str] | None = None,
        force_lang: str | None = None,
    ) -> Transcript:
        t0 = time.perf_counter()
        audio = audio[:N_SAMPLES].astype(np.float32)
        force_lang = force_lang or self.forced_lang
        if force_lang:
            lang, mixed, probs = force_lang, False, {force_lang: 1.0}
        else:
            probs = self.detect(audio)
            lang, mixed = choose_language(probs)
        prompt = build_prompt(lang, mixed, vocabulary or [], previous)
        segments, _info = self.model.transcribe(
            audio,
            language=lang,
            task="transcribe",
            initial_prompt=prompt,
            beam_size=1,  # greedy, like the MLX path (DecodingOptions default)
            temperature=[0.0, 0.3, 0.6],
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            condition_on_previous_text=False,
            without_timestamps=True,
            vad_filter=False,  # the engine already cut the audio with Silero VAD
        )
        segs = list(segments)
        text = " ".join(s.text.strip() for s in segs).strip()
        avg_logprob = float(np.mean([s.avg_logprob for s in segs])) if segs else -2.0
        no_speech = float(max((s.no_speech_prob for s in segs), default=1.0))
        text = clean(text, avg_logprob, no_speech, len(audio))
        return Transcript(
            text=text, lang=lang, lang_probs=_he_en(probs), mixed=mixed,
            avg_logprob=avg_logprob, no_speech_prob=no_speech,
            model=self.model_key, ms=int((time.perf_counter() - t0) * 1000),
        )
