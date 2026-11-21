import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingMeta, Segment } from '@shared/types'
import { engine } from './engine'
import { encodeRaw } from './meetings/finalize'
import { settings } from './settings'
import { db } from './storage/db'
import { listMeetingFolders, readMeta, writeMeeting, writeMeta } from './storage/files'
import { broadcast } from './windows'

/**
 * Recordings interrupted by a crash or quit keep their raw audio in `.raw/`.
 * Once the engine is ready, transcribe them offline and save them like a normal meeting.
 */
export async function recoverInterrupted(activeId: string | null): Promise<void> {
  for (const folder of listMeetingFolders()) {
    const meta = readMeta(folder)
    if (!meta || meta.id === activeId) continue
    if (meta.status === 'done') {
      await encodeLeftover(folder, meta)
      continue
    }
    if (meta.status !== 'recording' && meta.status !== 'processing') continue
    const streams = (meta.mode === 'meeting' ? ['mic', 'system'] : ['mic']).filter((s) => {
      const p = join(folder, '.raw', `${s}.pcm`)
      return existsSync(p) && statSync(p).size > 32000
    })
    if (!streams.length) {
      meta.status = 'error'
      meta.error = 'interrupted before any audio was saved'
      writeMeta(folder, meta)
      continue
    }
    await recoverOne(folder, meta, streams)
  }
}

const SPEAKERS_IDLE_MS = 30 * 60_000 // as the finalizer: the engine silent this long during the speaker step gives up

async function recoverOne(folder: string, meta: MeetingMeta, streams: string[]): Promise<void> {
  await transcribeSaved(folder, meta, streams)
}

/**
 * Transcribes a meeting folder's saved raw audio (.raw/<stream>.pcm, 16 kHz mono Int16) offline and
 * saves it like a normal meeting: transcript, audio.m4a, index. Used for interrupted recordings and
 * for recordings pulled from the phone (phoneRecordings.ts). True when the transcript was saved;
 * on failure the meeting is marked 'error' (and its .raw audio stays).
 */
export async function transcribeSaved(folder: string, meta: MeetingMeta, streams: string[], opts: { speakers?: boolean } = {}): Promise<boolean> {
  const rawPaths = Object.fromEntries(streams.map((s) => [s, join(folder, '.raw', `${s}.pcm`)]))
  const id = `${meta.id}_r`
  const diarize = meta.mode === 'inperson' ? ['mic'] : streams.includes('system') ? ['system'] : []
  meta.status = 'processing'
  writeMeta(folder, meta)
  // With `speakers`, also wait for who-said-what (the engine sends it after the transcript, read from
  // .raw, so .raw stays until then), as the finalizer does for a live recording.
  const speakersP = opts.speakers && diarize.length ? engine.waitIdle('session.speakers', id, SPEAKERS_IDLE_MS) : null
  speakersP?.catch(() => undefined)
  engine.send({ type: 'transcribe.file', id, mode: meta.mode, rawPaths, diarize })
  try {
    const seconds = Math.max(...streams.map((s) => statSync(rawPaths[s]).size / 32000))
    const final = await engine.waitFor('session.final', id, Math.max(300_000, seconds * 2000))
    meta.speakers = { ...(meta.mode === 'meeting' ? { me: { name: null, key: 'me', isMe: true } } : {}), ...final.speakers }
    meta.durationSec = Math.round(seconds)
    meta.endedAt = new Date(new Date(meta.startedAt).getTime() + seconds * 1000).toISOString()
    meta.status = 'done'
    let segments: Segment[] = final.segments
    writeMeeting(folder, meta, segments)
    if (speakersP) {
      try {
        const sp = await speakersP
        if (!sp.skipped && sp.segments) {
          segments = [...segments.filter((s) => s.stream !== sp.stream), ...sp.segments].sort((a, b) => a.start - b.start)
          meta.speakers = { ...(meta.mode === 'meeting' ? { me: meta.speakers.me } : {}), ...sp.speakers }
          writeMeeting(folder, meta, segments)
        }
      } catch (err) {
        console.warn(`recording ${meta.id}: speaker step: ${String((err as Error).message)}`) // the transcript stays as it is
      }
    }
    // The transcript is saved; an encoding failure leaves .raw for the next launch (encodeLeftover).
    const encoded = await encodeKept(folder, meta)
    if (encoded !== null) {
      meta.hasAudio = encoded
      writeMeta(folder, meta)
    }
    db().indexMeeting(meta, segments)
    broadcast('meetings:changed', meta.id)
    return true
  } catch (err) {
    meta.status = 'error'
    meta.error = String((err as Error).message)
    writeMeta(folder, meta)
    return false
  }
}

/** A finished meeting whose audio was never encoded (e.g. the app quit right at the end). */
async function encodeLeftover(folder: string, meta: MeetingMeta): Promise<void> {
  if (!existsSync(join(folder, '.raw'))) return
  if (existsSync(join(folder, 'audio.m4a'))) {
    rmSync(join(folder, '.raw'), { recursive: true, force: true }) // already encoded
    return
  }
  if (!settings.value.keepAudio) {
    rmSync(join(folder, '.raw'), { recursive: true, force: true }) // audio not kept: nothing to encode
    return
  }
  if (await encodeKept(folder, meta)) {
    meta.hasAudio = true
    writeMeta(folder, meta)
    broadcast('meetings:changed', meta.id)
  }
}

/**
 * Encodes audio.m4a from whichever sides were recorded (unless audio isn't kept) and removes .raw.
 * Whether audio.m4a was made; null (and .raw kept for another try) when encoding failed.
 */
async function encodeKept(folder: string, meta: MeetingMeta): Promise<boolean | null> {
  try {
    const made = settings.value.keepAudio && (await encodeRaw(folder, meta.mode))
    rmSync(join(folder, '.raw'), { recursive: true, force: true })
    return made
  } catch (err) {
    console.error('encode failed', folder, err)
    return null
  }
}
