import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingMeta } from '@shared/types'
import { engine } from './engine'
import { helper } from './helper'
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

async function recoverOne(folder: string, meta: MeetingMeta, streams: string[]): Promise<void> {
  const rawPaths = Object.fromEntries(streams.map((s) => [s, join(folder, '.raw', `${s}.pcm`)]))
  const id = `${meta.id}_r`
  meta.status = 'processing'
  writeMeta(folder, meta)
  engine.send({
    type: 'transcribe.file', id, mode: meta.mode, rawPaths,
    diarize: meta.mode === 'inperson' ? ['mic'] : streams.includes('system') ? ['system'] : []
  })
  try {
    const seconds = Math.max(...streams.map((s) => statSync(rawPaths[s]).size / 32000))
    const final = await engine.waitFor('session.final', id, Math.max(300_000, seconds * 2000))
    meta.speakers = { ...(meta.mode === 'meeting' ? { me: { name: null, key: 'me', isMe: true } } : {}), ...final.speakers }
    meta.durationSec = Math.round(seconds)
    meta.endedAt = new Date(new Date(meta.startedAt).getTime() + seconds * 1000).toISOString()
    meta.status = 'done'
    writeMeeting(folder, meta, final.segments)
    await helper.request('encode', { inputs: Object.values(rawPaths), output: join(folder, 'audio.m4a') }, 600_000)
    rmSync(join(folder, '.raw'), { recursive: true, force: true })
    meta.hasAudio = true
    writeMeta(folder, meta)
    db().indexMeeting(meta, final.segments)
    broadcast('meetings:changed', meta.id)
  } catch (err) {
    meta.status = 'error'
    meta.error = String((err as Error).message)
    writeMeta(folder, meta)
  }
}

/** A finished meeting whose audio was never encoded (e.g. the app quit right at the end). */
async function encodeLeftover(folder: string, meta: MeetingMeta): Promise<void> {
  const streams = meta.mode === 'meeting' ? ['mic', 'system'] : ['mic']
  const raw = streams.map((s) => join(folder, '.raw', `${s}.pcm`))
  if (existsSync(join(folder, 'audio.m4a'))) {
    if (existsSync(join(folder, '.raw'))) rmSync(join(folder, '.raw'), { recursive: true, force: true }) // already encoded
    return
  }
  if (!raw.every((p) => existsSync(p) && statSync(p).size > 0)) return
  try {
    await helper.request('encode', { inputs: raw, output: join(folder, 'audio.m4a') }, 600_000)
    rmSync(join(folder, '.raw'), { recursive: true, force: true })
    meta.hasAudio = true
    writeMeta(folder, meta)
    broadcast('meetings:changed', meta.id)
  } catch (err) {
    console.error('leftover encode failed', folder, err)
  }
}
