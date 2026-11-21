import { Notification, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingMeta } from '@shared/types'
import { decodeToPcmFile } from './audioDecode'
import { cloudHealth, cloudRequest, uploadNow } from './cloud'
import { engine } from './engine'
import { finalizer } from './meetings/finalize'
import { recorder } from './meetings/recorder'
import { dataDir } from './paths'
import { transcribeSaved } from './recovery'
import { RecordingsPuller, parseRecordingList, phoneTitle, type CloudRecording, type PendingCleanup } from './recordingsPull'
import { settings } from './settings'
import { db } from './storage/db'
import { createMeetingFolder, listMeetingFolders, readMeta, writeMeta } from './storage/files'
import { autoSummary } from './summarize'
import { broadcast, showLibrary } from './windows'

/**
 * Optional, with Cloudflare sync on: recordings made on the phone (the Worker's /rec/<token> page)
 * are pulled every 2 minutes and become meetings, processed like an in-person recording (speakers
 * separated). The logic is in recordingsPull.ts; this file connects it to the app.
 */
const PULL_EVERY_MS = 2 * 60_000
const MAX_DOWNLOAD = 600 * 1024 * 1024
const PENDING_FILE = join(dataDir, 'phone-recordings.json')
const TMP_DIR = join(dataDir, 'tmp')

export interface PhoneState {
  /** The Worker can take phone recordings (null: not asked yet). */
  supported: boolean | null
  busy: boolean
  lastCheck?: string
  lastImport?: string
  imported: number
  lastError?: string
}

const state: PhoneState = { supported: null, busy: false, imported: 0 }

export function phoneState(): PhoneState {
  return { ...state, busy: puller.running }
}

function findLocal(recordingId: string): { meetingId: string; status: string } | null {
  for (const folder of listMeetingFolders()) {
    const meta = readMeta(folder)
    if (meta?.cloudRecordingId === recordingId) return { meetingId: meta.id, status: meta.status }
  }
  return null
}

function folderOf(meetingId: string): string | null {
  const indexed = db().getFolder(meetingId)
  if (indexed && existsSync(indexed)) return indexed
  for (const folder of listMeetingFolders()) if (readMeta(folder)?.id === meetingId) return folder
  return null
}

/** Moves the decoded PCM into place (a copy when the meeting folder is on another disk). */
function movePcm(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch {
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
}

async function makeMeeting(rec: CloudRecording, pcmPath: string): Promise<string> {
  const startedAt = rec.startedAt ?? new Date().toISOString()
  const source = rec.kind === 'inperson' ? 'inperson' : 'phone'
  const lang = settings.value.uiLanguage === 'en' ? 'en' : 'he'
  const title = rec.title ?? phoneTitle(startedAt, lang)
  const folder = createMeetingFolder({ startedAt, source, title })
  const id = `m_${new Date(startedAt).getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const meta: MeetingMeta = {
    id, title, source, mode: 'inperson', startedAt, folder, status: 'processing',
    calendarEvent: null, attendees: [], speakers: {}, bookmarks: [],
    ...(rec.title ? { titleSource: 'user' as const } : {}),
    cloudRecordingId: rec.id
  }
  writeMeta(folder, meta)
  // The decoded audio becomes the meeting's raw recording, as if it had been recorded here (no copy in memory).
  mkdirSync(join(folder, '.raw'), { recursive: true })
  movePcm(pcmPath, join(folder, '.raw', 'mic.pcm'))
  // In person: the speakers are told apart (Nemotron + voiceprints) before the meeting counts as done.
  if (!(await transcribeSaved(folder, meta, ['mic'], { speakers: true }))) {
    const why = meta.error ?? 'transcription failed'
    await shell.trashItem(folder).catch(() => rmSync(folder, { recursive: true, force: true }))
    throw new Error(why)
  }
  autoSummary.enqueue(id) // the same automatic notes as any finished call
  return id
}

function notifyImported(meetingId: string, title: string): void {
  const he = settings.value.uiLanguage !== 'en'
  const n = new Notification({ title: he ? 'הקלטה מהטלפון תומללה' : 'Phone recording transcribed', body: title, silent: true })
  n.on('click', () => showLibrary(`meeting/${meetingId}`))
  n.show()
}

export const puller = new RecordingsPuller({
  canRun: () => settings.value.cloudSync && engine.status.state === 'ready' && !recorder.live && finalizer.pending.size === 0,
  features: async () => (await cloudHealth())?.features ?? null,
  list: async () => {
    // Ready ones, plus claimed ones whose earlier try failed: the Worker hands those out again once
    // their 30-minute claim expired (claim answers 409 until then, which skips them quietly).
    const out: CloudRecording[] = []
    for (const status of ['ready', 'processing']) {
      const r = await cloudRequest('GET', `/api/recordings?status=${status}`)
      if (!r.ok) throw new Error(`the Worker answered ${r.status} to the recordings list`)
      out.push(...parseRecordingList(await r.json()))
    }
    return out
  },
  claim: async (id) => {
    const r = await cloudRequest('POST', `/api/recordings/${encodeURIComponent(id)}/claim`, { body: '{}' })
    if (r.ok) return true
    if (r.status === 404 || r.status === 409 || r.status === 410) return false // gone, or taken by another computer
    throw new Error(`the Worker answered ${r.status} to claim`)
  },
  release: async (id) => {
    // An older Worker has no /release (404): its claim just expires after 30 minutes.
    const r = await cloudRequest('POST', `/api/recordings/${encodeURIComponent(id)}/release`, { body: '{}' })
    if (!r.ok && r.status !== 404) throw new Error(`the Worker answered ${r.status} to release`)
  },
  download: async (id) => {
    const r = await cloudRequest('GET', `/api/recordings/${encodeURIComponent(id)}/audio`, { timeoutMs: 15 * 60_000 })
    if (!r.ok) throw new Error(`the Worker answered ${r.status} to the download`)
    const size = Number(r.headers.get('content-length') ?? 0)
    if (size > MAX_DOWNLOAD) throw new Error('the recording is too large')
    const bytes = new Uint8Array(await r.arrayBuffer())
    // The Worker says how many bytes the recording has: a cut-off download must not look complete.
    const expected = Number(r.headers.get('x-recording-bytes') ?? NaN)
    if (Number.isFinite(expected) && expected !== bytes.byteLength) throw new Error('the download was cut off')
    return { bytes, contentType: r.headers.get('content-type') }
  },
  decode: async (rec, bytes) => {
    // Straight to raw 16 kHz PCM on disk (the format of .raw/mic.pcm), which makeMeeting then moves into place.
    mkdirSync(TMP_DIR, { recursive: true })
    const path = join(TMP_DIR, `phone-${rec.id.replace(/[^A-Za-z0-9_-]/g, '_')}.pcm`)
    const samples = await decodeToPcmFile(bytes, path)
    if (samples < 16000) {
      rmSync(path, { force: true })
      throw new Error('the recording is shorter than a second')
    }
    return path
  },
  findLocal,
  removeLocal: (meetingId) => {
    const folder = folderOf(meetingId)
    if (folder) void shell.trashItem(folder).catch(() => undefined)
    db().removeMeeting(meetingId)
  },
  transcribe: async (rec, pcmPath) => {
    const id = await makeMeeting(rec, pcmPath)
    const title = readMeta(folderOf(id) ?? '')?.title ?? rec.title ?? ''
    notifyImported(id, title)
    return id
  },
  upload: (meetingId) => uploadNow(meetingId),
  remove: async (id) => {
    const r = await cloudRequest('DELETE', `/api/recordings/${encodeURIComponent(id)}`)
    if (!r.ok && r.status !== 404) throw new Error(`the Worker answered ${r.status} to delete`)
  },
  cleanup: (pcmPath) => rmSync(pcmPath, { force: true }),
  loadPending: (): PendingCleanup[] => {
    try {
      const list = JSON.parse(readFileSync(PENDING_FILE, 'utf8'))
      return Array.isArray(list) ? list.filter((p) => typeof p?.recordingId === 'string' && typeof p?.meetingId === 'string') : []
    } catch {
      return []
    }
  },
  savePending: (list) => {
    if (!list.length) return rmSync(PENDING_FILE, { force: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2))
  },
  log: (message) => console.log(message) // ids and reasons only, never transcript content
})

/** One round now (also from Settings), with the result kept for the settings screen. */
export async function pullPhoneRecordings(): Promise<PhoneState> {
  const report = await puller.pullOnce().catch((err) => ({ skipped: undefined, imported: [], cleaned: [], failed: [{ id: '', error: (err as Error).message }] }))
  if (report.skipped === 'busy' || report.skipped === 'notReady') return phoneState()
  state.lastCheck = new Date().toISOString()
  if (report.skipped === 'noFeature') state.supported = false
  else if (report.skipped !== 'unreachable') state.supported = true
  if (report.imported.length) {
    state.imported += report.imported.length
    state.lastImport = state.lastCheck
  }
  state.lastError = report.failed.at(-1)?.error
  if (report.imported.length || report.failed.length || report.cleaned.length) broadcast('cloud:changed', null)
  return phoneState()
}

let timer: NodeJS.Timeout | null = null

/** Every 2 minutes while sync is on (each round checks the engine and the recorder itself). */
export function startPhoneRecordings(): void {
  if (timer) return
  timer = setInterval(() => {
    if (settings.value.cloudSync) void pullPhoneRecordings()
  }, PULL_EVERY_MS)
  // A first look soon after launch, once the engine had time to load.
  setTimeout(() => {
    if (settings.value.cloudSync) void pullPhoneRecordings()
  }, 45_000)
}
