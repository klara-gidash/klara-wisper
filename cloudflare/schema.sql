-- Klara Wisper Cloud gateway: one row per uploaded meeting (transcript and summary text only, never audio).
-- Apply with: npx wrangler d1 execute klara-wisper --remote --file=schema.sql
-- Safe to run again: it only creates what is missing.

CREATE TABLE IF NOT EXISTS meetings (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  started_at     TEXT NOT NULL,              -- UTC ISO 8601, e.g. 2026-11-05T08:30:00.000Z
  duration_sec   INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT '',   -- zoom, meet, teams, slack, inperson, ...
  participants   TEXT NOT NULL DEFAULT '[]', -- JSON array of names
  scope          TEXT,
  calendar_title TEXT,
  transcript     TEXT NOT NULL DEFAULT '',   -- Markdown
  summary        TEXT,                       -- Markdown, NULL until written
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings (started_at);
