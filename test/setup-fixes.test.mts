// Install/health helpers in src/shared/plan.ts: file-retry codes, engine code files, engine stderr
// filtering, the health check's main fix, and resuming an install at launch.
// Run with `node --test test/setup-fixes.test.mts` (Node runs the TypeScript directly; no Electron).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engineErrorLines, healthFix, isEngineCodeFile, resumeSetupAtLaunch, retryableFsError } from '../src/shared/plan.ts'

test('retryableFsError: busy/locked files only', () => {
  for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY']) assert.equal(retryableFsError({ code }), true)
  assert.equal(retryableFsError({ code: 'ENOENT' }), false)
  assert.equal(retryableFsError(new Error('x')), false)
  assert.equal(retryableFsError(null), false)
})

test('isEngineCodeFile: .py files, not caches, either separator', () => {
  assert.equal(isEngineCodeFile('klara_engine/server.py'), true)
  assert.equal(isEngineCodeFile('klara_engine\\asr\\whisper.py'), true)
  assert.equal(isEngineCodeFile('klara_engine/__pycache__/server.py'), false)
  assert.equal(isEngineCodeFile('klara_engine/data.json'), false)
})

test('engineErrorLines keeps tracebacks next to warnings', () => {
  const chunk = 'UserWarning: something\nTraceback (most recent call last):\nImportError: DLL load failed\n'
  assert.equal(engineErrorLines(chunk), 'Traceback (most recent call last):\nImportError: DLL load failed')
  assert.equal(engineErrorLines('FutureWarning: x\r\nLoading weights 100%\n'), '')
})

test('healthFix: repair only for a broken engine, retry for models/transcribe', () => {
  const f = (id: string, code?: string) => ({ id, status: 'fail', code })
  assert.equal(healthFix([f('models')]), 'retry')
  assert.equal(healthFix([f('transcribe'), { id: 'engine', status: 'ok' }]), 'retry')
  assert.equal(healthFix([f('engine'), f('models')]), 'repair')
  assert.equal(healthFix([f('speakers')]), 'repair')
  assert.equal(healthFix([f('claude', 'serverFailed')]), 'repair')
  assert.equal(healthFix([f('claude', 'other'), f('microphone')]), null)
  assert.equal(healthFix(null), null)
})

test('resumeSetupAtLaunch: onboarded, or a plan was chosen', () => {
  assert.equal(resumeSetupAtLaunch({ onboarded: true, setupModels: null }), true)
  assert.equal(resumeSetupAtLaunch({ onboarded: false, setupModels: ['ecapa'] }), true)
  assert.equal(resumeSetupAtLaunch({ onboarded: false, setupModels: [] }), false)
  assert.equal(resumeSetupAtLaunch({ onboarded: false, setupModels: null }), false)
})
