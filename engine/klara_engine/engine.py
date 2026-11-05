"""Sessions, the ASR queue and the end-of-recording steps.

Threads:
- one ASR thread owns everything MLX (Whisper must be loaded and run on the same thread);
- one ingest thread per session runs VAD (and voiceprints for in-person meetings), then queues ASR;
- when a session stops, its ingest thread sends the transcript right away ("session.final"), then
  works out who spoke (Nemotron + voiceprints) and sends that separately ("session.speakers"),
  so the transcript is ready the moment the call ends and a new call is never held up.
"""

from __future__ import annotations

import difflib
import itertools
import queue
import re
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

import os
import sys

from .diarize import Diarizer
from .models import ASR_DEFAULT, is_downloaded
from .speakers import SpeakerTracker, assign_speakers, speaker_parts
from .vad import SR, Segmenter, Utterance
from .voiceprint import VoiceEncoder, VoiceprintStore

PRIORITY = {"dictation": 0, "meeting": 1, "inperson": 1, "file": 2, "redo": 3}
MIN_UTTERANCE_S = 0.5   # shorter clips are coughs, clicks and "mm" — Whisper turns them into junk
MIN_UTTERANCE_DB = -50  # quieter clips are background noise
# Every Whisper call costs a full 30-second encoder pass, however short the clip. Consecutive
# utterances of one side are packed into one call (up to PACK_MAX_S of speech), which cuts the
# number of calls several-fold; a pack is sent as soon as there's a pause of PACK_GAP_S.
PACK_MAX_S = 16.0       # while transcription keeps up: short packs, text shows up sooner
PACK_GAP_S = 1.0
BUSY_PACK_MAX_S = 28.0  # when it falls behind (busy Mac): bigger packs, fewer calls, catches up faster
BUSY_PACK_GAP_S = 3.0
BUSY_BACKLOG_S = 20.0   # queued speech that counts as "behind"
PACK_JOIN = np.zeros(int(0.25 * SR), dtype=np.float32)


@dataclass(order=True)
class Job:
    prio: int
    seq: int
    fn: Callable[[], None] = field(compare=False)
    seconds: float = field(default=0.0, compare=False)
    mode: str = field(default="", compare=False)


def read_audio(path: str) -> np.ndarray | None:
    p = Path(path)
    if not p.exists():
        return None
    if p.suffix == ".pcm":
        return np.fromfile(p, dtype="<i2").astype(np.float32) / 32768.0
    audio, sr = sf.read(str(p), dtype="float32", always_2d=True)
    if sr != SR:
        raise ValueError(f"{path}: expected 16 kHz audio, got {sr}")
    return audio.mean(axis=1)


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", "", text.lower())


def echo_score(a: str, b: str) -> float:
    """How much of the shorter text appears in the longer one (0..1)."""
    a, b = _norm(a), _norm(b)
    if min(len(a), len(b)) < 8:
        return 0.0
    m = difflib.SequenceMatcher(None, a, b, autojunk=False)
    return sum(x.size for x in m.get_matching_blocks()) / min(len(a), len(b))


class StreamState:
    def __init__(self, name: str, session: "Session", diarize: bool):
        e = session.engine
        dictation = session.mode == "dictation"
        self.name = name
        self.seg = Segmenter(
            min_silence_ms=350 if dictation else 500,
            max_utterance_s=12.0 if dictation else 20.0,
        )
        # Live speaker labels only for in-person meetings (cheap voiceprints); for calls the other
        # side is simply "participants" until the after-call speaker step.
        live_tracker = diarize and session.live and session.mode == "inperson"
        self.tracker = SpeakerTracker(e.encoder, e.store, "spk") if live_tracker else None
        self.diarize = diarize
        self.previous: tuple[str, str] | None = None
        self.cursor = 0  # dictation: end of audio already queued for ASR
        self.pack: list[Utterance] = []
        self.pack_label: str | None = None


class Session:
    def __init__(self, engine: "Engine", msg: dict):
        self.engine = engine
        self.id: str = msg["id"]
        self.mode: str = msg.get("mode", "meeting")
        self.live: bool = msg.get("live", True)
        self.vocabulary: list[str] = msg.get("vocabulary", [])
        self.raw_paths: dict[str, str] = msg.get("rawPaths", {})
        diarize = set(msg.get("diarize", []))
        self.streams = {s: StreamState(s, self, s in diarize) for s in msg.get("streams", ["mic"])}
        self.segments: dict[str, dict] = {}
        self.inbox: queue.Queue = queue.Queue()
        self.cancelled = False
        self.counter = itertools.count(1)
        self.pending = 0
        self.cv = threading.Condition()
        self.t0 = time.time()
        threading.Thread(target=self._ingest, name=f"ingest-{self.id}", daemon=True).start()

    def emit(self, msg: dict) -> None:
        self.engine.emit({**msg, "id": self.id})

    # ---- ingest thread ----

    def _ingest(self) -> None:
        try:
            while True:
                item = self.inbox.get()
                if item is None:
                    break
                stream, samples = item
                st = self.streams.get(stream)
                if st is None or self.cancelled:
                    continue
                utts, changes = st.seg.feed(samples)
                for speaking in changes:
                    self.emit({"type": "speaking", "stream": stream, "value": speaking, "t": round(st.seg.total / SR, 2)})
                for u in utts:
                    self._on_utterance(st, u)
                if st.pack and not st.seg.speaking and st.seg.total - st.pack[-1].end >= self._pack_limits()[1] * SR:
                    self._flush_pack(st)
            if not self.cancelled:
                self._finish()
        except Exception as exc:  # keep the engine alive; report to the app
            traceback.print_exc()
            self.emit({"type": "error", "message": f"session failed: {exc}"})
        finally:
            self.engine.sessions.pop(self.id, None)
            self.engine.release_memory()

    def _on_utterance(self, st: StreamState, u: Utterance) -> None:
        if self.mode != "dictation":
            level = 20 * np.log10(np.sqrt(np.mean(u.audio**2)) + 1e-9) if len(u.audio) else -120
            if u.seconds < MIN_UTTERANCE_S or level < MIN_UTTERANCE_DB:
                return
        label = None
        if self.mode == "meeting":
            label = "me" if st.name == "mic" else "rem"
        elif st.tracker is not None:
            label, changed = st.tracker.assign(u.audio, None)
            if changed:
                self.emit({"type": "speakers", "speakers": st.tracker.public()})
        if self.mode == "dictation":
            st.cursor = u.end
            seg_id = f"{st.name[0]}{next(self.counter)}"
            self._submit(lambda: self._transcribe(st, u, seg_id, label), u.seconds)
            return
        if st.pack:
            max_s, gap_s = self._pack_limits()
            fits = (u.start - st.pack[-1].end) < gap_s * SR and \
                sum(x.seconds for x in st.pack) + u.seconds <= max_s and label == st.pack_label
            if not fits:
                self._flush_pack(st)
        st.pack.append(u)
        st.pack_label = label

    def _pack_limits(self) -> tuple[float, float]:
        if self.engine.queued_live_s > BUSY_BACKLOG_S:
            return BUSY_PACK_MAX_S, BUSY_PACK_GAP_S
        return PACK_MAX_S, PACK_GAP_S

    def _flush_pack(self, st: StreamState) -> None:
        """Send the packed utterances of one side to Whisper as one call."""
        if not st.pack:
            return
        parts = st.pack
        st.pack = []
        audio = np.concatenate([x for u in parts for x in (u.audio, PACK_JOIN)][:-1])
        u = Utterance(parts[0].start, parts[-1].end, audio)
        label = st.pack_label
        seg_id = f"{st.name[0]}{next(self.counter)}"
        self._submit(lambda: self._transcribe(st, u, seg_id, label), u.seconds)

    def _submit(self, fn: Callable[[], None], seconds: float, kind: str | None = None) -> None:
        with self.cv:
            self.pending += 1

        def run() -> None:
            try:
                if not self.cancelled:
                    fn()
            finally:
                with self.cv:
                    self.pending -= 1
                    self.cv.notify_all()

        mode = kind or self.mode
        self.engine.submit(PRIORITY.get(mode, 1), run, seconds, mode)

    # ---- ASR thread ----

    def _transcribe(self, st: StreamState, u: Utterance, seg_id: str, label: str | None) -> None:
        asr = self.engine.asr
        assert asr is not None
        r = asr.transcribe(u.audio, vocabulary=self.vocabulary, previous=st.previous)
        if not r.text:
            return
        st.previous = (r.text, r.lang)
        seg = {
            "id": seg_id, "stream": st.name, "start": round(u.start / SR, 2), "end": round(u.end / SR, 2),
            "text": r.text, "lang": r.lang, "langProbs": r.lang_probs, "mixed": r.mixed,
            "speaker": label, "model": r.model, "ms": r.ms,
            # seconds between the end of this speech and its text being ready (live sessions)
            "lag": round(time.time() - (self.t0 + u.end / SR), 1) if self.live else None,
        }
        self.segments[seg_id] = seg
        if self.mode == "dictation":
            self.emit({"type": "dictation.partial", "text": self._dictation_text()})
            return
        self.emit({"type": "segment", "segment": _public(seg)})
        if self.mode == "meeting":
            self._dedupe_echo(seg)

    def _dedupe_echo(self, seg: dict) -> None:
        """Laptop speakers leak the other side into the mic; drop mic lines that repeat system lines."""
        if seg["stream"] == "mic" and len(seg["text"].split()) <= 2 and self._system_overlaps(seg):
            seg["echo"] = True  # a stray word picked up while the other side was talking
            self.emit({"type": "segment.remove", "segmentId": seg["id"]})
            return
        other = "system" if seg["stream"] == "mic" else "mic"
        for s in list(self.segments.values()):
            if s["stream"] != other or s.get("echo"):
                continue
            if s["end"] < seg["start"] - 2.5 or s["start"] > seg["end"] + 2.5:
                continue
            if echo_score(s["text"], seg["text"]) >= 0.7:
                mic = seg if seg["stream"] == "mic" else s
                mic["echo"] = True
                self.emit({"type": "segment.remove", "segmentId": mic["id"]})
                if mic is seg:
                    return

    def _system_overlaps(self, seg: dict) -> bool:
        return any(
            s["stream"] == "system" and s["start"] < seg["end"] + 1 and s["end"] > seg["start"] - 1
            for s in self.segments.values()
        )

    def _dictation_text(self) -> str:
        parts = sorted(self.segments.values(), key=lambda s: s["start"])
        return " ".join(p["text"] for p in parts).strip()

    # ---- end of session ----

    def stop(self) -> None:
        self.inbox.put(None)

    def cancel(self) -> None:
        self.cancelled = True
        self.inbox.put(None)

    def _wait_idle(self) -> None:
        with self.cv:
            self.cv.wait_for(lambda: self.pending == 0)

    def _finish(self) -> None:
        for st in self.streams.values():
            if self.mode == "dictation":
                u = st.seg.flush() if st.seg.speaking else None
                if u is None:
                    tail = st.seg.slice(st.cursor, st.seg.total)
                    if len(tail) >= 0.3 * SR and 20 * np.log10(np.sqrt(np.mean(tail**2)) + 1e-9) > -45:
                        u = Utterance(st.cursor, st.seg.total, tail)
                if u is not None:
                    self._on_utterance(st, u)
            else:
                u = st.seg.flush()
                if u is not None:
                    self._on_utterance(st, u)
                self._flush_pack(st)
        self._wait_idle()

        if self.mode == "dictation":
            first = min(self.segments.values(), key=lambda s: s["start"], default=None)
            self.emit({
                "type": "dictation.result", "text": self._dictation_text(),
                "lang": first["lang"] if first else None, "seconds": round(time.time() - self.t0, 2),
            })
            return

        speakers: dict[str, dict] = {}
        if self.mode == "meeting":
            speakers["me"] = {"name": None, "key": "me", "isMe": True}
            speakers["rem"] = {"name": None, "key": None, "isMe": False}
        for st in self.streams.values():
            if st.tracker is not None:
                speakers.update(st.tracker.public())
        segments = self._final_segments()
        # The transcript is complete now: send it before the (slower) speaker step.
        self.emit({"type": "session.final", "segments": segments, "speakers": speakers})
        for st in self.streams.values():
            if st.diarize:
                self._assign_speakers(st)

    def _final_segments(self) -> list[dict]:
        return [_public(s) for s in sorted((s for s in self.segments.values() if not s.get("echo")), key=lambda s: (s["start"], s["stream"]))]

    def _split_at_speaker_changes(self, st, audio, segs, labels, timeline) -> list[dict]:
        """A segment that two people spoke (no pause between them) is cut where the voice changes
        and each part is transcribed on its own. Only those few segments are re-transcribed."""
        out: list[dict] = []
        texts: dict[str, str] = {}
        plan: list[tuple[dict, list[tuple[float, float, str]]]] = []
        for seg in segs:
            parts = speaker_parts(timeline, seg["start"], seg["end"]) if timeline else []
            plan.append((seg, parts))
            if len(parts) > 1:
                for i, (a, b, _) in enumerate(parts):
                    clip = audio[int(a * SR) : int(b * SR)]
                    self._submit(_split_text_job(lambda: self.engine.asr, clip, self.vocabulary, texts, f"{seg['id']}.{i}"), b - a, kind="redo")
        self._wait_idle()
        for seg, parts in plan:
            if len(parts) <= 1:
                out.append({**seg, "speaker": labels.get(seg["id"], seg.get("speaker"))})
                continue
            for i, (a, b, lab) in enumerate(parts):
                text = texts.get(f"{seg['id']}.{i}", "")
                if text:
                    out.append({**seg, "id": f"{seg['id']}.{i}", "start": a, "end": b, "text": text, "speaker": lab})
        return out

    def _assign_speakers(self, st: StreamState) -> None:
        """Who said what, from the full recording (runs after the transcript was sent).
        Always ends with one "session.speakers" message for the stream (possibly "skipped")."""
        e = self.engine
        reply: dict = {"type": "session.speakers", "stream": st.name, "skipped": True}
        try:
            audio = read_audio(self.raw_paths[st.name]) if st.name in self.raw_paths else None
            segs = [s for s in self._final_segments() if s["stream"] == st.name]
            if audio is None or e.encoder is None or not segs:
                return
            t0 = time.time()
            self.emit({"type": "progress", "stage": "speakers", "stream": st.name, "value": 0.0})
            windows = list(e.diarizer.offline_windows(audio)) if e.diarizer is not None else None
            prefix = "spk" if self.mode == "inperson" else "rem"
            labels, speakers, timeline = assign_speakers(audio, segs, windows, e.encoder, e.store, prefix)
            if self.mode == "meeting" and len(speakers) <= 1:
                return  # one voice on the other side: keep the plain "participants" label
            segs = self._split_at_speaker_changes(st, audio, segs, labels, timeline)
            reply = {"type": "session.speakers", "stream": st.name, "speakers": speakers, "segments": segs,
                     "seconds": round(time.time() - t0, 1)}
        except Exception as exc:
            traceback.print_exc()
            self.emit({"type": "error", "message": f"speaker step failed: {exc}"})
        finally:
            self.emit(reply)


def _split_text_job(asr_getter, audio: np.ndarray, vocabulary: list[str], out: dict, key: str):
    def run() -> None:
        asr = asr_getter()
        if asr is not None:
            out[key] = asr.transcribe(audio, vocabulary=vocabulary).text
    return run


def _public(seg: dict) -> dict:
    return {k: v for k, v in seg.items() if k != "echo"}


class Engine:
    def __init__(self, emit: Callable[[dict], None], data_dir: Path):
        self.emit = emit
        self.data_dir = data_dir
        self.asr: WhisperASR | None = None
        self.diarizer: Diarizer | None = None
        self.encoder: VoiceEncoder | None = None
        self.store = VoiceprintStore(data_dir / "voiceprints.json")
        self.sessions: dict[str, Session] = {}
        self.queued_live_s = 0.0  # speech waiting for transcription in live sessions
        self.jobs: queue.PriorityQueue[Job] = queue.PriorityQueue()
        self.seq = itertools.count()
        self.ready = threading.Event()
        self.lock = threading.Lock()
        threading.Thread(target=self._asr_loop, name="asr", daemon=True).start()
        threading.Thread(target=self._load_torch_models, name="load", daemon=True).start()

    # ---- models ----

    def _load_torch_models(self) -> None:
        try:
            if is_downloaded("nemotron-diarization"):
                self.diarizer = Diarizer()
            if is_downloaded("ecapa"):
                self.encoder = VoiceEncoder()
        except Exception as exc:
            traceback.print_exc()
            self.emit({"type": "error", "message": f"speaker models failed to load: {exc}"})
        self._announce()

    def _announce(self) -> None:
        if self.asr is not None:
            self.emit(self.status())

    def status(self) -> dict:
        return {
            "type": "ready" if self.asr else "loading",
            "asr": self.asr.model_key if self.asr else None,
            "diarization": self.diarizer is not None,
            "voiceprints": self.encoder is not None,
            "voiceprintKeys": {k: {"name": v["name"], "isMe": v.get("isMe", False)} for k, v in self.store.items.items()},
        }

    def release_memory(self) -> None:
        """After a session: return cached GPU buffers and Python garbage."""
        if self.sessions:
            return

        def clear() -> None:  # MLX objects are owned by the ASR thread
            try:
                import mlx.core as mx
            except ImportError:  # CTranslate2 backend: nothing cached
                return
            mx.clear_cache()

        self.jobs.put(Job(PRIORITY["redo"], next(self.seq), clear))
        import gc

        gc.collect()

    # ---- ASR queue ----

    def submit(self, prio: int, fn: Callable[[], None], seconds: float, mode: str) -> None:
        with self.lock:
            if mode in ("meeting", "inperson"):
                self.queued_live_s += seconds
        self.jobs.put(Job(prio, next(self.seq), fn, seconds, mode))

    def _asr_loop(self) -> None:
        try:
            self.asr = make_asr(asr_model())
        except Exception as exc:
            traceback.print_exc()
            self.emit({"type": "error", "message": f"Whisper failed to load: {exc}"})
            return
        self.ready.set()
        self._announce()
        while True:
            job = self.jobs.get()
            try:
                job.fn()
            except Exception as exc:
                traceback.print_exc()
                self.emit({"type": "error", "message": f"transcription failed: {exc}"})
            finally:
                if job.mode in ("meeting", "inperson"):
                    with self.lock:
                        self.queued_live_s = max(0.0, self.queued_live_s - job.seconds)

    # ---- messages from the app ----

    def handle(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "audio":
            s = self.sessions.get(msg["id"])
            if s is not None:
                pcm = np.frombuffer(_b64(msg["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
                s.inbox.put((msg["stream"], pcm))
        elif kind == "session.start":
            if msg["id"] not in self.sessions:
                self.sessions[msg["id"]] = Session(self, msg)
        elif kind == "session.stop":
            s = self.sessions.get(msg["id"])
            if s:
                s.stop()
        elif kind == "session.cancel":
            s = self.sessions.get(msg["id"])
            if s:
                s.cancel()
        elif kind == "transcribe.file":
            threading.Thread(target=self._transcribe_file, args=(msg,), daemon=True).start()
        elif kind == "voiceprint.enroll":
            threading.Thread(target=self._enroll, args=(msg,), daemon=True).start()
        elif kind == "voiceprint.remember":
            self.store.put(msg["key"], msg["name"], np.array(msg["embedding"], dtype=np.float32), msg.get("isMe", False))
            self.emit(self.status())
        elif kind == "voiceprint.remove":
            self.store.remove(msg["key"])
            self.emit(self.status())
        elif kind == "status":
            self.emit(self.status())

    def _transcribe_file(self, msg: dict) -> None:
        """Offline transcription of saved audio (re-transcribe, tests). Streams in `rawPaths`."""
        self.ready.wait()
        session = Session(self, {**msg, "live": False, "streams": list(msg["rawPaths"]), "mode": msg.get("mode", "inperson")})
        self.sessions[session.id] = session
        for stream, path in msg["rawPaths"].items():
            audio = read_audio(path)
            if audio is None:
                continue
            for i in range(0, len(audio), SR):
                session.inbox.put((stream, audio[i : i + SR]))
        session.stop()

    def _enroll(self, msg: dict) -> None:
        try:
            if self.encoder is None:
                raise RuntimeError("voiceprint model not loaded")
            audio = read_audio(msg["path"])
            if audio is None or len(audio) < 3 * SR:
                raise RuntimeError("recording is too short")
            self.store.put(msg.get("key", "me"), msg.get("name", "me"), self.encoder.embed(audio), msg.get("isMe", True))
            self.emit({"type": "voiceprint.enrolled", "key": msg.get("key", "me")})
            self.emit(self.status())
        except Exception as exc:
            self.emit({"type": "error", "message": f"voiceprint: {exc}"})


def asr_model() -> str:
    """The Hebrew turbo model when present (KLARA_ASR_MODEL overrides); on the Mac, else OpenAI large-v3.
    With Hebrew + English (KLARA_ASR_LANGUAGE=auto) the Hebrew-only fine-tune gives way to OpenAI's turbo,
    which can tell the two languages apart."""
    wanted = os.environ.get("KLARA_ASR_MODEL", ASR_DEFAULT)
    if os.environ.get("KLARA_ASR_LANGUAGE") == "auto" and "ivrit" in wanted:
        for alt in ("whisper-large-v3-turbo", "whisper-large-v3"):
            if is_downloaded(alt):
                return alt
    if is_downloaded(wanted) or sys.platform != "darwin":
        return wanted
    return "whisper-large-v3"


def make_asr(key: str):
    """MLX on Apple Silicon; CTranslate2 (faster-whisper) for "*-ct2" models (Windows)."""
    if key.endswith("-ct2"):
        from .asr_ct2 import CT2WhisperASR

        return CT2WhisperASR(key)
    from .asr import WhisperASR

    return WhisperASR(key)


def _b64(s: str) -> bytes:
    import base64

    return base64.b64decode(s)
