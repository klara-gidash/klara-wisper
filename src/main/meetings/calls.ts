import type { Candidate } from './detector'

/** What the call controller needs from the rest of the app (fakes in test/calls.test.mts). */
export interface CallDeps {
  recorder: {
    readonly live: { id: string; phase: string } | null
    detectorKey: string | null
    readonly winding: boolean
    readonly busyStopping: boolean
    idle(): Promise<void>
    start(c: Candidate): Promise<unknown>
    stop(): Promise<void>
    cancelAutoStop(reason?: string): void
    requestAutoStop(reason: string): void
  }
  detector: {
    claim(key: string | null): void
    release(key: string): void
    dismiss(key: string): void
    park(key: string, ms?: number): void
  }
  engineReady(): boolean
  autoRecord(): boolean
  needsConfirmation(c: Candidate): boolean
  /** "Call in X, click to record": `record` starts the recording when clicked. */
  askToRecord(c: Candidate, record: () => void): void
  recording(c: Candidate): void
  micDenied(err: unknown): boolean
  explainMicDenied(): void
  log(msg: string): void
  now(): number
}

/** A dropped connection and rejoin of the same web meeting within this time continues the recording. */
export const REJOIN_MS = 2 * 60_000

const isWebMeeting = (key: string): boolean => key.startsWith('web:') && !key.includes(':unknown')

/**
 * Turns detector events into recordings. Every call gets its own recording:
 *  - the same call (same key) that never ended keeps going;
 *  - after the call app let go of the mic (detector 'end'), any new call closes that recording and
 *    starts a new one: Zoom then Zoom, Meet then Meet, Zoom then WhatsApp. The only exception is
 *    rejoining the same web meeting (same Meet code) within 2 minutes;
 *  - a recording started by hand adopts the call that shows up.
 * Closing a recording hands it to the finalizer (transcript saved at once, the rest in the
 * background), so the next call starts immediately and its predecessor is already readable in Claude.
 */
export class CallController {
  /** key → when the detector said that call let go of the mic. */
  private endedAt = new Map<string, number>()

  private d: CallDeps

  constructor(deps: CallDeps) {
    this.d = deps // a plain field: Node runs this file directly in tests (no parameter properties)
  }

  async onStart(cand: Candidate): Promise<void> {
    const { recorder: r, detector } = this.d
    this.d.log(`call detected: ${cand.key} (${cand.appName})`)
    // A recording is being closed right now: wait for it (a second or two), then start this one.
    if (r.busyStopping) await r.idle()

    const live = r.live
    if (live && live.phase === 'recording') {
      if (!r.detectorKey) {
        // Started by hand: this call is the one being recorded.
        r.cancelAutoStop(`adopted ${cand.key}`)
        r.detectorKey = cand.key
        detector.claim(cand.key)
        return
      }
      const sameKey = r.detectorKey === cand.key
      const ended = this.endedAt.get(r.detectorKey)
      const rejoin = sameKey && ended !== undefined && isWebMeeting(cand.key) && this.d.now() - ended <= REJOIN_MS
      if (sameKey && (ended === undefined || rejoin)) {
        r.cancelAutoStop(rejoin ? 'rejoined the same meeting' : 'the call is using the microphone again')
        this.endedAt.delete(cand.key)
        detector.claim(cand.key)
        return
      }
      if (!sameKey && ended === undefined && !r.winding) {
        // Another call while this one still holds the mic (two calls at once): keep recording this
        // one, and look at the other again in a moment.
        detector.release(cand.key)
        return
      }
      // The previous call is over (or this is a new call in the same app): its own recording.
      this.d.log(`recording ${live.id}: closed, a new call started (${cand.key})`)
      this.endedAt.delete(r.detectorKey)
      await r.stop()
      if (r.busyStopping) await r.idle()
    }

    if (!this.d.autoRecord() || this.d.needsConfirmation(cand)) {
      // Ask, and don't block other calls meanwhile (a known call that starts records by itself).
      detector.park(cand.key)
      this.d.askToRecord(cand, () => {
        detector.claim(cand.key)
        void this.begin(cand)
      })
      return
    }
    if (!this.d.engineReady()) {
      detector.release(cand.key) // the engine is still starting: try again shortly
      return
    }
    await this.begin(cand)
  }

  onEnd(key: string): void {
    this.d.log(`call released the microphone: ${key}`)
    this.endedAt.set(key, this.d.now())
    const r = this.d.recorder
    if (r.live && r.detectorKey === key) r.requestAutoStop('the call app released the microphone')
  }

  private async begin(cand: Candidate): Promise<void> {
    try {
      if (this.d.recorder.busyStopping) await this.d.recorder.idle()
      await this.d.recorder.start(cand)
      this.endedAt.delete(cand.key)
      this.d.recording(cand)
    } catch (err) {
      this.d.log(`auto-record failed: ${(err as Error)?.message ?? err}`)
      if (this.d.micDenied(err)) {
        this.d.detector.dismiss(cand.key)
        this.d.explainMicDenied()
      } else {
        this.d.detector.release(cand.key)
      }
    }
  }
}
