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
  const source = meta.source === 'inperson' ? 'פנים מול פנים' : SOURCE_LABEL[meta.source]
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
export function renameMeetingFolder(folder: string, meta: MeetingMeta): string {
  const wanted = folderLabel(meta)
  if (basename(folder) === wanted) return folder
  let target = join(dirname(folder), wanted)
  for (let i = 2; existsSync(target); i++) target = join(dirname(folder), `${wanted} (${i})`)
  try {
    renameSync(folder, target)
    return target
  } catch {
    return folder
  }
}

/** Write-then-rename, so Claude (MCP) and the file watcher never read a half-written file mid-call. */
function writeAtomic(file: string, data: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.tmp`)
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

export function writeMeeting(folder: string, meta: MeetingMeta, segments: Segment[]): void {
  mkdirSync(folder, { recursive: true })
  const m = { ...meta, folder }
  writeAtomic(join(folder, 'meta.json'), JSON.stringify(m, null, 2))
  writeAtomic(join(folder, 'transcript.json'), JSON.stringify({ version: 1, meta: m, segments }, null, 1))
  writeAtomic(join(folder, 'transcript.md'), toMarkdown(m, segments, settings.value.userName, { frontMatter: true }))
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
