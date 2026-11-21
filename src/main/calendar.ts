import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CalendarEvent, MeetingSource } from '@shared/types'
import { mergeEvents } from '@shared/ical'
import { googleCalendarName, googleEvents, googleLinked, googleReadable } from './googleCalendar'
import { helper } from './helper'
import { dataDir } from './paths'
import { settings } from './settings'

const run = promisify(execFile)

/**
 * Asks macOS for calendar access (the system prompt). macOS keeps calendar access for the app
 * (io.klara.wisper), and once it has recorded a "no" for this build it answers at once without
 * asking, so "connect calendar" seemed to do nothing. Then the old answer is cleared (only Klara
 * Wisper's calendar permission) and the question asked again: the user just pressed "connect".
 */
export async function requestCalendar(): Promise<string> {
  const ask = async (): Promise<{ result: string; ms: number }> => {
    const t0 = Date.now()
    const r = await helper.request('requestPermission', { kind: 'calendar' }, 180_000)
    return { result: r.result, ms: Date.now() - t0 }
  }
  let r = await ask()
  if (r.result !== 'granted' && r.ms < 2000 && process.platform === 'darwin') {
    console.log(`calendar: macOS answered "${r.result}" without asking; clearing Klara Wisper's calendar permission and asking again`)
    // The helper disclaims responsibility (Disclaim.swift), so macOS records the grant under the
    // helper's own id; the app's id is cleared too for builds where the app asked.
    for (const id of ['io.klara.wisper.helper', 'io.klara.wisper']) {
      await run('/usr/bin/tccutil', ['reset', 'Calendar', id], { timeout: 10_000 }).catch((err) => console.warn(`calendar: tccutil reset ${id} failed`, err))
    }
    r = await ask()
  }
  console.log(`calendar: ${r.result}`)
  return r.result === 'granted' ? 'granted' : 'denied'
}

/**
 * The helper reads plain ISO dates ("…T10:00:00Z") and silently falls back to "the next 24 hours" on
 * anything else, and toISOString() adds milliseconds ("….000Z"). So every range used to come back as
 * "now to tomorrow": past calls never matched their events, and "coming up" showed a single day.
 */
const plainIso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

export interface CalendarLookup {
  events: CalendarEvent[]
  /** The Mac calendar answered with access granted. */
  mac: boolean
  /** Google's link is saved and its feed (fresh or last good copy) could be read. */
  google: boolean
  /** At least one source was readable: an empty `events` then really means "no events". */
  readable: boolean
}

/**
 * The Mac calendar's events and, when its link is saved, Google Calendar's (counted once when both
 * have them), and whether any source could actually be read: with none readable, an empty list means
 * "don't know", not "no meeting" (so callers must not stamp, clear or cache on it).
 */
export async function lookupBetween(from: Date, to: Date): Promise<CalendarLookup> {
  const [mac, google] = await Promise.all([
    helper.request('calendarEvents', { from: plainIso(from), to: plainIso(to) }).then(
      (r) => ({ events: (r.events ?? []) as CalendarEvent[], ok: r.status === 'granted' }),
      () => ({ events: [] as CalendarEvent[], ok: false })
    ),
    (async () => {
      if (!googleLinked()) return { events: [] as CalendarEvent[], ok: false }
      const events = await googleEvents(from, to).catch(() => [] as CalendarEvent[])
      const state = await googleReadable().catch(() => null)
      return { events, ok: !!state?.ok }
    })()
  ])
  const events = google.events.length ? mergeEvents(mac.events, google.events) : mac.events
  return { events, mac: mac.ok, google: google.ok, readable: mac.ok || google.ok }
}

export async function eventsBetween(from: Date, to: Date): Promise<CalendarEvent[]> {
  return (await lookupBetween(from, to)).events
}

/** Whether any calendar source can be read right now (for finalize: don't stamp calendarChecked otherwise). */
export async function calendarReadable(): Promise<boolean> {
  const now = new Date()
  return (await lookupBetween(now, new Date(now.getTime() + 60_000))).readable
}

/**
 * The calendars "coming up" shows. By default the account's own calendars (macOS names them after
 * the email address) plus the Google link's calendar; when there are neither, all of them. A hand-made
 * choice (settings.calendars) is kept, but the Google link's calendar is always added, so linking
 * Google never hides it, and linking it never hides Mac calendars shown before (it only adds a name).
 */
export function shownCalendars(names: string[]): Set<string> {
  const gname = googleCalendarName()
  const chosen = settings.value.calendars
  if (chosen) return new Set(gname ? [...chosen, gname] : chosen)
  const own = names.filter((n) => n.includes('@'))
  const def = [...own, ...(gname && names.includes(gname) && !own.includes(gname) ? [gname] : [])]
  return new Set(def.length ? def : names)
}

const UPCOMING_FILE = (): string => join(dataDir, 'upcoming.json')

/**
 * Writes what Claude's list_upcoming_meetings reads. A list produced while no calendar could be read
 * never replaces a non-empty cache (an old list beats an empty one; the MCP server shows its age).
 */
export function writeUpcomingCache(events: CalendarEvent[], readable = true): void {
  try {
    if (!events.length && !readable) {
      const old = JSON.parse(readFileSync(UPCOMING_FILE(), 'utf8')) as { events?: unknown[] }
      if (old.events?.length) return
    }
  } catch {
    /* no cache yet */
  }
  try {
    writeFileSync(UPCOMING_FILE(), JSON.stringify({ at: new Date().toISOString(), events }))
  } catch {
    /* not critical */
  }
}

/** The next 7 days, filtered like the home screen, into upcoming.json. */
export async function refreshUpcomingCache(): Promise<void> {
  const from = new Date()
  const to = new Date(from)
  to.setHours(0, 0, 0, 0)
  to.setDate(to.getDate() + 7)
  const r = await lookupBetween(from, to)
  const all = r.events.filter((e) => new Date(e.end).getTime() > Date.now())
  const shown = shownCalendars([...new Set(all.map((e) => e.calendar))])
  writeUpcomingCache(all.filter((e) => shown.has(e.calendar)), r.readable)
}

let upcomingTimer: NodeJS.Timeout | null = null
/**
 * Keeps upcoming.json fresh from the main process (at start and every 5 minutes), so Claude sees the
 * calendar even when no window is open. Safe to call more than once.
 */
export function startUpcomingRefresh(everyMs = 5 * 60_000): void {
  if (upcomingTimer) return
  const tick = (): void => void refreshUpcomingCache().catch((err) => console.warn('calendar: upcoming refresh failed', err))
  setTimeout(tick, 5_000).unref?.() // give the helper a moment to start
  upcomingTimer = setInterval(tick, everyMs)
  upcomingTimer.unref?.()
}

export async function upcoming(hours = 36): Promise<CalendarEvent[]> {
  const now = new Date()
  const from = new Date(now.getTime() - 2 * 3600_000)
  const events = await eventsBetween(from, new Date(now.getTime() + hours * 3600_000))
  return events.filter((e) => new Date(e.end).getTime() > now.getTime() - 15 * 60_000)
}

const SOURCE_HOSTS: Partial<Record<MeetingSource, RegExp>> = {
  meet: /meet\.google\.com/i,
  zoom: /zoom\.us/i,
  teams: /teams\.(microsoft|live|cloud)/i,
  slack: /slack\.com/i
}

function meetCode(url?: string): string | null {
  return url?.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)?.[1]?.toLowerCase() ?? null
}

function zoomId(url?: string): string | null {
  return url?.match(/zoom\.us\/(?:j|wc(?:\/join)?)\/(\d{9,11})/i)?.[1] ?? null
}

/** Bumped when the matching below gets better, so the past-calls pass looks everything up again. */
export const MATCH_VERSION = 4

/**
 * What a meeting's `calendarChecked` records: the matching version, and whether Google Calendar's
 * link took part. Saving (or removing) the link looks the past calls up once more.
 */
export const matchVersion = (): number => (googleLinked() ? MATCH_VERSION * 10 + 1 : MATCH_VERSION)

/**
 * The calendar event this recording belongs to:
 *  1. the event with the same Meet code / Zoom ID;
 *  2. else, among the events the recording overlaps that have other people or a meeting link (so
 *     not "Lunch" or a focus block) and last under 4 hours (not a shift or an all-day block such as
 *     the support roster), from calendars shown under "Coming up": one with a link of the same kind
 *     (Zoom for a Zoom call), then one from the user's own calendar (named after the email address,
 *     not a shared one), then the one whose time fits the call best. Calls started by hand ("other")
 *     and in-person meetings match this way too.
 * Once the call has ended `durationSec` is known and the overlap counts; at the start only the moment does.
 */
export async function matchEvent(at: Date, hint: { source: MeetingSource; url?: string; durationSec?: number }): Promise<CalendarEvent | null> {
  return (await matchEventChecked(at, hint)).event
}

/**
 * matchEvent, plus whether any calendar could be read. `readable: false` means the null event is
 * "unknown", so the caller must not mark the meeting calendarChecked (it is looked up again later).
 */
export async function matchEventChecked(
  at: Date,
  hint: { source: MeetingSource; url?: string; durationSec?: number }
): Promise<{ event: CalendarEvent | null; readable: boolean }> {
  const t0 = at.getTime()
  const t1 = t0 + Math.max(0, hint.durationSec ?? 0) * 1000
  const r = await lookupBetween(new Date(t0 - 3 * 3600_000), new Date(t1 + 3 * 3600_000))
  const events = r.events
  const done = (event: CalendarEvent | null): { event: CalendarEvent | null; readable: boolean } => ({ event, readable: r.readable })
  const code = meetCode(hint.url)
  const zid = zoomId(hint.url)
  const byLink = events.find((e) => e.links.some((l) => (code && meetCode(l) === code) || (zid && zoomId(l) === zid)))
  if (byLink) return done(byLink)

  const span = (e: CalendarEvent): [number, number] => [new Date(e.start).getTime(), new Date(e.end).getTime()]
  const overlap = (e: CalendarEvent): number => {
    const [s, f] = span(e)
    return Math.min(t1, f) - Math.max(t0, s)
  }
  const fits = (e: CalendarEvent): boolean => {
    const [s, f] = span(e)
    const startedInside = s - 15 * 60_000 <= t0 && t0 <= f + 5 * 60_000
    return startedInside || (t1 > t0 && overlap(e) >= Math.min(10 * 60_000, 0.5 * (t1 - t0)))
  }
  const withPeople = (e: CalendarEvent): boolean => e.attendees.some((a) => !a.isMe) || e.links.length > 0
  const meetingSized = (e: CalendarEvent): boolean => span(e)[1] - span(e)[0] <= 4 * 3600_000
  const shown = settings.value.calendars ? shownCalendars([]) : null
  const visible = (e: CalendarEvent): boolean => !shown || shown.has(e.calendar)
  const own = (e: CalendarEvent): boolean => e.calendar.includes('@')
  const host = SOURCE_HOSTS[hint.source]
  const candidates = events.filter((e) => fits(e) && withPeople(e) && meetingSized(e) && visible(e))
  // How well the times agree: shared time / combined time (1 = same start and end); at the start, closeness.
  const timeFit = (e: CalendarEvent): number => {
    const [s, f] = span(e)
    if (t1 <= t0) return 1 / (1 + Math.abs(s - t0) / 60_000)
    return Math.max(0, overlap(e)) / (Math.max(t1, f) - Math.min(t0, s))
  }
  const score = (e: CalendarEvent): number => (host && e.links.some((l) => host.test(l)) ? 4 : 0) + (own(e) ? 2 : 0) + timeFit(e)
  return done(candidates.sort((a, b) => score(b) - score(a))[0] ?? null)
}
