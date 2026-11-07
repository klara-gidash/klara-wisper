// Call controller: detector events in, recordings out. Every call must get its own recording.
// Run with `node --test test/calls.test.mts` (Node 24 runs TypeScript directly).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CallController, REJOIN_MS, type CallDeps } from '../src/main/meetings/calls.ts'
import type { Candidate } from '../src/main/meetings/detector.ts'

const cand = (key: string, source = key.split(':')[1] ?? 'other'): Candidate => ({ key, source: source as never, appName: source, micUids: [] })

/** A fake recorder + detector that records what happened. */
function setup(o: { autoRecord?: boolean; engineReady?: boolean; startFails?: Error } = {}) {
  let clock = 0
  const log: string[] = []
  const recordings: { id: string; key: string; stopped: boolean }[] = []
  const asked: string[] = []
  let current: { id: string; phase: string } | null = null
  let detectorKey: string | null = null
  let winding = false
  let stopping: Promise<void> | null = null
  const det = { claimed: [] as (string | null)[], released: [] as string[], dismissed: [] as string[], parked: [] as string[] }
  let pendingClick: (() => void) | null = null

  const deps: CallDeps = {
    recorder: {
      get live() {
        return current
      },
      get detectorKey() {
        return detectorKey
      },
      set detectorKey(k) {
        detectorKey = k
      },
      get winding() {
        return winding
      },
      get busyStopping() {
        return stopping !== null
      },
      idle: async () => {
        await stopping
      },
      start: async (c) => {
        if (o.startFails) throw o.startFails
        if (current) throw new Error('already recording')
        const id = `rec${recordings.length + 1}`
        recordings.push({ id, key: c.key, stopped: false })
        current = { id, phase: 'recording' }
        detectorKey = c.key
        winding = false
      },
      stop: () => {
        if (!current) return Promise.resolve()
        const r = recordings.find((x) => x.id === current!.id)!
        stopping = new Promise<void>((res) =>
          setTimeout(() => {
            r.stopped = true
            current = null
            detectorKey = null
            winding = false
            stopping = null
            res()
          }, 5)
        )
        return stopping
      },
      cancelAutoStop: () => {
        winding = false
      },
      requestAutoStop: () => {
        winding = true
      }
    },
    detector: {
      claim: (k) => void det.claimed.push(k),
      release: (k) => void det.released.push(k),
      dismiss: (k) => void det.dismissed.push(k),
      park: (k) => void det.parked.push(k)
    },
    engineReady: () => o.engineReady ?? true,
    autoRecord: () => o.autoRecord ?? true,
    needsConfirmation: (c) => c.key.includes(':unknown'),
    askToRecord: (c, record) => {
      asked.push(c.key)
      pendingClick = record
    },
    recording: () => undefined,
    micDenied: (err) => String(err).includes('denied'),
    explainMicDenied: () => undefined,
    log: (m) => void log.push(m),
    now: () => clock
  }
  const calls = new CallController(deps)
  return {
    calls,
    recordings,
    asked,
    det,
    log,
    advance: (ms: number) => void (clock += ms),
    click: async () => {
      pendingClick?.()
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

test('Zoom, then another Zoom call after the first ended: two recordings', async () => {
  const t = setup()
  await t.calls.onStart(cand('app:zoom'))
  t.advance(30 * 60_000)
  t.calls.onEnd('app:zoom') // the first call let go of the mic
  t.advance(60_000)
  await t.calls.onStart(cand('app:zoom')) // the next Zoom call
  assert.deepEqual(t.recordings.map((r) => [r.key, r.stopped]), [['app:zoom', true], ['app:zoom', false]])
})

test('Meet A then Meet B: two recordings', async () => {
  const t = setup()
  await t.calls.onStart(cand('web:meet:https://meet.google.com/aaa-bbbb-ccc', 'meet'))
  t.advance(20 * 60_000)
  t.calls.onEnd('web:meet:https://meet.google.com/aaa-bbbb-ccc')
  await t.calls.onStart(cand('web:meet:https://meet.google.com/ddd-eeee-fff', 'meet'))
  assert.equal(t.recordings.length, 2)
  assert.equal(t.recordings[0].stopped, true)
  assert.equal(t.recordings[1].key, 'web:meet:https://meet.google.com/ddd-eeee-fff')
})

test('Zoom then WhatsApp: two recordings', async () => {
  const t = setup()
  await t.calls.onStart(cand('app:zoom'))
  t.calls.onEnd('app:zoom')
  await t.calls.onStart(cand('app:whatsapp'))
  assert.deepEqual(t.recordings.map((r) => r.key), ['app:zoom', 'app:whatsapp'])
  assert.equal(t.recordings[0].stopped, true)
})

test('rejoining the same Meet within 2 minutes keeps one recording', async () => {
  const t = setup()
  const key = 'web:meet:https://meet.google.com/aaa-bbbb-ccc'
  await t.calls.onStart(cand(key, 'meet'))
  t.calls.onEnd(key)
  t.advance(REJOIN_MS - 10_000)
  await t.calls.onStart(cand(key, 'meet'))
  assert.equal(t.recordings.length, 1)
  assert.equal(t.recordings[0].stopped, false)
})

test('the same Meet after more than 2 minutes is a new recording', async () => {
  const t = setup()
  const key = 'web:meet:https://meet.google.com/aaa-bbbb-ccc'
  await t.calls.onStart(cand(key, 'meet'))
  t.calls.onEnd(key)
  t.advance(REJOIN_MS + 10_000)
  await t.calls.onStart(cand(key, 'meet'))
  assert.equal(t.recordings.length, 2)
})

test('a second call while the first still holds the mic waits (released for a retry)', async () => {
  const t = setup()
  await t.calls.onStart(cand('app:zoom'))
  await t.calls.onStart(cand('app:whatsapp'))
  assert.equal(t.recordings.length, 1)
  assert.deepEqual(t.det.released, ['app:whatsapp'])
})

test('a call that starts while the previous recording is being closed starts right after it', async () => {
  const t = setup()
  await t.calls.onStart(cand('app:zoom'))
  t.calls.onEnd('app:zoom')
  const p1 = t.calls.onStart(cand('app:teams'))
  await p1
  assert.deepEqual(t.recordings.map((r) => [r.key, r.stopped]), [['app:zoom', true], ['app:teams', false]])
  assert.equal(t.det.released.length, 0, 'no "already recording" retry')
})

test('a recording started by hand adopts the call', async () => {
  const t = setup()
  // simulate a manual recording: start without a detector key
  await t.calls.onStart(cand('app:zoom'))
  ;(t as any).calls.d.recorder.detectorKey = null
  await t.calls.onStart(cand('app:zoom'))
  assert.equal(t.recordings.length, 1)
})

test('an unknown app asks first, parks itself, and records when clicked', async () => {
  const t = setup()
  await t.calls.onStart(cand('app:unknown:com.example.softphone', 'other'))
  assert.deepEqual(t.asked, ['app:unknown:com.example.softphone'])
  assert.deepEqual(t.det.parked, ['app:unknown:com.example.softphone'])
  assert.equal(t.recordings.length, 0)
  await t.click()
  assert.equal(t.recordings.length, 1)
})

test('a known call records while an unknown one waits for a click', async () => {
  const t = setup()
  await t.calls.onStart(cand('web:unknown:Firefox', 'other'))
  await t.calls.onStart(cand('app:zoom'))
  assert.deepEqual(t.recordings.map((r) => r.key), ['app:zoom'])
})

test('engine not ready: released for a retry, nothing recorded', async () => {
  const t = setup({ engineReady: false })
  await t.calls.onStart(cand('app:zoom'))
  assert.equal(t.recordings.length, 0)
  assert.deepEqual(t.det.released, ['app:zoom'])
})

test('microphone denied: the call is dismissed', async () => {
  const t = setup({ startFails: new Error('microphone denied') })
  await t.calls.onStart(cand('app:zoom'))
  assert.deepEqual(t.det.dismissed, ['app:zoom'])
})

test('auto-record off: asks instead of recording', async () => {
  const t = setup({ autoRecord: false })
  await t.calls.onStart(cand('app:zoom'))
  assert.deepEqual(t.asked, ['app:zoom'])
  assert.equal(t.recordings.length, 0)
})

test('three calls in a row: three recordings, each closed before the next', async () => {
  const t = setup()
  for (const k of ['app:zoom', 'app:zoom', 'web:meet:https://meet.google.com/aaa-bbbb-ccc']) {
    await t.calls.onStart(cand(k))
    t.advance(10 * 60_000)
    t.calls.onEnd(k)
    t.advance(5 * 60_000)
  }
  assert.equal(t.recordings.length, 3)
  assert.deepEqual(t.recordings.map((r) => r.stopped), [true, true, false])
})
