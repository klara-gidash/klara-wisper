import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthItem, HealthReport, Permissions } from '@shared/types'
import { audio } from './audio'
import * as claude from './claude'
import { engine } from './engine'
import { googleState } from './googleCalendar'
import { helper } from './helper'
import { recorder } from './meetings/recorder'
import { dataDir, enginePython, projectRoot } from './paths'
import { canWrite, freeGB, machine, misplaced } from './preflight'
import { settings } from './settings'
import { missingModels, requiredModels, setup } from './setup'

/**
 * The health check: does everything a user needs actually work on this computer, end to end?
 * It runs at the end of the install wizard and from Settings. Each item is something the app
 * really does (the helper answers, the engine loads its model, a Hebrew sentence is transcribed,
 * Claude can start the connection), not just "the file is there".
 */

const ORDER: HealthItem['id'][] = ['app', 'helper', 'engine', 'models', 'transcribe', 'speakers', 'microphone', 'permissions', 'calendar', 'claude', 'storage']
/** A 9-second Hebrew sentence shipped with the app ("…התוכנית…המשימות…"). */
const SAMPLE_SECONDS = 9
const SAMPLE_WORDS = ['התוכנית', 'משימות', 'היום', 'צוות']

function samplePath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'health-he.wav') : join(projectRoot, 'resources', 'health-he.wav')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitUntil(test: () => boolean, timeoutMs: number, stepMs = 500): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (test()) return true
    await sleep(stepMs)
  }
  return test()
}

/** What an engine that does not start is usually missing, from what it wrote before it stopped. */
function engineFailure(text: string): { code: string; detail?: string } {
  if (/Visual C\+\+|DLL load failed|vcruntime|msvcp140|VCRUNTIME/i.test(text)) return { code: 'vcRuntime' }
  if (/pinned hash|not downloaded/i.test(text)) return { code: 'badModel' }
  if (/out of memory|MemoryError|bad_alloc|unable to allocate|Insufficient Memory/i.test(text)) return { code: 'memory' }
  if (/ModuleNotFoundError|ImportError|No module named/i.test(text)) return { code: 'brokenInstall' }
  const last = text.trim().split('\n').filter(Boolean).pop()
  return { code: 'failed', detail: last?.slice(0, 300) }
}

/**
 * Starts the MCP server exactly as Claude does and asks it to introduce itself.
 * Resolves with an error text, or null when it answered.
 */
export function mcpSelfTest(timeoutMs = 45_000): Promise<string | null> {
  return new Promise((resolve) => {
    const python = enginePython()
    if (!existsSync(python)) return resolve('engine not installed')
    const { command, args } = claude.mcpEntry()
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    let done = false
    const finish = (result: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.kill()
      resolve(result)
    }
    const timer = setTimeout(() => finish(`no answer after ${Math.round(timeoutMs / 1000)} s`), timeoutMs)
    proc.stdout.on('data', (d) => {
      out += String(d)
      for (const line of out.split('\n')) {
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1 && msg.result?.serverInfo) return finish(null)
          if (msg.id === 1 && msg.error) return finish(String(msg.error.message ?? 'error'))
        } catch {
          /* a partial line */
        }
      }
    })
    proc.stderr.on('data', (d) => (err = (err + String(d)).slice(-600)))
    proc.on('error', (e) => finish(e.message))
    proc.on('exit', (code) => finish(`exited (${code}): ${err.trim().split('\n').pop() ?? ''}`))
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'klara-wisper-health-check', version: app.getVersion() } }
      }) + '\n'
    )
  })
}

let running: Promise<HealthReport> | null = null

/** Runs every check in order; `onUpdate` gets the list after each change (for a live screen). */
export function runHealth(onUpdate?: (items: HealthItem[]) => void): Promise<HealthReport> {
  if (running) return running
  running = doRun(onUpdate).finally(() => (running = null))
  return running
}

async function doRun(onUpdate?: (items: HealthItem[]) => void): Promise<HealthReport> {
  const mac = process.platform === 'darwin'
  const ids = ORDER.filter((id) => id !== 'permissions' || mac)
  const items: HealthItem[] = ids.map((id) => ({ id, status: 'running' as const }))
  const put = (id: HealthItem['id'], patch: Omit<HealthItem, 'id'>): void => {
    const i = items.findIndex((x) => x.id === id)
    if (i >= 0) items[i] = { id, ...patch }
    onUpdate?.(items.map((x) => ({ ...x })))
  }
  const check = async (id: HealthItem['id'], fn: () => Promise<Omit<HealthItem, 'id'>>): Promise<HealthItem['status']> => {
    if (!ids.includes(id)) return 'skip'
    const t0 = Date.now()
    let result: Omit<HealthItem, 'id'>
    try {
      result = await fn()
    } catch (err) {
      result = { status: 'fail', code: 'error', detail: (err as Error).message.slice(0, 300) }
    }
    put(id, { ms: Date.now() - t0, ...result })
    return result.status
  }
  onUpdate?.(items.map((x) => ({ ...x })))

  // 1. the app itself
  await check('app', async () => (misplaced() ? { status: 'fail', code: 'misplaced' } : { status: 'ok', detail: app.getVersion() }))

  // 2. the helper (microphone, call detection, the dictation key)
  let perms: Permissions | null = null
  await check('helper', async () => {
    if (!helper.ready && !(await waitUntil(() => helper.ready, 15_000))) return { status: 'fail', code: 'notRunning' }
    perms = await helper.request<Permissions>('permissions', {}, 8000)
    return { status: 'ok' }
  })

  // 3. the engine: installed, started, model loaded
  const engineStatus = await check('engine', async () => {
    setup.refresh()
    if (setup.state.running) return { status: 'skip', code: 'installing' }
    if (setup.state.engineMissing) return { status: 'fail', code: 'notInstalled' }
    if (missingModels().length) return { status: 'fail', code: 'notInstalled' }
    if (engine.status.state === 'missing') engine.restart() // installed since the engine last looked
    // Loading the model takes seconds on a Mac and up to a few minutes on a slow PC's first start.
    const ready = await waitUntil(() => engine.status.state === 'ready' && engine.connected, 240_000)
    if (!ready) return { status: 'fail', ...engineFailure(`${engine.lastErrors}\n${engine.status.error ?? ''}`) }
    return { status: 'ok', detail: engine.status.asr ?? undefined }
  })

  // 4. the models of this computer's plan
  await check('models', async () => {
    const missing = missingModels()
    return missing.length ? { status: setup.state.running ? 'skip' : 'fail', code: setup.state.running ? 'installing' : 'missing', detail: missing.join(', ') } : { status: 'ok' }
  })

  // 5. a real transcription of a Hebrew sentence
  await check('transcribe', async () => {
    if (engineStatus !== 'ok') return { status: 'skip', code: 'noEngine' }
    if (recorder.live) return { status: 'skip', code: 'recording' }
    const sample = samplePath()
    if (!existsSync(sample)) return { status: 'skip', code: 'noSample' }
    const id = `health_${Date.now().toString(36)}`
    const t0 = Date.now()
    engine.send({ type: 'transcribe.file', id, mode: 'inperson', rawPaths: { mic: sample }, diarize: [] })
    const final = await engine.waitFor<{ segments: { text: string }[] }>('session.final', id, 240_000)
    const seconds = (Date.now() - t0) / 1000
    const text = final.segments.map((s) => s.text).join(' ')
    const hebrew = (text.match(/[א-ת]/g) ?? []).length
    if (!SAMPLE_WORDS.some((w) => text.includes(w)) && hebrew < 12) return { status: 'fail', code: 'wrongText', detail: text.slice(0, 120) || '(empty)' }
    const detail = `${seconds.toFixed(1)} s`
    // Slower than three times real time: calls are still transcribed, but the text arrives late.
    return seconds > SAMPLE_SECONDS * 3 ? { status: 'warn', code: 'slow', detail } : { status: 'ok', detail }
  })

  // 5b. speaker recognition: the models this plan needs are loaded, and the user's own voice is known
  await check('speakers', async () => {
    if (engineStatus !== 'ok') return { status: 'skip', code: 'noEngine' }
    const need = requiredModels()
    // The speaker models load next to Whisper; give them a few seconds more if they are still loading.
    const loaded = (): boolean =>
      (!need.includes('ecapa') || !!engine.status.voiceprints) && (!need.includes('nemotron-diarization') || !!engine.status.diarization)
    if (!loaded()) await waitUntil(loaded, 60_000)
    if (need.includes('ecapa') && !engine.status.voiceprints) return { status: 'fail', code: 'voiceModel' }
    if (need.includes('nemotron-diarization') && !engine.status.diarization) return { status: 'fail', code: 'diarModel' }
    const me = Object.values(engine.status.voiceprintKeys ?? {}).some((v) => v.isMe)
    if (need.includes('ecapa') && !me) return { status: 'warn', code: 'notEnrolled' }
    return { status: 'ok', detail: need.includes('nemotron-diarization') ? undefined : 'voice' }
  })

  // 6. the microphone
  await check('microphone', async () => {
    if (!perms) return { status: 'skip', code: 'noHelper' }
    if (perms.microphone === 'denied') return { status: 'fail', code: 'denied' }
    await audio.refreshDevices().catch(() => undefined)
    if (audio.devices.length === 0) return { status: 'fail', code: 'noDevice' }
    if (perms.microphone !== 'granted' && mac) return { status: 'warn', code: 'notAsked' }
    return { status: 'ok', detail: audio.devices.find((d) => d.isDefault)?.name ?? audio.devices[0].name }
  })

  // 7. macOS permissions for dictation (the key and the paste)
  await check('permissions', async () => {
    if (!perms) return { status: 'skip', code: 'noHelper' }
    const missing = (['accessibility', 'inputMonitoring'] as const).filter((k) => perms![k] !== 'granted')
    return missing.length ? { status: 'warn', code: 'dictation', detail: missing.join(', ') } : { status: 'ok' }
  })

  // 8. the calendar: the Mac's Calendar app, or Google Calendar through its secret link (never fatal)
  await check('calendar', async () => {
    const google = googleState()
    if (google.linked && google.lastError) return { status: 'warn', code: 'googleError', detail: google.lastError.replace(/^gcal:/, '') }
    if (google.linked) return { status: 'ok', detail: google.calendar ?? 'Google Calendar' }
    const macPerms = perms as Permissions | null
    if (mac && macPerms?.calendar === 'granted') return { status: 'ok', detail: 'macOS Calendar' }
    return { status: 'warn', code: 'notConnected' }
  })

  // 9. Claude: connected, and the connection really starts
  await check('claude', async () => {
    if (!settings.value.claudeConnected) return { status: 'skip', code: 'off' }
    let s = await claude.status()
    if (!s.desktopInstalled && !s.codeCli) return { status: 'warn', code: 'notInstalled' }
    const connected = (x: typeof s): boolean => (!x.desktopInstalled || x.desktop) && (!x.codeCli || x.code)
    if (!connected(s)) {
      const auto = await claude.autoConnect()
      s = await claude.status()
      if (!connected(s)) return { status: 'fail', code: 'notConnected', detail: auto.error?.slice(0, 300) }
    }
    if (setup.state.engineMissing) return { status: 'skip', code: 'installing' }
    const problem = await mcpSelfTest()
    if (problem) return { status: 'fail', code: 'serverFailed', detail: problem.slice(0, 300) }
    return { status: 'ok', detail: [s.desktop && s.desktopInstalled ? 'Claude Desktop' : '', s.code ? 'Claude Code' : ''].filter(Boolean).join(' + ') }
  })

  // 10. room and write access for the recordings
  await check('storage', async () => {
    for (const dir of [dataDir, settings.value.folder]) {
      if (!canWrite(dir)) return { status: 'fail', code: 'noWrite', detail: dir }
    }
    const free = freeGB(settings.value.folder)
    if (free >= 0 && free < 2) return { status: 'warn', code: 'lowDisk', detail: `${free.toFixed(1)} GB` }
    return { status: 'ok', detail: free >= 0 ? `${Math.round(free)} GB` : undefined }
  })

  const report: HealthReport = { at: new Date().toISOString(), ok: !items.some((i) => i.status === 'fail'), items }
  try {
    writeFileSync(join(dataDir, 'health.json'), JSON.stringify(report, null, 2))
  } catch {
    /* the storage item already says so */
  }
  console.log(`health check: ${report.ok ? 'ok' : 'PROBLEMS'} ${items.map((i) => `${i.id}=${i.status}${i.code ? `(${i.code})` : ''}`).join(' ')}`)
  return report
}

/**
 * The report as plain text, to send to whoever helps with the install. It has the computer's
 * specs and the check results, and nothing from the recordings, the calendar or the settings.
 */
export async function healthText(report: HealthReport): Promise<string> {
  const m = await machine()
  const lines = [
    `Klara Wisper ${app.getVersion()} health check, ${report.at}`,
    `${m.platform} ${m.osVersion} · ${m.arch}${m.translated ? ' (translated)' : ''} · ${m.model ? `${m.model} · ` : ''}${m.chip} · ${m.cores} cores · ${m.ramGB} GB RAM · ${m.freeGB} GB free${m.gpu ? ` · ${m.gpu}` : ''}`,
    `plan: ${(settings.value.setupModels ?? ['default']).join(', ')} · language ${settings.value.asrLanguage}`,
    '',
    ...report.items.map((i) => `${i.status.toUpperCase().padEnd(5)} ${i.id}${i.code ? ` [${i.code}]` : ''}${i.detail ? `: ${i.detail}` : ''}${i.ms !== undefined ? ` (${i.ms} ms)` : ''}`)
  ]
  if (!report.ok && engine.lastErrors.trim()) lines.push('', 'engine:', engine.lastErrors.trim().slice(-800))
  if (setup.state.error) lines.push('', `setup: [${setup.state.errorKind ?? ''}] ${setup.state.error}`)
  return lines.join('\n')
}
