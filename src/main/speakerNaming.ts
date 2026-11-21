import type { SpeakerInfo } from '@shared/types'
import { autoNameFor, nameAutomatically, nameByUser, undoAutoName, type NamingResult } from '@shared/speakerNames'
import { engine } from './engine'
import { settings } from './settings'
import { db } from './storage/db'
import { readMeeting, writeMeeting } from './storage/files'
import { broadcast } from './windows'

/**
 * Speakers by name, applied to a saved meeting: the names the user gives (typed or a calendar chip),
 * the automatic name of a 1:1 call, and its undo. The rules live in src/shared/speakerNames.ts.
 * Saving rewrites transcript.md too, so the names reach the Markdown file and Claude (MCP) at once.
 */
function apply(folder: string, label: string, decide: (info: SpeakerInfo | undefined) => NamingResult | null): NamingResult | null {
  const m = readMeeting(folder)
  if (!m) return null
  const r = decide(m.meta.speakers?.[label])
  if (!r) return null
  if (r.forget) engine.send({ type: 'voiceprint.remove', key: r.forget })
  if (r.remember) engine.send({ type: 'voiceprint.remember', ...r.remember })
  const meta = { ...m.meta, folder, speakers: { ...m.meta.speakers, [label]: r.info } }
  writeMeeting(folder, meta, m.segments)
  db().updateMeta(meta)
  broadcast('meetings:changed', meta.id)
  return r
}

/** The user named a speaker; `remember` also saves the voice so later calls recognise it. */
export function nameSpeaker(folder: string, label: string, name: string, remember: boolean): void {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!clean || label === 'me') return
  apply(folder, label, (info) => (info?.isMe ? null : nameByUser(info, clean, { remember: !!remember, known: engine.status.voiceprintKeys })))
}

/** "Not them": the automatic name and its voiceprint go. */
export function undoAutoSpeaker(folder: string, label: string): void {
  apply(folder, label, (info) => (info?.auto ? undoAutoName(info) : null))
}

/** After a call: a 1:1 call's one remote voice takes the name of the one other person on the invite. */
export function autoNameSpeakers(folder: string): void {
  try {
    const m = readMeeting(folder)
    const a = m && autoNameFor(m.meta, m.segments, settings.value.userName)
    if (!a) return
    if (apply(folder, a.label, (info) => nameAutomatically(info, a))) {
      console.log(`speakers: ${a.label} named automatically from the calendar (1:1 call)${a.remember ? ', voice remembered' : ''}`)
    }
  } catch (err) {
    console.warn('speakers: automatic name failed', err)
  }
}

/** The user closed the "who is this?" card of a meeting. */
export function dismissSpeakerPrompt(folder: string): void {
  const m = readMeeting(folder)
  if (!m) return
  const meta = { ...m.meta, folder, speakerPromptDismissed: true }
  writeMeeting(folder, meta, m.segments)
  db().updateMeta(meta)
  broadcast('meetings:changed', meta.id)
}
