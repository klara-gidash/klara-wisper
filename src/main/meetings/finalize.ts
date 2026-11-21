import { Notification } from 'electron'
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingMeta, RecordingMode, Segment, SpeakerInfo } from '@shared/types'
import { SOURCE_LABEL } from '@shared/types'
import { matchEventChecked, matchVersion } from '../calendar'
import { engine } from '../engine'
import { helper } from '../helper'
import { settings } from '../settings'
import { autoSummary } from '../summarize'
import { db } from '../storage/db'
import { readMeeting, renameMeetingFolder, writeMeeting, writeMeta } from '../storage/files'
import { broadcast, showLibrary } from '../windows'
import { isGenericTitle } from './titles'

export interface FinalizeJob {
  meta: MeetingMeta
  mode: RecordingMode
  defaultTitle: string
  liveSegments: Segment[]
  speakers: Record<string, SpeakerInfo>
  renames: Record<string, string>
  diarized: boolean
  stoppedAt: number
}

const FINAL_IDLE_MS = 10 * 60_000   // engine silent this long while finishing the transcript: give up, keep the live text
const SPEAKERS_IDLE_MS = 30 * 60_000

/**
 * Saving a finished recording happens here, in the background and one at a time, so the
 * recorder is free for the next call the moment the previous one ends.
 *  1. the engine's complete transcript ("session.final", seconds after the call) → saved, indexed;
 *  2. the audio file is encoded;
 *  3. who-said-what ("session.speakers", a minute or two later) → the saved transcript is updated.
 */
class Finalizer {
  private chain: Promise<void> = Promise.resolve()
  pending = new Set<string>()

  enqueue(job: FinalizeJob): void {
    const id = job.meta.id
    this.pending.add(id)
    // Listen right away: the engine may answer before earlier jobs are done.
    const finalP = engine.waitIdle('session.final', id, FINAL_IDLE_MS)
    const speakersP = job.diarized ? engine.waitIdle('session.speakers', id, SPEAKERS_IDLE_MS) : null
    finalP.catch(() => undefined)
    speakersP?.catch(() => undefined)
    this.chain = this.chain
      .then(() => this.run(job, finalP, speakersP))
      // Speakers are in: Claude can write the summary now (its own queue, never blocks the next call).
      .then(() => autoSummary.enqueue(id))
      .catch((err) => console.error(`finalize ${id} failed`, err))
      .finally(() => this.pending.delete(id))
  }

  private async run(job: FinalizeJob, finalP: Promise<any>, speakersP: Promise<any> | null): Promise<void> {
    const meta = job.meta
    let segments = job.liveSegments
    let speakers = { ...job.speakers }
    try {
      const final = await finalP
      segments = final.segments
      speakers = { ...speakers, ...final.speakers }
    } catch (err) {
      console.error(`recording ${meta.id}: ${String((err as Error).message)}; saving the live transcript`)
      engine.send({ type: 'session.cancel', id: meta.id })
    }
    speakers = applyRenames(speakers, job.renames)

    if (!meta.calendarEvent) {
      const r = await matchEventChecked(new Date(meta.startedAt), meta).catch(() => ({ event: null, readable: false }))
      if (r.event) {
        meta.calendarEvent = r.event
        meta.attendees = r.event.attendees
      }
      // No event: an ad-hoc call or in person. The automatic summary names it (MCP set_meeting_details).
      // Stamp only when a calendar was readable; otherwise the backfill looks again later.
      if (r.readable) meta.calendarChecked = matchVersion()
    }
    // A browser tab's or app's placeholder ("abc-defg-hij", "Zoom Meeting", "Google Meet 10:30")
    // gives way to the calendar event's title; a name the user typed never does.
    const ev = meta.calendarEvent
    if (ev?.title && meta.titleSource !== 'user' && (meta.title === job.defaultTitle || isGenericTitle(meta.title, Object.values(SOURCE_LABEL)))) {
      meta.title = ev.title
      meta.titleSource = 'calendar'
    }
    meta.speakers = speakers
    meta.languages = [...new Set(segments.map((s) => s.lang))]
    meta.status = 'done'
    meta.folder = renameMeetingFolder(meta.folder, meta)
    writeMeeting(meta.folder, meta, segments)
    db().indexMeeting(meta, segments)
    broadcast('meetings:changed', meta.id)
    console.log(`recording ${meta.id}: transcript saved, ${segments.length} lines, ${meta.durationSec}s audio, ${Math.round((Date.now() - job.stoppedAt) / 1000)}s after the call ended`)
    notify(meta, segments.length)

    await encodeAudio(meta, job.mode)
    try {
      if (speakersP) await this.addSpeakers(job, segments, speakersP)
    } finally {
      // The raw recording is only needed until the audio file exists and the speaker step read it
      // (or at all, when the user doesn't keep audio).
      if (!settings.value.keepAudio || existsSync(join(meta.folder, 'audio.m4a'))) rmSync(join(meta.folder, '.raw'), { recursive: true, force: true })
    }
  }

  private async addSpeakers(job: FinalizeJob, segments: Segment[], speakersP: Promise<any>): Promise<void> {
    const meta = job.meta
    try {
      const sp = await speakersP
      if (sp.skipped || !sp.segments) return
      const current = readMeeting(meta.folder) // the user may have renamed things meanwhile
      const base = current?.segments ?? segments
      const merged = [...base.filter((s) => s.stream !== sp.stream), ...sp.segments].sort((a, b) => a.start - b.start)
      const m = current?.meta ?? meta
      const kept = Object.fromEntries(Object.entries(m.speakers ?? {}).filter(([k]) => k === 'me'))
      m.speakers = applyRenames({ ...kept, ...sp.speakers }, job.renames)
      writeMeeting(m.folder, m, merged)
      db().indexMeeting({ ...m, folder: m.folder }, merged)
      broadcast('meetings:changed', m.id)
      console.log(`recording ${meta.id}: speakers added (${Object.keys(sp.speakers).length} on ${sp.stream}, ${sp.seconds}s)`)
    } catch (err) {
      console.warn(`recording ${meta.id}: speaker step: ${String((err as Error).message)}`)
    }
  }
}

function applyRenames(speakers: Record<string, SpeakerInfo>, renames: Record<string, string>): Record<string, SpeakerInfo> {
  const out = { ...speakers }
  for (const [label, name] of Object.entries(renames)) {
    if (out[label]) out[label] = { ...out[label], name }
  }
  return out
}

/**
 * Encodes a meeting's raw recordings into audio.m4a (channel 1 = me, channel 2 = the other side).
 * Works with whichever side was recorded: a missing or empty side becomes a short silent file,
 * which both helpers pad with silence to the other side's length, so the channels keep their
 * meaning. False when there is no audio at all; throws when encoding fails (after one retry).
 */
export async function encodeRaw(folder: string, mode: RecordingMode): Promise<boolean> {
  const streams = mode === 'meeting' ? ['mic', 'system'] : ['mic']
  const paths = streams.map((s) => join(folder, '.raw', `${s}.pcm`))
  const has = paths.map((p) => existsSync(p) && statSync(p).size > 0)
  if (!has.some(Boolean)) return false
  const inputs = paths.map((p, i) => {
    if (has[i]) return p
    const silent = join(folder, '.raw', `${streams[i]}.silent.pcm`)
    writeFileSync(silent, Buffer.alloc(3200)) // 0.1 s of 16 kHz Int16 silence
    return silent
  })
  const encode = (): Promise<unknown> => helper.request('encode', { inputs, output: join(folder, 'audio.m4a') }, 600_000)
  await encode().catch(async (err) => {
    console.error('encode failed, retrying', err)
    await new Promise((r) => setTimeout(r, 1500))
    return encode()
  })
  return true
}

async function encodeAudio(meta: MeetingMeta, mode: RecordingMode): Promise<void> {
  // Audio not kept: don't encode at all (the raw files are deleted after the speaker step).
  if (!settings.value.keepAudio) return
  try {
    if (!(await encodeRaw(meta.folder, mode))) return
    meta.hasAudio = true
    writeMeta(meta.folder, meta)
  } catch (err) {
    console.error('encode failed', err)
  }
}

function notify(meta: MeetingMeta, lines: number): void {
  const he = settings.value.uiLanguage === 'he'
  const n = new Notification({
    title: he ? 'התמלול מוכן' : 'Transcript ready',
    body: `${meta.title} · ${lines} ${he ? 'שורות' : 'lines'}`,
    silent: true
  })
  n.on('click', () => showLibrary(`meeting/${meta.id}`))
  n.show()
}

export const finalizer = new Finalizer()
