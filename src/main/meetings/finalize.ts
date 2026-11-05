import { Notification } from 'electron'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingMeta, RecordingMode, Segment, SpeakerInfo } from '@shared/types'
import { MATCH_VERSION, matchEvent } from '../calendar'
import { engine } from '../engine'
import { helper } from '../helper'
import { settings } from '../settings'
import { autoSummary } from '../summarize'
import { db } from '../storage/db'
import { readMeeting, renameMeetingFolder, writeMeeting, writeMeta } from '../storage/files'
import { broadcast, showLibrary } from '../windows'

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
      const event = await matchEvent(new Date(meta.startedAt), meta).catch(() => null)
      if (event) {
        meta.calendarEvent = event
        meta.attendees = event.attendees
        if (meta.title === job.defaultTitle && meta.titleSource !== 'user') {
          meta.title = event.title
          meta.titleSource = 'calendar'
        }
      }
      // No event: an ad-hoc call or in person. The automatic summary names it (MCP set_meeting_details).
      meta.calendarChecked = MATCH_VERSION
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
      // The raw recording is only needed until the audio file exists and the speaker step read it.
      if (existsSync(join(meta.folder, 'audio.m4a'))) rmSync(join(meta.folder, '.raw'), { recursive: true, force: true })
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

async function encodeAudio(meta: MeetingMeta, mode: RecordingMode): Promise<void> {
  const raw = (mode === 'meeting' ? ['mic', 'system'] : ['mic']).map((s) => join(meta.folder, '.raw', `${s}.pcm`))
  if (!raw.every((p) => existsSync(p) && statSync(p).size > 0)) return
  try {
    const encode = (): Promise<unknown> => helper.request('encode', { inputs: raw, output: join(meta.folder, 'audio.m4a') }, 600_000)
    await encode().catch(async (err) => {
      console.error('encode failed, retrying', err)
      await new Promise((r) => setTimeout(r, 1500))
      return encode()
    })
    meta.hasAudio = true
    if (!settings.value.keepAudio) {
      rmSync(join(meta.folder, 'audio.m4a'), { force: true })
      meta.hasAudio = false
    }
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
