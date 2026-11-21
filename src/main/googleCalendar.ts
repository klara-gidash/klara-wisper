import { net, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CalendarEvent, GoogleCalendarState } from '@shared/types'
import { cleanGoogleLink as cleanLink, eventsInRange, googleCalendarId as calendarId, parseIcs, type IcsCalendar } from '@shared/ical'
import { dataDir } from './paths'

/**
 * Google Calendar through its "secret address in iCal format": a private link that returns the
 * calendar as an .ics file, with no sign-in and no Google Cloud project (so no admin). It works on
 * Windows too, where there is no Mac calendar, and carries each event's exact Meet link.
 *
 * Whoever holds the link can read the calendar, so it is kept encrypted by the system
 * (safeStorage: Keychain on macOS, DPAPI on Windows), never in settings.json, and only sent to
 * calendar.google.com. Resetting it in Google Calendar settings makes the old one stop working.
 */
const LINK_FILE = join(dataDir, 'google-calendar-link.bin')
/** A fresh copy is fetched when the one in memory is older than this (the home screen asks every minute). */
const FRESH_MS = 3 * 60_000
/** After a failed fetch, wait this long before trying again. */
const RETRY_MS = 60_000
const MAX_BYTES = 40 * 1024 * 1024

let feed: { cal: IcsCalendar; at: number } | null = null
let lastTry = 0
let lastError: string | null = null
let inflight: Promise<void> | null = null

/** Errors carry a code ("gcal:notFound"…) that the settings page turns into a sentence. */
const fail = (code: string): Error => new Error(`gcal:${code}`)

/**
 * End-to-end tests only: with KLARA_E2E=1 and KLARA_E2E_ICS_FILE=/path/to/feed.ics, Google Calendar
 * reads that local file instead of fetching, and counts as linked without any saved (encrypted) link,
 * so no Keychain/safeStorage and no network are involved. Never set in a normal run.
 */
const E2E_ICS = process.env.KLARA_E2E === '1' && process.env.KLARA_E2E_ICS_FILE ? process.env.KLARA_E2E_ICS_FILE : null
const E2E_LINK = 'https://calendar.google.com/calendar/ical/e2e%40example.com/private-e2e/basic.ics'

/** Set when the saved link exists but can't be decrypted (Keychain refused after an update, profile moved…). */
let unreadable = false

function readLink(): string | null {
  if (E2E_ICS) return E2E_LINK
  try {
    if (!existsSync(LINK_FILE)) {
      unreadable = false
      return null
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('no encryption')
    const link = safeStorage.decryptString(readFileSync(LINK_FILE))
    unreadable = false
    return link
  } catch {
    unreadable = true
    return null
  }
}

/** A link is saved (it may still be unreadable: see googleNeedsRelink). */
export const googleLinked = (): boolean => !!E2E_ICS || existsSync(LINK_FILE)

/**
 * A link file is there but the system won't decrypt it, so Google Calendar is silently off: the user
 * has to paste the link again. Shown in the settings section and as a warning in the health check.
 */
export function googleNeedsRelink(): boolean {
  if (E2E_ICS || !existsSync(LINK_FILE)) return false
  readLink()
  return unreadable
}

async function download(link: string): Promise<IcsCalendar> {
  if (E2E_ICS) return parseIcs(new Uint8Array(readFileSync(E2E_ICS)), { me: calendarId(link) })
  let res: Response
  try {
    res = await net.fetch(link, { signal: AbortSignal.timeout(30_000), credentials: 'omit' })
  } catch {
    throw fail('network')
  }
  if (res.status === 404 || res.status === 403 || res.status === 401 || res.status === 410) throw fail('notFound')
  if (!res.ok) throw fail('network')
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw fail('tooBig')
  // Raw bytes, not res.text(): folds are removed before UTF-8 decoding (see decodeIcs in ical.ts).
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > MAX_BYTES) throw fail('tooBig')
  // A sign-in page or an "access denied" page instead of a calendar: the organization blocks the link.
  if (!Buffer.from(bytes.subarray(0, 4096)).toString('latin1').includes('BEGIN:VCALENDAR')) throw fail('notCalendar')
  return parseIcs(bytes, { me: calendarId(link) })
}

/** Fetches a new copy when the one in memory is old; on failure keeps the last good one. */
async function refresh(maxAgeMs = FRESH_MS): Promise<void> {
  const link = readLink()
  if (!link) {
    feed = null
    return
  }
  if (feed && Date.now() - feed.at < maxAgeMs) return
  if (inflight) return inflight
  if (Date.now() - lastTry < RETRY_MS && lastError) return
  inflight = (async () => {
    lastTry = Date.now()
    try {
      feed = { cal: await download(link), at: Date.now() }
      lastError = null
    } catch (err) {
      lastError = (err as Error).message
      console.warn(`google calendar: ${lastError}`)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

const calendarName = (): string => {
  const link = readLink()
  const id = link ? calendarId(link) : ''
  // Named like the Mac names a Google calendar (the address), so it counts as the user's own.
  return id.includes('@') ? id : feed?.cal.name || 'Google Calendar'
}

/** The Google events that overlap [from, to); [] when no link is saved or the calendar can't be read. */
export async function googleEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  if (!googleLinked()) return []
  await refresh()
  return feed ? eventsInRange(feed.cal, from, to, calendarName()) : []
}

/** Whether the Google feed could be read just now (fetching a fresh copy if the cached one is old). */
export async function googleReadable(maxAgeMs = FRESH_MS): Promise<{ linked: boolean; ok: boolean; needsRelink: boolean; error: string | null; events: number | null }> {
  if (!googleLinked()) return { linked: false, ok: false, needsRelink: false, error: null, events: null }
  await refresh(maxAgeMs)
  const needsRelink = googleNeedsRelink()
  return { linked: true, ok: !!feed && !needsRelink, needsRelink, error: needsRelink ? 'gcal:needsRelink' : lastError, events: feed ? feed.cal.events.length : null }
}

/** The name events from the Google link carry in `calendar` (so "coming up" can always show it), or null. */
export function googleCalendarName(): string | null {
  return googleLinked() && readLink() ? calendarName() : null
}

export function googleState(): GoogleCalendarState & { needsRelink: boolean } {
  const needsRelink = googleNeedsRelink()
  if (needsRelink) {
    // Linked as far as the user knows, but off: ask for the link again (the section shows the input).
    return { linked: true, needsRelink, calendar: null, lastSync: null, lastError: 'gcal:needsRelink', upcoming: null }
  }
  const linked = googleLinked() && readLink() !== null
  const now = new Date()
  const week = new Date(now.getTime() + 7 * 86_400_000)
  return {
    linked,
    calendar: linked ? calendarName() : null,
    lastSync: feed ? new Date(feed.at).toISOString() : null,
    lastError: linked ? lastError : null,
    upcoming: linked && feed ? eventsInRange(feed.cal, now, week).length : null,
    needsRelink: false
  }
}

/** Checks the link (it must return a calendar), then keeps it encrypted. */
export async function connectGoogle(raw: string): Promise<GoogleCalendarState & { needsRelink: boolean }> {
  const link = cleanLink(raw)
  if (!safeStorage.isEncryptionAvailable()) throw fail('noEncryption')
  const cal = await download(link)
  writeFileSync(LINK_FILE, safeStorage.encryptString(link), { mode: 0o600 })
  feed = { cal, at: Date.now() }
  lastError = null
  console.log(`google calendar: connected (${cal.events.length} events in the feed)`)
  return googleState()
}

export function disconnectGoogle(): GoogleCalendarState & { needsRelink: boolean } {
  rmSync(LINK_FILE, { force: true })
  feed = null
  lastError = null
  console.log('google calendar: disconnected')
  return googleState()
}
