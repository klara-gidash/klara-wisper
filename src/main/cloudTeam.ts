import { safeStorage } from 'electron'
import {
  InviteError, buildInvite, cleanRule, parseDomains, parseInvite, parseJoinResponse, parseTeamInfo,
  type AutoShare, type Invite, type ShareRule, type TeamInfo
} from '@shared/team'
import {
  MCP_TOKEN_FILE, REC_TOKEN_FILE, cloudHealth, cloudRequest, configureCloud, forgetCloud, queueCloud, saveSecret, saveUploadToken, uploadToken
} from './cloud'
import { connectorUrl } from './cloudflareApi'
import { inTeam, readTeam, setShareChoice, shareRule, shownShare, writeTeam, clearTeam } from './cloudTeamState'
import { pullPhoneRecordings } from './phoneRecordings'
import { settings } from './settings'
import { db } from './storage/db'
import { readMeeting } from './storage/files'
import { broadcast } from './windows'

/**
 * Team cloud (optional, roadmap 7): the owner of a Worker invites teammates from Settings > Cloud > Team, and
 * a teammate joins with the invite code. Each person's computer keeps using the same code paths as a personal
 * cloud (cloud.ts, phoneRecordings.ts) with that person's own tokens; the Worker keeps everyone's meetings
 * apart and shows the team connector only the meetings their uploaders shared.
 * Errors are thrown as "team:<code>" for the settings screen to explain (strings: team.err.<code>).
 */

export interface TeamState {
  /** owner: deployed this Worker (KLARA_TOKEN); member: joined someone's; null: no team (or cloud off). */
  role: 'owner' | 'member' | null
  /** In a team right now: owners with at least one member or team connector, and members. */
  active: boolean
  /** The Worker knows about teams (null: not asked, cloud off or not reachable). */
  supported: boolean | null
  name?: string
  ownerName?: string
  /** The owner's view: members, team connectors, limits. */
  team?: TeamInfo
  limits?: { meetingsMb: number; recordingsMb: number }
  rule: ShareRule
  error?: string
}

function fail(code: string): never {
  throw new Error(`team:${code}`)
}

async function readJson(r: Response): Promise<any> {
  return r.json().catch(() => null)
}

/** One owner/member request; the Worker's own refusals become team:<code>. */
async function request(method: string, path: string, body?: unknown): Promise<any> {
  let r: Response
  try {
    r = await cloudRequest(method, path, { body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (err) {
    if (/not set up|can no longer be read/.test(String((err as Error).message))) fail('notSetUp')
    fail('network')
  }
  if (r.status === 401) fail('rejected')
  if (r.status === 403) fail('notOwner')
  if (r.status === 404 && path.startsWith('/api/team')) {
    const health = await cloudHealth().catch(() => null)
    if (health && !health.features.includes('team')) fail('oldWorker')
  }
  const data = await readJson(r)
  if (!r.ok) {
    if (r.status === 409 && /at most/.test(String(data?.error))) fail('limit')
    if (r.status === 404) fail('notFound')
    fail(`worker`)
  }
  return data
}

function cloudReady(): boolean {
  return settings.value.cloudSync && !!settings.value.cloudUrl && !!uploadToken()
}

/** Settings > Cloud > Team: who this computer is in the team, and (for the owner) the team. */
export async function teamState(): Promise<TeamState> {
  const rule = shareRule()
  const membership = readTeam()
  const base: TeamState = { role: membership?.role ?? null, active: inTeam(), supported: null, rule, name: membership?.name, ownerName: membership?.ownerName }
  if (!cloudReady()) return base
  try {
    const me = await request('GET', '/api/me')
    if (me?.role === 'member') {
      const next = { role: 'member' as const, url: settings.value.cloudUrl, memberId: String(me.id), name: String(me.name ?? ''), ownerName: String(me.ownerName ?? ''), joinedAt: membership?.joinedAt }
      writeTeam(next)
      const limits = me.limits && typeof me.limits === 'object' ? { meetingsMb: Number(me.limits.meetingsMb) || 0, recordingsMb: Number(me.limits.recordingsMb) || 0 } : undefined
      return { ...base, role: 'member', active: inTeam(), supported: true, name: next.name, ownerName: next.ownerName, limits }
    }
    const team = parseTeamInfo(await request('GET', '/api/team'))
    if (!team) fail('worker')
    // "In a team" once there is someone to share with: a member or a team connector.
    if (team.members.length || team.connectors.length) writeTeam({ role: 'owner', url: settings.value.cloudUrl, name: team.ownerName })
    else if (membership?.role === 'owner') clearTeam({ keepShares: true })
    return { ...base, role: 'owner', active: inTeam(), supported: true, name: team.ownerName, ownerName: team.ownerName, team }
  } catch (err) {
    const code = String((err as Error).message).replace(/^team:/, '')
    // An older Worker has no /api/me: it answers 404 to it.
    if (code === 'oldWorker' || code === 'notFound') return { ...base, supported: false }
    return { ...base, error: code }
  }
}

function markOwner(): void {
  const t = readTeam()
  if (t?.role !== 'owner') writeTeam({ role: 'owner', url: settings.value.cloudUrl })
}

/** A new member: the invite text to send them (it works once, for 7 days). */
export async function inviteMember(name: string): Promise<{ invite: string; expiresAt: string; name: string }> {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!clean) fail('nameRequired')
  const r = await request('POST', '/api/team/members', { name: clean })
  markOwner()
  return { invite: buildInvite({ url: settings.value.cloudUrl, code: String(r.invite.code) }), expiresAt: String(r.invite.expiresAt), name: clean }
}

/** A new invite for an existing member (a new computer, or the first one expired). Their old one stops working. */
export async function reinviteMember(id: string): Promise<{ invite: string; expiresAt: string }> {
  if (!/^u_[0-9a-f]{16}$/.test(id)) fail('notFound')
  const r = await request('POST', `/api/team/members/${id}/invite`)
  return { invite: buildInvite({ url: settings.value.cloudUrl, code: String(r.invite.code) }), expiresAt: String(r.invite.expiresAt) }
}

export async function removeMember(id: string, deleteShared: boolean): Promise<{ deletedMeetings: number; keptShared: number }> {
  if (!/^u_[0-9a-f]{16}$/.test(id)) fail('notFound')
  const r = await request('DELETE', `/api/team/members/${id}`, { deleteShared: deleteShared === true })
  return { deletedMeetings: Number(r.deletedMeetings) || 0, keptShared: Number(r.keptShared) || 0 }
}

/** A team connector: its link is shown once (it is a credential for everything shared with the team). */
export async function createTeamConnector(label: string): Promise<{ url: string; id: string }> {
  const r = await request('POST', '/api/team/connectors', { label: String(label ?? '').trim().slice(0, 80) })
  markOwner()
  return { url: connectorUrl(settings.value.cloudUrl, String(r.token)), id: String(r.connector.id) }
}

export async function deleteTeamConnector(id: string): Promise<void> {
  if (!/^t_[0-9a-f]{16}$/.test(id)) fail('notFound')
  await request('DELETE', `/api/team/connectors/${id}`)
}

export async function setOwnerName(name: string): Promise<void> {
  await request('PUT', '/api/team', { ownerName: String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) })
}

/**
 * "Join a team cloud": trades the invite code for this person's own tokens and connects to the team's Worker.
 * Replaces this computer's own cloud connection (if it had one): the settings screen asks first.
 */
export async function joinTeam(text: string): Promise<TeamState> {
  let invite: Invite
  try {
    invite = parseInvite(text)
  } catch (err) {
    fail(err instanceof InviteError && err.code === 'empty' ? 'inviteEmpty' : 'inviteFormat')
  }
  if (!safeStorage.isEncryptionAvailable()) fail('encryption') // check before the one-time code is spent
  let r: Response
  try {
    r = await fetch(`${invite.url}/api/team/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: invite.code }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error'
    })
  } catch {
    fail('network')
  }
  if (r.status === 404 || r.status === 405) {
    // An older Worker has no /api/team/join (it answers 404 to any unknown path).
    const health = (await fetch(`${invite.url}/api/health`, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
      .then((h) => h.json())
      .catch(() => null)) as { features?: unknown } | null
    const features: unknown = health?.features
    fail(Array.isArray(features) && !features.includes('team') ? 'oldWorker' : 'inviteUsed')
  }
  if (!r.ok) fail('worker')
  const joined = parseJoinResponse(await readJson(r))
  if (!joined) fail('worker')

  // This computer now belongs to the team's Worker, with this person's own three tokens.
  forgetCloud()
  saveUploadToken(joined.tokens.upload)
  saveSecret(MCP_TOKEN_FILE, joined.tokens.mcp)
  saveSecret(REC_TOKEN_FILE, joined.tokens.rec)
  settings.update({ cloudUrl: invite.url })
  writeTeam({ role: 'member', url: invite.url, memberId: joined.member.id, name: joined.member.name, ownerName: joined.ownerName, joinedAt: new Date().toISOString() })
  try {
    await configureCloud({ url: invite.url, enabled: true })
  } catch {
    // Sync is saved as on; it starts working as soon as the Worker answers.
  }
  setTimeout(() => void pullPhoneRecordings(), 5_000)
  broadcast('cloud:changed', null)
  return teamState()
}

/** Settings: share meetings with the team automatically. Changing it applies only to meetings from now on. */
export function setAutoShare(input: { mode?: unknown; domains?: unknown }): ShareRule {
  const mode: AutoShare = input?.mode === 'all' || input?.mode === 'domains' ? input.mode : 'never'
  const domains = typeof input?.domains === 'string' ? parseDomains(input.domains) : Array.isArray(input?.domains) ? parseDomains(input.domains.join(' ')) : []
  const old = shareRule()
  const changed = old.mode !== mode || old.domains.join() !== domains.join()
  const next = cleanRule({ mode, domains, since: changed ? new Date().toISOString() : old.since })
  settings.update({ teamAutoShare: next })
  return next
}

function meetingMeta(id: string) {
  const folder = db().getFolder(id)
  const m = folder ? readMeeting(folder) : null
  if (!m) fail('notFound')
  return m.meta
}

/** The meeting view's "share with the team" switch: shown only in a team cloud. */
export function meetingShare(id: string): { inTeam: boolean; shared: boolean } {
  if (!inTeam()) return { inTeam: false, shared: false }
  return { inTeam: true, shared: shownShare(meetingMeta(id)) }
}

/**
 * Turns sharing on or off for one meeting: saved here first, then sent to the Worker. Not uploaded yet (or the
 * Worker can't be reached): the next upload of the meeting carries the choice; `synced` says which happened.
 */
export async function setMeetingShare(id: string, shared: boolean): Promise<{ shared: boolean; synced: boolean }> {
  if (!inTeam()) fail('notInTeam')
  meetingMeta(id)
  setShareChoice(id, shared)
  try {
    const r = await cloudRequest('POST', `/api/meetings/${encodeURIComponent(id)}/share`, { body: JSON.stringify({ shared }) })
    if (r.ok) return { shared, synced: true }
  } catch {
    /* offline: the upload below carries it when it can */
  }
  queueCloud(id)
  return { shared, synced: false }
}
