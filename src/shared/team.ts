/**
 * Team cloud (optional, roadmap 7): the pieces with no Electron in them, so they can be tested
 * (test/team.test.mts) and used by the cloud simulation (scripts/cloud-sim/team.mjs).
 *
 * - The invite code the owner sends a teammate: the Worker's address plus a one-time code. Pasted into
 *   "Join a team cloud", the app trades it at the Worker for the member's own three tokens.
 * - The rule for sharing meetings with the team automatically: never (the default), meetings with guests
 *   from some email domains, or all. Decided once per meeting, for meetings that start after the rule was set.
 */

export const INVITE_PREFIX = 'klara-team:'
const CODE_RE = /^[0-9a-f]{64}$/
const TOKEN_RE = /^[0-9a-f]{64}$/
const MEMBER_ID_RE = /^u_[0-9a-f]{16}$/

export type InviteErrorCode = 'empty' | 'format' | 'url' | 'code'

export class InviteError extends Error {
  code: InviteErrorCode
  constructor(code: InviteErrorCode) {
    super(`invite: ${code}`)
    this.code = code
  }
}

export interface Invite {
  /** The Worker's address (an origin, no path). */
  url: string
  /** The one-time code (64 hex characters). */
  code: string
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/**
 * A Worker address as the app keeps it: https and the origin only. `allowLocalHttp` lets
 * http://127.0.0.1 and http://localhost through, for the simulation only.
 */
export function workerOrigin(raw: string, opts: { allowLocalHttp?: boolean } = {}): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (u.protocol !== 'https:' && !(opts.allowLocalHttp && local && u.protocol === 'http:')) return null
  if (u.username || u.password) return null
  return u.origin
}

/** The text the owner sends: klara-team:<base64url of {"v":1,"url":...,"code":...}>. */
export function buildInvite(invite: Invite): string {
  const url = workerOrigin(invite.url, { allowLocalHttp: true })
  if (!url) throw new InviteError('url')
  if (!CODE_RE.test(invite.code)) throw new InviteError('code')
  return INVITE_PREFIX + toBase64Url(JSON.stringify({ v: 1, url, code: invite.code }))
}

/**
 * Reads an invite out of whatever was pasted: the code alone, or a whole message with the code in it
 * (quotes, line breaks and a trailing period are fine). Throws InviteError.
 */
export function parseInvite(text: string, opts: { allowLocalHttp?: boolean } = {}): Invite {
  const raw = String(text ?? '').trim()
  if (!raw) throw new InviteError('empty')
  const match = /klara-team:\s*([A-Za-z0-9_\-\s]{20,4000})/i.exec(raw)
  if (!match) throw new InviteError('format')
  // Chat apps can wrap a long word, and words may follow it: try the first piece, then join the next ones back.
  const pieces = match[1].trim().split(/\s+/)
  let data: unknown = null
  for (let n = 1; n <= Math.min(pieces.length, 20) && data === null; n++) {
    try {
      data = JSON.parse(fromBase64Url(pieces.slice(0, n).join('')))
    } catch {
      data = null
    }
  }
  if (data === null) throw new InviteError('format')
  if (!data || typeof data !== 'object' || (data as { v?: unknown }).v !== 1) throw new InviteError('format')
  const d = data as { url?: unknown; code?: unknown }
  const url = typeof d.url === 'string' ? workerOrigin(d.url, opts) : null
  if (!url) throw new InviteError('url')
  if (typeof d.code !== 'string' || !CODE_RE.test(d.code)) throw new InviteError('code')
  return { url, code: d.code }
}

export interface JoinResult {
  member: { id: string; name: string }
  ownerName: string
  tokens: { upload: string; mcp: string; rec: string }
}

/** The Worker's answer to POST /api/team/join, checked; null when it isn't one. */
export function parseJoinResponse(body: unknown): JoinResult | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { ok?: unknown; member?: { id?: unknown; name?: unknown }; ownerName?: unknown; tokens?: Record<string, unknown> }
  if (b.ok !== true || !b.member || !b.tokens) return null
  const { id, name } = b.member
  if (typeof id !== 'string' || !MEMBER_ID_RE.test(id) || typeof name !== 'string') return null
  const t = b.tokens
  if (![t.upload, t.mcp, t.rec].every((x) => typeof x === 'string' && TOKEN_RE.test(x))) return null
  if (new Set([t.upload, t.mcp, t.rec]).size !== 3) return null
  return {
    member: { id, name: name.slice(0, 80) },
    ownerName: typeof b.ownerName === 'string' ? b.ownerName.slice(0, 80) : '',
    tokens: { upload: t.upload as string, mcp: t.mcp as string, rec: t.rec as string }
  }
}

// ---------- automatic sharing ----------

export type AutoShare = 'never' | 'domains' | 'all'

export interface ShareRule {
  mode: AutoShare
  /** Email domains, e.g. ["acme.com"]: a meeting with a guest from one of them (or a subdomain) is shared. */
  domains: string[]
  /** When the rule was last changed (ISO): only meetings that start after it follow it. */
  since: string | null
}

const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** Domains from what the user typed: commas, spaces or new lines; "@acme.com", "*.acme.com" and emails become "acme.com". */
export function parseDomains(text: string): string[] {
  const out: string[] = []
  for (const part of String(text ?? '').split(/[\s,;]+/)) {
    let d = part.trim().toLowerCase()
    if (!d) continue
    if (d.includes('@')) d = d.slice(d.lastIndexOf('@') + 1)
    d = d.replace(/^\*\./, '').replace(/^\.+|\.+$/g, '')
    if (DOMAIN_RE.test(d) && !out.includes(d)) out.push(d)
    if (out.length >= 50) break
  }
  return out
}

export function emailDomain(email: string | undefined | null): string | null {
  const at = String(email ?? '').lastIndexOf('@')
  if (at < 1) return null
  const d = String(email).slice(at + 1).trim().toLowerCase()
  return DOMAIN_RE.test(d) ? d : null
}

function domainMatches(domain: string, wanted: string[]): boolean {
  return wanted.some((w) => domain === w || domain.endsWith(`.${w}`))
}

interface Person {
  email?: string
  isMe?: boolean
}

export interface ShareableMeeting {
  startedAt: string
  attendees?: Person[]
  calendarEvent?: { attendees?: Person[] } | null
}

/** What the rule says for a meeting (the user's own choice in the meeting view always wins over it). */
export function autoShareDecision(meeting: ShareableMeeting, rule: ShareRule): boolean {
  if (rule.mode === 'never') return false
  // Changing the rule never reaches back: only meetings that start after it was set.
  const since = rule.since ? Date.parse(rule.since) : NaN
  const started = Date.parse(meeting.startedAt)
  if (!Number.isFinite(since) || !Number.isFinite(started) || started < since) return false
  if (rule.mode === 'all') return true
  const people = [...(meeting.attendees ?? []), ...(meeting.calendarEvent?.attendees ?? [])]
  return people.some((p) => {
    if (p.isMe) return false
    const d = emailDomain(p.email)
    return !!d && domainMatches(d, rule.domains)
  })
}

/** A rule from settings, cleaned. */
export function cleanRule(raw: Partial<ShareRule> | null | undefined): ShareRule {
  const mode: AutoShare = raw?.mode === 'all' || raw?.mode === 'domains' ? raw.mode : 'never'
  const domains = Array.isArray(raw?.domains) ? parseDomains(raw.domains.join(' ')) : []
  const since = typeof raw?.since === 'string' && Number.isFinite(Date.parse(raw.since)) ? raw.since : null
  return { mode, domains, since }
}

// ---------- the owner's view of the team (GET /api/team) ----------

export interface TeamMember {
  id: string
  name: string
  status: 'joined' | 'invited' | 'expired'
  createdAt: string
  joinedAt: string | null
  lastSeenAt: string | null
  inviteExpiresAt: string | null
  meetings: number
  shared: number
  bytes: number
  recordings: number
}

export interface TeamConnector {
  id: string
  label: string
  createdAt: string
}

export interface TeamInfo {
  ownerName: string
  owner: { meetings: number; shared: number }
  members: TeamMember[]
  connectors: TeamConnector[]
  limits: { members: number; connectors: number; memberMeetingsMb: number; memberRecordingsMb: number }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 64) : null)

/** GET /api/team's answer, checked and with only the fields the app shows. */
export function parseTeamInfo(body: unknown): TeamInfo | null {
  if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) return null
  const b = body as Record<string, any>
  if (!Array.isArray(b.members) || !Array.isArray(b.connectors)) return null
  return {
    ownerName: str(b.ownerName, 80),
    owner: { meetings: num(b.owner?.meetings), shared: num(b.owner?.shared) },
    members: b.members
      .filter((m: any) => m && typeof m.id === 'string' && MEMBER_ID_RE.test(m.id))
      .map((m: any) => ({
        id: m.id,
        name: str(m.name, 80),
        status: m.status === 'joined' || m.status === 'invited' ? m.status : 'expired',
        createdAt: str(m.createdAt, 64),
        joinedAt: strOrNull(m.joinedAt),
        lastSeenAt: strOrNull(m.lastSeenAt),
        inviteExpiresAt: strOrNull(m.inviteExpiresAt),
        meetings: num(m.meetings),
        shared: num(m.shared),
        bytes: num(m.bytes),
        recordings: num(m.recordings)
      })),
    connectors: b.connectors
      .filter((c: any) => c && typeof c.id === 'string' && /^t_[0-9a-f]{16}$/.test(c.id))
      .map((c: any) => ({ id: c.id, label: str(c.label, 80), createdAt: str(c.createdAt, 64) })),
    limits: {
      members: num(b.limits?.members),
      connectors: num(b.limits?.connectors),
      memberMeetingsMb: num(b.limits?.memberMeetingsMb),
      memberRecordingsMb: num(b.limits?.memberRecordingsMb)
    }
  }
}
