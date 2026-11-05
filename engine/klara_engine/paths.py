"""Where the app keeps its data, per platform (KLARA_DATA_DIR overrides, e.g. for tests)."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """Settings, voiceprints, logs (KLARA_DATA_DIR overrides)."""
    if os.environ.get("KLARA_DATA_DIR"):
        return Path(os.environ["KLARA_DATA_DIR"])
    return default_data_dir()


def default_data_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "Klara Wisper"
    return Path.home() / "Library" / "Application Support" / "Klara Wisper"


def documents_dir() -> Path:
    return Path.home() / "Documents" / "Klara Wisper"
