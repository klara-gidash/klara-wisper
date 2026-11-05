"""What every ASR backend shares: the result type, the language choice, the prompt, and the
clean-up of Whisper's usual hallucinations. No ML imports here, so it loads on any platform."""

from __future__ import annotations

from dataclasses import dataclass

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
