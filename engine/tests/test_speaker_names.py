"""Fast tests for speakers by name (no models, no audio): saved-voice matching, the single remote
voice of a 1:1 call, and names in the MCP output."""

from __future__ import annotations

import json

import numpy as np
import pytest

from klara_engine.engine import single_voice_reply
from klara_engine.voiceprint import MATCH_SIM, VoiceprintStore


def unit(*v: float) -> np.ndarray:
    a = np.array(v, dtype=np.float32)
    return a / np.linalg.norm(a)


def near(base: np.ndarray, sim: float) -> np.ndarray:
    """A unit vector with cosine `sim` to `base` (base is on the first axes, the rest goes to the last)."""
    other = np.zeros_like(base)
    other[-1] = 1.0
    other -= base * float(np.dot(base, other))
    other /= np.linalg.norm(other)
    return (sim * base + np.sqrt(1 - sim * sim) * other).astype(np.float32)


@pytest.fixture()
def store(tmp_path):
    s = VoiceprintStore(tmp_path / "voiceprints.json")
    s.put("me", "Klara", unit(1, 0, 0, 0, 0), is_me=True)
    s.put("v_roi", "Roi", unit(0, 1, 0, 0, 0))
    s.put("v_dana", "Dana", unit(0, 0, 1, 0, 0))
    return s


def test_match_threshold(store):
    roi = store.items["v_roi"]["embedding"]
    assert store.match(near(np.array(roi, dtype=np.float32), MATCH_SIM + 0.05))[0] == "v_roi"
    assert store.match(near(np.array(roi, dtype=np.float32), MATCH_SIM - 0.05)) is None


def test_match_two_people_nearly_as_close_is_a_guess(store):
    between = unit(0, 1, 0.97, 0, 0)  # Roi 0.72, Dana 0.70: too close to tell apart
    assert store.match(between) is None
    clear = unit(0, 1, 0.5, 0, 0)  # Roi 0.89, Dana 0.45
    assert store.match(clear)[0] == "v_roi"


def test_match_two_prints_of_the_same_person_are_not_a_conflict(store):
    store.put("auto_roi", "roi", unit(0, 1, 0.1, 0, 0), auto=True)
    assert store.match(unit(0, 1, 0.05, 0, 0))[0] in ("v_roi", "auto_roi")


def test_remote_side_never_matches_the_users_own_voice(store):
    mine = unit(1, 0.05, 0, 0, 0)
    assert store.match(mine)[0] == "me"
    assert store.match(mine, exclude_me=True) is None


def test_each_saved_voice_names_at_most_one_speaker(store):
    got = store.assign({"rem1": unit(0, 1, 0.2, 0, 0), "rem2": unit(0, 1, 0.4, 0, 0), "rem3": unit(0, 0, 1, 0, 0)})
    assert got == {"rem1": "v_roi", "rem3": "v_dana"}  # rem2 is less like Roi than rem1: stays unnamed


def test_auto_flag_kept_until_the_user_saves_the_voice(store, tmp_path):
    store.put("auto_x", "Roi Cohen", unit(0, 0, 0, 1, 0), auto=True)
    assert store.items["auto_x"]["auto"] is True
    assert VoiceprintStore(tmp_path / "voiceprints.json").items["auto_x"]["auto"] is True
    store.put("auto_x", "Roi Cohen", unit(0, 0, 0, 1, 0.1), auto=True)
    assert store.items["auto_x"]["auto"] is True and store.items["auto_x"]["n"] == 2
    store.put("auto_x", "Roi Cohen", unit(0, 0, 0, 1, 0))
    assert "auto" not in store.items["auto_x"]


def test_single_remote_voice_keeps_rem_and_carries_the_voiceprint():
    segs = [{"id": "a", "stream": "system", "start": 0, "end": 3, "text": "שלום", "speaker": "rem1"}]
    r = single_voice_reply("system", segs, {"rem1": {"name": "Roi", "key": "v_roi", "isMe": False, "embedding": [0.1, 0.2]}}, 1.5)
    assert r["type"] == "session.speakers" and r["stream"] == "system"
    assert r["speakers"] == {"rem": {"name": "Roi", "key": "v_roi", "isMe": False, "embedding": [0.1, 0.2]}}
    assert [s["speaker"] for s in r["segments"]] == ["rem"]
    # No voiceprint (too little audio): nothing to add, the step stays "skipped".
    assert single_voice_reply("system", segs, {"rem1": {"name": None, "key": None, "isMe": False}}, 1) is None
    assert single_voice_reply("system", segs, {"rem1": {"name": None, "isMe": False, "embedding": [0.0, 0.0]}}, 1) is None
    assert single_voice_reply("system", segs, {}, 1) is None


# ---------------------------------------------------------------- MCP output


@pytest.fixture()
def library(tmp_path, monkeypatch):
    monkeypatch.delenv("KLARA_MCP_ONLY", raising=False)
    from klara_engine import mcp_server

    folder = tmp_path / "Meetings" / "2026" / "11" / "2026-11-20 Sync"
    folder.mkdir(parents=True)
    meta = {
        "id": "m1", "title": "Sync", "source": "phone", "mode": "meeting", "startedAt": "2026-11-20T10:00:00.000Z",
        "folder": str(folder), "status": "done", "durationSec": 600,
        "speakers": {
            "me": {"name": None, "key": "me", "isMe": True},
            "rem1": {"name": "Roi Cohen", "key": "auto_roi", "isMe": False, "auto": True},
            "rem2": {"name": None, "key": None, "isMe": False},
        },
    }
    segs = [
        {"id": "1", "stream": "mic", "start": 0, "end": 2, "text": "היי", "speaker": "me"},
        {"id": "2", "stream": "system", "start": 2, "end": 5, "text": "מה נשמע", "speaker": "rem1"},
        {"id": "3", "stream": "system", "start": 5, "end": 8, "text": "הכול טוב", "speaker": "rem2"},
    ]
    (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    (folder / "transcript.json").write_text(json.dumps({"version": 1, "meta": meta, "segments": segs}, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(mcp_server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(mcp_server, "ONLY", None)
    monkeypatch.setattr(mcp_server, "settings", lambda: {"userName": "Klara", "folder": str(tmp_path)})
    monkeypatch.setattr(mcp_server, "root", lambda: tmp_path)
    return mcp_server, folder


def test_mcp_transcript_shows_speaker_names(library):
    mcp, _ = library
    out = mcp.get_transcript("m1")
    assert "Roi Cohen [00:02]:" in out
    assert "Klara [00:00]:" in out
    assert "משתתף 2 [00:05]:" in out
    assert "Roi Cohen (named automatically from the calendar, 1:1 call)" in out
    assert "משתתף 2 (not named yet, label rem2)" in out
    assert "source: Phone" in out


def test_mcp_set_speaker_name_confirms_an_automatic_name(library):
    mcp, folder = library
    assert "now" in mcp.set_speaker_name("m1", "rem1", "Roi Cohen")
    sp = json.loads((folder / "meta.json").read_text(encoding="utf-8"))["speakers"]["rem1"]
    assert sp["name"] == "Roi Cohen" and "auto" not in sp
    assert "named automatically" not in mcp.get_transcript("m1")
