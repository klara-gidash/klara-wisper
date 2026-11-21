import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoShareDecision, cleanRule, type ShareRule, type ShareableMeeting } from '@shared/team'
import { dataDir } from './paths'
import { settings } from './settings'

/**
 * Team cloud (optional): whether this computer is in a team cloud, and the sharing choice for each meeting.
 * No secrets here (the tokens are in cloud.ts's encrypted files) and no network: cloud.ts reads it on every
 * upload, cloudTeam.ts changes it.
 */
export const TEAM_FILE = join(dataDir, 'cloud-team.json')
/** meeting id -> shared with the team (the user's choice, or the automatic rule's, decided once). */
export const SHARES_FILE = join(dataDir, 'cloud-team-shares.json')

export interface TeamMembership {
  /** owner: this computer deployed the Worker and has a team (members or a team connector); member: joined one. */
  role: 'owner' | 'member'
  /** The Worker it belongs to: a membership for another address is ignored. */
  url: string
  memberId?: string
  name?: string
  ownerName?: string
  joinedAt?: string
}

export function readTeam(): TeamMembership | null {
  try {
    if (!existsSync(TEAM_FILE)) return null
    const t = JSON.parse(readFileSync(TEAM_FILE, 'utf8')) as Partial<TeamMembership>
    if ((t.role !== 'owner' && t.role !== 'member') || typeof t.url !== 'string') return null
    if (!settings.value.cloudUrl || t.url !== settings.value.cloudUrl) return null
    return t as TeamMembership
  } catch {
    return null
  }
}

export function writeTeam(t: TeamMembership): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(TEAM_FILE, JSON.stringify(t, null, 2))
}

/** Leaves the team on this computer. `keepShares`: an owner whose team is empty for now keeps the meetings' choices. */
export function clearTeam(opts: { keepShares?: boolean } = {}): void {
  rmSync(TEAM_FILE, { force: true })
  if (!opts.keepShares) rmSync(SHARES_FILE, { force: true })
}

/** In a team cloud with sync on: the meeting view shows "share with the team" and uploads say shared or not. */
export function inTeam(): boolean {
  return settings.value.cloudSync && readTeam() !== null
}

export function shareRule(): ShareRule {
  return cleanRule(settings.value.teamAutoShare)
}

function readShares(): Record<string, boolean> {
  try {
    const s = JSON.parse(readFileSync(SHARES_FILE, 'utf8'))
    return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeShares(s: Record<string, boolean>): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(SHARES_FILE, JSON.stringify(s))
}

/** The saved choice for a meeting, or undefined when none was made yet. */
export function shareChoice(id: string): boolean | undefined {
  const v = readShares()[id]
  return typeof v === 'boolean' ? v : undefined
}

export function setShareChoice(id: string, shared: boolean): void {
  const s = readShares()
  s[id] = shared
  writeShares(s)
}

export function forgetShareChoice(id: string): void {
  const s = readShares()
  if (!(id in s)) return
  delete s[id]
  writeShares(s)
}

/** What the meeting view shows: the saved choice, or what the rule would decide. */
export function shownShare(meeting: ShareableMeeting & { id: string }): boolean {
  return shareChoice(meeting.id) ?? autoShareDecision(meeting, shareRule())
}

/**
 * The "shared" flag an upload sends: undefined outside a team (the field is left out, as before). Otherwise the
 * saved choice, or the rule's decision, saved the first time so a later change of the rule never flips it.
 */
export function shareForUpload(meeting: ShareableMeeting & { id: string }): boolean | undefined {
  if (!readTeam()) return undefined
  const saved = shareChoice(meeting.id)
  if (saved !== undefined) return saved
  const decided = autoShareDecision(meeting, shareRule())
  setShareChoice(meeting.id, decided)
  return decided
}
