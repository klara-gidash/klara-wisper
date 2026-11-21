// Speakers by name: name suggestions from the calendar, the automatic name in 1:1 calls, and the
// "who is this?" card. Pure functions (no I/O), so Node runs this file directly in tests
// (test/speaker-names.test.mts); src/main/speakerNaming.ts applies the results.
import type { Attendee, MeetingMeta, Segment, SpeakerInfo } from './types'

export interface NameSuggestion {
  name: string
  email: string
}

/** Known voiceprints as the engine reports them (EngineStatus.voiceprintKeys). */
export type KnownVoices = Record<string, { name: string; isMe: boolean; auto?: boolean }> | undefined

/** A remote speaker in a 1:1 call needs this much talk before its voiceprint is remembered by itself. */
export const AUTO_REMEMBER_MIN_TALK_S = 20

/** Prefix of voiceprints learned without a click (removed again by "undo"). */
export const AUTO_KEY_PREFIX = 'auto_'

const ROOM = /resource\.calendar\.google\.com|group\.calendar\.google\.com/i
const MARKS = /[֑-ׇ‎‏‪-‮⁦-⁩]/g

/** Names compared the way people read them: case, spaces, niqqud and direction marks ignored. */
export function normName(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').replace(MARKS, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normName(a)
  return !!x && x === normName(b)
}

/** What to call an attendee: the calendar's name, else the address's local part ("roi.cohen@" → "Roi Cohen"). */
export function attendeeName(a: Attendee): string {
  const name = (a.name ?? '').replace(MARKS, '').trim()
  if (name && !name.includes('@')) return name
  const local = (a.email || name).split('@')[0] ?? ''
  return local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

/**
 * The other people on the calendar invite: not the user (isMe, or the user's name when no attendee
 * is marked), not rooms, each person once.
 */
export function otherAttendees(attendees: Attendee[] | null | undefined, userName = ''): NameSuggestion[] {
  const list = attendees ?? []
  const anyMe = list.some((a) => a.isMe)
  const me = normName(userName)
  const seen = new Set<string>()
  const out: NameSuggestion[] = []
  for (const a of list) {
    const email = (a.email ?? '').trim().toLowerCase()
    if (a.isMe || ROOM.test(email)) continue
    const name = attendeeName(a)
    const n = normName(name)
    if (!n) continue
    // Without an isMe mark (some calendars), the user's own entry is recognised by her name:
    // the full name, or her first name ("Klara" in settings, "Klara Gidash" on the invite).
    if (me && (n === me || (!anyMe && !me.includes(' ') && n.startsWith(`${me} `)))) continue
    const id = email || n
    if (seen.has(id) || seen.has(n)) continue
    seen.add(id)
    seen.add(n)
    out.push({ name, email })
  }
  return out
}

export function isUserSpeaker(label: string | null | undefined, info?: SpeakerInfo | null): boolean {
  return label === 'me' || !!info?.isMe
}

export function talkTime(segments: Segment[], label: string): number {
  return segments.reduce((t, s) => (s.speaker === label ? t + Math.max(0, s.end - s.start) : t), 0)
}

/**
 * Speakers other than the user, in order of first appearance. "rem" (everyone on the other side, not
 * told apart) counts only when the speaker step found one voice there (it then has a voiceprint).
 */
export function otherSpeakers(meta: Pick<MeetingMeta, 'speakers'>, segments: Segment[]): string[] {
  const speakers = meta.speakers ?? {}
  const order: string[] = []
  const spoke = new Set<string>()
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    if (!s.speaker || spoke.has(s.speaker)) continue
    spoke.add(s.speaker)
    order.push(s.speaker)
  }
  const labels = segments.length ? order : Object.keys(speakers)
  return labels.filter((l) => {
    const info = speakers[l]
    if (isUserSpeaker(l, info)) return false
    if (l === 'rem' && !info?.embedding?.length && !info?.name) return false
    return true
  })
}

/** Speakers still shown as "משתתף N" / "דובר N". */
export function unnamedSpeakers(meta: Pick<MeetingMeta, 'speakers'>, segments: Segment[]): string[] {
  return otherSpeakers(meta, segments).filter((l) => !meta.speakers?.[l]?.name)
}

function inviteOf(meta: Pick<MeetingMeta, 'attendees' | 'calendarEvent'>): Attendee[] {
  return meta.attendees?.length ? meta.attendees : (meta.calendarEvent?.attendees ?? [])
}

/** One-tap name chips for a speaker: the invite's other people, minus names other speakers already have. */
export function suggestionsFor(
  meta: Pick<MeetingMeta, 'attendees' | 'calendarEvent' | 'speakers'>,
  label: string,
  userName = ''
): NameSuggestion[] {
  const taken = Object.entries(meta.speakers ?? {})
    .filter(([l, s]) => l !== label && s.name)
    .map(([, s]) => s.name as string)
  return otherAttendees(inviteOf(meta), userName).filter((a) => !taken.some((t) => sameName(t, a.name)))
}

/** The gentle "who is this?" card in the meeting view: a finished meeting with unnamed speakers. */
export function needsWhoPrompt(meta: MeetingMeta, segments: Segment[]): boolean {
  if (meta.status !== 'done' || meta.speakerPromptDismissed) return false
  return unnamedSpeakers(meta, segments).length > 0
}

export interface AutoName {
  label: string
  name: string
  email: string
  /** Remember the voiceprint too (enough talk to trust it). */
  remember: boolean
}

/**
 * A 1:1 call: exactly one other person on the invite and exactly one voice on the other side, still
 * unnamed. That voice is that person. Never replaces a name (the user's, or a recognised voiceprint),
 * and never again after the user undid it.
 */
export function autoNameFor(meta: MeetingMeta, segments: Segment[], userName = ''): AutoName | null {
  if (meta.mode !== 'meeting') return null
  const others = otherAttendees(inviteOf(meta), userName)
  if (others.length !== 1) return null
  const remote = otherSpeakers(meta, segments)
  // "rem" without a voiceprint is everyone on the other side; in a 1:1 call that is the one guest.
  const undiarized = remote.length === 0 && segments.some((s) => s.speaker === 'rem')
  const labels = undiarized ? ['rem'] : remote
  if (labels.length !== 1) return null
  const label = labels[0]
  const info = meta.speakers?.[label]
  if (info?.name || info?.autoRejected || info?.isMe) return null
  return {
    label,
    name: others[0].name,
    email: others[0].email,
    remember: !!info?.embedding?.length && talkTime(segments, label) >= AUTO_REMEMBER_MIN_TALK_S
  }
}

function slug(s: string): string {
  return normName(s).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x'
}

export interface Voiceprint {
  key: string
  name: string
  embedding: number[]
  isMe: boolean
  auto?: boolean
}

export interface NamingResult {
  info: SpeakerInfo
  /** Save (or update) this voiceprint in the engine. */
  remember?: Voiceprint
  /** Remove this voiceprint from the engine (a wrong automatic one). */
  forget?: string
}

/**
 * The user names a speaker (typed, or a chip). A wrong automatic name gives way and its voiceprint is
 * dropped; with `remember`, the voice is saved: into the speaker's own voiceprint, else into a saved
 * voice with the same name (more audio makes it steadier), else a new one.
 */
export function nameByUser(
  info: SpeakerInfo | undefined,
  name: string,
  o: { remember: boolean; known?: KnownVoices; now?: number }
): NamingResult {
  const base: SpeakerInfo = { ...(info ?? { name: null, isMe: false }) }
  let forget: string | undefined
  if (base.auto && base.key && !sameName(base.name, name)) {
    forget = base.key
    base.key = null
  }
  const out: SpeakerInfo = { ...base, name }
  delete out.auto
  if (!o.remember || !out.embedding?.length) return { info: out, forget }
  let key = out.key && !out.key.startsWith(AUTO_KEY_PREFIX) ? out.key : null
  if (!key) {
    const same = Object.entries(o.known ?? {}).find(([k, v]) => !v.isMe && !v.auto && !k.startsWith(AUTO_KEY_PREFIX) && sameName(v.name, name))
    key = same?.[0] ?? `v_${(o.now ?? Date.now()).toString(36)}`
  }
  // A confirmed automatic voiceprint: the user's own one takes over, the automatic one goes.
  if (out.key && out.key !== key && out.key.startsWith(AUTO_KEY_PREFIX)) forget = out.key
  out.key = key
  return { info: out, forget, remember: { key, name, embedding: out.embedding, isMe: !!out.isMe } }
}

/** The automatic name of a 1:1 call (see autoNameFor), with its voiceprint under an "auto_" key. */
export function nameAutomatically(info: SpeakerInfo | undefined, a: AutoName): NamingResult | null {
  if (info?.name || info?.autoRejected || info?.isMe) return null
  const out: SpeakerInfo = { ...(info ?? { name: null, isMe: false }), name: a.name, auto: true }
  if (!a.remember || !out.embedding?.length) return { info: out }
  const key = `${AUTO_KEY_PREFIX}${slug(a.email || a.name)}`
  out.key = key
  return { info: out, remember: { key, name: a.name, embedding: out.embedding, isMe: false, auto: true } }
}

/** "Not them": back to "משתתף N", the automatic voiceprint removed, and never named automatically again. */
export function undoAutoName(info: SpeakerInfo): NamingResult {
  const forget = info.key && info.key.startsWith(AUTO_KEY_PREFIX) ? info.key : undefined
  const out: SpeakerInfo = { ...info, name: null, autoRejected: true }
  delete out.auto
  if (forget) out.key = null
  return { info: out, forget }
}
