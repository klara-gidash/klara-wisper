/**
 * Pure helpers for Markdown notes: YAML front matter, note file names, and the vault path check.
 * No Electron, no Node built-ins at runtime (the renderer imports transcript.ts, which uses this),
 * and only type imports, so `node --test` can load this file directly (test/obsidian.test.mts).
 */
import type { MeetingMeta } from './types'

export type FrontMatterValue = string | number | boolean | null | undefined | string[]

/** The parts of node:path the vault check needs; passed in so this file stays browser-safe. */
export type PathLike = {
  resolve: (...p: string[]) => string
  relative: (from: string, to: string) => string
  isAbsolute: (p: string) => boolean
  sep: string
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
// Not printable in YAML even inside quotes (C1 controls, DEL, BOM, non-characters), or read as line breaks (NEL, LS, PS).
const YAML_UNSAFE = /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g

/**
 * A YAML double-quoted scalar. JSON string syntax is valid YAML; Hebrew stays as is (UTF-8),
 * and the few characters YAML treats differently from JSON are written as \u escapes.
 */
export function yamlString(s: string): string {
  return JSON.stringify(String(s).replace(LONE_SURROGATE, '�')).replace(
    YAML_UNSAFE,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  )
}

function yamlValue(v: FrontMatterValue): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) return v.length ? '\n' + v.map((x) => `  - ${yamlString(x)}`).join('\n') : '[]'
  return yamlString(v)
}

/** `---` block from fixed keys (letters, digits, underscore) in the given order. */
export function frontMatter(fields: Record<string, FrontMatterValue>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    const v = yamlValue(value)
    lines.push(v.startsWith('\n') ? `${key}:${v}` : `${key}: ${v}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

/** Calendar attendees other than the user; otherwise the people Claude identified from the transcript. */
export function meetingParticipants(meta: Pick<MeetingMeta, 'attendees' | 'calendarEvent' | 'inferredParticipants'>): string[] {
  const attendees = meta.attendees ?? meta.calendarEvent?.attendees ?? []
  const people = attendees.filter((a) => !a.isMe).map((a) => (a.name || a.email || '').trim())
  const list = people.filter(Boolean).length ? people : (meta.inferredParticipants ?? []).map((p) => String(p).trim())
  return [...new Set(list.filter(Boolean))]
}

function isoDate(s: string): string {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString()
}

/** The front matter of transcript.md and of the Obsidian note (`extra` adds keys at the end). */
export function meetingFrontMatter(meta: MeetingMeta, extra: Record<string, FrontMatterValue> = {}): string {
  return frontMatter({
    id: meta.id,
    title: meta.title ?? '',
    date: isoDate(meta.startedAt),
    source: meta.source,
    duration_min: typeof meta.durationSec === 'number' ? Math.round(meta.durationSec / 60) : null,
    calendar_event: meta.calendarEvent?.title ?? null,
    participants: meetingParticipants(meta),
    scope: meta.scope ?? null,
    tags: ['klara-wisper'],
    ...extra
  })
}

/**
 * A safe note file name: no path or reserved characters (/ \ : * ? " < > |, and # ^ [ ] that break
 * Obsidian links), no control characters, no leading dot (hidden file) or trailing dot/space,
 * at most 80 characters (counted by code point, so an emoji is never cut in half).
 */
export function sanitizeNoteName(s: string): string {
  const clean = String(s)
    .replace(LONE_SURROGATE, '')
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const cut = Array.from(clean).slice(0, 80).join('')
  return cut.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `YYYY-MM-DD HH-MM <title>.md`, in local time. */
export function noteFileName(meta: Pick<MeetingMeta, 'startedAt' | 'title'>): string {
  const d = new Date(meta.startedAt)
  const stamp = Number.isNaN(d.getTime())
    ? ''
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`
  return (sanitizeNoteName(`${stamp} ${meta.title ?? ''}`) || 'Klara Wisper') + '.md'
}

/** True only when `target` is strictly inside `root` (after resolving `..`). */
export function isInsideDir(root: string, target: string, path: PathLike): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/** Drops a leading `---` front matter block (so a note never has two). */
export function stripFrontMatter(md: string): string {
  return md.replace(/^\ufeff?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '')
}

/** Moves headings down two levels (# → ###), so a saved summary nests under the note's "## סיכום". */
export function demoteHeadings(md: string): string {
  let fence = false
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence
      if (fence) return line
      const m = /^(#{1,6})(\s.*)?$/.exec(line)
      return m ? '#'.repeat(Math.min(6, m[1].length + 2)) + (m[2] ?? '') : line
    })
    .join('\n')
}
