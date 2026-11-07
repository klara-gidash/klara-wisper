import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toMarkdown } from '@shared/transcript'
import { dataDir } from './paths'
import { settings } from './settings'
import { db } from './storage/db'
import { listMeetingFolders, readMeeting } from './storage/files'

/**
 * Optional (off by default): copies each call's transcript and summary (never the audio) to the
 * user's own Cloudflare Worker (cloudflare/, docs/CLOUDFLARE.he.md). The Worker serves them to
 * Claude as a remote connector, so Claude on the phone can answer about the calls too.
 * The token is kept encrypted by macOS (safeStorage / Keychain), never in settings.json.
 */
const TOKEN_FILE = join(dataDir, 'cloud-token.bin')

export interface CloudState {
  enabled: boolean
  url: string
  hasToken: boolean
  lastSync?: string
  lastError?: string
}

let lastSync: string | undefined
let lastError: string | undefined

function token(): string | null {
  try {
    if (!existsSync(TOKEN_FILE) || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(readFileSync(TOKEN_FILE))
  } catch {
    return null
  }
}

export function cloudState(): CloudState {
  return { enabled: settings.value.cloudSync, url: settings.value.cloudUrl, hasToken: !!token(), lastSync, lastError }
}

function cleanUrl(url: string): string {
  const u = new URL(url.trim())
  if (u.protocol !== 'https:') throw new Error('The Worker address must start with https://')
  return u.origin
}

/** Saves the Worker address and (when given) a new token; checks both against the Worker. */
export async function configureCloud(opts: { url: string; token?: string; enabled: boolean }): Promise<CloudState> {
  const url = opts.url ? cleanUrl(opts.url) : ''
  if (opts.token !== undefined && opts.token !== '') {
    if (opts.token.trim().length < 32) throw new Error('The token must be at least 32 characters (openssl rand -hex 32)')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS encryption (Keychain) is not available')
    writeFileSync(TOKEN_FILE, safeStorage.encryptString(opts.token.trim()), { mode: 0o600 })
  }
  if (opts.enabled && (!url || !token())) throw new Error('Fill in the Worker address and the token first')
  settings.update({ cloudUrl: url, cloudSync: opts.enabled })
  if (opts.enabled) await checkCloud()
  return cloudState()
}

export function forgetCloud(): CloudState {
  rmSync(TOKEN_FILE, { force: true })
  settings.update({ cloudSync: false })
  return cloudState()
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const t = token()
  if (!t || !settings.value.cloudUrl) throw new Error('Cloudflare sync is not set up')
  return fetch(settings.value.cloudUrl + path, {
    method,
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error' // never resend a transcript to a redirected (possibly http) address
  })
}

/** The Worker answers and accepts the token (deleting a meeting that doesn't exist changes nothing). */
export async function checkCloud(): Promise<CloudState> {
  try {
    const r = await call('DELETE', '/api/meetings/__connection-check__')
    if (r.status === 401 || r.status === 403) throw new Error('The Worker rejected the token')
    if (!r.ok && r.status !== 404) throw new Error(`The Worker answered ${r.status}`)
    lastError = undefined
  } catch (err) {
    lastError = (err as Error).message
    throw err
  }
  return cloudState()
}

async function upload(id: string): Promise<void> {
  const folder = db().getFolder(id)
  const m = folder ? readMeeting(folder) : null
  if (!m || m.meta.status !== 'done') return
  const meta = m.meta
  const people = (meta.attendees ?? []).filter((a) => !a.isMe).map((a) => a.name || a.email)
  const r = await call('POST', '/api/meetings', {
    id: meta.id,
    title: meta.title,
    startedAt: meta.startedAt,
    durationSec: meta.durationSec ?? 0,
    source: meta.source,
    participants: people.length ? people : meta.inferredParticipants ?? [],
    scope: meta.scope ?? null,
    calendarTitle: meta.calendarEvent?.title ?? null,
    transcript: toMarkdown(meta, m.segments, settings.value.userName).slice(0, 1_900_000),
    summary: m.summary
  })
  if (!r.ok) throw new Error(`upload ${id}: ${r.status}`)
}

let chain: Promise<void> = Promise.resolve()
const pending = new Set<string>()

/** Uploads a meeting soon (after it was saved, summarized or renamed). One at a time, never blocking anything. */
export function queueCloud(id: string): void {
  if (!settings.value.cloudSync || pending.has(id)) return
  pending.add(id)
  chain = chain
    .then(async () => {
      pending.delete(id)
      await upload(id)
      lastSync = new Date().toISOString()
      lastError = undefined
    })
    .catch((err) => {
      pending.delete(id)
      lastError = (err as Error).message
      console.warn(`cloud sync: ${lastError}`) // no transcript content in the log
    })
}

/**
 * Removes a deleted meeting's copy from the Worker. Queued after any upload already under way, so
 * that upload can't put the meeting back. Rejects on failure; the caller logs it.
 */
export function deleteCloud(id: string): Promise<void> {
  const done = chain.then(async () => {
    const r = await call('DELETE', `/api/meetings/${encodeURIComponent(id)}`)
    if (!r.ok) throw new Error(`the Worker answered ${r.status}`)
  })
  chain = done.catch(() => undefined)
  return done
}

/** "Sync all calls": every finished call, oldest first. */
export function syncAllCloud(): number {
  if (!settings.value.cloudSync) return 0
  const ids = listMeetingFolders()
    .map((f) => readMeeting(f)?.meta)
    .filter((m): m is NonNullable<typeof m> => !!m && m.status === 'done')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((m) => m.id)
  for (const id of ids) queueCloud(id)
  console.log(`cloud sync: ${ids.length} calls queued`)
  return ids.length
}
