"""Whisper (MLX) transcription, Hebrew first.

Each utterance (<= 30 s, cut by VAD) is encoded exactly once; the same encoder features are
reused for language detection (when used) and for every decoding attempt (temperature fallback).

The default model is ivrit.ai's Hebrew fine-tune of large-v3-turbo: ~45% fewer Hebrew errors
than OpenAI large-v3 and several times faster. It always transcribes as Hebrew (its language
detection was degraded by the fine-tune); English words come out in Latin letters or transliterated.
"""

from __future__ import annotations

import time

import mlx.core as mx
import numpy as np
from mlx_whisper.audio import N_FRAMES, N_SAMPLES, SAMPLE_RATE, log_mel_spectrogram, pad_or_trim
from mlx_whisper.decoding import DecodingOptions, DecodingTask, GreedyDecoder, categorical, detect_language
from mlx_whisper.load_models import load_model
from mlx_whisper.tokenizer import get_tokenizer

from .asr_common import asr_language
from .asr_common import (  # noqa: F401  (re-exported: tests and older imports use asr.*)
    BIDI_MARKS, BILINGUAL_PROMPT, HALLUCINATIONS, MIXED_RATIO, Transcript, _he_en, build_prompt, choose_language, clean,
)
from .asr_common import seg_conf, unsure_words
from .models import is_downloaded, model_path, verify

# MLX keeps freed GPU buffers for reuse; without a cap that cache grows by gigabytes over a
# long meeting and pushes a 16 GB Mac into swap.
mx.set_cache_limit(256 * 1024 * 1024)

class _TokenLogprobs(GreedyDecoder):
    """mlx-whisper's greedy decoder, also keeping the log-probability of each token it picks.

    Those values are already computed for avg_logprob; keeping them costs nothing extra (no second
    Whisper pass, unlike word timestamps). Same logic as GreedyDecoder.update (mlx-whisper 0.4.3)."""

    def reset(self) -> None:
        self.steps: list[mx.array] = []

    def update(self, tokens: mx.array, logits: mx.array, sum_logprobs: mx.array):
        if self.temperature == 0:
            next_tokens = logits.argmax(axis=-1)
        else:
            next_tokens = categorical(logits, self.temperature)
        logprobs = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
        current_logprobs = logprobs[mx.arange(logprobs.shape[0]), next_tokens]
        self.steps.append(current_logprobs)
        sum_logprobs += current_logprobs * (tokens[:, -1] != self.eot)
        eot_mask = tokens[:, -1] == self.eot
        next_tokens = next_tokens * (1 - eot_mask) + self.eot * eot_mask
        tokens = mx.concatenate([tokens, next_tokens[:, None]], axis=-1)
        completed = mx.all(tokens[:, -1] == self.eot)
        return tokens, completed, sum_logprobs

    def token_logprobs(self, n: int) -> list[float]:
        """Log-probabilities of the first n picked tokens (step i picked token i)."""
        steps = self.steps[:n]
        return mx.concatenate(steps).tolist() if steps else []


def decode_with_logprobs(model, features: mx.array, options: DecodingOptions):
    """mlx_whisper.decode for one utterance, plus each output token's log-probability."""
    task = DecodingTask(model, options)
    recorder = _TokenLogprobs(options.temperature, task.tokenizer.eot)
    recorder.reset()
    task.decoder = recorder
    result = task.run(features)[0]
    return result, recorder.token_logprobs(len(result.tokens))


class WhisperASR:
    def __init__(self, model_key: str = "whisper-large-v3"):
        if not is_downloaded(model_key):
            raise RuntimeError(f"model {model_key} is not downloaded")
        verify(model_key)
        self.model_key = model_key
        self.path = str(model_path(model_key))
        self.model = load_model(self.path, dtype=mx.float16)
        self.tokenizer = get_tokenizer(
            self.model.is_multilingual, num_languages=self.model.num_languages, task="transcribe"
        )
        # Hebrew fine-tunes can't be trusted to detect the language: always transcribe as Hebrew.
        # Settings > language: "he" (default) forces Hebrew with any model; "auto" lets OpenAI's models
        # tell Hebrew from English per utterance (Israeli English included).
        self.forced_lang = "he" if "ivrit" in model_key or asr_language() == "he" else None
        self.warmup()

    def warmup(self) -> None:
        self.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))

    def _features(self, audio: np.ndarray) -> mx.array:
        mel = log_mel_spectrogram(audio, n_mels=self.model.dims.n_mels)
        mel = pad_or_trim(mel, N_FRAMES, axis=-2).astype(mx.float16)
        return self.model.encoder(mel[None])

    def detect(self, audio: np.ndarray) -> dict[str, float]:
        _, probs = detect_language(self.model, self._features(audio), self.tokenizer)
        return probs[0]

    def build_prompt(self, lang: str, mixed: bool, vocabulary: list[str], previous: tuple[str, str] | None) -> str | None:
        return build_prompt(lang, mixed, vocabulary, previous)

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        vocabulary: list[str] | None = None,
        previous: tuple[str, str] | None = None,
        force_lang: str | None = None,
    ) -> Transcript:
        """Transcribe one utterance (<= 30 s of 16 kHz float32 mono): one encoder pass."""
        t0 = time.perf_counter()
        audio = audio[:N_SAMPLES].astype(np.float32)
        features = self._features(audio)
        force_lang = force_lang or self.forced_lang
        if force_lang:
            lang, mixed, probs = force_lang, False, {force_lang: 1.0}
        else:
            _, probs_list = detect_language(self.model, features, self.tokenizer)
            probs = probs_list[0]
            lang, mixed = choose_language(probs)
        prompt = self.build_prompt(lang, mixed, vocabulary or [], previous)

        result, logprobs = None, []
        for temperature in (0.0, 0.3, 0.6):
            options = DecodingOptions(
                task="transcribe", language=lang, prompt=prompt, temperature=temperature,
                without_timestamps=True, fp16=True,
            )
            result, logprobs = decode_with_logprobs(self.model, features, options)
            if result.no_speech_prob > 0.6 and result.avg_logprob < -1.0:
                break  # silence; don't retry
            if result.compression_ratio <= 2.4 and result.avg_logprob >= -1.0:
                break
        assert result is not None
        text = clean(result.text, result.avg_logprob, result.no_speech_prob, len(audio))
        words = unsure_words(result.tokens, logprobs, self.tokenizer.split_to_word_tokens, text, self.tokenizer.eot) if text else []
        return Transcript(
            text=text, lang=lang, lang_probs=_he_en(probs), mixed=mixed,
            avg_logprob=float(result.avg_logprob), no_speech_prob=float(result.no_speech_prob),
            model=self.model_key, ms=int((time.perf_counter() - t0) * 1000),
            conf=seg_conf(result.avg_logprob), words=words,
        )
