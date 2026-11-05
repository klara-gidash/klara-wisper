"""Who is speaking: Nemotron turn detection + ECAPA voiceprints.

Nemotron-3-Diarization finds speaker turns and overlaps. Voiceprints then confirm identity:
turns with very different voices are split, turns with the same voice are merged, and
clusters are matched against saved voiceprints ("me", remembered colleagues).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from sklearn.cluster import AgglomerativeClustering

from .diarize import FPS
from .voiceprint import VoiceEncoder, VoiceprintStore, cosine

SR = 16000
SAME_VOICE = 0.42       # live: an utterance this similar to a speaker is that speaker (call audio: same person 0.45–0.75, others ≤0.30)
NEW_SPEAKER_MIN_S = 2.0 # live: only an utterance this long may start a new speaker
CLUSTER_SIM = 0.42      # offline: average-linkage threshold between turns
MERGE_SIM = 0.45        # offline: two speakers this similar are one person
MIN_TALK_S = 20.0       # offline: a speaker needs this much talk time…
MIN_TURNS = 3           # …and this many turns, otherwise it is folded into the nearest speaker
MAX_SPEAKERS = 8
MIN_EMBED_S = 1.0       # shorter audio gives unreliable voiceprints
MAX_EMBED_S = 12.0


@dataclass
class Speaker:
    label: str
    centroid: np.ndarray
    n: int = 1
    name: str | None = None
    key: str | None = None   # voiceprint key when recognised
    is_me: bool = False
    nemotron: dict[int, int] = field(default_factory=dict)  # co-occurrence with Nemotron indices

    def public(self) -> dict:
        return {"name": self.name, "key": self.key, "isMe": self.is_me, "embedding": self.centroid.round(5).tolist()}


class SpeakerTracker:
    """Live labelling for one diarized stream."""

    def __init__(self, encoder: VoiceEncoder | None, store: VoiceprintStore | None, prefix: str = "spk"):
        self.encoder = encoder
        self.store = store
        self.prefix = prefix
        self.speakers: list[Speaker] = []
        self.last: str | None = None

    def _new(self, emb: np.ndarray) -> Speaker:
        spk = Speaker(label=f"{self.prefix}{len(self.speakers) + 1}", centroid=emb)
        self._recognise(spk)
        self.speakers.append(spk)
        return spk

    def _recognise(self, spk: Speaker) -> None:
        if not self.store:
            return
        hit = self.store.match(spk.centroid)
        if hit:
            item = self.store.items[hit[0]]
            spk.key, spk.name, spk.is_me = hit[0], item["name"], item.get("isMe", False)

    def assign(self, audio: np.ndarray, nemotron_idx: int | None) -> tuple[str | None, bool]:
        """Label for an utterance. Returns (label, speakers_changed)."""
        changed = False
        if self.encoder is not None and len(audio) >= MIN_EMBED_S * SR:
            emb = self.encoder.embed(audio[: int(MAX_EMBED_S * SR)])
            best = max(self.speakers, key=lambda s: cosine(s.centroid, emb), default=None)
            if best is not None and cosine(best.centroid, emb) >= SAME_VOICE:
                merged = best.centroid * best.n + emb
                best.centroid = merged / (np.linalg.norm(merged) + 1e-9)
                best.n += 1
                if best.key is None:
                    self._recognise(best)
                    changed = best.key is not None
                spk = best
            elif best is not None and len(audio) < NEW_SPEAKER_MIN_S * SR:
                spk = best  # too short to be sure it's someone new
            else:
                spk = self._new(emb)
                changed = True
            if nemotron_idx is not None:
                spk.nemotron[nemotron_idx] = spk.nemotron.get(nemotron_idx, 0) + 1
            self.last = spk.label
            return spk.label, changed
        # Too short for a voiceprint: trust Nemotron's index via what it co-occurred with.
        if nemotron_idx is not None:
            owners = [(s.nemotron.get(nemotron_idx, 0), s) for s in self.speakers]
            count, owner = max(owners, key=lambda x: x[0], default=(0, None))
            if owner is not None and count > 0:
                self.last = owner.label
                return owner.label, False
        return self.last, False

    def public(self) -> dict[str, dict]:
        return {s.label: s.public() for s in self.speakers}


def label_timeline(
    audio: np.ndarray,
    probs: np.ndarray,
    encoder: VoiceEncoder | None,
    store: VoiceprintStore | None,
    prefix: str = "spk",
) -> tuple[list[tuple[float, float, str]], dict[str, dict]]:
    """Offline: turns [(start, end, label)] for a whole recording, plus the speakers map."""
    if len(probs) == 0:
        return [], {}
    active = probs > 0.5
    single = active.sum(axis=1) == 1
    dominant = np.where(single, probs.argmax(axis=1), -1)

    # Runs of frames where exactly one Nemotron speaker talks.
    turns: list[tuple[int, int, int]] = []
    start = 0
    for i in range(1, len(dominant) + 1):
        if i == len(dominant) or dominant[i] != dominant[start]:
            if dominant[start] >= 0 and (i - start) >= FPS * 0.3:
                turns.append((start, i, int(dominant[start])))
            start = i
    if not turns:
        return [], {}

    long_idx = [k for k, (a, b, _) in enumerate(turns) if (b - a) / FPS >= MIN_EMBED_S]
    labels_by_turn: dict[int, int] = {}
    if encoder is not None and len(long_idx) >= 1:
        embs = np.stack([
            encoder.embed(audio[int(turns[k][0] / FPS * SR) : int(min(turns[k][1], turns[k][0] + MAX_EMBED_S * FPS) / FPS * SR)])
            for k in long_idx
        ])
        if len(long_idx) == 1:
            clusters = np.array([0])
        else:
            clusters = AgglomerativeClustering(
                n_clusters=None, metric="cosine", linkage="average", distance_threshold=1 - SAME_VOICE
            ).fit_predict(embs)
        for k, c in zip(long_idx, clusters):
            labels_by_turn[k] = int(c)
        centroids = {}
        for c in set(clusters.tolist()):
            v = embs[clusters == c].mean(axis=0)
            centroids[c] = v / (np.linalg.norm(v) + 1e-9)
    else:  # no voiceprints: Nemotron's indices are the speakers
        for k, (_, _, n) in enumerate(turns):
            labels_by_turn[k] = n
        centroids = {}

    # Short turns follow whichever cluster their Nemotron index mostly mapped to.
    votes: dict[int, dict[int, int]] = {}
    for k, c in labels_by_turn.items():
        votes.setdefault(turns[k][2], {}).setdefault(c, 0)
        votes[turns[k][2]][c] += turns[k][1] - turns[k][0]
    for k, (_, _, n) in enumerate(turns):
        if k not in labels_by_turn and n in votes:
            labels_by_turn[k] = max(votes[n].items(), key=lambda x: x[1])[0]

    # Stable labels in order of first appearance.
    order: dict[int, str] = {}
    for k in sorted(labels_by_turn):
        c = labels_by_turn[k]
        if c not in order:
            order[c] = f"{prefix}{len(order) + 1}"

    speakers: dict[str, dict] = {}
    for c, label in order.items():
        spk = Speaker(label=label, centroid=centroids.get(c, np.zeros(192, dtype=np.float32)))
        if c in centroids and store:
            hit = store.match(spk.centroid)
            if hit:
                item = store.items[hit[0]]
                spk.key, spk.name, spk.is_me = hit[0], item["name"], item.get("isMe", False)
        speakers[label] = spk.public()

    timeline = [
        (turns[k][0] / FPS, turns[k][1] / FPS, order[labels_by_turn[k]])
        for k in sorted(labels_by_turn)
    ]
    return timeline, speakers


def label_for(timeline: list[tuple[float, float, str]], start: float, end: float) -> str | None:
    overlap: dict[str, float] = {}
    for a, b, label in timeline:
        o = min(b, end) - max(a, start)
        if o > 0:
            overlap[label] = overlap.get(label, 0.0) + o
    return max(overlap.items(), key=lambda x: x[1])[0] if overlap else None


def split_by_speaker(segment: dict, timeline: list[tuple[float, float, str]], min_part_s: float = 1.0) -> list[dict]:
    """Split a transcribed segment at speaker changes, using its (absolute) word timestamps."""
    words = segment.get("words") or []
    if not words:
        return [{**segment, "speaker": label_for(timeline, segment["start"], segment["end"]) or segment.get("speaker")}]
    parts: list[dict] = []
    for w in words:
        label = label_for(timeline, w["start"], w["end"]) or (parts[-1]["speaker"] if parts else segment.get("speaker"))
        if parts and parts[-1]["speaker"] == label:
            parts[-1]["words"].append(w)
        else:
            parts.append({"speaker": label, "words": [w]})
    # Fold tiny parts into a neighbour so one stray word doesn't create a new line.
    merged: list[dict] = []
    for p in parts:
        dur = p["words"][-1]["end"] - p["words"][0]["start"]
        if merged and (dur < min_part_s or merged[-1]["speaker"] == p["speaker"]):
            merged[-1]["words"].extend(p["words"])
        else:
            merged.append(p)
    if len(merged) > 1:
        first = merged[0]
        if first["words"][-1]["end"] - first["words"][0]["start"] < min_part_s:
            merged[1]["words"] = first["words"] + merged[1]["words"]
            merged = merged[1:]
    out = []
    for i, p in enumerate(merged):
        out.append({
            **segment,
            "id": segment["id"] if i == 0 else f"{segment['id']}.{i}",
            "start": p["words"][0]["start"],
            "end": p["words"][-1]["end"],
            "text": "".join(w["word"] for w in p["words"]).strip(),
            "speaker": p["speaker"],
            "words": p["words"],
        })
    return out


def assign_speakers(
    audio: np.ndarray,
    segments: list[dict],
    windows: list[tuple[float, np.ndarray]] | None,
    encoder: VoiceEncoder | None,
    store: VoiceprintStore | None,
    prefix: str,
) -> tuple[dict[str, str], dict[str, dict], list[tuple[float, float, str]]]:
    """After a recording: who said each segment. Returns ({segment id: label}, speakers map, timeline).

    Turns come from Nemotron windows when available (cleaner single-voice audio), otherwise
    from the transcript segments themselves. Voiceprints of turns are clustered over the whole
    recording; similar speakers are merged and speakers with too little talk are folded into the
    nearest real one, so short noisy clips can't become phantom participants.
    """
    if encoder is None or not segments:
        return {}, {}, []
    turns: list[tuple[float, float]] = []
    for offset, probs in windows or []:
        active = probs > 0.5
        single = active.sum(axis=1) == 1
        dom = np.where(single, probs.argmax(axis=1), -1)
        start = 0
        for i in range(1, len(dom) + 1):
            if i == len(dom) or dom[i] != dom[start]:
                if dom[start] >= 0 and (i - start) >= FPS * 0.3:
                    turns.append((offset + start / FPS, offset + i / FPS))
                start = i
    if not turns:
        turns = [(s["start"], s["end"]) for s in segments]
    turns.sort()

    long_idx = [k for k, (a, b) in enumerate(turns) if b - a >= MIN_EMBED_S]
    if not long_idx:
        return {s["id"]: f"{prefix}1" for s in segments}, {f"{prefix}1": {"name": None, "key": None, "isMe": False}}, []
    embs = np.stack([
        encoder.embed(audio[int(turns[k][0] * SR) : int(min(turns[k][1], turns[k][0] + MAX_EMBED_S) * SR)])
        for k in long_idx
    ])
    if len(long_idx) == 1:
        clusters = np.array([0])
    else:
        clusters = AgglomerativeClustering(
            n_clusters=None, metric="cosine", linkage="average", distance_threshold=1 - CLUSTER_SIM
        ).fit_predict(embs)

    # Short turns belong to the nearest long turn in time.
    owner = np.zeros(len(turns), dtype=int)
    long_mid = np.array([(turns[k][0] + turns[k][1]) / 2 for k in long_idx])
    for k, (a, b) in enumerate(turns):
        owner[k] = clusters[int(np.argmin(np.abs(long_mid - (a + b) / 2)))]

    def stats() -> dict[int, dict]:
        out: dict[int, dict] = {}
        for k, (a, b) in enumerate(turns):
            st = out.setdefault(int(owner[k]), {"talk": 0.0, "turns": 0})
            st["talk"] += b - a
            st["turns"] += 1
        return out

    def centroid(c: int) -> np.ndarray:
        v = embs[[i for i, k in enumerate(long_idx) if owner[k] == c]].mean(axis=0)
        return v / (np.linalg.norm(v) + 1e-9)

    # Merge speakers that sound alike.
    merged = True
    while merged:
        merged = False
        ids = sorted(set(owner.tolist()))
        cents = {c: centroid(c) for c in ids if any(owner[k] == c for k in long_idx)}
        for i, a in enumerate(cents):
            for b in list(cents)[i + 1 :]:
                if cosine(cents[a], cents[b]) >= MERGE_SIM:
                    owner[owner == b] = a
                    merged = True
                    break
            if merged:
                break

    # Fold speakers with too little talk into the nearest real one (cap the count, too).
    st = stats()
    total = sum(v["talk"] for v in st.values())
    # Short meetings: scale the bar down so a 1-minute chat can still have several speakers.
    min_talk = min(MIN_TALK_S, 0.05 * total)
    min_turns = MIN_TURNS if total >= 120 else 1
    big = sorted((c for c, v in st.items() if v["talk"] >= min_talk and v["turns"] >= min_turns), key=lambda c: -st[c]["talk"])
    big = big[:MAX_SPEAKERS]
    if not big:
        big = [max(st, key=lambda c: st[c]["talk"])]
    big_cents = {c: centroid(c) for c in big if any(owner[k] == c for k in long_idx)}
    for c in set(owner.tolist()) - set(big):
        has_voice = any(owner[k] == c for k in long_idx)
        target = max(big_cents, key=lambda b: cosine(big_cents[b], centroid(c))) if has_voice and big_cents else big[0]
        owner[owner == c] = target

    # Labels in order of first appearance, recognised voices get their names.
    order: dict[int, str] = {}
    for k in range(len(turns)):
        order.setdefault(int(owner[k]), f"{prefix}{len(order) + 1}")
    speakers: dict[str, dict] = {}
    for c, label in order.items():
        spk = Speaker(label=label, centroid=centroid(c) if c in big_cents else np.zeros(192, dtype=np.float32))
        if c in big_cents and store:
            hit = store.match(spk.centroid)
            if hit:
                item = store.items[hit[0]]
                spk.key, spk.name, spk.is_me = hit[0], item["name"], item.get("isMe", False)
        speakers[label] = spk.public()

    # Each segment takes the speaker it overlaps most.
    timeline = [(a, b, order[int(owner[k])]) for k, (a, b) in enumerate(turns)]
    labels: dict[str, str] = {}
    for s in segments:
        label = label_for(timeline, s["start"], s["end"])
        if label is None:
            mid = (s["start"] + s["end"]) / 2
            label = min(timeline, key=lambda t: abs((t[0] + t[1]) / 2 - mid))[2]
        labels[s["id"]] = label
    used = set(labels.values()) | {t[2] for t in timeline}
    return labels, {k: v for k, v in speakers.items() if k in used}, timeline


def speaker_parts(timeline: list[tuple[float, float, str]], start: float, end: float, min_part_s: float = 1.5) -> list[tuple[float, float, str]]:
    """Where the speaker changes inside one transcribed segment: [(start, end, label)], covering it end to end.
    Parts shorter than `min_part_s` are folded into a neighbour."""
    cuts = sorted((max(a, start), min(b, end), lab) for a, b, lab in timeline if b > start and a < end)
    runs: list[list] = []
    for a, b, lab in cuts:
        if runs and runs[-1][2] == lab:
            runs[-1][1] = max(runs[-1][1], b)
        else:
            runs.append([a, b, lab])
    kept: list[list] = []
    for r in runs:
        if kept and r[1] - r[0] < min_part_s:
            kept[-1][1] = r[1]
        elif kept and kept[-1][1] - kept[-1][0] < min_part_s:
            kept[-1][1], kept[-1][2] = r[1], r[2]
        elif kept and kept[-1][2] == r[2]:
            kept[-1][1] = r[1]
        else:
            kept.append(r)
    if len(kept) <= 1:
        return [(start, end, kept[0][2])] if kept else []
    out = []
    for i, (a, b, lab) in enumerate(kept):
        s0 = start if i == 0 else round((kept[i - 1][1] + a) / 2, 2)
        e0 = end if i == len(kept) - 1 else round((b + kept[i + 1][0]) / 2, 2)
        out.append((s0, e0, lab))
    return out
