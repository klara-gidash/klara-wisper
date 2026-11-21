"""Fast tests for the confidence marks (roadmap item 4): no models, no audio."""

from __future__ import annotations

import json
import math
import sys
from types import SimpleNamespace

import numpy as np
import pytest

from klara_engine.asr_common import LINE_UNSURE, MAX_UNSURE_WORDS, WORD_UNSURE, seg_conf, unsure_words

EOT = 1000


def fake_split(tokens):
    """Like Whisper's split_to_word_tokens: a token starting with a space (or punctuation) starts a word."""
    words, groups = [], []
    for t in tokens:
        piece = VOCAB[t]
        if not words or piece.startswith(" ") or piece.strip() in ".,?!":
            words.append(piece)
            groups.append([t])
        else:
            words[-1] += piece
            groups[-1].append(t)
    return words, groups


VOCAB = {1: " שלום", 2: " ל", 3: "כולם", 4: ",", 5: " את", 6: " הפגישה", 7: " את", 8: " זה", 9: "."}
lp = math.log


def test_seg_conf():
    assert seg_conf(0.0) == 1.0
    assert seg_conf(-0.105) == 0.9
    assert seg_conf(float("-inf")) == 0.0
    assert seg_conf(float("nan")) == 0.0


def test_unsure_words_marks_low_words_with_exact_offsets():
    text = "שלום לכולם, את הפגישה את זה."
    tokens = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    # "לכולם" = tokens 2+3: mean(0.92, 0.1) = 0.51 -> sure; the second "את" is unsure.
    probs = [0.99, 0.92, 0.1, 0.2, 0.95, 0.97, 0.3, 0.98, 0.05]
    out = unsure_words(tokens, [lp(p) for p in probs], fake_split, text, EOT)
    # punctuation (",", ".") is never marked, however low
    assert out == [{"t": "את", "p": 0.3, "i": text.index("את", text.index("הפגישה"))}]
    w = out[0]
    assert text[w["i"] : w["i"] + len(w["t"])] == "את"


def test_unsure_words_mean_of_tokens_and_threshold():
    text = "שלום לכולם"
    out = unsure_words([1, 2, 3], [lp(0.99), lp(0.4), lp(0.2)], fake_split, text, EOT)
    assert out == [{"t": "לכולם", "p": 0.3, "i": 5}]
    assert WORD_UNSURE == 0.5


def test_unsure_words_ignores_special_tokens_and_bad_input():
    text = "שלום"
    assert unsure_words([1, EOT], [lp(0.2), lp(0.01)], fake_split, text, EOT) == [{"t": "שלום", "p": 0.2, "i": 0}]
    assert unsure_words([], [], fake_split, text, EOT) == []
    assert unsure_words([1], [lp(0.2)], fake_split, "", EOT) == []
    # -inf log-prob counts as 0
    assert unsure_words([1], [float("-inf")], fake_split, text, EOT)[0]["p"] == 0.0


def test_unsure_words_skips_words_clean_removed():
    # clean() dropped the text (hallucination): nothing can be located, nothing is marked
    assert unsure_words([1, 8], [lp(0.1), lp(0.1)], fake_split, "אחר", EOT) == []


def test_unsure_words_keeps_only_the_least_sure():
    n = MAX_UNSURE_WORDS + 5
    vocab = {i + 1: f" w{i}" for i in range(n)}
    text = " ".join(f"w{i}" for i in range(n))
    split = lambda toks: ([vocab[t] for t in toks], [[t] for t in toks])  # noqa: E731
    probs = [0.01 * (i + 1) for i in range(n)]
    out = unsure_words(list(vocab), [lp(p) for p in probs], split, text, EOT)
    assert len(out) == MAX_UNSURE_WORDS
    assert [w["t"] for w in out] == [f"w{i}" for i in range(MAX_UNSURE_WORDS)]  # lowest, in text order
    assert all(text[w["i"] : w["i"] + len(w["t"])] == w["t"] for w in out)


def test_engine_confidence_fields_only_when_present():
    from klara_engine.engine import confidence

    assert confidence(SimpleNamespace(conf=None, words=None)) == {}
    assert confidence(SimpleNamespace(conf=0.93, words=[])) == {"conf": 0.93}
    w = [{"t": "x", "p": 0.2, "i": 0}]
    assert confidence(SimpleNamespace(conf=0.5, words=w)) == {"conf": 0.5, "words": w}


# ---- MLX: the recorded log-probs come from the single decode ----

mlx_only = pytest.mark.skipif(sys.platform != "darwin", reason="mlx-whisper is the Mac backend")


@mlx_only
def test_token_logprobs_decoder_matches_greedy():
    import mlx.core as mx
    from mlx_whisper.decoding import GreedyDecoder

    from klara_engine.asr import _TokenLogprobs

    eot = 4
    rec, ref = _TokenLogprobs(0.0, eot), GreedyDecoder(0.0, eot)
    rec.reset()
    tokens = mx.array([[7, 8]])
    s_rec = s_ref = mx.zeros(1)
    t_rec = t_ref = tokens
    steps = [[0.1, 2.0, 0.3, 0.0, 0.0], [1.5, 0.2, 0.1, 0.0, 0.3], [0.0, 0.0, 0.0, 0.0, 5.0]]
    for row in steps:
        logits = mx.array([row])
        t_rec, _, s_rec = rec.update(t_rec, logits, s_rec)
        t_ref, _, s_ref = ref.update(t_ref, logits, s_ref)
    assert t_rec.tolist() == t_ref.tolist() == [[7, 8, 1, 0, 4]]
    assert abs(s_rec.item() - s_ref.item()) < 1e-5
    got = rec.token_logprobs(2)
    want = [row[i] - math.log(sum(math.exp(x) for x in row)) for row, i in zip(steps, (1, 0))]
    assert np.allclose(got, want, atol=1e-5)
    assert rec.token_logprobs(0) == []


@mlx_only
def test_transcribe_puts_confidence_on_the_transcript(monkeypatch):
    import mlx.core as mx

    from klara_engine import asr

    m = object.__new__(asr.WhisperASR)
    m.model_key, m.forced_lang = "whisper-ivrit-turbo", "he"
    m.tokenizer = SimpleNamespace(eot=EOT, split_to_word_tokens=fake_split)
    m._features = lambda audio: mx.zeros((1, 4, 4))
    result = SimpleNamespace(
        text=" שלום לכולם", tokens=[1, 2, 3], avg_logprob=-0.2, no_speech_prob=0.01, compression_ratio=1.1,
    )
    monkeypatch.setattr(asr, "decode_with_logprobs", lambda model, f, o: (result, [lp(0.99), lp(0.3), lp(0.2)]))
    m.model = None
    r = m.transcribe(np.zeros(16000 * 5, dtype=np.float32))
    assert r.text == "שלום לכולם"
    assert r.conf == seg_conf(-0.2) == 0.82
    assert r.words == [{"t": "לכולם", "p": 0.25, "i": 5}]


# ---- MCP: a short note only on low lines ----


@pytest.fixture()
def mcp(tmp_path, monkeypatch):
    monkeypatch.delenv("KLARA_MCP_ONLY", raising=False)
    from klara_engine import mcp_server

    monkeypatch.setattr(mcp_server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(mcp_server, "ONLY", None)
    return mcp_server


def test_unsure_note(mcp):
    assert mcp.unsure_note({"text": "x"}) == ""  # older files: no fields, no note
    assert mcp.unsure_note({"conf": 0.95}) == ""
    assert mcp.unsure_note({"conf": 0.9, "words": [{"t": "ליגל", "p": 0.31, "i": 0}, {"t": "ליגל", "p": 0.2, "i": 9}]}) == " (unsure: ליגל)"
    assert mcp.unsure_note({"conf": LINE_UNSURE - 0.05}) == " (unsure line)"
    # legacy word-timestamp entries ({word, p}) only count when low
    assert mcp.unsure_note({"words": [{"word": " טוב", "p": 0.9}, {"word": " רע", "p": 0.1}]}) == " (unsure: רע)"


def test_get_transcript_notes_low_lines_only(mcp, tmp_path):
    folder = tmp_path / "m1"
    folder.mkdir()
    meta = {"id": "m1", "title": "Test", "startedAt": "2026-11-20T10:00:00Z", "folder": str(folder), "speakers": {}, "status": "done"}
    segs = [
        {"id": "a", "start": 0, "end": 3, "text": "שלום לכולם", "speaker": None, "conf": 0.97},
        {"id": "b", "start": 4, "end": 8, "text": "נדבר עם ליגל", "speaker": None, "conf": 0.8, "words": [{"t": "ליגל", "p": 0.3, "i": 8}]},
    ]
    (folder / "transcript.json").write_text(json.dumps({"version": 1, "meta": meta, "segments": segs}))
    plain = mcp.transcript_text(meta)
    assert "unsure" not in plain
    noted = mcp.transcript_text(meta, notes=True)
    assert "שלום לכולם\n" in noted and "נדבר עם ליגל (unsure: ליגל)" in noted
