// The install plan: which "version" each computer gets, and what stops an install (src/shared/plan.ts).
// Run with `node --test test/plan.test.mts` (Node runs the TypeScript directly; no Electron).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blocked, classifyFailure, neededGB, problems, recommend, tierOf, versionAtLeast, windowsBuild, type Machine
} from '../src/shared/plan.ts'

const mac = (over: Partial<Machine> = {}): Machine => ({
  platform: 'darwin', arch: 'arm64', translated: false, osVersion: '15.2', chip: 'Apple M2', cores: 8,
  ramGB: 16, freeGB: 120, model: 'MacBook Air', gpu: '', ...over
})
const pc = (over: Partial<Machine> = {}): Machine => ({
  platform: 'win32', arch: 'x64', translated: false, osVersion: '10.0.22631', chip: 'Intel(R) Core(TM) i7-1165G7', cores: 8,
  ramGB: 16, freeGB: 200, model: '', gpu: 'Intel Iris Xe', ...over
})
const ids = (m: Machine, plan = recommend(m)) => problems(m, plan).map((p) => `${p.id}:${p.severity}`)

test('tiers: Pro/Max/Ultra chips or 32 GB are strong Macs, 8 GB Macs are light', () => {
  assert.equal(tierOf(mac({ chip: 'Apple M3 Pro', ramGB: 18 })), 'strong')
  assert.equal(tierOf(mac({ chip: 'Apple M2', ramGB: 32 })), 'strong')
  assert.equal(tierOf(mac({ ramGB: 16 })), 'standard')
  assert.equal(tierOf(mac({ ramGB: 8 })), 'light')
  assert.equal(tierOf(pc({ cores: 16, ramGB: 32 })), 'strong')
  assert.equal(tierOf(pc()), 'standard')
  assert.equal(tierOf(pc({ cores: 4, ramGB: 8 })), 'light')
})

test('default plan on a Mac: the Hebrew turbo model and the speaker models', () => {
  const p = recommend(mac())
  assert.equal(p.asr, 'whisper-ivrit-turbo')
  assert.equal(p.language, 'he')
  assert.deepEqual(p.models, ['whisper-ivrit-turbo', 'nemotron-diarization', 'ecapa'])
  assert.equal(p.speakers, true)
  assert.equal(p.diarizeRemote, true)
  assert.equal(p.autoRecord, true)
  assert.equal(p.downloadGB, 2.5)
})

test('Hebrew + English picks OpenAI turbo; only a strong Mac gets large-v3 when asked', () => {
  assert.equal(recommend(mac(), { uses: ['calls'], language: 'auto' }).asr, 'whisper-large-v3-turbo')
  assert.equal(recommend(mac(), { uses: ['calls'], language: 'auto', accurate: true }).asr, 'whisper-large-v3-turbo')
  assert.equal(recommend(mac({ chip: 'Apple M4 Max' }), { uses: ['calls'], language: 'auto', accurate: true }).asr, 'whisper-large-v3')
  assert.equal(recommend(mac({ chip: 'Apple M4 Max' }), { uses: ['calls'], language: 'he', accurate: true }).asr, 'whisper-ivrit-turbo')
})

test('Windows always gets the CTranslate2 Hebrew model, whatever the language answer', () => {
  const p = recommend(pc(), { uses: ['dictation', 'calls'], language: 'auto' })
  assert.equal(p.asr, 'whisper-ivrit-turbo-ct2')
  assert.equal(p.language, 'he')
})

test('speaker recognition is on whatever the uses, unless the computer is light', () => {
  const p = recommend(mac(), { uses: ['dictation'], language: 'he' })
  assert.deepEqual(p.models, ['whisper-ivrit-turbo', 'nemotron-diarization', 'ecapa'])
  assert.equal(p.speakers, true)
  assert.equal(p.voiceprint, true)
  assert.equal(p.autoRecord, false) // dictation only: calls are not recorded by themselves
  assert.equal(recommend(pc(), { uses: ['calls'], language: 'he' }).diarizeRemote, true)
})

test('a light computer keeps the own-voice model, skips speaker separation unless in person', () => {
  for (const light of [mac({ ramGB: 8 }), pc({ cores: 4, ramGB: 8 })]) {
    const calls = recommend(light, { uses: ['dictation', 'calls'], language: 'he' })
    assert.equal(calls.speakers, false)
    assert.equal(calls.voiceprint, true)
    assert.ok(calls.models.includes('ecapa'))
    assert.ok(!calls.models.includes('nemotron-diarization'))
    assert.equal(calls.diarizeRemote, false)
    const inperson = recommend(light, { uses: ['inperson'], language: 'he' })
    assert.equal(inperson.speakers, true)
    assert.equal(inperson.diarizeRemote, false)
  }
})

test('every plan, on every kind of computer, recognises the user\'s own voice', () => {
  const machines = [
    mac(), mac({ ramGB: 8 }), mac({ chip: 'Apple M3 Max', ramGB: 64 }), pc(), pc({ cores: 4, ramGB: 8 }), pc({ cores: 16, ramGB: 32 }),
    pc({ arch: 'arm64', translated: true, chip: 'Snapdragon X Elite', ramGB: 16, cores: 12 })
  ]
  const uses = [['dictation'], ['calls'], ['inperson'], ['dictation', 'calls', 'inperson']] as const
  for (const m of machines) {
    for (const u of uses) {
      for (const language of ['he', 'auto'] as const) {
        const p = recommend(m, { uses: [...u], language })
        assert.ok(p.models.includes('ecapa'), `${m.chip} ${u}`)
        assert.equal(p.models[0], p.asr)
        assert.ok(p.downloadGB < 4.5 && p.downloadGB >= 2, `${p.downloadGB}`)
        if (m.platform === 'win32') assert.equal(p.asr, 'whisper-ivrit-turbo-ct2')
      }
    }
  }
})

test('no uses picked counts as all of them', () => {
  assert.deepEqual(recommend(mac(), { uses: [], language: 'he' }).models, recommend(mac()).models)
})

test('a good Mac and a good PC have no problems', () => {
  assert.deepEqual(ids(mac()), [])
  assert.deepEqual(ids(pc()), [])
})

test('Macs that cannot run it: Intel, Rosetta, old macOS', () => {
  assert.deepEqual(ids(mac({ arch: 'x64', chip: 'Intel(R) Core(TM) i5' })), ['intelMac:block'])
  assert.deepEqual(ids(mac({ translated: true })), ['translated:block'])
  assert.deepEqual(ids(mac({ osVersion: '14.3.1' })), ['oldMac:block'])
  assert.deepEqual(ids(mac({ osVersion: '14.4' })), [])
  assert.deepEqual(ids(mac({ osVersion: '26.1' })), [])
})

test('Windows: 32-bit and pre-1809 are blocked, old builds and ARM are warnings', () => {
  assert.deepEqual(ids(pc({ arch: 'ia32' })), ['win32bit:block'])
  assert.deepEqual(ids(pc({ osVersion: '6.3.9600' })), ['oldWindows:block'])
  assert.deepEqual(ids(pc({ osVersion: '10.0.17134' })), ['oldWindows:block'])
  assert.deepEqual(ids(pc({ osVersion: '10.0.18363' })), ['oldWindows:warn'])
  assert.deepEqual(ids(pc({ osVersion: '10.0.19045' })), [])
  assert.deepEqual(ids(pc({ arch: 'arm64', translated: true, chip: 'Snapdragon X Elite' })), ['winArm:warn'])
  assert.deepEqual(ids(pc({ cores: 2 })), ['slowCpu:warn'])
})

test('memory: under 6 GB is blocked, 6-7 GB is a warning, "8 GB" machines pass', () => {
  assert.deepEqual(ids(mac({ ramGB: 4 })), ['ramTooLow:block'])
  assert.deepEqual(ids(pc({ ramGB: 6 })), ['ramLow:warn'])
  assert.deepEqual(ids(mac({ ramGB: 8 })), [])
})

test('disk: blocked on Windows, only a warning on a Mac unless it is nearly full', () => {
  assert.deepEqual(ids(pc({ freeGB: 3 })), ['disk:block'])
  assert.deepEqual(ids(mac({ freeGB: 3 })), ['disk:warn'])
  assert.deepEqual(ids(mac({ freeGB: 1 })), ['disk:block'])
  assert.deepEqual(ids(pc({ freeGB: -1 })), []) // unknown: not held against the computer
  const p = problems(pc({ freeGB: 3 }), recommend(pc()))[0]
  assert.equal(p.values?.need, neededGB(recommend(pc()), { engine: false, models: [] }))
})

test('an update or repair needs only the room for what is missing', () => {
  const plan = recommend(pc())
  assert.equal(neededGB(plan, { engine: true, models: plan.models }), 0.5)
  assert.ok(neededGB(plan, { engine: true, models: ['nemotron-diarization', 'ecapa'] }) < neededGB(plan, { engine: false, models: [] }))
  assert.deepEqual(problems(pc({ freeGB: 1 }), plan, { engine: true, models: plan.models }).map((p) => p.id), [])
})

test('blocked() is true only with a blocking problem', () => {
  assert.equal(blocked(problems(pc({ cores: 2 }), recommend(pc()))), false)
  assert.equal(blocked(problems(pc({ arch: 'ia32' }), recommend(pc()))), true)
})

test('versions', () => {
  assert.equal(versionAtLeast('14.4', [14, 4]), true)
  assert.equal(versionAtLeast('14.10', [14, 4]), true)
  assert.equal(versionAtLeast('14', [14, 4]), false)
  assert.equal(versionAtLeast('15.0.1', [14, 4]), true)
  assert.equal(windowsBuild('10.0.22631'), 22631)
})

test('failures are told apart from their text', () => {
  assert.equal(classifyFailure('could not reach Hugging Face: HTTPSConnectionPool(...) Max retries exceeded'), 'network')
  assert.equal(classifyFailure('uv failed (2): error: Failed to fetch: `https://pypi.org/simple/torch/` | Caused by: error sending request'), 'network')
  assert.equal(classifyFailure("[Errno 11001] getaddrinfo failed"), 'network')
  assert.equal(classifyFailure('Read timed out. (read timeout=10)'), 'network')
  assert.equal(classifyFailure('Server error 503 Service Unavailable'), 'network')
  assert.equal(classifyFailure('[Errno 28] No space left on device'), 'disk')
  assert.equal(classifyFailure('not enough free disk space: 2.5 GB needed, 1.0 GB free'), 'disk')
  assert.equal(classifyFailure('failed to write: There is not enough space on the disk. (os error 112)'), 'disk')
  assert.equal(classifyFailure('invalid peer certificate: UnknownIssuer'), 'tls')
  assert.equal(classifyFailure('[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate'), 'tls')
  assert.equal(classifyFailure('Access is denied. (os error 5)'), 'blocked')
  assert.equal(classifyFailure('The process cannot access the file because it is being used by another process. (os error 32)'), 'blocked')
  assert.equal(classifyFailure('model file ecapa/hyperparams.yaml does not match its pinned hash'), 'unknown')
  assert.equal(classifyFailure('uv failed (1): torch-2.8.0 has 1500 files'), 'unknown')
})
