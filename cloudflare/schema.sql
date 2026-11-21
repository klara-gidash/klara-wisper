-- Klara Wisper Cloud gateway: uploaded meetings (transcript and summary text), and phone recordings waiting to be transcribed.
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
  updated_at     TEXT NOT NULL,
  -- Team cloud (the Worker adds these three to an older table by itself):
  uploaded_by    TEXT NOT NULL DEFAULT 'owner', -- 'owner' or a members.id: who uploaded it
  shared         INTEGER NOT NULL DEFAULT 0,    -- 1 only when its uploader shared it with the team
  row_bytes      INTEGER NOT NULL DEFAULT 0     -- UTF-8 bytes of the row's text, for the per-member limit
);

CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings (started_at);

-- Phone recordings (the /rec/<KLARA_REC_TOKEN> link). The Worker also creates these tables by itself on first use,
-- so a deployment made before they existed upgrades just by redeploying the Worker.
-- Audio stays here only until Klara Wisper on the computer downloads and transcribes it, then it is deleted.
CREATE TABLE IF NOT EXISTS recordings (
  id           TEXT PRIMARY KEY,                 -- r_ + random
  client_id    TEXT,                             -- the phone page's own id, so a retried start is not a new row
  title        TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'inperson', -- inperson or phone
  mime         TEXT NOT NULL,                    -- audio/webm (opus) or audio/mp4
  started_at   TEXT NOT NULL,                    -- UTC ISO 8601
  duration_sec INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0,
  chunks       INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'recording', -- recording, ready or processing
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  finished_at  TEXT,
  claimed_at   TEXT,
  member_id    TEXT NOT NULL DEFAULT 'owner'      -- whose phone link made it: 'owner' or a members.id
);

CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings (status, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_client_id_unique ON recordings (client_id);

CREATE TABLE IF NOT EXISTS recording_chunks (
  id   TEXT NOT NULL,     -- recordings.id
  seq  INTEGER NOT NULL,  -- 0, 1, 2, ... in recording order
  data BLOB NOT NULL,     -- at most 1,000,000 bytes
  PRIMARY KEY (id, seq)
);

-- When old recordings were last cleaned up (ms since 1970), so the cleanup runs at most once an hour.
CREATE TABLE IF NOT EXISTS recording_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO recording_meta (key, value) VALUES ('cleanup', 0);

-- Team cloud (optional): members the owner invited, team connectors, and the owner's display name.
-- Tokens and invite codes are stored only as SHA-256 hashes. The Worker creates these tables by itself too, and the
-- indexes on the team columns above (uploaded_by, shared, member_id): this file runs again on every update, when an
-- older table may not have those columns yet, so it never indexes them.
CREATE TABLE IF NOT EXISTS members (
  id                TEXT PRIMARY KEY,  -- u_ + random
  name              TEXT NOT NULL,     -- shown on the team connector next to the meetings they share
  upload_hash       TEXT UNIQUE,       -- NULL until they join, and after they are removed
  mcp_hash          TEXT UNIQUE,
  rec_hash          TEXT UNIQUE,
  invite_hash       TEXT UNIQUE,       -- the one-time invite code, until it is used
  invite_expires_at TEXT,
  created_at        TEXT NOT NULL,
  joined_at         TEXT,
  last_seen_at      TEXT,
  removed_at        TEXT               -- kept only while their shared meetings stay
);

CREATE TABLE IF NOT EXISTS team_connectors (
  id         TEXT PRIMARY KEY,         -- t_ + random
  label      TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
