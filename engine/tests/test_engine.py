"""End-to-end tests against a live engine server (real models, real audio from macOS voices).

Run: cd engine && .venv/bin/pytest -s
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from websockets.asyncio.client import connect

from klara_engine.engine import echo_score

AUDIO = Path(__file__).parent / "audio"
SR = 16000


def pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


def load(name: str) -> np.ndarray:
    a, sr = sf.read(AUDIO / f"{name}.wav", dtype="float32")
    assert sr == SR
    return a


@pytest.fixture(scope="module")
def server():
    tmp = tempfile.mkdtemp()
    token = "t" * 32
    env = {**os.environ, "KLARA_DATA_DIR": tmp}
    proc = subprocess.Popen(
        [sys.executable, "-m", "klara_engine.server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        env=env, cwd=Path(__file__).parent.parent, text=True,
    )
    proc.stdin.write(token + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    port = json.loads(line)["port"]
    yield f"ws://127.0.0.1:{port}/?token={token}", tmp
    proc.stdin.close()
    proc.wait(timeout=10)


async def run_session(url: str, start: dict, feeds: dict[str, np.ndarray], until: str, realtime: float = 0.0, then: str | None = None):
    events = []
    async with connect(url, max_size=2**24) as ws:
        while True:  # wait for Whisper to be loaded
            ev = json.loads(await ws.recv())
            if ev["type"] == "ready":
                break
        await ws.send(json.dumps({"type": "session.start", **start}))
        step = SR // 10
        n = max(len(a) for a in feeds.values())
        for i in range(0, n, step):
            for stream, audio in feeds.items():
                if i < len(audio):
                    chunk = base64.b64encode(pcm16(audio[i : i + step])).decode()
                    await ws.send(json.dumps({"type": "audio", "id": start["id"], "stream": stream, "pcm": chunk}))
            if realtime:
                await asyncio.sleep(0.1 / realtime)
        await ws.send(json.dumps({"type": "session.stop", "id": start["id"]}))
        while True:
            ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=300))
            events.append(ev)
            if ev["type"] == until and ev.get("id") == start["id"]:
                if not then:
                    return events
                until, then = then, None


def test_rejects_bad_token_and_web_pages(server):
    url, _ = server
    import websockets

    async def attempt(u, **kw):
        try:
            async with connect(u, **kw):
                return "open"
        except websockets.exceptions.InvalidStatus as e:
            return e.response.status_code

    assert asyncio.run(attempt(url.replace("token=", "token=x"))) == 403
    assert asyncio.run(attempt(url, origin="https://evil.example")) == 403
    assert asyncio.run(attempt(url)) == "open"


def test_echo_score():
    assert echo_score("שלום לכולם, היום נדבר על התוכנית", "שלום לכולם היום נדבר על התוכנית") > 0.9
    assert echo_score("Let's move the deadline", "I disagree completely with this") < 0.5


def test_dictation_hebrew(server):
    url, _ = server
    audio = np.concatenate([np.zeros(SR // 2, np.float32), load("he"), np.zeros(SR // 4, np.float32)])
    events = asyncio.run(run_session(url, {"id": "d1", "mode": "dictation", "streams": ["mic"]}, {"mic": audio}, "dictation.result"))
    result = events[-1]
    print("dictation:", result)
    assert result["lang"] == "he"
    assert "התוכנית" in result["text"] and "משימות" in result["text"]


def test_meeting_two_channels(server):
    url, tmp = server
    mic = np.concatenate([load("he"), np.zeros(SR * 7, np.float32), load("mixed")])
    system = np.concatenate([np.zeros(SR * 10, np.float32), load("en"), np.zeros(SR * 7, np.float32)])
    raw = {}
    for name, audio in (("mic", mic), ("system", system)):
        p = Path(tmp) / f"{name}.pcm"
        p.write_bytes(pcm16(audio))
        raw[name] = str(p)
    start = {"id": "m1", "mode": "meeting", "streams": ["mic", "system"], "diarize": ["system"], "rawPaths": raw}
    events = asyncio.run(run_session(url, start, {"mic": mic, "system": system}, "session.final"))
    live = [e["segment"] for e in events if e["type"] == "segment"]
    final = events[-1]
    for s in final["segments"]:
        print(f'{s["start"]:6.1f} {s["stream"]:6s} {str(s["speaker"]):5s} {s["lang"]} {s["text"]}')
    assert any(s["stream"] == "mic" and s["speaker"] == "me" and s["lang"] == "he" for s in final["segments"])
    assert any(s["stream"] == "system" and s["speaker"] == "rem" and len(s["text"]) > 20 for s in final["segments"])
    assert final["speakers"]["me"]["isMe"] is True
    assert live, "segments should arrive live, before the final pass"


def test_inperson_speakers_and_me(server):
    url, tmp = server
    # Enroll "me" with Daniel's voice, then hold a 4-person meeting.
    me = Path(tmp) / "me.wav"
    subprocess.run(["say", "-v", "Daniel", "-o", str(me), "--data-format=LEI16@16000",
                    "This is my voice. I am recording a short sample so the app can recognise me in meetings later on."], check=True)
    meeting = load("meeting4")
    raw = Path(tmp) / "inperson.pcm"
    raw.write_bytes(pcm16(meeting))

    async def flow():
        async with connect(server[0], max_size=2**24) as ws:
            await ws.send(json.dumps({"type": "voiceprint.enroll", "key": "me", "name": "Klara", "path": str(me)}))
            while json.loads(await ws.recv())["type"] != "voiceprint.enrolled":
                pass

    asyncio.run(flow())
    start = {"id": "p1", "mode": "inperson", "streams": ["mic"], "diarize": ["mic"], "rawPaths": {"mic": str(raw)}}
    events = asyncio.run(run_session(url, start, {"mic": meeting}, "session.final", then="session.speakers"))
    final = next(e for e in events if e["type"] == "session.final")
    spk = events[-1]
    final["segments"] = spk["segments"]  # re-cut where the speaker changes
    for seg in final["segments"]:
        print(f'{seg["start"]:6.1f} {str(seg["speaker"]):5s} {seg["text"]}')
    final["speakers"] = spk["speakers"]
    print("speakers:", {k: (v["name"], v["isMe"]) for k, v in final["speakers"].items()}, "| speaker step", spk["seconds"], "s")
    labels = {s["speaker"] for s in final["segments"]}
    assert len(labels) >= 3, f"expected 3-4 speakers, got {labels}"
    me_labels = [k for k, v in final["speakers"].items() if v["isMe"]]
    assert len(me_labels) == 1
    # Daniel (enrolled as "me") speaks at 5.2 s and 23.2 s in meeting4.wav.
    daniel_lines = [s for s in final["segments"] if any(abs(s["start"] - t) < 1.0 for t in (5.2, 23.2))]
    assert daniel_lines and all(s["speaker"] == me_labels[0] for s in daniel_lines)
