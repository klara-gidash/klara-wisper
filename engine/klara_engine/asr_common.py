"""What every ASR backend shares: the result type, the language choice, the prompt, and the
clean-up of Whisper's usual hallucinations. No ML imports here, so it loads on any platform."""

from __future__ import annotations

import math
import string
from dataclasses import dataclass, field
from typing import Callable, Sequence

SAMPLE_RATE = 16000

# Both languages count as "plausible" when the weaker one has at least this share of the stronger.
MIXED_RATIO = 0.25

# A short prompt in mixed Hebrew/English nudges Whisper to keep English terms in Latin script.
BILINGUAL_PROMPT = "שלום, עברנו על ה-roadmap וה-pricing של Q4, וקבענו follow-up עם ה-team."

# Phrases Whisper tends to invent on silence or noise.
HALLUCINATIONS = {
    "תודה רבה.", "תודה רבה", "תודה.", "תודה על הצפייה.", "תודה שצפיתם.", "כתוביות", "כתוביות:",
    "thank you.", "thank you", "thanks for watching!", "thanks for watching.", "you",
    "subtitles by the amara.org community", ".", "...",
}


@dataclass
class Transcript:
    text: str
    lang: str
    lang_probs: dict[str, float]
    mixed: bool
    avg_logprob: float
    no_speech_prob: float
    model: str
    ms: int
    # How sure the model was, 0..1: exp(avg_logprob) of the decode (both backends).
    conf: float | None = None
    # Only the words it was unsure of: {"t": word, "p": probability 0..1, "i": offset in text}.
    # None = the backend has no per-word probabilities (CTranslate2); [] = every word was confident.
    words: list[dict] | None = field(default=None)


def choose_language(probs: dict[str, float]) -> tuple[str, bool]:
    """Hebrew unless the clip is clearly English (most speech here is Hebrew; short Hebrew clips
    were often misread as English and came out as English nonsense)."""
    he = probs.get("he", 0.0) + 0.5 * (probs.get("yi", 0.0) + probs.get("ar", 0.0))
    en = probs.get("en", 0.0)
    lang = "en" if en >= 0.85 and en > 4 * he else "he"
    mixed = min(he, en) >= MIXED_RATIO * max(he, en, 1e-9)
    return lang, mixed


def build_prompt(lang: str, mixed: bool, vocabulary: list[str], previous: tuple[str, str] | None) -> str | None:
    parts: list[str] = []
    if vocabulary:
        parts.append(", ".join(vocabulary) + ".")
    if lang == "he" and mixed:
        parts.append(BILINGUAL_PROMPT)
    if previous and previous[1] == lang:  # context only helps in the same language
        parts.append(previous[0][-200:])
    return " ".join(parts) or None


def _he_en(probs: dict[str, float]) -> dict[str, float]:
    return {"he": round(probs.get("he", 0.0), 4), "en": round(probs.get("en", 0.0), 4)}


BIDI_MARKS = dict.fromkeys(map(ord, "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"))


def clean(text: str, avg_logprob: float, no_speech_prob: float, n_samples: int) -> str:
    text = text.translate(BIDI_MARKS).strip()  # the app sets each line's direction itself
    if no_speech_prob > 0.6 and avg_logprob < -1.0:
        return ""
    if text.lower() in HALLUCINATIONS and (n_samples < 4 * SAMPLE_RATE or avg_logprob < -0.6):
        return ""
    return text


def asr_language() -> str:
    """Settings > transcription language: "he" (Hebrew only, the default) or "auto" (Hebrew + English)."""
    import os

    return "auto" if os.environ.get("KLARA_ASR_LANGUAGE") == "auto" else "he"


# ---- confidence (roadmap item 4) ----
# Taken from the one decode that made the text: no extra Whisper pass (word timestamps were removed
# for speed, and this must not bring that cost back).

# A word is "unsure" below this probability (mean of its tokens' probabilities, as in Whisper's
# word timestamps). Tuned on the test recordings: clear speech sits above 0.8, misheard names and
# mumbled words below 0.5.
WORD_UNSURE = 0.5
# With no per-word probabilities (CTranslate2) or no unsure word, a whole line counts as unsure below
# this segment confidence (exp(avg_logprob) ~ -0.43; Whisper retries at -1.0). Same value in
# src/shared/confidence.ts.
LINE_UNSURE = 0.65
# Words kept per segment at most (the least sure ones), so transcript.json stays small.
MAX_UNSURE_WORDS = 12


def seg_conf(avg_logprob: float) -> float:
    """Segment confidence 0..1 from Whisper's average token log-probability."""
    if not math.isfinite(avg_logprob):
        return 0.0
    return round(min(1.0, max(0.0, math.exp(avg_logprob))), 2)


def unsure_words(
    tokens: Sequence[int],
    token_logprobs: Sequence[float],
    split: Callable[[list[int]], tuple[list[str], list[list[int]]]],
    text: str,
    eot: int,
) -> list[dict]:
    """The words of `text` the decoder was unsure of, with their probability and offset in `text`.

    tokens / token_logprobs: the decoded text tokens and the log-probability the decoder gave each
    one when it picked it (same length). split: the tokenizer's split_to_word_tokens. text: the
    final (cleaned) segment text; every word is located in it in order, so offsets are exact even
    when a word occurs twice."""
    pairs = [(t, lp) for t, lp in zip(tokens, token_logprobs) if t < eot]
    if not pairs or not text:
        return []
    prob = [math.exp(lp) if math.isfinite(lp) else 0.0 for _, lp in pairs]
    words, word_tokens = split([t for t, _ in pairs])
    out: list[dict] = []
    cursor, k = 0, 0
    for word, toks in zip(words, word_tokens):
        ps = [prob[k + j] for j in range(len(toks))]
        k += len(toks)
        w = word.translate(BIDI_MARKS).strip()
        if not w:
            continue
        pos = text.find(w, cursor)
        if pos < 0:
            continue  # clean() changed it; skip rather than mark the wrong place
        cursor = pos + len(w)
        if all(c in string.punctuation for c in w):
            continue
        p = sum(ps) / len(ps)
        if p < WORD_UNSURE:
            out.append({"t": w, "p": round(p, 2), "i": pos})
    if len(out) > MAX_UNSURE_WORDS:
        keep = sorted(out, key=lambda d: d["p"])[:MAX_UNSURE_WORDS]
        out = sorted(keep, key=lambda d: d["i"])
    return out
