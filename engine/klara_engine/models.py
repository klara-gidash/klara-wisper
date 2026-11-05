"""Model registry and downloads.

All models live under one folder (default: <app data folder>/models)
so the app can show their size and status, and nothing is scattered in ~/.cache.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import shutil
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

# Plain HTTPS downloads into the model folder (no Xet chunk cache in ~/.cache), so the app can
# show real progress and nothing is left outside the app's folder. Must be set before the import.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from huggingface_hub import HfApi, snapshot_download  # noqa: E402

from .paths import default_data_dir  # noqa: E402


@dataclass(frozen=True)
class ModelSpec:
    key: str
    repo: str
    revision: str  # pinned commit: a changed upstream repo can't slip in new weights or configs
    title: str
    approx_gb: float
    sha256: dict[str, str] = field(default_factory=dict)  # files checked after download and at load
    ignore: list[str] = field(default_factory=list)
    optional: bool = False


MODELS: dict[str, ModelSpec] = {
    m.key: m
    for m in [
        ModelSpec(
            "whisper-large-v3", "mlx-community/whisper-large-v3-mlx", "49e6aa286ad60c14352c404340ded53710378a11",
            "Whisper large-v3", 3.1,
            sha256={
                "weights.npz": "05ff791ce3630fae47e7c51004e9666204d786246ec07cac6110af768099b40d",
                "config.json": "34982ce6ae286095000f82ae9583b3431639e8b092bf60c961f203745e6500e3",
            },
        ),
        ModelSpec(
            "whisper-large-v3-turbo", "mlx-community/whisper-large-v3-turbo", "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb",
            "Whisper large-v3 turbo", 1.6,
            sha256={
                "weights.safetensors": "951ed3fc1203e6a62467abb2144a96ce7eafca8fa77e3704fdb8635ff3e7f8a6",
                "config.json": "b34fc29e4e11e0a25e812775dd67f4dd16fc2c8eb43d28ae25ff7d660ecb6379",
            },
        ),
        ModelSpec(
            # ivrit.ai's Hebrew fine-tune of large-v3-turbo (Apache-2.0): ~45% fewer Hebrew errors than
            # OpenAI large-v3 and ~5x faster. Its language detection is unreliable: always force Hebrew.
            "whisper-ivrit-turbo", "mlx-community/ivrit-ai-whisper-large-v3-turbo-mlx", "53ad8c6cd8b32eb0303f093a404ae13c1b1d567f",
            "Whisper large-v3 turbo · ivrit.ai Hebrew", 1.6,
            sha256={
                "weights.safetensors": "f69cfdd61a6169f4b29a7813e32f9d7f128b5bc07f0b6c09dbf2ef44ac3fb13f",
                "config.json": "b34fc29e4e11e0a25e812775dd67f4dd16fc2c8eb43d28ae25ff7d660ecb6379",
            },
        ),
        ModelSpec(
            # The same ivrit.ai model converted to CTranslate2 (faster-whisper): the Windows ASR model.
            "whisper-ivrit-turbo-ct2", "ivrit-ai/whisper-large-v3-turbo-ct2", "72ad623a37947395efcc3933132353790e5a12f5",
            "Whisper large-v3 turbo · ivrit.ai Hebrew (CTranslate2)", 1.6,
            sha256={
                "model.bin": "db2a2265aa012c16c7db9edda3d699c99f984efdd3f2e22a72a8ce7e9720f3a2",
                "config.json": "c805eff43fc2a1d00d5cfa315e4b2230895f34994257c185959808a116e7c4f0",
                "preprocessor_config.json": "654cf18d3e163b948ceaf9766da56ce0b52de265d58673cf61c9376f126bd499",
                "tokenizer.json": "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd",
                "vocabulary.json": "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1",
            },
        ),
        ModelSpec(
            "nemotron-diarization", "nvidia/Nemotron-3-Diarization", "f667ed73aee57d40cc39428eb768b4fd87a0a29e",
            "NVIDIA Nemotron 3 Diarization", 0.4,
            sha256={
                "model.safetensors": "c074d86335b3b794f8fa5edc25594558f128bdb3914d27806a3a5a2e44963cb6",
                "config.json": "dd795ec07ffa09acf18d231aa3fa8642aa5c521760953754e02559a7413b6873",
                "processor_config.json": "91726746788a024a2f0f2f699a6c3667f0d74e6a0e9288fc44fe3018e23af68e",
            },
            ignore=["*.nemo", "*.gguf", "*.mp4", "*.gif", "*.png"],
        ),
        ModelSpec(
            # hyperparams.yaml is HyperPyYAML, which can construct Python objects: it must match exactly.
            "ecapa", "speechbrain/spkrec-ecapa-voxceleb", "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286",
            "SpeechBrain ECAPA voiceprint", 0.09,
            sha256={
                "hyperparams.yaml": "6f78854fa04ba59e761437b76a2575d3aba5e5016de3e9b69f0c9a5077fb1a41",
                "embedding_model.ckpt": "0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2",
                "mean_var_norm_emb.ckpt": "cd70225b05b37be64fc5a95e24395d804231d43f74b2e1e5a513db7b69b34c33",
                "classifier.ckpt": "fd9e3634fe68bd0a427c95e354c0c677374f62b3f434e45b78599950d860d535",
                "label_encoder.ckpt": "e13c3a167bb4112685670ee896d20e2b565af16b3a4ceeaa8689fa4d22adb8b9",
            },
        ),
    ]
}


# What a new install downloads: the Hebrew ASR model and the after-call speaker models.
ASR_DEFAULT = "whisper-ivrit-turbo" if sys.platform == "darwin" else "whisper-ivrit-turbo-ct2"
DEFAULT_KEYS = [ASR_DEFAULT, "nemotron-diarization", "ecapa"]


def models_dir() -> Path:
    # Not under KLARA_DATA_DIR: tests point that at a temp folder and still use the installed models.
    default = default_data_dir() / "models"
    path = Path(os.environ.get("KLARA_MODELS_DIR", default))
    path.mkdir(parents=True, exist_ok=True)
    return path


def model_path(key: str) -> Path:
    return models_dir() / key


def is_downloaded(key: str) -> bool:
    return (model_path(key) / ".complete").exists()


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def verify(key: str) -> None:
    """Raise if a model file differs from the pinned hash (checked before loading)."""
    for name, want in MODELS[key].sha256.items():
        path = model_path(key) / name
        if not path.exists() or _sha256(path) != want:
            raise RuntimeError(f"model file {key}/{name} does not match its pinned hash")


def _fixup(key: str) -> None:
    """Make the folder loadable offline, exactly as the loaders expect it."""
    if key == "ecapa":
        # SpeechBrain looks for label_encoder.ckpt, which the repo ships as label_encoder.txt; when it
        # is missing it fetches it from the Hub at load time (which fails offline). Same bytes.
        folder = model_path(key)
        ckpt = folder / "label_encoder.ckpt"
        if not ckpt.exists() or ckpt.is_symlink():
            ckpt.unlink(missing_ok=True)
            shutil.copyfile(folder / "label_encoder.txt", ckpt)


def remote_files(key: str) -> dict[str, int]:
    """File name -> size (bytes) of the pinned revision, minus the ignored patterns."""
    spec = MODELS[key]
    info = HfApi().model_info(spec.repo, revision=spec.revision, files_metadata=True)
    out: dict[str, int] = {}
    for f in info.siblings or []:
        if any(fnmatch.fnmatch(f.rfilename, pat) for pat in spec.ignore):
            continue
        out[f.rfilename] = int(f.size or 0)
    return out


def _bytes_on_disk(folder: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(folder):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def download(key: str, on_progress: Callable[[str, float], None] | None = None) -> Path:
    spec = MODELS[key]
    target = model_path(key)
    if is_downloaded(key):
        return target
    if on_progress:
        on_progress(key, 0.0)
    snapshot_download(repo_id=spec.repo, revision=spec.revision, local_dir=target, ignore_patterns=spec.ignore or None)
    _fixup(key)
    verify(key)
    (target / ".complete").write_text(f"{spec.repo}@{spec.revision}")
    if on_progress:
        on_progress(key, 1.0)
    return target


def status() -> list[dict]:
    return [
        {"key": m.key, "title": m.title, "approxGb": m.approx_gb, "downloaded": is_downloaded(m.key)}
        for m in MODELS.values()
    ]


def fetch_json(keys: list[str]) -> int:
    """Download `keys` and print one JSON line per update for the app's progress bar:
    {"event": "plan", "models": [{key, title, bytes}]}, {"event": "progress", key, done, total},
    {"event": "verifying", key}, {"event": "done", key}, {"event": "error", key, message}, {"event": "finished"}."""

    def say(**msg) -> None:
        print(json.dumps(msg, ensure_ascii=False), flush=True)

    todo = [k for k in keys if not is_downloaded(k)]
    try:
        sizes = {k: remote_files(k) for k in todo}
    except Exception as exc:  # no network, Hub down…
        say(event="error", key=None, message=f"could not reach Hugging Face: {exc}")
        return 1
    say(event="plan", models=[
        {"key": k, "title": MODELS[k].title, "bytes": sum(sizes[k].values()) if k in sizes else 0, "downloaded": k not in sizes}
        for k in keys
    ])
    for key in todo:
        total = sum(sizes[key].values())
        target = model_path(key)
        stop = threading.Event()

        def report(key=key, total=total, target=target, stop=stop) -> None:
            while not stop.wait(0.5):
                say(event="progress", key=key, done=min(_bytes_on_disk(target), total), total=total)

        t = threading.Thread(target=report, daemon=True)
        t.start()
        try:
            spec = MODELS[key]
            for attempt in range(3):  # a dropped connection resumes from the partial file
                try:
                    snapshot_download(repo_id=spec.repo, revision=spec.revision, local_dir=target, ignore_patterns=spec.ignore or None)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(3)
        except Exception as exc:
            stop.set()
            say(event="error", key=key, message=str(exc))
            return 1
        stop.set()
        t.join()
        say(event="progress", key=key, done=total, total=total)
        say(event="verifying", key=key)
        try:
            _fixup(key)
            verify(key)
        except Exception as exc:
            say(event="error", key=key, message=str(exc))
            return 1
        (target / ".complete").write_text(f"{MODELS[key].repo}@{MODELS[key].revision}")
        say(event="done", key=key)
    say(event="finished")
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "fetch":  # used by the app's setup screen
        wanted = sys.argv[2:] or DEFAULT_KEYS
        bad = [k for k in wanted if k not in MODELS]
        if bad:
            sys.exit(f"unknown model(s): {', '.join(bad)}")
        sys.exit(fetch_json(wanted))
    keys = sys.argv[2:] if len(sys.argv) > 2 and sys.argv[1] == "download" else []
    if keys == ["all"]:
        keys = list(MODELS)
    for k in keys:
        print(f"downloading {k} …", flush=True)
        print("  ->", download(k), flush=True)
    for row in status():
        print(row)
