import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CalendarEvent, MeetingSource } from '@shared/types'
import { helper } from './helper'
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
    await run('/usr/bin/tccutil', ['reset', 'Calendar', 'io.klara.wisper'], { timeout: 10_000 }).catch((err) => console.warn('calendar: tccutil reset failed', err))
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

export async function eventsBetween(from: Date, to: Date): Promise<CalendarEvent[]> {
  try {
    const r = await helper.request('calendarEvents', { from: plainIso(from), to: plainIso(to) })
    return r.events ?? []
  } catch {
    return []
  }
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
  const t0 = at.getTime()
  const t1 = t0 + Math.max(0, hint.durationSec ?? 0) * 1000
  const events = await eventsBetween(new Date(t0 - 3 * 3600_000), new Date(t1 + 3 * 3600_000))
  const code = meetCode(hint.url)
  const zid = zoomId(hint.url)
  const byLink = events.find((e) => e.links.some((l) => (code && meetCode(l) === code) || (zid && zoomId(l) === zid)))
  if (byLink) return byLink

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
  const shown = settings.value.calendars
  const visible = (e: CalendarEvent): boolean => !shown || shown.includes(e.calendar)
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
  return candidates.sort((a, b) => score(b) - score(a))[0] ?? null
}
