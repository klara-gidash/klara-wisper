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

function readLink(): string | null {
  try {
    if (!existsSync(LINK_FILE) || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(readFileSync(LINK_FILE))
  } catch {
    return null
  }
}

export const googleLinked = (): boolean => existsSync(LINK_FILE)

async function download(link: string): Promise<IcsCalendar> {
  let res: Response
  try {
    res = await net.fetch(link, { signal: AbortSignal.timeout(30_000), credentials: 'omit' })
  } catch {
    throw fail('network')
  }
  if (res.status === 404 || res.status === 403 || res.status === 401 || res.status === 410) throw fail('notFound')
  if (!res.ok) throw fail('network')
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw fail('tooBig')
  const text = await res.text()
  if (text.length > MAX_BYTES) throw fail('tooBig')
  // A sign-in page or an "access denied" page instead of a calendar: the organization blocks the link.
  if (!text.includes('BEGIN:VCALENDAR')) throw fail('notCalendar')
  return parseIcs(text, { me: calendarId(link) })
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

export function googleState(): GoogleCalendarState {
  const linked = googleLinked() && readLink() !== null
  const now = new Date()
  const week = new Date(now.getTime() + 7 * 86_400_000)
  return {
    linked,
    calendar: linked ? calendarName() : null,
    lastSync: feed ? new Date(feed.at).toISOString() : null,
    lastError: linked ? lastError : null,
    upcoming: linked && feed ? eventsInRange(feed.cal, now, week).length : null
  }
}

/** Checks the link (it must return a calendar), then keeps it encrypted. */
export async function connectGoogle(raw: string): Promise<GoogleCalendarState> {
  const link = cleanLink(raw)
  if (!safeStorage.isEncryptionAvailable()) throw fail('noEncryption')
  const cal = await download(link)
  writeFileSync(LINK_FILE, safeStorage.encryptString(link), { mode: 0o600 })
  feed = { cal, at: Date.now() }
  lastError = null
  console.log(`google calendar: connected (${cal.events.length} events in the feed)`)
  return googleState()
}

export function disconnectGoogle(): GoogleCalendarState {
  rmSync(LINK_FILE, { force: true })
  feed = null
  lastError = null
  console.log('google calendar: disconnected')
  return googleState()
}
