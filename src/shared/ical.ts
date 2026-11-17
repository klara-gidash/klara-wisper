import type { Attendee, CalendarEvent } from './types'

/**
 * A small reader for iCalendar (.ics) feeds, made for Google Calendar's "secret address in iCal
 * format": single and repeating events (RRULE, EXDATE, moved or cancelled occurrences), time zones
 * (IANA names, through Intl), attendees and meeting links. All-day events are left out, as the Mac
 * calendar does (helper CalendarSource.swift), and so are events the user declined.
 */

interface Wall {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
}

export interface IcsEvent {
  uid: string
  title: string
  start: number
  end: number
  allDay: boolean
  /** The zone DTSTART is written in ('UTC' for "…Z" times, null = floating, the computer's own). */
  tz: string | null
  /** DTSTART on the clock of that zone: repeats keep this time of day across daylight-saving changes. */
  wall: Wall
  rrule: string | null
  exdates: Set<number>
  /** For a moved or cancelled occurrence of a repeating event: the start it replaces. */
  recurrenceId: number | null
  cancelled: boolean
  declined: boolean
  location: string
  links: string[]
  organizer: string
  attendees: Attendee[]
}

export interface IcsCalendar {
  /** X-WR-CALNAME (Google: the calendar's name, the email address for a primary calendar). */
  name: string
  events: IcsEvent[]
}

/** Same pattern as the Mac helper (CalendarSource.swift): Zoom, Meet, Teams and Slack huddle links. */
const LINK =
  /https?:\/\/(?:[\w-]+\.)*(?:zoom\.us\/(?:j|my|w|wc)\/[^\s<>"]+|meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}|teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"]+|teams\.live\.com\/meet\/[^\s<>"]+|teams\.cloud\.microsoft\/[^\s<>"]+|app\.slack\.com\/huddle\/[^\s<>"]+)/gi

export function meetingLinks(text: string): string[] {
  return [...new Set(text.match(LINK) ?? [])]
}

/**
 * Only Google Calendar's own iCal links ("webcal://" copied from elsewhere becomes https), without
 * query or fragment. Throws "gcal:badLink", or "gcal:publicLink" for the public address (it only
 * works for a public calendar).
 */
export function cleanGoogleLink(raw: string): string {
  let u: URL
  try {
    u = new URL(String(raw ?? '').trim().replace(/^webcal:\/\//i, 'https://'))
  } catch {
    throw new Error('gcal:badLink')
  }
  if (u.protocol !== 'https:' || u.hostname !== 'calendar.google.com' || !/^\/calendar\/ical\/[^/]+\/[^/]+\/basic\.ics$/.test(u.pathname)) {
    throw new Error('gcal:badLink')
  }
  if (u.pathname.split('/')[4] === 'public') throw new Error('gcal:publicLink')
  return `${u.origin}${u.pathname}`
}

/** The calendar ID in a Google iCal link: the user's address for their main calendar. */
export function googleCalendarId(link: string): string {
  try {
    return decodeURIComponent(new URL(link).pathname.split('/')[3] ?? '')
  } catch {
    return ''
  }
}

// ---- time zones ----

const formats = new Map<string, Intl.DateTimeFormat | null>()

function zoneFormat(tz: string): Intl.DateTimeFormat | null {
  if (!formats.has(tz)) {
    try {
      formats.set(
        tz,
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
        })
      )
    } catch {
      formats.set(tz, null) // not an IANA name (e.g. a Windows zone name): use the computer's zone
    }
  }
  return formats.get(tz) ?? null
}

const offsets = new Map<string, number>()
const QUARTER_HOUR = 15 * 60_000

/**
 * How far the zone's clock is ahead of UTC at this moment, in ms. Remembered per quarter hour
 * (zones change their offset on the hour or half hour), since Intl is slow and a repeating event
 * asks for many times.
 */
function zoneOffset(ms: number, tz: string, f: Intl.DateTimeFormat): number {
  const key = `${tz}|${Math.floor(ms / QUARTER_HOUR)}`
  const known = offsets.get(key)
  if (known !== undefined) return known
  const at = Math.floor(ms / QUARTER_HOUR) * QUARTER_HOUR
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(at))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - at
  if (offsets.size > 100_000) offsets.clear()
  offsets.set(key, offset)
  return offset
}

/** The moment a wall-clock time in a zone happens. */
export function wallToMs(w: Wall, tz: string | null): number {
  if (tz === 'UTC') return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
  const f = tz ? zoneFormat(tz) : null
  if (!f || !tz) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime()
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
  const first = guess - zoneOffset(guess, tz, f)
  return guess - zoneOffset(first, tz, f) // a second pass settles times near a daylight-saving change
}

// ---- content lines ----

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const c of s) {
    if (c === '"') quoted = !quoted
    if (c === sep && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

function parseLine(line: string): Prop | null {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (c === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const [name, ...rest] = splitOutsideQuotes(line.slice(0, colon), ';')
  const params: Record<string, string> = {}
  for (const p of rest) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"(.*)"$/, '$1')
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) }
}

const unescapeText = (v: string): string => v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

interface When {
  ms: number
  allDay: boolean
  tz: string | null
  wall: Wall
}

function parseWhen(value: string, params: Record<string, string>, defaultTz: string | null): When | null {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const wall: Wall = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) }
  const allDay = params.VALUE === 'DATE' || m[4] === undefined
  const tz = m[7] ? 'UTC' : params.TZID ?? defaultTz
  return { ms: wallToMs(wall, tz), allDay, tz, wall }
}

function parseDuration(value: string): number | null {
  const m = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const ms = (((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60_000 + +(m[6] ?? 0) * 1000
  return m[1] === '-' ? -ms : ms
}

const mailto = (v: string): string => v.replace(/^mailto:/i, '').trim()

/**
 * Reads a feed. `me` is the calendar owner's address (Google: the calendar ID in the secret link),
 * used to mark the user among the attendees and to drop the events they declined.
 */
export function parseIcs(text: string, opts: { me?: string } = {}): IcsCalendar {
  const me = opts.me?.toLowerCase() ?? ''
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  let name = ''
  let defaultTz: string | null = null
  const events: IcsEvent[] = []
  const stack: string[] = []
  let props: Prop[] | null = null

  for (const line of lines) {
    if (!line) continue
    const p = parseLine(line)
    if (!p) continue
    if (p.name === 'BEGIN') {
      stack.push(p.value.toUpperCase())
      if (p.value.toUpperCase() === 'VEVENT' && stack.length === 2) props = []
      continue
    }
    if (p.name === 'END') {
      const done = stack.pop()
      if (done === 'VEVENT' && props) {
        const e = buildEvent(props, defaultTz, me)
        if (e) events.push(e)
        props = null
      }
      continue
    }
    const where = stack[stack.length - 1]
    if (where === 'VCALENDAR') {
      if (p.name === 'X-WR-CALNAME') name = unescapeText(p.value)
      if (p.name === 'X-WR-TIMEZONE' && zoneFormat(p.value.trim())) defaultTz = p.value.trim()
    } else if (where === 'VEVENT' && props) props.push(p) // not inside a VALARM
  }
  return { name, events }
}

function buildEvent(props: Prop[], defaultTz: string | null, me: string): IcsEvent | null {
  const one = (n: string): Prop | undefined => props.find((p) => p.name === n)
  const dtstart = one('DTSTART')
  const start = dtstart && parseWhen(dtstart.value, dtstart.params, defaultTz)
  if (!start) return null

  const dtend = one('DTEND')
  const endWhen = dtend && parseWhen(dtend.value, dtend.params, defaultTz)
  const duration = one('DURATION') && parseDuration(one('DURATION')!.value)
  const end = endWhen ? endWhen.ms : duration != null ? start.ms + duration : start.allDay ? start.ms + 86_400_000 : start.ms

  const exdates = new Set<number>()
  for (const p of props.filter((x) => x.name === 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const w = parseWhen(v, p.params, start.tz)
      if (w) exdates.add(w.ms)
    }
  }
  const rid = one('RECURRENCE-ID')
  const recurrenceId = rid ? parseWhen(rid.value, rid.params, start.tz)?.ms ?? null : null

  const attendees: Attendee[] = []
  let declined = false
  for (const p of props.filter((x) => x.name === 'ATTENDEE')) {
    const email = mailto(p.value)
    const isMe = !!me && email.toLowerCase() === me
    if (isMe && (p.params.PARTSTAT ?? '').toUpperCase() === 'DECLINED') declined = true
    attendees.push({ name: p.params.CN && p.params.CN !== email ? unescapeText(p.params.CN) : '', email, isMe })
  }
  const org = one('ORGANIZER')
  const text = ['X-GOOGLE-CONFERENCE', 'URL', 'LOCATION', 'DESCRIPTION'].map((n) => unescapeText(one(n)?.value ?? '')).join('\n')

  return {
    uid: one('UID')?.value.trim() ?? '',
    title: unescapeText(one('SUMMARY')?.value ?? '').trim(),
    start: start.ms,
    end: Math.max(end, start.ms),
    allDay: start.allDay,
    tz: start.tz,
    wall: start.wall,
    rrule: one('RRULE')?.value.trim() || null,
    exdates,
    recurrenceId,
    cancelled: (one('STATUS')?.value ?? '').trim().toUpperCase() === 'CANCELLED',
    declined,
    location: unescapeText(one('LOCATION')?.value ?? '').trim(),
    links: meetingLinks(text),
    organizer: org ? (org.params.CN ? unescapeText(org.params.CN) : mailto(org.value)) : '',
    attendees
  }
}

// ---- repeating events ----

const DAY = 86_400_000
const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count: number | null
  until: number | null
  byday: { n: number; wd: number }[]
  bymonthday: number[]
  bymonth: number[]
  bysetpos: number[]
  wkst: number
}

const dayNum = (y: number, mo: number, d: number): number => Math.floor(Date.UTC(y, mo - 1, d) / DAY)
const weekday = (dn: number): number => new Date(dn * DAY).getUTCDay()
const daysInMonth = (y: number, mo: number): number => new Date(Date.UTC(y, mo, 0)).getUTCDate()
function ymd(dn: number): [number, number, number] {
  const d = new Date(dn * DAY)
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
}
const ints = (v?: string): number[] => (v ? v.split(',').map(Number).filter((n) => Number.isInteger(n) && n !== 0) : [])

function parseRule(e: IcsEvent): Rule | null {
  const r: Record<string, string> = {}
  for (const part of (e.rrule ?? '').split(';')) {
    const [k, v] = part.split('=')
    if (k && v) r[k.toUpperCase()] = v.toUpperCase()
  }
  const freq = r.FREQ
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null
  if (r.BYYEARDAY || r.BYWEEKNO || r.BYHOUR || r.BYMINUTE || r.BYSECOND) return null // never written by Google
  let until: number | null = null
  if (r.UNTIL) {
    const w = parseWhen(r.UNTIL, {}, e.tz === 'UTC' ? 'UTC' : e.tz)
    if (w) until = w.allDay ? wallToMs({ ...w.wall, h: 23, mi: 59, s: 59 }, e.tz) : w.ms
  }
  const byday: Rule['byday'] = []
  for (const b of (r.BYDAY ?? '').split(',')) {
    const m = b.match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/)
    if (m) byday.push({ n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS[m[2]] })
  }
  return {
    freq,
    interval: Math.max(1, Number(r.INTERVAL) || 1),
    count: Number(r.COUNT) > 0 ? Number(r.COUNT) : null,
    until,
    byday,
    bymonthday: ints(r.BYMONTHDAY),
    bymonth: ints(r.BYMONTH),
    bysetpos: ints(r.BYSETPOS),
    wkst: WEEKDAYS[r.WKST] ?? 1
  }
}

function pickPositions(days: number[], pos: number[]): number[] {
  if (!pos.length) return days
  const picked = pos.map((p) => days[p > 0 ? p - 1 : days.length + p]).filter((d) => d !== undefined)
  return [...new Set(picked)].sort((a, b) => a - b)
}

/** The days of one month that match BYMONTHDAY / BYDAY (or the start's day of the month). */
function monthDays(y: number, mo: number, rule: Rule, startDay: number): number[] {
  const len = daysInMonth(y, mo)
  let days: number[] = rule.bymonthday.map((d) => (d > 0 ? d : len + d + 1)).filter((d) => d >= 1 && d <= len)
  if (rule.byday.length) {
    const fromWeekdays: number[] = []
    for (const b of rule.byday) {
      const all: number[] = []
      for (let d = 1; d <= len; d++) if (weekday(dayNum(y, mo, d)) === b.wd) all.push(d)
      if (b.n === 0) fromWeekdays.push(...all)
      else {
        const d = all[b.n > 0 ? b.n - 1 : all.length + b.n]
        if (d) fromWeekdays.push(d)
      }
    }
    days = rule.bymonthday.length ? days.filter((d) => fromWeekdays.includes(d)) : fromWeekdays
  } else if (!rule.bymonthday.length) {
    days = startDay <= len ? [startDay] : []
  }
  return [...new Set(days)].sort((a, b) => a - b).map((d) => dayNum(y, mo, d))
}

/** One period of the rule (a day, week, month or year after the start): its first day and the matching days. */
function period(rule: Rule, w: Wall, startDn: number, i: number): { base: number; days: number[] } {
  const okMonth = (dn: number): boolean => !rule.bymonth.length || rule.bymonth.includes(ymd(dn)[1])
  switch (rule.freq) {
    case 'DAILY': {
      const dn = startDn + i * rule.interval
      const [y, mo, d] = ymd(dn)
      const ok =
        okMonth(dn) &&
        (!rule.bymonthday.length || rule.bymonthday.some((x) => (x > 0 ? x : daysInMonth(y, mo) + x + 1) === d)) &&
        (!rule.byday.length || rule.byday.some((b) => b.wd === weekday(dn)))
      return { base: dn, days: ok ? [dn] : [] }
    }
    case 'WEEKLY': {
      const base = startDn - ((weekday(startDn) - rule.wkst + 7) % 7) + i * rule.interval * 7
      const wds = rule.byday.length ? rule.byday.map((b) => b.wd) : [weekday(startDn)]
      const days: number[] = []
      for (let k = 0; k < 7; k++) if (wds.includes(weekday(base + k)) && okMonth(base + k)) days.push(base + k)
      return { base, days }
    }
    case 'MONTHLY': {
      const total = w.y * 12 + (w.mo - 1) + i * rule.interval
      const y = Math.floor(total / 12)
      const mo = (total % 12) + 1
      const base = dayNum(y, mo, 1)
      if (rule.bymonth.length && !rule.bymonth.includes(mo)) return { base, days: [] }
      return { base, days: pickPositions(monthDays(y, mo, rule, w.d), rule.bysetpos) }
    }
    case 'YEARLY': {
      const y = w.y + i * rule.interval
      const months = rule.bymonth.length ? [...rule.bymonth].sort((a, b) => a - b) : [w.mo]
      const days = months.flatMap((mo) => monthDays(y, mo, rule, w.d))
      return { base: dayNum(y, 1, 1), days: pickPositions(days, rule.bysetpos) }
    }
  }
}

/** The start times of a repeating event that fall in [from, to). */
function occurrences(e: IcsEvent, from: number, to: number): number[] {
  const rule = parseRule(e)
  if (!rule) return e.start >= from && e.start < to ? [e.start] : []
  const w = e.wall
  const startDn = dayNum(w.y, w.mo, w.d)
  const toDn = Math.floor(to / DAY) + 2
  // Without COUNT, skip straight to the periods near `from` instead of walking from the first one.
  let i = 0
  if (!rule.count && from > e.start) {
    const fromDn = Math.floor(from / DAY) - 2
    const [fy, fm] = ymd(fromDn)
    const span =
      rule.freq === 'DAILY' ? (fromDn - startDn) / rule.interval
        : rule.freq === 'WEEKLY' ? (fromDn - startDn) / (7 * rule.interval)
          : rule.freq === 'MONTHLY' ? ((fy - w.y) * 12 + (fm - w.mo)) / rule.interval
            : (fy - w.y) / rule.interval
    i = Math.max(0, Math.floor(span) - 1)
  }
  const out: number[] = []
  let n = 0
  for (let guard = 0; guard < 20_000; guard++, i++) {
    const { base, days } = period(rule, w, startDn, i)
    if (base > toDn) break
    for (const dn of days) {
      if (dn < startDn) continue
      const [y, mo, d] = ymd(dn)
      const ms = wallToMs({ y, mo, d, h: w.h, mi: w.mi, s: w.s }, e.tz)
      if (rule.until !== null && ms > rule.until) return out
      if (rule.count && ++n > rule.count) return out
      if (ms >= to) return out
      if (ms >= from) out.push(ms)
    }
  }
  return out
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The events that overlap [from, to), repeating ones unrolled, as the app's CalendarEvent. */
export function eventsInRange(cal: IcsCalendar, from: Date, to: Date, calendar = cal.name): CalendarEvent[] {
  const f = from.getTime()
  const t = to.getTime()
  const moved = new Map<string, Set<number>>()
  for (const e of cal.events) {
    if (e.recurrenceId === null) continue
    if (!moved.has(e.uid)) moved.set(e.uid, new Set())
    moved.get(e.uid)!.add(e.recurrenceId)
  }
  const out: CalendarEvent[] = []
  const add = (e: IcsEvent, start: number, end: number): void => {
    out.push({
      id: `gcal:${e.uid}@${Math.floor(start / 1000)}`,
      title: e.title,
      start: iso(start),
      end: iso(end),
      calendar,
      color: null,
      location: e.location,
      links: e.links,
      organizer: e.organizer,
      attendees: e.attendees
    })
  }
  for (const e of cal.events) {
    if (e.allDay || e.cancelled || e.declined) continue
    const length = e.end - e.start
    if (e.rrule && e.recurrenceId === null) {
      if (e.start >= t) continue // the series starts after the range
      const skip = moved.get(e.uid)
      for (const s of occurrences(e, f - length, t)) {
        if (e.exdates.has(s) || skip?.has(s)) continue
        if (s + length > f) add(e, s, s + length)
      }
    } else if (e.start < t && e.end > f) {
      add(e, e.start, e.end)
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

/**
 * The Mac calendar's events plus the ones from a feed, without doubles: when the same Google
 * calendar is also on the Mac, an event with the same title and start counts once (the Mac's copy,
 * which keeps its calendar name and color), with any meeting link or guests only the feed had.
 */
export function mergeEvents(primary: CalendarEvent[], extra: CalendarEvent[]): CalendarEvent[] {
  const key = (e: CalendarEvent): string => `${e.title.trim().toLowerCase()}|${Math.round(new Date(e.start).getTime() / 60_000)}`
  const out = primary.map((e) => ({ ...e }))
  const seen = new Map(out.map((e) => [key(e), e]))
  for (const g of extra) {
    const same = seen.get(key(g))
    if (!same) {
      out.push(g)
      seen.set(key(g), g)
      continue
    }
    same.links = [...new Set([...same.links, ...g.links])]
    if (!same.attendees.length) same.attendees = g.attendees
  }
  return out.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
}
