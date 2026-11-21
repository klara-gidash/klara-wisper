import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Dictation, MeetingMeta, Segment } from '@shared/types'
import { listMeetingFolders as listFolders } from '@shared/library'
import { SOURCE_LABEL } from '@shared/types'
import { sanitizeName, toMarkdown } from '@shared/transcript'
import { settings } from '../settings'

/**
 * On-disk layout (the folder is the source of truth; the SQLite index can be rebuilt from it):
 *   <folder>/Meetings/YYYY/MM/YYYY-MM-DD HHmm · Source · Title/
 *       meta.json, transcript.json, transcript.md, audio.m4a, summary.md, .raw/*.pcm (while recording)
 *   <folder>/Dictations/YYYY-MM.jsonl + YYYY-MM.md
 */
export function meetingsRoot(): string {
  return join(settings.value.folder, 'Meetings')
}

export function dictationsRoot(): string {
  return join(settings.value.folder, 'Dictations')
}

const pad = (n: number): string => String(n).padStart(2, '0')

function folderLabel(meta: Pick<MeetingMeta, 'startedAt' | 'source' | 'title'>): string {
  const d = new Date(meta.startedAt)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`
  const source = meta.source === 'inperson' ? 'פנים מול פנים' : meta.source === 'phone' ? 'טלפון' : SOURCE_LABEL[meta.source]
  const title = sanitizeName(meta.title)
  return [stamp, source, title && title !== source ? title : null].filter(Boolean).join(' · ')
}

export function createMeetingFolder(meta: Pick<MeetingMeta, 'startedAt' | 'source' | 'title'>): string {
  const d = new Date(meta.startedAt)
  const parent = join(meetingsRoot(), String(d.getFullYear()), pad(d.getMonth() + 1))
  mkdirSync(parent, { recursive: true })
  let folder = join(parent, folderLabel(meta))
  for (let i = 2; existsSync(folder); i++) folder = join(parent, `${folderLabel(meta)} (${i})`)
  mkdirSync(join(folder, '.raw'), { recursive: true })
  return folder
}

/** Renames the folder when the title changed (e.g. matched to a calendar event at the end). */
/**
 * Renames a meeting's folder after its title. While the recording is still being processed (its
 * .raw folder exists) the folder keeps its name: the engine reads .raw for the speaker step after
 * sending the transcript, and the finalizer renames the folder itself at the very end (force).
 */
export function renameMeetingFolder(folder: string, meta: MeetingMeta, opts: { force?: boolean } = {}): string {
  const wanted = folderLabel(meta)
  if (basename(folder) === wanted) return folder
  if (!opts.force && existsSync(join(folder, '.raw'))) return folder
  let target = join(dirname(folder), wanted)
  for (let i = 2; existsSync(target); i++) target = join(dirname(folder), `${wanted} (${i})`)
  try {
    withRetry(() => renameSync(folder, target))
    return target
  } catch {
    return folder
  }
}

const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRY_MS = [50, 100, 200, 400, 800]

/** Blocks this thread for a moment (the writes here are synchronous). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Windows: antivirus, OneDrive or a reader (Claude's MCP server, the file watcher) holding the file
 * makes writes and renames fail with EPERM/EBUSY/EACCES for a moment. Try again a few times.
 */
function withRetry<T>(fn: () => T): T {
  for (let i = 0; ; i++) {
    try {
      return fn()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? ''
      if (process.platform !== 'win32' || !BUSY_CODES.has(code) || i >= RETRY_MS.length) throw err
      pause(RETRY_MS[i])
    }
  }
}

/** Write-then-rename, so Claude (MCP) and the file watcher never read a half-written file mid-call. */
function writeAtomic(file: string, data: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.tmp`)
  withRetry(() => writeFileSync(tmp, data))
  withRetry(() => renameSync(tmp, file))
}

export function writeMeeting(folder: string, meta: MeetingMeta, segments: Segment[]): void {
  mkdirSync(folder, { recursive: true })
  const m = { ...meta, folder }
  writeAtomic(join(folder, 'meta.json'), JSON.stringify(m, null, 2))
  writeAtomic(join(folder, 'transcript.json'), JSON.stringify({ version: 1, meta: m, segments }, null, 1))
  writeAtomic(join(folder, 'transcript.md'), toMarkdown(m, segments, settings.value.userName, { frontMatter: true }))
}

/**
 * transcript.md again from meta.json, when an edit made outside the app (Claude naming a speaker
 * through MCP, a title) changed what it shows. Writes only when the text differs.
 */
export function refreshMarkdown(folder: string, meta: MeetingMeta, segments: Segment[]): boolean {
  const file = join(folder, 'transcript.md')
  const md = toMarkdown({ ...meta, folder }, segments, settings.value.userName, { frontMatter: true })
  const old = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (old === md) return false
  writeAtomic(file, md)
  return true
}

export function writeMeta(folder: string, meta: MeetingMeta): void {
  writeAtomic(join(folder, 'meta.json'), JSON.stringify({ ...meta, folder }, null, 2))
}

export { readMeeting, readMeta } from '@shared/library'

export function listMeetingFolders(): string[] {
  return listFolders(meetingsRoot())
}

export function appendDictation(d: Dictation): void {
  const root = dictationsRoot()
  mkdirSync(root, { recursive: true })
  const at = new Date(d.at)
  const month = `${at.getFullYear()}-${pad(at.getMonth() + 1)}`
  appendFileSync(join(root, `${month}.jsonl`), JSON.stringify(d) + '\n')
  const day = `${pad(at.getDate())}/${pad(at.getMonth() + 1)} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  appendFileSync(join(root, `${month}.md`), `- **${day}**${d.app ? ` · ${d.app}` : ''} — ${d.text}\n`)
}

export function readAllDictations(): Dictation[] {
  const root = dictationsRoot()
  if (!existsSync(root)) return []
  const out: Dictation[] = []
  for (const f of readdirSync(root).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(root, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* skip */
      }
    }
  }
  return out
}
