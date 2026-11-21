// Phone recordings pull (src/main/recordingsPull.ts): claim → download → decode → transcribe → upload → delete;
// any failure keeps the recording in the cloud. Run with `node --test test/recordings-pull.test.mts`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_FAILURES, MeetingGoneError, RecordingsPuller, parseRecordingList, phoneTitle, wavHeader, type PendingCleanup, type PullDeps } from '../src/main/recordingsPull.ts'

const rec = (id: string, startedAt = '2026-11-20T10:00:00Z') => ({ id, title: null, startedAt, kind: 'phone' as const, status: 'ready' as const, contentType: 'audio/webm', durationSec: 60 })

function setup(o: { features?: string[] | null; fail?: string; claim?: boolean; local?: { meetingId: string; status: string } | null; list?: ReturnType<typeof rec>[]; canRun?: () => boolean } = {}) {
  const log: string[] = []
  let pending: PendingCleanup[] = []
  const cloud = new Set((o.list ?? [rec('r1')]).map((r) => r.id))
  const step = (name: string) => {
    log.push(name)
    if (o.fail === name) throw new Error(`${name} failed`)
  }
  const deps: PullDeps = {
    canRun: o.canRun ?? (() => true),
    features: async () => (o.features === undefined ? ['meetings', 'recordings'] : o.features),
    list: async () => (o.list ?? [rec('r1')]).filter((r) => cloud.has(r.id)),
    claim: async (id) => (step(`claim ${id}`), o.claim ?? true),
    download: async (id) => (step(`download ${id}`), { bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/webm' }),
    decode: async (r) => (step(`decode ${r.id}`), `/tmp/${r.id}.wav`),
    findLocal: () => o.local ?? null,
    removeLocal: (id) => log.push(`removeLocal ${id}`),
    transcribe: async (r) => (step(`transcribe ${r.id}`), `m_${r.id}`),
    upload: async (id) => step(`upload ${id}`),
    remove: async (id) => {
      step(`delete ${id}`)
      cloud.delete(id)
    },
    cleanup: (p) => log.push(`cleanup ${p}`),
    loadPending: () => pending,
    savePending: (l) => (pending = l),
    log: () => undefined
  }
  return { p: new RecordingsPuller(deps), log, cloud, pending: () => pending }
}

test('happy path: claim → download → decode → transcribe → upload → delete', async () => {
  const s = setup()
  const r = await s.p.pullOnce()
  assert.deepEqual(r.imported, ['m_r1'])
  assert.deepEqual(s.log, ['claim r1', 'download r1', 'decode r1', 'transcribe r1', 'cleanup /tmp/r1.wav', 'upload m_r1', 'delete r1'])
  assert.equal(s.cloud.size, 0)
  assert.deepEqual(s.pending(), [])
})

for (const stage of ['download r1', 'decode r1', 'transcribe r1']) {
  test(`failure at ${stage.split(' ')[0]}: the recording stays in the cloud`, async () => {
    const s = setup({ fail: stage })
    const r = await s.p.pullOnce()
    assert.equal(r.failed.length, 1)
    assert.ok(s.cloud.has('r1'))
    assert.ok(!s.log.some((l) => l.startsWith('delete')))
    assert.deepEqual(s.pending(), [])
  })
}

test('upload fails after the transcript is saved: kept in the cloud, retried next round without transcribing again', async () => {
  const s = setup({ fail: 'upload m_r1' })
  await s.p.pullOnce()
  assert.ok(s.cloud.has('r1'))
  assert.deepEqual(s.pending(), [{ recordingId: 'r1', meetingId: 'm_r1' }])
  const s2Log = s.log.length
  // next round: upload works now
  ;(s as any).p.deps.upload = async (id: string) => s.log.push(`upload ${id}`)
  ;(s as any).p.deps.findLocal = () => ({ meetingId: 'm_r1', status: 'done' })
  await s.p.pullOnce()
  const later = s.log.slice(s2Log)
  assert.deepEqual(later, ['upload m_r1', 'delete r1'])
  assert.equal(s.cloud.size, 0)
  assert.deepEqual(s.pending(), [])
})

test('older Worker without "recordings": nothing happens', async () => {
  const s = setup({ features: ['meetings'] })
  assert.equal((await s.p.pullOnce()).skipped, 'noFeature')
  assert.deepEqual(s.log, [])
})

test('not while a call is recorded', async () => {
  const s = setup({ canRun: () => false })
  assert.equal((await s.p.pullOnce()).skipped, 'notReady')
  assert.deepEqual(s.log, [])
})

test('claimed elsewhere: skipped quietly', async () => {
  const s = setup({ claim: false })
  const r = await s.p.pullOnce()
  assert.deepEqual(s.log, ['claim r1'])
  assert.equal(r.failed.length, 0)
  assert.ok(s.cloud.has('r1'))
})

test('still transcribing locally: left alone; a failed local try is removed and redone', async () => {
  const a = setup({ local: { meetingId: 'm_old', status: 'processing' } })
  await a.p.pullOnce()
  assert.deepEqual(a.log, [])
  const b = setup({ local: { meetingId: 'm_old', status: 'error' } })
  await b.p.pullOnce()
  assert.equal(b.log[0], 'removeLocal m_old')
  assert.ok(b.log.includes('transcribe r1'))
})

test(`after ${MAX_FAILURES} failures a recording waits for the next launch`, async () => {
  const s = setup({ fail: 'decode r1' })
  for (let i = 0; i < MAX_FAILURES + 2; i++) await s.p.pullOnce()
  assert.equal(s.log.filter((l) => l === 'decode r1').length, MAX_FAILURES)
})

test('parseRecordingList: the Worker contract, oldest first, bad rows dropped', () => {
  const l = parseRecordingList({ ok: true, recordings: [
    { id: 'b', title: 'x', kind: 'inperson', mime: 'audio/mp4', startedAt: '2026-11-20T11:00:00Z', durationSec: 5, status: 'ready' },
    { id: 'a', title: null, kind: 'phone', mime: 'audio/webm', startedAt: '2026-11-20T10:00:00Z', status: 'processing' },
    { id: 'c', status: 'recording' },
    { id: 'bad id!' }
  ] })
  assert.deepEqual(l.map((r) => r.id), ['a', 'b'])
  assert.equal(l[1].contentType, 'audio/mp4')
  assert.equal(l[1].kind, 'inperson')
})

test('the meeting was deleted here before the cloud copy was cleaned up: the recording is deleted too, not transcribed again', async () => {
  const s = setup({ fail: 'upload m_r1' })
  await s.p.pullOnce()
  assert.deepEqual(s.pending(), [{ recordingId: 'r1', meetingId: 'm_r1' }])
  // The user deletes the meeting; uploadNow now rejects with MeetingGoneError.
  ;(s as any).p.deps.upload = async (id: string) => {
    s.log.push(`upload ${id}`)
    throw new MeetingGoneError(id)
  }
  const r = await s.p.pullOnce()
  assert.deepEqual(r.cleaned, ['r1'])
  assert.equal(s.cloud.size, 0)
  assert.deepEqual(s.pending(), [])
  assert.equal(s.log.filter((l) => l === 'transcribe r1').length, 1)
})

test('an upload that fails for another reason (meeting not finished, 401) keeps the recording', async () => {
  const s = setup()
  ;(s as any).p.deps.upload = async () => {
    throw new Error('meeting m_r1 is not finished yet (processing)')
  }
  await s.p.pullOnce()
  assert.ok(s.cloud.has('r1'))
  assert.deepEqual(s.pending(), [{ recordingId: 'r1', meetingId: 'm_r1' }])
})

test('a try that fails before the transcript is saved hands the claim back; one that fails after it does not', async () => {
  for (const stage of ['download r1', 'decode r1', 'transcribe r1']) {
    const s = setup({ fail: stage })
    const released: string[] = []
    ;(s as any).p.deps.release = async (id: string) => void released.push(id)
    await s.p.pullOnce()
    assert.deepEqual(released, ['r1'], stage)
  }
  const s = setup({ fail: 'upload m_r1' })
  const released: string[] = []
  ;(s as any).p.deps.release = async (id: string) => void released.push(id)
  await s.p.pullOnce()
  assert.deepEqual(released, [], 'saved here: kept claimed, finished from the pending list')
  // A release that fails itself changes nothing else.
  const s2 = setup({ fail: 'decode r1' })
  ;(s2 as any).p.deps.release = async () => {
    throw new Error('offline')
  }
  const r = await s2.p.pullOnce()
  assert.equal(r.failed[0].error, 'decode r1 failed')
})

test('phoneTitle is in Israel time whatever the computer time zone', () => {
  assert.equal(phoneTitle('2026-11-20T10:05:00Z', 'en'), 'Phone recording 12:05')
  assert.equal(phoneTitle('2026-07-20T10:05:00Z', 'he'), 'הקלטה מהטלפון 13:05')
})

test('wavHeader: 16 kHz mono 16-bit', () => {
  const h = new DataView(wavHeader(32000).buffer)
  assert.equal(h.getUint32(24, true), 16000)
  assert.equal(h.getUint16(22, true), 1)
  assert.equal(h.getUint32(40, true), 32000)
})
