import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Dictation, MeetingMeta, MeetingSummary, SearchHit, Segment } from '@shared/types'
import { dataDir } from '../paths'
import { listMeetingFolders, readAllDictations, readMeeting } from './files'

const SCHEMA_VERSION = 1

/**
 * Search index over the meeting folders. FTS5 with the trigram tokenizer finds Hebrew words
 * even with attached prefixes (ה/ו/ב/ל/מ/ש) and English substrings.
 */
class Index {
  private db: Database.Database

  constructor() {
    mkdirSync(dataDir, { recursive: true })
    this.db = new Database(join(dataDir, 'index.sqlite'))
    this.db.pragma('journal_mode = WAL')
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version !== SCHEMA_VERSION) this.reset()
  }

  private reset(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS meetings; DROP TABLE IF EXISTS segments; DROP TABLE IF EXISTS segments_fts;
      DROP TABLE IF EXISTS dictations; DROP TABLE IF EXISTS dictations_fts;
      CREATE TABLE meetings (id TEXT PRIMARY KEY, started_at TEXT, source TEXT, mode TEXT, title TEXT, folder TEXT, meta TEXT, preview TEXT);
      CREATE INDEX meetings_started ON meetings(started_at DESC);
      CREATE TABLE segments (rowid INTEGER PRIMARY KEY, meeting_id TEXT, seg_id TEXT, start REAL, speaker TEXT, lang TEXT, text TEXT);
      CREATE INDEX segments_meeting ON segments(meeting_id);
      CREATE VIRTUAL TABLE segments_fts USING fts5(text, content='segments', content_rowid='rowid', tokenize='trigram');
      CREATE TABLE dictations (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, at TEXT, lang TEXT, app TEXT, seconds REAL, text TEXT);
      CREATE VIRTUAL TABLE dictations_fts USING fts5(text, content='dictations', content_rowid='rowid', tokenize='trigram');
    `)
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  isEmpty(): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n === 0
  }

  /** Re-reads every meeting folder and dictation log. */
  rebuild(): void {
    this.reset()
    for (const folder of listMeetingFolders()) {
      const m = readMeeting(folder)
      if (m) this.indexMeeting(m.meta, m.segments)
    }
    for (const d of readAllDictations()) this.indexDictation(d)
  }

  indexMeeting(meta: MeetingMeta, segments: Segment[]): void {
    const tx = this.db.transaction(() => {
      this.removeMeeting(meta.id)
      const preview = segments.slice(0, 3).map((s) => s.text).join(' ').slice(0, 220)
      this.db
        .prepare('INSERT INTO meetings (id, started_at, source, mode, title, folder, meta, preview) VALUES (?,?,?,?,?,?,?,?)')
        .run(meta.id, meta.startedAt, meta.source, meta.mode, meta.title, meta.folder, JSON.stringify(meta), preview)
      const ins = this.db.prepare('INSERT INTO segments (meeting_id, seg_id, start, speaker, lang, text) VALUES (?,?,?,?,?,?)')
      const fts = this.db.prepare('INSERT INTO segments_fts (rowid, text) VALUES (?, ?)')
      for (const s of segments) {
        const r = ins.run(meta.id, s.id, s.start, s.speaker, s.lang, s.text)
        fts.run(r.lastInsertRowid, s.text)
      }
    })
    tx()
  }

  updateMeta(meta: MeetingMeta): void {
    this.db.prepare('UPDATE meetings SET title = ?, folder = ?, meta = ? WHERE id = ?').run(meta.title, meta.folder, JSON.stringify(meta), meta.id)
  }

  removeMeeting(id: string): void {
    const rows = this.db.prepare('SELECT rowid, text FROM segments WHERE meeting_id = ?').all(id) as { rowid: number; text: string }[]
    const del = this.db.prepare("INSERT INTO segments_fts (segments_fts, rowid, text) VALUES ('delete', ?, ?)")
    for (const r of rows) del.run(r.rowid, r.text)
    this.db.prepare('DELETE FROM segments WHERE meeting_id = ?').run(id)
    this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
  }

  listMeetings(opts: { source?: string; mode?: string; limit?: number } = {}): MeetingSummary[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.source) {
      where.push('source = ?')
      args.push(opts.source)
    }
    if (opts.mode) {
      where.push('mode = ?')
      args.push(opts.mode)
    }
    const sql = `SELECT meta, preview FROM meetings ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...args, opts.limit ?? 500) as { meta: string; preview: string }[]
    return rows.map((r) => ({ ...JSON.parse(r.meta), preview: r.preview }))
  }

  getFolder(id: string): string | null {
    const row = this.db.prepare('SELECT folder FROM meetings WHERE id = ?').get(id) as { folder: string } | undefined
    return row?.folder ?? null
  }

  search(q: string, limit = 50): SearchHit[] {
    const query = q.trim()
    if (!query) return []
    let rows: { meeting_id: string; seg_id: string; start: number; speaker: string | null; text: string }[]
    if ([...query].length >= 3) {
      const phrase = '"' + query.replace(/"/g, '""') + '"'
      rows = this.db
        .prepare(
          `SELECT s.meeting_id, s.seg_id, s.start, s.speaker, s.text FROM segments_fts f
           JOIN segments s ON s.rowid = f.rowid WHERE segments_fts MATCH ? ORDER BY s.meeting_id, s.start LIMIT 2000`
        )
        .all(phrase) as typeof rows
    } else {
      rows = this.db
        .prepare('SELECT meeting_id, seg_id, start, speaker, text FROM segments WHERE text LIKE ? LIMIT 2000')
        .all(`%${query}%`) as typeof rows
    }
    const meetings = new Map<string, SearchHit>()
    const metaStmt = this.db.prepare('SELECT title, started_at, source FROM meetings WHERE id = ?')
    for (const r of rows) {
      let hit = meetings.get(r.meeting_id)
      if (!hit) {
        const m = metaStmt.get(r.meeting_id) as { title: string; started_at: string; source: any } | undefined
        if (!m) continue
        hit = { meetingId: r.meeting_id, title: m.title, startedAt: m.started_at, source: m.source, segments: [] }
        meetings.set(r.meeting_id, hit)
      }
      if (hit.segments.length < 8) hit.segments.push({ id: r.seg_id, start: r.start, speaker: r.speaker, text: r.text })
    }
    return [...meetings.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
  }

  indexDictation(d: Dictation): void {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO dictations (id, at, lang, app, seconds, text) VALUES (?,?,?,?,?,?)')
      .run(d.id, d.at, d.lang, d.app ?? null, d.seconds ?? null, d.text)
    if (r.changes) this.db.prepare('INSERT INTO dictations_fts (rowid, text) VALUES (?, ?)').run(r.lastInsertRowid, d.text)
  }

  listDictations(q = '', limit = 300): Dictation[] {
    if (q.trim().length >= 3) {
      return this.db
        .prepare(
          `SELECT d.id, d.at, d.lang, d.app, d.seconds, d.text FROM dictations_fts f JOIN dictations d ON d.rowid = f.rowid
           WHERE dictations_fts MATCH ? ORDER BY d.at DESC LIMIT ?`
        )
        .all('"' + q.replace(/"/g, '""') + '"', limit) as Dictation[]
    }
    const like = q.trim() ? `%${q.trim()}%` : '%'
    return this.db.prepare('SELECT id, at, lang, app, seconds, text FROM dictations WHERE text LIKE ? ORDER BY at DESC LIMIT ?').all(like, limit) as Dictation[]
  }
}

let instance: Index | null = null
export function db(): Index {
  if (!instance) instance = new Index()
  return instance
}
