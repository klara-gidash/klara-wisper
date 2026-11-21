/**
 * Client file ("תיק לקוח מצטבר"): groups meetings by client or person, and reads the open tasks and
 * decisions out of a saved summary. Pure functions: no Electron, no Node built-ins, only type imports,
 * so the renderer, the main process and `node --test` (test/clients.test.mts) all load this file.
 *
 * The MCP server has the same rules in Python (engine/klara_engine/clients.py); keep the two in step.
 *
 * Grouping:
 * - Company: the email domain of the calendar attendees (acme.com, eu.acme.com and acme.co.il's
 *   registrable part), minus the user's own domain (her colleagues) and personal mail (gmail.com...).
 * - Person: an attendee on personal mail or without an email, and the people Claude identified in an
 *   in-person or ad-hoc call (when the meeting has no calendar attendees).
 * - Title words: a meeting whose title names a client (the domain's name, or a word that keeps coming
 *   back in that client's meeting titles and in nobody else's, like "שיכון") joins that client too, so an
 *   ad-hoc call titled "שיחה עם Acme" or an internal "הכנה לשיכון" lands in the right file.
 */
import type { Attendee, MeetingMeta, MeetingSource } from './types'

export type ClientKind = 'company' | 'person'

export interface ClientMeetingInput {
  id: string
  title?: string
  startedAt: string
  attendees?: Attendee[]
  calendarEvent?: { title?: string; calendar?: string; attendees?: Attendee[] } | null
  inferredParticipants?: string[] | null
}

export interface ClientGroup {
  /** The registrable domain for a company ("acme.com"), "person:<name>" for a person. */
  key: string
  kind: ClientKind
  name: string
  domain: string | null
  /** Title words that also bring a meeting into this client (besides the domain's name). */
  aliases: string[]
  /** Attendees from that company (or the person), as "Name <email>" or the name alone. */
  people: string[]
  /** Newest first. */
  meetingIds: string[]
  count: number
  lastAt: string
}

/** Personal mail: an attendee on one of these is a person, not a company. */
export const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.il', 'ymail.com', 'hotmail.com', 'hotmail.co.il',
  'outlook.com', 'outlook.co.il', 'live.com', 'live.co.il', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'walla.co.il', 'walla.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net',
  'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com', 'bezeqint.net', 'netvision.net.il', '012.net.il',
  'inter.net.il', 'smile.net.il', 'zahav.net.il'
])

/** Calendar rooms and group calendars: not people at all. */
const RESOURCE = /(^|\.)(resource|group)\.calendar\.google\.com$|(^|\.)calendar\.google\.com$/

/** Words that say nothing about who the meeting was with. */
const STOPWORDS = new Set([
  'meeting', 'call', 'sync', 'weekly', 'daily', 'monthly', 'intro', 'introduction', 'demo', 'review', 'with', 'and',
  'the', 'for', 'about', 'update', 'updates', 'kickoff', 'kick', 'off', 'follow', 'followup', 'check', 'catch',
  'zoom', 'meet', 'teams', 'google', 'slack', 'huddle', 'chat', 'session', 'discussion', 'planning', 'status',
  'onboarding', 'training', 'team', 'quick', 'touch', 'base', 'connect', 'next', 'steps', 'new', 'via', 'from',
  'פגישה', 'פגישת', 'שיחה', 'שיחת', 'שיחות', 'פגישות', 'עם', 'על', 'של', 'את', 'בין', 'לבין', 'אצל', 'סטטוס',
  'הכרות', 'היכרות', 'דמו', 'הדגמה', 'סנכרון', 'שבועית', 'שבועי', 'חודשית', 'חודשי', 'יומי', 'יומית', 'עדכון',
  'המשך', 'הצגה', 'תיאום', 'הכנה', 'לקראת', 'סיכום', 'בנושא', 'נושא', 'קצרה', 'קצר', 'ראשונה', 'חדש', 'חדשה',
  'צוות', 'הדרכה', 'הטמעה', 'מעקב', 'זום', 'טלפון', 'טלפונית', 'פנים', 'מול'
])

const COMPOUND_SLD = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'muni', 'k12', 'ltd', 'plc'])

/** Lowercase, without Hebrew niqqud or Latin accents, one space between words. */
export function normalizeText(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[֑-ׇ̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Title words worth matching: letters or digits, 3+ characters, not a stopword, not a bare number. */
export function titleWords(title: string | null | undefined): string[] {
  const out = new Set<string>()
  for (const w of normalizeText(title).split(/[^\p{L}\p{N}]+/u)) {
    if ([...w].length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) out.add(w)
  }
  return [...out]
}

/** "eu.mail.acme.co.il" → "acme.co.il"; "Dana@Acme.com" → "acme.com"; "" when there is no domain. */
export function registrableDomain(emailOrDomain: string | null | undefined): string {
  const host = String(emailOrDomain ?? '').trim().toLowerCase().split('@').pop()!.replace(/\.+$/, '')
  if (!host || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return ''
  const labels = host.split('.')
  if (RESOURCE.test(host)) return host
  const n = labels.length
  const take = n >= 3 && labels[n - 1].length === 2 && COMPOUND_SLD.has(labels[n - 2]) ? 3 : 2
  return labels.slice(-take).join('.')
}

/** "acme.co.il" → "Acme"; "shikun-binui.com" → "Shikun Binui". */
export function companyName(domain: string): string {
  const label = domain.split('.')[0] ?? domain
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/** Speaker labels the app or Claude use when nobody is named ("משתתף 2", "דובר 1", "Speaker 3"). */
function isPlaceholder(name: string): boolean {
  return /^(משתתף|משתתפת|דובר|דוברת|speaker|participant|rem|spk)\s*\d*$/i.test(name.trim()) || /^(אני|me|לא ידוע|unknown)$/i.test(name.trim())
}

function attendeesOf(m: ClientMeetingInput): Attendee[] {
  return (m.attendees?.length ? m.attendees : m.calendarEvent?.attendees) ?? []
}

/**
 * The user's own domains: from the attendees marked as her, and from calendars named by an email
 * (Google calendars are), plus any given. Personal mail never counts as "own".
 */
export function ownDomains(meetings: ClientMeetingInput[], extra: string[] = []): Set<string> {
  const out = new Set<string>()
  const add = (d: string): void => {
    if (d && !GENERIC_DOMAINS.has(d) && !RESOURCE.test(d)) out.add(d)
  }
  for (const d of extra) add(registrableDomain(d))
  for (const m of meetings) {
    for (const a of attendeesOf(m)) if (a.isMe && a.email?.includes('@')) add(registrableDomain(a.email))
    const cal = m.calendarEvent?.calendar ?? ''
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cal)) add(registrableDomain(cal))
  }
  return out
}

interface Draft {
  key: string
  kind: ClientKind
  name: string
  domain: string | null
  people: Map<string, string>
  direct: Set<string>
  all: Set<string>
}

/**
 * Groups meetings into clients, most recent first. `ownDomains` adds to the user's own domains (found
 * from the meetings themselves); `userName` keeps the user out of the people found from transcripts.
 */
export function groupClients(meetings: ClientMeetingInput[], opts: { ownDomains?: string[]; userName?: string } = {}): ClientGroup[] {
  const own = ownDomains(meetings, opts.ownDomains ?? [])
  const me = normalizeText(opts.userName)
  const drafts = new Map<string, Draft>()
  const byId = new Map(meetings.map((m) => [m.id, m]))

  const draft = (key: string, kind: ClientKind, name: string, domain: string | null): Draft => {
    let d = drafts.get(key)
    if (!d) drafts.set(key, (d = { key, kind, name, domain, people: new Map(), direct: new Set(), all: new Set() }))
    return d
  }
  const addPerson = (d: Draft, name: string, email: string): void => {
    const id = (email || normalizeText(name)).toLowerCase()
    if (!id || d.people.has(id)) return
    d.people.set(id, name && email ? `${name} <${email}>` : name || email)
  }
  const personKey = (name: string): string => `person:${normalizeText(name)}`

  // 1. Attendees: companies by domain, people on personal mail (or with no email).
  for (const m of meetings) {
    const others = attendeesOf(m).filter((a) => !a.isMe)
    let anyone = false
    for (const a of others) {
      const email = (a.email ?? '').trim().toLowerCase()
      const name = String(a.name ?? '').replace(/\s+/g, ' ').trim()
      const domain = email.includes('@') ? registrableDomain(email) : ''
      if (domain && RESOURCE.test(domain)) continue
      if (domain && own.has(domain)) {
        anyone = true // a colleague: the meeting had attendees, so don't fall back to the transcript's names
        continue
      }
      anyone = true
      if (domain && !GENERIC_DOMAINS.has(domain)) {
        const d = draft(domain, 'company', companyName(domain), domain)
        d.direct.add(m.id)
        addPerson(d, name, email)
      } else {
        const label = name || email.split('@')[0]
        if (!label || isPlaceholder(label) || (me && normalizeText(label) === me)) continue
        const d = draft(personKey(label), 'person', label, null)
        d.direct.add(m.id)
        addPerson(d, name, email)
      }
    }
    // An ad-hoc or in-person call: the people Claude identified from the transcript.
    if (!anyone) {
      for (const raw of m.inferredParticipants ?? []) {
        const label = String(raw ?? '').replace(/\s+/g, ' ').trim()
        if (!label || isPlaceholder(label) || (me && normalizeText(label) === me)) continue
        const d = draft(personKey(label), 'person', label, null)
        d.direct.add(m.id)
        addPerson(d, label, '')
      }
    }
  }

  // 2. Title words that belong to one company: in 2+ of its meetings' titles and in no other client's.
  const titlesOf = (m: ClientMeetingInput): string[] => [...new Set([...titleWords(m.title), ...titleWords(m.calendarEvent?.title)])]
  const owners = new Map<string, Set<string>>() // word → clients whose own meetings have it in the title
  const counts = new Map<string, Map<string, number>>() // client → word → meetings
  for (const d of drafts.values()) {
    const c = new Map<string, number>()
    for (const id of d.direct) for (const w of titlesOf(byId.get(id)!)) c.set(w, (c.get(w) ?? 0) + 1)
    counts.set(d.key, c)
    for (const w of c.keys()) {
      if (!owners.has(w)) owners.set(w, new Set())
      owners.get(w)!.add(d.key)
    }
  }
  const myWords = new Set(titleWords(opts.userName))
  const aliases = new Map<string, string[]>()
  for (const d of drafts.values()) {
    if (d.kind !== 'company') continue
    const words = [...(counts.get(d.key) ?? new Map()).entries()]
      .filter(([w, n]) => n >= 2 && owners.get(w)!.size === 1 && !myWords.has(w))
      .map(([w]) => w)
    const label = normalizeText(d.domain!.split('.')[0])
    aliases.set(d.key, [...new Set([...([...label].length >= 3 && !STOPWORDS.has(label) ? [label] : []), ...words])])
  }

  // 3. Every meeting whose title names a client joins it (an ad-hoc call, an internal prep meeting).
  for (const m of meetings) {
    const words = new Set(titlesOf(m))
    const title = ` ${normalizeText(`${m.title ?? ''} ${m.calendarEvent?.title ?? ''}`).replace(/[^\p{L}\p{N}]+/gu, ' ')} `
    for (const d of drafts.values()) {
      if (d.direct.has(m.id)) continue
      if (d.kind === 'company') {
        if ((aliases.get(d.key) ?? []).some((w) => words.has(w))) d.all.add(m.id)
      } else {
        const full = normalizeText(d.name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
        if (full.includes(' ') && title.includes(` ${full} `)) d.all.add(m.id)
      }
    }
  }

  const out: ClientGroup[] = []
  for (const d of drafts.values()) {
    const ids = [...new Set([...d.direct, ...d.all])].filter((id) => byId.has(id))
    ids.sort((a, b) => byId.get(b)!.startedAt.localeCompare(byId.get(a)!.startedAt))
    if (!ids.length) continue
    const label = d.kind === 'company' ? normalizeText(d.domain!.split('.')[0]) : ''
    out.push({
      key: d.key,
      kind: d.kind,
      name: d.name,
      domain: d.domain,
      aliases: (aliases.get(d.key) ?? []).filter((w) => w !== label),
      people: [...d.people.values()],
      meetingIds: ids,
      count: ids.length,
      lastAt: byId.get(ids[0])!.startedAt
    })
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt) || b.count - a.count || a.name.localeCompare(b.name))
}

/** One meeting on a client's timeline (the Clients page). */
export interface ClientMeetingEntry {
  id: string
  title: string
  startedAt: string
  source: MeetingSource
  durationSec?: number
  status: MeetingMeta['status']
  hasSummary: boolean
  gist: string
  openTasks: string[]
  decisions: string[]
}

export interface ClientFile {
  client: ClientGroup
  /** Newest first. */
  meetings: ClientMeetingEntry[]
}

// ---- summary.md ----

export interface SummaryDigest {
  /** The first lines of the summary (its "תקציר"/"Summary" section, or the first paragraph). */
  gist: string
  /** Unchecked tasks from the "משימות"/"Tasks" section, without the checkbox. */
  openTasks: string[]
  /** Bullets of the "החלטות"/"Decisions" section ("לא התקבלו החלטות" left out). */
  decisions: string[]
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
// No \b: in JavaScript it only knows Latin letters, so it never matches after a Hebrew word.
const END = '(?![\\p{L}\\p{N}])'
const TASKS = new RegExp(`^(משימות|tasks|action items|next actions|to-?dos?)${END}`, 'iu')
const DECISIONS = new RegExp(`^(החלטות|decisions)${END}`, 'iu')
const GIST = new RegExp(`^(תקציר|סיכום|summary|tl;?dr|overview)${END}`, 'iu')
const NO_DECISIONS = /^(לא התקבלו החלטות|אין החלטות|no decisions)/i
const NONE = /^(אין|none|—|-)\.?$/i

function cleanInline(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/\s+/g, ' ').trim()
}

/** Reads the gist, the open tasks and the decisions out of a saved summary (Hebrew or English headings). */
export function digestSummary(md: string | null | undefined, gistLimit = 240): SummaryDigest {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  let section: 'tasks' | 'decisions' | 'gist' | 'other' | 'top' = 'top'
  const gist: string[] = []
  const top: string[] = []
  const openTasks: string[] = []
  const decisions: string[] = []
  let fence = false
  let seenHeading = false
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence
    if (fence) continue
    const h = HEADING.exec(raw)
    if (h) {
      const title = cleanInline(h[2])
      if (h[1].length === 1 && !seenHeading) section = 'top' // "# <title> — <date>": the document's title
      else section = TASKS.test(title) ? 'tasks' : DECISIONS.test(title) ? 'decisions' : GIST.test(title) ? 'gist' : top.length || section !== 'top' ? 'other' : 'top'
      seenHeading = true
      continue
    }
    const line = raw.trim()
    if (!line) continue
    const bullet = /^(?:[-*•+]|\d+[.)])\s+(.*)$/.exec(line)
    if (section === 'tasks' && bullet) {
      const box = /^\[( |x|X)\]\s*(.*)$/.exec(bullet[1])
      if (box && box[1] !== ' ') continue
      const text = cleanInline(box ? box[2] : bullet[1])
      if (text && !NONE.test(text)) openTasks.push(text)
    } else if (section === 'decisions' && bullet) {
      const text = cleanInline(bullet[1])
      if (text && !NO_DECISIONS.test(text) && !NONE.test(text)) decisions.push(text)
    } else if (section === 'gist') {
      gist.push(cleanInline(bullet ? bullet[1] : line))
    } else if (section === 'top' && !/^\*\*[^*]+:\*\*/.test(line) && !/^---$/.test(line)) {
      top.push(cleanInline(bullet ? bullet[1] : line))
    }
  }
  const text = (gist.length ? gist : top).join(' ')
  const chars = [...text]
  return { gist: chars.length > gistLimit ? chars.slice(0, gistLimit - 1).join('').trimEnd() + '…' : text, openTasks, decisions }
}
