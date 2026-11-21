/**
 * Recordings made on the phone (the Worker's /rec/<token> page) are pulled into Klara Wisper and
 * become meetings: claim → download → decode → transcribe → upload the transcript → delete the
 * recording in the cloud. The recording is deleted only after the transcript is saved here and
 * uploaded; any failure leaves it in the cloud for the next try, so audio is never lost.
 *
 * No Electron here: everything comes in through `PullDeps` (fakes in test/recordings-pull.test.mts);
 * the wiring is src/main/phoneRecordings.ts.
 */

export interface CloudRecording {
  id: string
  title: string | null
  startedAt: string | null
  /** "phone" (a phone call on speaker) or "inperson" (a meeting in a room). */
  kind: 'phone' | 'inperson' | null
  /** "ready", or "processing" (claimed; the Worker lets a claim expire after 30 minutes). */
  status: 'ready' | 'processing'
  contentType: string | null
  durationSec: number | null
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

/**
 * GET /api/recordings?status=ready (and ?status=processing) → the recordings, oldest first; rows
 * still uploading, unknown or malformed are left out. Worker contract: {ok, recordings: [{id, title,
 * kind: "inperson" | "phone", mime, startedAt, durationSec, bytes, chunks, status}]}.
 */
export function parseRecordingList(body: unknown): CloudRecording[] {
  const b = body as Record<string, unknown> | unknown[] | null
  const rows: unknown[] = Array.isArray(b) ? b : Array.isArray(b?.recordings) ? (b.recordings as unknown[]) : Array.isArray(b?.items) ? (b.items as unknown[]) : []
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const out: CloudRecording[] = []
  for (const row of rows) {
    const r = row as Record<string, unknown>
    if (!r || typeof r !== 'object') continue
    const id = str(r.id)
    if (!id || !ID_RE.test(id)) continue
    const status = r.status === undefined ? 'ready' : r.status
    if (status !== 'ready' && status !== 'processing') continue
    const startedAt = str(r.startedAt) ?? str(r.started_at) ?? str(r.recordedAt) ?? str(r.createdAt) ?? str(r.created_at)
    const kind = r.kind === 'inperson' || r.kind === 'phone' ? r.kind : null
    const dur = Number(r.durationSec ?? r.duration_sec)
    out.push({
      id,
      title: str(r.title)?.slice(0, 200) ?? null,
      startedAt: startedAt && !Number.isNaN(Date.parse(startedAt)) ? new Date(startedAt).toISOString() : null,
      kind,
      status: r.status === 'processing' ? 'processing' : 'ready',
      contentType: str(r.contentType) ?? str(r.content_type) ?? str(r.mime) ?? null,
      durationSec: Number.isFinite(dur) && dur >= 0 ? dur : null
    })
  }
  return out.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
}

/** A transcript saved here whose recording isn't deleted in the cloud yet (kept across restarts). */
export interface PendingCleanup {
  recordingId: string
  meetingId: string
}

export interface PullDeps {
  /** Cloud sync on, engine ready, no call being recorded. */
  canRun(): boolean
  /** /api/health features, or null when the Worker didn't answer. */
  features(): Promise<string[] | null>
  list(): Promise<CloudRecording[]>
  /** False when the recording is already taken (another computer, or gone). */
  claim(id: string): Promise<boolean>
  download(id: string): Promise<{ bytes: Uint8Array; contentType: string | null }>
  /** Decodes to 16 kHz mono and writes a .wav; its path. */
  decode(rec: CloudRecording, bytes: Uint8Array, contentType: string | null): Promise<string>
  /** A meeting made earlier from this recording (e.g. the app quit before the cloud copy was deleted). */
  findLocal(recordingId: string): { meetingId: string; status: string } | null
  removeLocal(meetingId: string): void
  /** Makes the meeting and transcribes it; resolves with its id once the transcript is saved. */
  transcribe(rec: CloudRecording, wavPath: string): Promise<string>
  /** Uploads the meeting's transcript to the Worker (rejects when it didn't get there). */
  upload(meetingId: string): Promise<void>
  /** DELETE /api/recordings/:id (an already deleted recording counts as done). */
  remove(recordingId: string): Promise<void>
  cleanup(wavPath: string): void
  loadPending(): PendingCleanup[]
  savePending(list: PendingCleanup[]): void
  log(message: string): void
}

export interface PullReport {
  skipped?: 'busy' | 'notReady' | 'noFeature' | 'unreachable'
  imported: string[]
  cleaned: string[]
  failed: { id: string; error: string }[]
}

/** After this many failures in one run of the app, a recording waits for the next launch. */
export const MAX_FAILURES = 3

export class RecordingsPuller {
  private deps: PullDeps
  private busy = false
  failures = new Map<string, number>()
  /** The recording being worked on now, for the settings screen. */
  current: string | null = null

  constructor(deps: PullDeps) {
    this.deps = deps
  }

  get running(): boolean {
    return this.busy
  }

  async pullOnce(): Promise<PullReport> {
    const report: PullReport = { imported: [], cleaned: [], failed: [] }
    if (this.busy) return { ...report, skipped: 'busy' }
    if (!this.deps.canRun()) return { ...report, skipped: 'notReady' }
    this.busy = true
    try {
      let features: string[] | null
      try {
        features = await this.deps.features()
      } catch {
        features = null
      }
      if (features === null) return { ...report, skipped: 'unreachable' }
      if (!features.includes('recordings')) return { ...report, skipped: 'noFeature' } // an older Worker: nothing to do

      await this.finishPending(report)

      const list = await this.deps.list()
      for (const rec of list) {
        if (!this.deps.canRun()) break // a call started: the rest waits for the next round
        if ((this.failures.get(rec.id) ?? 0) >= MAX_FAILURES) continue
        await this.one(rec, report)
      }
      return report
    } finally {
      this.busy = false
      this.current = null
    }
  }

  /** Transcripts already saved here: upload them and delete their recordings in the cloud. */
  private async finishPending(report: PullReport): Promise<void> {
    for (const p of this.deps.loadPending()) {
      try {
        await this.deps.upload(p.meetingId)
        await this.deps.remove(p.recordingId)
        this.dropPending(p.recordingId)
        report.cleaned.push(p.recordingId)
      } catch (err) {
        this.deps.log(`phone recording ${p.recordingId}: cleanup will be tried again (${(err as Error).message})`)
      }
    }
  }

  private addPending(p: PendingCleanup): void {
    const list = this.deps.loadPending().filter((x) => x.recordingId !== p.recordingId)
    this.deps.savePending([...list, p])
  }

  private dropPending(recordingId: string): void {
    this.deps.savePending(this.deps.loadPending().filter((x) => x.recordingId !== recordingId))
  }

  private async one(rec: CloudRecording, report: PullReport): Promise<void> {
    const d = this.deps
    let wav: string | null = null
    this.current = rec.id
    try {
      const local = d.findLocal(rec.id)
      if (local?.status === 'done') {
        // Transcribed before (e.g. the app quit before deleting it): only the cloud side is left.
        this.addPending({ recordingId: rec.id, meetingId: local.meetingId })
        await d.upload(local.meetingId)
        await d.remove(rec.id)
        this.dropPending(rec.id)
        report.cleaned.push(rec.id)
        return
      }
      if (local && (local.status === 'processing' || local.status === 'recording')) return // still being transcribed
      if (local) d.removeLocal(local.meetingId) // a failed try: start over from the cloud copy

      if (!(await d.claim(rec.id))) return
      const file = await d.download(rec.id)
      if (!file.bytes.byteLength) throw new Error('empty recording')
      wav = await d.decode(rec, file.bytes, file.contentType ?? rec.contentType)
      const meetingId = await d.transcribe(rec, wav)
      // Saved here: from now on only the cloud side is left, and it is retried until it's done.
      this.addPending({ recordingId: rec.id, meetingId })
      d.cleanup(wav)
      wav = null
      report.imported.push(meetingId)
      await d.upload(meetingId)
      await d.remove(rec.id)
      this.dropPending(rec.id)
      this.failures.delete(rec.id)
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      this.failures.set(rec.id, (this.failures.get(rec.id) ?? 0) + 1)
      report.failed.push({ id: rec.id, error: message })
      d.log(`phone recording ${rec.id}: ${message} (kept in the cloud for the next try)`)
    } finally {
      if (wav) d.cleanup(wav)
    }
  }
}

/** "הקלטה מהטלפון 14:05" (or the English one), at the recording's time in Israel. */
export function phoneTitle(startedAt: string, lang: 'he' | 'en'): string {
  const time = new Date(startedAt).toLocaleTimeString(lang === 'he' ? 'he-IL' : 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return lang === 'he' ? `הקלטה מהטלפון ${time}` : `Phone recording ${time}`
}

/** A 16 kHz mono 16-bit WAV header for `dataBytes` bytes of samples. */
export function wavHeader(dataBytes: number, sampleRate = 16000): Uint8Array {
  const h = new DataView(new ArrayBuffer(44))
  const ascii = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  h.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  h.setUint32(16, 16, true) // PCM chunk size
  h.setUint16(20, 1, true) // PCM
  h.setUint16(22, 1, true) // mono
  h.setUint32(24, sampleRate, true)
  h.setUint32(28, sampleRate * 2, true) // bytes per second
  h.setUint16(32, 2, true) // block align
  h.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  h.setUint32(40, dataBytes, true)
  return new Uint8Array(h.buffer)
}
