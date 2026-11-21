"""Fast tests for the MCP server's time handling (no models, no audio)."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture()
def mcp(tmp_path, monkeypatch):
    monkeypatch.setenv("TZ", "Asia/Jerusalem")
    time.tzset()
    monkeypatch.delenv("KLARA_MCP_ONLY", raising=False)
    from klara_engine import mcp_server

    monkeypatch.setattr(mcp_server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(mcp_server, "ONLY", None)
    yield mcp_server
    monkeypatch.delenv("TZ")
    time.tzset()


def z(d: datetime) -> str:
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_cache(tmp_path, events, at=None):
    (tmp_path / "upcoming.json").write_text(json.dumps({"at": z(at or datetime.now(timezone.utc)), "events": events}))


def test_upcoming_keeps_meeting_ending_soon(mcp, tmp_path):
    now = datetime.now(timezone.utc)
    write_cache(tmp_path, [
        {"title": "Ends in an hour", "start": z(now - timedelta(minutes=30)), "end": z(now + timedelta(hours=1))},
        {"title": "Already over", "start": z(now - timedelta(hours=2)), "end": z(now - timedelta(minutes=5))},
    ])
    out = mcp.list_upcoming_meetings()
    assert "Ends in an hour" in out
    assert "Already over" not in out
    assert "out of date" not in out


def test_upcoming_says_when_cache_is_old(mcp, tmp_path):
    now = datetime.now(timezone.utc)
    write_cache(tmp_path, [], at=now - timedelta(hours=2))
    out = mcp.list_upcoming_meetings()
    assert "out of date" in out and "No upcoming meetings." in out


def test_date_filter_uses_local_date(mcp):
    # 23:30 UTC on 20/11 is 01:30 on 21/11 in Israel.
    iso = "2026-11-20T23:30:00Z"
    assert mcp.local_day(iso) == "2026-11-21"
    assert mcp.in_range(iso, "2026-11-21", "2026-11-21")
    assert not mcp.in_range(iso, "2026-11-20", "2026-11-20")
