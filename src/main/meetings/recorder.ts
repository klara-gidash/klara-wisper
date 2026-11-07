import { shell } from 'electron'
import { EventEmitter } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { CalendarEvent, LiveSession, MeetingMeta, MeetingSource, RecordingMode, Segment, SpeakerInfo, Stream } from '@shared/types'
import { SOURCE_LABEL } from '@shared/types'
import { audio } from '../audio'
import { matchEvent } from '../calendar'
import { engine } from '../engine'
import { helper } from '../helper'
import { settings } from '../settings'
import { createMeetingFolder, writeMeeting, writeMeta } from '../storage/files'
import { finalizer, type FinalizeJob } from './finalize'
import { broadcast, showLive } from '../windows'

export interface StartOptions {
  mode: RecordingMode
  source: MeetingSource
  title?: string
  appName?: string
  url?: string
  micUids?: string[]
  detectorKey?: string | null
}

const BYTES_PER_SECOND = 32000

export function defaultTitle(source: MeetingSource, at: Date): string {
  const time = at.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
  return source === 'inperson' ? `פגישה ${time}` : `${SOURCE_LABEL[source]} ${time}`
}

/**
 * One recording at a time (online call or in-person meeting): writes raw audio to the meeting
 * folder, streams it to the engine, relays live lines to the windows, and at the end saves the
 * transcript, encodes audio.m4a and indexes everything.
 */
class Recorder extends EventEmitter {
  live: LiveSession | null = null
  detectorKey: string | null = null
  private meta: MeetingMeta | null = null
  private files = new Map<Stream, WriteStream>()
  private segments = new Map<string, Segment>()
  private speakers: Record<string, SpeakerInfo> = {}
  private renames: Record<string, string> = {}
  private bytes = new Map<Stream, number>()
  private stopping: Promise<void> | null = null
  private lastCallSound = 0
  private autoStopTimer: NodeJS.Timeout | null = null

  /** The call app already let go of the mic; we're only waiting for its audio to go quiet. */
  get winding(): boolean {
    return this.autoStopTimer !== null
  }
  private stats = { mic: { sum: 0, n: 0, max: -120 }, system: { sum: 0, n: 0, max: -120 } }
  private statsTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    audio.on('pcm', (stream: Stream, buf: Buffer, b64: string) => this.onPcm(stream, buf, b64))
    engine.on('segment', (m) => this.forMe(m) && this.onSegment(m.segment))
    engine.on('segment.remove', (m) => {
      if (!this.forMe(m)) return
      this.segments.delete(m.segmentId)
      broadcast('live:remove', m.segmentId)
      this.saveLiveSoon()
    })
    engine.on('speakers', (m) => {
      if (!this.forMe(m)) return
      this.speakers = { ...this.speakers, ...m.speakers }
      this.applyRenames()
      broadcast('live:speakers', this.speakers)
    })
    engine.on('speaking', (m) => this.forMe(m) && broadcast('live:speaking', { stream: m.stream, value: m.value }))
    engine.on('progress', (m) => this.forMe(m) && broadcast('live:progress', m))
  }

  private forMe(m: { id?: string }): boolean {
    return !!this.meta && m.id === this.meta.id
  }

  snapshot(): { live: LiveSession | null; segments: Segment[]; speakers: Record<string, SpeakerInfo> } {
    return { live: this.live, segments: [...this.segments.values()].sort((a, b) => a.start - b.start), speakers: this.speakers }
  }

  async start(opts: StartOptions): Promise<LiveSession> {
    if (this.live) throw new Error('already recording')
    if (engine.status.state !== 'ready') throw new Error('engine not ready')
    const startedAt = new Date()
    let event: CalendarEvent | null = null
    if (opts.mode === 'meeting' || opts.source === 'inperson') event = await matchEvent(startedAt, opts).catch(() => null)
    const title = opts.title || event?.title || defaultTitle(opts.source, startedAt)
    const folder = createMeetingFolder({ startedAt: startedAt.toISOString(), source: opts.source, title })
    const id = `m_${startedAt.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const streams: Stream[] = opts.mode === 'meeting' ? ['mic', 'system'] : ['mic']

    this.meta = {
      id, title, source: opts.source, mode: opts.mode, startedAt: startedAt.toISOString(), folder,
      status: 'recording', calendarEvent: event, attendees: event?.attendees ?? [], speakers: {},
      bookmarks: [], appName: opts.appName, url: opts.url
    }
    writeMeta(folder, this.meta)
    this.segments.clear()
    this.speakers = opts.mode === 'meeting' ? { me: { name: null, key: 'me', isMe: true } } : {}
    this.renames = {}
    this.bytes.clear()
    this.detectorKey = opts.detectorKey ?? null
    const rawPaths: Record<string, string> = {}
    for (const s of streams) {
      rawPaths[s] = join(folder, '.raw', `${s}.pcm`)
      this.files.set(s, createWriteStream(rawPaths[s]))
      this.bytes.set(s, 0)
    }
    engine.send({
      type: 'session.start', id, mode: opts.mode, streams,
      diarize: opts.mode === 'inperson' ? ['mic'] : settings.value.diarizeRemote ? ['system'] : [],
      vocabulary: settings.value.vocabulary, rawPaths
    })
    this.live = {
      id, mode: opts.mode, source: opts.source, title, startedAt: this.meta.startedAt,
      paused: false, phase: 'recording', mic: null, appName: opts.appName
    }
    try {
      await audio.acquireMic('meeting', opts.micUids ?? [])
    } catch (err) {
      await this.abort(err as Error, /microphone permission denied/i.test(String(err)))
      throw err
    }
    // The other side's audio must never cost us the call: if it can't start (e.g. macOS is still
    // showing its permission prompt), record the microphone now and keep trying in the background.
    if (opts.mode === 'meeting') void this.startSystemAudio(id)
    this.live.mic = audio.current?.name ?? null
    this.lastCallSound = Date.now()
    this.statsTimer = setInterval(() => this.logLevels(), 30_000)
    console.log(`recording ${id}: ${opts.mode} ${opts.source} "${title}" via ${opts.appName ?? 'manual'} · mic "${this.live.mic}" · detector ${this.detectorKey ?? '-'}`)
    this.publish()
    showLive()
    return this.live
  }

  private async startSystemAudio(id: string, attempt = 1): Promise<void> {
    const stillRecording = (): boolean => this.live?.id === id && this.live.phase === 'recording'
    try {
      await helper.request('startSystem', { bundlePrefixes: [] }, 30_000)
      if (!stillRecording()) {
        // The call ended while we waited; leave the tap alone if a newer call is using it.
        if (!this.live) void helper.request('stopSystem').catch(() => undefined)
        return
      }
      if (attempt > 1) console.log(`recording ${id}: call audio started (attempt ${attempt})`)
    } catch (err) {
      console.warn(`recording ${id}: call audio did not start (attempt ${attempt}): ${(err as Error).message}`)
      if (stillRecording() && attempt < 8) setTimeout(() => void this.startSystemAudio(id, attempt + 1), 10_000)
    }
  }

  private onPcm(stream: Stream, buf: Buffer, b64: string): void {
    if (!this.live || this.live.phase !== 'recording') return
    const file = this.files.get(stream)
    if (!file) return
    const data = this.live.paused ? Buffer.alloc(buf.length) : buf
    const db = audio.levels[stream] ?? -120
    const st = this.stats[stream]
    st.sum += db
    st.n++
    st.max = Math.max(st.max, db)
    if (stream === 'system' && db > -55) this.lastCallSound = Date.now()
    file.write(data)
    this.bytes.set(stream, (this.bytes.get(stream) ?? 0) + data.length)
    engine.send({ type: 'audio', id: this.live.id, stream, pcm: this.live.paused ? data.toString('base64') : b64 })
  }

  private maxLag = 0

  private onSegment(seg: Segment): void {
    this.segments.set(seg.id, seg)
    const lag = (seg as Segment & { lag?: number }).lag
    if (typeof lag === 'number') this.maxLag = Math.max(this.maxLag, lag)
    broadcast('live:segment', seg)
    this.saveLiveSoon()
  }

  private liveTimer: NodeJS.Timeout | null = null

  /**
   * Keeps the meeting folder's transcript up to date while the call is still going, so Claude
   * (through the Klara Wisper connection) can answer questions about the call in progress.
   */
  private saveLiveSoon(): void {
    if (this.liveTimer || !this.meta) return
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null
      if (!this.meta || !this.live || this.live.phase === 'done') return
      try {
        const segments = [...this.segments.values()].sort((a, b) => a.start - b.start)
        writeMeeting(this.meta.folder, { ...this.meta, speakers: this.speakers, status: 'recording' }, segments)
      } catch (err) {
        console.warn('live transcript save failed', String(err))
      }
    }, 3000)
  }

  private logLevels(): void {
    if (!this.live) return
    const f = (k: Stream): string => {
      const st = this.stats[k]
      return st.n ? `${k} avg ${Math.round(st.sum / st.n)} max ${Math.round(st.max)} dB` : `${k} no audio`
    }
    console.log(`recording ${this.live.id} levels (30s): ${f('mic')} | ${this.live.mode === 'meeting' ? f('system') : ''} | text behind live: up to ${Math.round(this.maxLag)}s`)
    this.maxLag = 0
    this.stats = { mic: { sum: 0, n: 0, max: -120 }, system: { sum: 0, n: 0, max: -120 } }
  }

  /**
   * The call app let go of the microphone. That also happens when you mute yourself (Google Meet
   * releases the mic while muted), so keep recording while the other side can still be heard,
   * and stop only after a minute without any call audio.
   */
  requestAutoStop(reason: string): void {
    if (!this.live || this.live.phase !== 'recording' || this.autoStopTimer) return
    const quietMs = this.live.mode === 'meeting' ? 60_000 : 15_000
    console.log(`recording ${this.live.id}: ${reason}; waiting for the call audio to go quiet`)
    this.autoStopTimer = setInterval(() => {
      if (!this.live || this.live.phase !== 'recording') return this.cancelAutoStop()
      if (Date.now() - this.lastCallSound >= quietMs) {
        console.log(`recording ${this.live.id}: auto-stop, no call audio for ${quietMs / 1000}s`)
        this.cancelAutoStop()
        void this.stop()
      }
    }, 5000)
  }

  cancelAutoStop(reason?: string): void {
    if (!this.autoStopTimer) return
    clearInterval(this.autoStopTimer)
    this.autoStopTimer = null
    if (reason && this.live) console.log(`recording ${this.live.id}: keeps going (${reason})`)
  }

  setPaused(paused: boolean): void {
    if (!this.live) return
    this.live.paused = paused
    this.publish()
  }

  bookmark(): number | null {
    if (!this.live || !this.meta) return null
    const t = (this.bytes.get('mic') ?? 0) / BYTES_PER_SECOND
    this.meta.bookmarks = [...(this.meta.bookmarks ?? []), Math.round(t)]
    broadcast('live:bookmark', t)
    return t
  }

  rename(title: string): void {
    if (!this.meta || !this.live) return
    this.meta.title = title
    this.meta.titleSource = 'user' // the calendar and Claude keep their hands off a name the user typed
    this.live.title = title
    this.publish()
  }

  renameSpeaker(label: string, name: string): void {
    this.renames[label] = name
    this.applyRenames()
    broadcast('live:speakers', this.speakers)
  }

  private applyRenames(): void {
    for (const [label, name] of Object.entries(this.renames)) {
      this.speakers[label] = { ...(this.speakers[label] ?? { isMe: false }), name }
    }
  }

  private publish(): void {
    broadcast('live:state', this.live)
    this.emit('state', this.live)
  }

  /** A recording is being closed right now (a second or two: mic released, files closed). */
  get busyStopping(): boolean {
    return this.stopping !== null
  }

  /** Resolves once a recording being closed has handed off to the finalizer. */
  async idle(): Promise<void> {
    await this.stopping?.catch(() => undefined)
  }

  stop(): Promise<void> {
    if (!this.live) return Promise.resolve()
    if (!this.stopping) this.stopping = this.finish().finally(() => (this.stopping = null))
    return this.stopping
  }

  private async closeFiles(): Promise<void> {
    await Promise.all([...this.files.values()].map((f) => new Promise<void>((r) => f.end(() => r()))))
    this.files.clear()
  }

  private async abort(err: Error, discard = false): Promise<void> {
    await audio.releaseMic('meeting')
    await helper.request('stopSystem').catch(() => undefined)
    await this.closeFiles()
    if (this.meta && discard) {
      engine.send({ type: 'session.cancel', id: this.meta.id })
      await shell.trashItem(this.meta.folder).catch(() => undefined)
    } else if (this.meta) {
      engine.send({ type: 'session.cancel', id: this.meta.id })
      this.meta.status = 'error'
      this.meta.error = err.message
      writeMeta(this.meta.folder, this.meta)
    }
    this.live = null
    this.meta = null
    this.publish()
  }

  /**
   * End of a recording: stop capturing, save what we have, and hand the rest (complete transcript,
   * audio file, speakers) to the background finalizer. The recorder is free for the next call
   * as soon as this returns.
   */
  private async finish(): Promise<void> {
    const live = this.live!
    const meta = this.meta!
    this.cancelAutoStop()
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    if (this.liveTimer) clearTimeout(this.liveTimer)
    this.liveTimer = null
    this.logLevels()
    console.log(`recording ${meta.id}: stopping`)
    live.phase = 'processing'
    this.publish()
    await audio.releaseMic('meeting')
    if (live.mode === 'meeting') await helper.request('stopSystem').catch(() => undefined)
    await this.closeFiles()

    const duration = Math.max(...[...this.bytes.values()].map((b) => b / BYTES_PER_SECOND), 0)
    engine.send({ type: 'session.stop', id: meta.id })
    const job: FinalizeJob = {
      meta: { ...meta, endedAt: new Date().toISOString(), durationSec: Math.round(duration) },
      mode: live.mode,
      defaultTitle: defaultTitle(meta.source, new Date(meta.startedAt)),
      liveSegments: [...this.segments.values()].sort((a, b) => a.start - b.start),
      speakers: { ...this.speakers },
      renames: { ...this.renames },
      diarized: live.mode === 'inperson' || (live.mode === 'meeting' && settings.value.diarizeRemote),
      stoppedAt: Date.now()
    }
    try {
      // On disk right away, so nothing is lost even if the app quits before the final version.
      writeMeeting(meta.folder, { ...job.meta, speakers: job.speakers, status: 'processing' }, job.liveSegments)
    } catch (err) {
      console.warn('saving the live transcript failed', String(err))
    }
    this.live = null
    this.meta = null
    this.detectorKey = null
    this.segments.clear()
    this.speakers = {}
    this.renames = {}
    this.bytes.clear()
    this.publish()
    finalizer.enqueue(job)
  }
}

export const recorder = new Recorder()
