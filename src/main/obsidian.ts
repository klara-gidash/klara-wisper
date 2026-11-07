import { dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path, { join } from 'node:path'
import type { Meeting } from '@shared/types'
import { demoteHeadings, isInsideDir, meetingFrontMatter, noteFileName, stripFrontMatter, yamlString } from '@shared/notes'
import { fmtClock, paragraphs, speakerName } from '@shared/transcript'
import { dataDir } from './paths'
import { settings } from './settings'
import { db } from './storage/db'
import { listMeetingFolders, readMeeting, readMeta } from './storage/files'

/**
 * Optional (off by default): one Markdown note per finished call in the user's Obsidian vault,
 * at <vault>/Klara Wisper/YYYY-MM-DD HH-MM <title>.md, with properties, the summary and the transcript.
 * Rewritten when the call changes (summary saved, renamed); a renamed call renames its note,
 * through <dataDir>/obsidian-index.json (meeting id → file name). Nothing is written outside the vault.
 */
const INDEX_FILE = join(dataDir, 'obsidian-index.json')
const SUBFOLDER = 'Klara Wisper'

export interface ObsidianState {
  enabled: boolean
  vault: string
  /** The folder has a .obsidian folder (it is a vault, not just any folder). */
  looksLikeVault: boolean
  lastError?: string
}

interface NoteIndex {
  vault: string
  notes: Record<string, string>
}

let lastError: string | undefined
let chain: Promise<unknown> = Promise.resolve()
const pending = new Set<string>()

const he = (): boolean => settings.value.uiLanguage === 'he'

export function obsidianState(): ObsidianState {
  const vault = settings.value.obsidianVault
  return {
    enabled: settings.value.obsidianEnabled && !!vault,
    vault,
    looksLikeVault: !!vault && existsSync(join(vault, '.obsidian')),
    lastError
  }
}

export async function pickObsidianVault(): Promise<ObsidianState> {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: settings.value.obsidianVault || undefined,
    message: he() ? 'בחירת כספת Obsidian' : 'Choose your Obsidian vault'
  })
  if (r.canceled || !r.filePaths[0]) return obsidianState()
  settings.update({ obsidianVault: r.filePaths[0], obsidianEnabled: true })
  lastError = undefined
  return obsidianState()
}

/** Turns the export back on for the vault picked before (or asks for one). */
export async function enableObsidian(): Promise<ObsidianState> {
  const vault = settings.value.obsidianVault
  if (!vault || !isDir(vault)) return pickObsidianVault()
  settings.update({ obsidianEnabled: true })
  lastError = undefined
  return obsidianState()
}

/** Stops exporting; the notes already in the vault stay there. */
export function disableObsidian(): ObsidianState {
  settings.update({ obsidianEnabled: false })
  return obsidianState()
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function loadIndex(vault: string): NoteIndex {
  try {
    const j = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as NoteIndex
    if (j && j.vault === vault && j.notes && typeof j.notes === 'object') return j
  } catch {
    /* none yet */
  }
  return { vault, notes: {} } // another vault: its notes are found again by obsidian_id
}

/** Write-then-rename, so Obsidian never reads a half-written note. */
function writeAtomic(file: string, data: string): void {
  const tmp = join(path.dirname(file), `.${path.basename(file)}.tmp`)
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

function saveIndex(index: NoteIndex): void {
  mkdirSync(dataDir, { recursive: true })
  writeAtomic(INDEX_FILE, JSON.stringify(index, null, 1))
}

/** A note written by us for this meeting (the index was lost, or the vault was picked again). */
function ownsNote(file: string, id: string): boolean {
  try {
    return readFileSync(file, 'utf8').slice(0, 8000).includes(`obsidian_id: ${yamlString(id)}`)
  } catch {
    return false
  }
}

/** The wanted name, or "<name> (2).md"… when another call or the user's own note already has it. */
function freeName(dir: string, wanted: string, id: string, index: NoteIndex): string {
  const stem = wanted.replace(/\.md$/, '')
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? wanted : `${stem} (${i}).md`
    if (Object.entries(index.notes).some(([other, file]) => other !== id && file === name)) continue
    const file = join(dir, name)
    if (!existsSync(file) || index.notes[id] === name || ownsNote(file, id)) return name
  }
  return `${stem} (${id}).md`
}

function noteMarkdown(m: Meeting): string {
  const meta = m.meta
  const userName = settings.value.userName
  const summary = m.summary?.trim() ? demoteHeadings(stripFrontMatter(m.summary).trim()) : 'עוד אין סיכום'
  const lines = [meetingFrontMatter(meta, { obsidian_id: meta.id }), `# ${meta.title}`, '', '## סיכום', '', summary, '', '## תמלול', '']
  for (const p of paragraphs(m.segments)) {
    lines.push(`**${speakerName(p.speaker, meta.speakers, 'he', userName)}** [${fmtClock(p.start)}] ${p.lines.map((l) => l.text).join(' ')}`, '')
  }
  return lines.join('\n')
}

/** Writes (or updates, or renames) one meeting's note. False when there was nothing to write. */
function writeNote(vault: string, m: Meeting): boolean {
  if (m.meta.status !== 'done') return false
  if (!isDir(vault)) throw new Error(he() ? `תיקיית הכספת לא נמצאה: ${vault}` : `The vault folder is missing: ${vault}`)
  const root = realpathSync(vault)
  const dir = join(root, SUBFOLDER)
  mkdirSync(dir, { recursive: true })
  // "Klara Wisper" could be a link to somewhere else; only ever write inside the chosen folder.
  if (!isInsideDir(root, realpathSync(dir), path)) throw new Error('The Klara Wisper folder points outside the vault')
  const index = loadIndex(root)
  const id = m.meta.id
  const name = freeName(dir, noteFileName(m.meta), id, index)
  const target = join(dir, name)
  if (!isInsideDir(dir, target, path)) throw new Error('Note path outside the vault')

  const old = index.notes[id]
  if (old && old !== name) {
    const oldFile = join(dir, old)
    // Renamed call: move the note, so Obsidian keeps one note per call (not a copy under each title).
    if (isInsideDir(dir, oldFile, path) && existsSync(oldFile) && !existsSync(target)) renameSync(oldFile, target)
  }
  const content = noteMarkdown(m)
  const same = existsSync(target) && readFileSync(target, 'utf8') === content
  if (!same) writeAtomic(target, content)
  if (index.notes[id] !== name) {
    index.notes[id] = name
    saveIndex(index)
  }
  return true
}

function exportOne(id: string): void {
  const { obsidianEnabled, obsidianVault } = settings.value
  if (!obsidianEnabled || !obsidianVault) return
  const folder = db().getFolder(id)
  const m = folder ? readMeeting(folder) : null
  if (m) writeNote(obsidianVault, m)
}

/** Writes a meeting's note soon (after it was saved, summarized or renamed). One at a time. */
export function queueObsidian(id: string): void {
  if (!settings.value.obsidianEnabled || !settings.value.obsidianVault || pending.has(id)) return
  pending.add(id)
  chain = chain
    .then(() => {
      pending.delete(id)
      exportOne(id)
      lastError = undefined
    })
    .catch((err) => {
      pending.delete(id)
      lastError = (err as Error).message
      console.warn(`obsidian export: ${lastError}`) // no transcript content in the log
    })
}

/** "Export all calls": every finished call, oldest first. Resolves with how many notes were written. */
export function exportAllObsidian(): Promise<number> {
  const { obsidianEnabled, obsidianVault } = settings.value
  if (!obsidianEnabled || !obsidianVault) return Promise.resolve(0)
  const run = chain.then(() => {
    if (!isDir(obsidianVault)) throw new Error(he() ? `תיקיית הכספת לא נמצאה: ${obsidianVault}` : `The vault folder is missing: ${obsidianVault}`)
    const metas = listMeetingFolders()
      .map((folder) => ({ folder, meta: readMeta(folder) }))
      .filter((x) => x.meta?.status === 'done')
      .sort((a, b) => a.meta!.startedAt.localeCompare(b.meta!.startedAt))
    let n = 0
    for (const { folder } of metas) {
      const m = readMeeting(folder) // one at a time: only one transcript in memory
      try {
        if (m && writeNote(obsidianVault, m)) n++
      } catch (err) {
        lastError = (err as Error).message
        console.warn(`obsidian export: ${lastError}`)
      }
    }
    console.log(`obsidian export: ${n} of ${metas.length} calls written`)
    if (n === metas.length) lastError = undefined
    return n
  })
  chain = run.catch(() => undefined)
  return run
}
