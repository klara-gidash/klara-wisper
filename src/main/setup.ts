import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SetupState } from '@shared/types'
import { settings } from './settings'
import {
  bundledEngineSource, dataDir, engineDir, enginePython, isWindows, managedEngineDir, managesEngine, modelsDir, uvPath
} from './paths'

/**
 * First-launch setup of an installed app, so it needs nothing but itself:
 *   1. the engine: Python 3.12 and the exact packages of engine/uv.lock, installed by the uv binary
 *      shipped in the app into <data folder>/engine (no admin rights, nothing outside that folder);
 *   2. the models (pinned revisions, SHA-256 checked) into <data folder>/models.
 * After an app update with a new lockfile the engine is synced again; new engine code alone is
 * just copied over.
 */

const PYTHON = '3.12.15'
/** What a new install downloads (OpenAI large-v3 / turbo only on request). */
export const DEFAULT_MODELS = [isWindows ? 'whisper-ivrit-turbo-ct2' : 'whisper-ivrit-turbo', 'nemotron-diarization', 'ecapa']

const root = managedEngineDir
const stampFile = join(root, 'installed.json')
const srcDir = join(root, 'src')

interface Stamp {
  lock: string
  app: string
}

function lockHash(dir: string): string {
  const h = createHash('sha256')
  for (const f of ['pyproject.toml', 'uv.lock']) h.update(readFileSync(join(dir, f)))
  return h.digest('hex')
}

function readStamp(): Stamp | null {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'))
  } catch {
    return null
  }
}

export const modelReady = (key: string): boolean => existsSync(join(modelsDir, key, '.complete'))

/** The Whisper model the engine should load: the one picked in Settings, once it is downloaded. */
export function asrChoice(): string | null {
  const key = settings.value.asrModel
  return key && modelReady(key) ? key : null
}
export const missingModels = (): string[] => DEFAULT_MODELS.filter((k) => !modelReady(k))

/** The engine's packages are installed and match the lockfile shipped in this app. */
export function engineInstalled(): boolean {
  if (!existsSync(enginePython())) return false
  if (!managesEngine()) return true
  const stamp = readStamp()
  try {
    return !!stamp && stamp.lock === lockHash(bundledEngineSource())
  } catch {
    return false
  }
}

function sitePackages(): string {
  if (isWindows) return join(root, '.venv', 'Lib', 'site-packages')
  const lib = join(root, '.venv', 'lib')
  const py = readdirSync(lib).find((d) => d.startsWith('python3'))
  if (!py) throw new Error('virtualenv has no site-packages')
  return join(lib, py, 'site-packages')
}

/**
 * Copies the engine code shipped in this app next to the virtualenv (only when it changed) and
 * points Python at it. The copy (not the app bundle) is what runs, so Python never writes into
 * the signed app, and Claude's MCP server keeps working while the app is being updated.
 */
export function syncEngineCode(): void {
  if (!managesEngine() || !existsSync(enginePython())) return
  const stamp = readStamp()
  const pth = join(sitePackages(), 'klara_engine.pth')
  if (stamp?.app === app.getVersion() && existsSync(join(srcDir, 'klara_engine')) && existsSync(pth)) return
  copySource()
  writeFileSync(pth, srcDir + '\n')
  if (stamp) writeFileSync(stampFile, JSON.stringify({ ...stamp, app: app.getVersion() }))
}

function copySource(): void {
  const from = bundledEngineSource()
  rmSync(srcDir, { recursive: true, force: true })
  mkdirSync(srcDir, { recursive: true })
  for (const f of ['pyproject.toml', 'uv.lock']) cpSync(join(from, f), join(srcDir, f))
  cpSync(join(from, 'klara_engine'), join(srcDir, 'klara_engine'), {
    recursive: true,
    filter: (p) => !p.includes('__pycache__')
  })
}

/** Runs a program; calls `onLine` for every output line; rejects with the tail of its output. */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const tail: string[] = []
    const take = (line: string): void => {
      tail.push(line)
      if (tail.length > 20) tail.shift()
      onLine?.(line)
    }
    createInterface({ input: proc.stdout }).on('line', take)
    createInterface({ input: proc.stderr }).on('line', take)
    proc.on('error', reject)
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.split(/[\\/]/).pop()} failed (${code}): ${tail.slice(-6).join(' | ')}`))))
  })
}

class Setup extends EventEmitter {
  state: SetupState = { needed: false, running: false, phase: 'idle', progress: 0 }
  private job: Promise<void> | null = null

  refresh(): SetupState {
    const engineOk = engineInstalled()
    const missing = missingModels()
    if (!this.state.running) {
      this.state = { ...this.state, needed: !engineOk || missing.length > 0, engineMissing: !engineOk, modelsMissing: missing }
    }
    return this.state
  }

  private set(patch: Partial<SetupState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }

  /** Installs whatever is missing. Safe to call again while it runs (returns the same job). */
  run(): Promise<void> {
    if (this.job) return this.job
    this.job = this.doRun()
      .then(() => this.set({ running: false, phase: 'done', progress: 1, needed: false, engineMissing: false, modelsMissing: [], error: undefined }))
      .catch((err: Error) => {
        console.error('setup failed', err)
        this.set({ running: false, phase: 'error', error: err.message })
        this.refresh()
      })
      .finally(() => {
        this.job = null
      })
    return this.job
  }

  private async doRun(): Promise<void> {
    this.set({ running: true, error: undefined, progress: 0 })
    if (!engineInstalled()) {
      if (!managesEngine()) throw new Error(`engine not installed at ${enginePython()}`)
      await this.installEngine()
    }
    syncEngineCode()
    const missing = missingModels()
    if (missing.length) await this.downloadModels(missing)
  }

  private async installEngine(): Promise<void> {
    const uv = uvPath()
    if (!existsSync(uv)) throw new Error(`uv missing from the app: ${uv}`)
    mkdirSync(root, { recursive: true })
    rmSync(stampFile, { force: true })
    copySource()
    const cache = join(root, 'uv-cache')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: join(root, 'python'),
      UV_CACHE_DIR: cache,
      UV_PROJECT_ENVIRONMENT: join(root, '.venv'),
      UV_PYTHON_PREFERENCE: 'only-managed', // never a Python already on the machine
      UV_NO_CONFIG: '1', // ignore any uv.toml of the user
      UV_PYTHON_DOWNLOADS: 'automatic'
    }
    // 1. Python
    this.set({ phase: 'python', progress: 0.01, detail: `Python ${PYTHON}` })
    await run(uv, ['python', 'install', PYTHON, '--no-bin', ...(isWindows ? ['--no-registry'] : [])], env)
    // 2. Packages, exactly as locked. Progress = packages unpacked into the cache / packages to install.
    const sync = ['sync', '--project', srcDir, '--locked', '--no-dev', '--no-install-project', '--python', PYTHON]
    let total = 90
    await run(uv, [...sync, '--dry-run'], env, (line) => {
      const m = /Would (?:download|install) (\d+) packages/.exec(line)
      if (m) total = Math.max(1, Number(m[1]))
    }).catch(() => undefined)
    this.set({ phase: 'packages', progress: 0.05, detail: undefined })
    const archive = join(cache, 'archive-v0')
    const timer = setInterval(() => {
      let n = 0
      try {
        n = readdirSync(archive).length
      } catch {
        /* not created yet */
      }
      this.set({ progress: 0.05 + 0.9 * Math.min(1, n / total), detail: `${Math.min(n, total)}/${total}` })
    }, 700)
    try {
      await run(uv, sync, env)
    } finally {
      clearInterval(timer)
    }
    writeFileSync(join(sitePackages(), 'klara_engine.pth'), srcDir + '\n')
    // Packages are cloned out of the cache (copy-on-write), so the cache is only a duplicate now.
    rmSync(cache, { recursive: true, force: true })
    writeFileSync(stampFile, JSON.stringify({ lock: lockHash(bundledEngineSource()), app: app.getVersion() } satisfies Stamp))
    this.set({ progress: 1 })
  }

  /** Downloads models picked later in Settings (e.g. a bigger Whisper on a strong Mac), with progress. */
  fetchModels(keys: string[]): Promise<void> {
    if (this.job) return this.job.then(() => this.fetchModels(keys))
    const todo = keys.filter((k) => !modelReady(k))
    if (!todo.length) return Promise.resolve()
    this.set({ running: true, error: undefined })
    const job = this.downloadModels(todo)
      .then(() => this.set({ running: false, phase: 'idle', progress: 1, models: undefined }))
      .catch((err: Error) => {
        this.set({ running: false, phase: 'error', error: err.message })
        throw err
      })
      .finally(() => {
        this.job = null
      })
    this.job = job.catch(() => undefined)
    return job
  }

  private downloadModels(keys: string[]): Promise<void> {
    this.set({ phase: 'models', progress: 0, detail: undefined, models: undefined })
    const sizes = new Map<string, number>()
    const done = new Map<string, number>()
    let models: NonNullable<SetupState['models']> = []
    const overall = (): number => {
      const total = [...sizes.values()].reduce((a, b) => a + b, 0)
      return total ? [...done.values()].reduce((a, b) => a + b, 0) / total : 0
    }
    return new Promise((resolve, reject) => {
      const proc = spawn(enginePython(), ['-m', 'klara_engine.models', 'fetch', ...keys], {
        cwd: engineDir(),
        env: { ...process.env, KLARA_DATA_DIR: dataDir, KLARA_MODELS_DIR: modelsDir, PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      let error = ''
      const stderr: string[] = []
      createInterface({ input: proc.stderr }).on('line', (l) => {
        stderr.push(l)
        if (stderr.length > 10) stderr.shift()
      })
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.event === 'plan') {
          models = msg.models.map((m: any) => ({ key: m.key, title: m.title, bytes: m.bytes, done: m.downloaded ? m.bytes : 0, state: m.downloaded ? 'done' : 'waiting' }))
          for (const m of models) if (m.state !== 'done') sizes.set(m.key, m.bytes)
        } else if (msg.event === 'progress') {
          done.set(msg.key, msg.done)
          models = models.map((m) => (m.key === msg.key ? { ...m, done: msg.done, state: 'downloading' } : m))
        } else if (msg.event === 'verifying' || msg.event === 'done') {
          models = models.map((m) => (m.key === msg.key ? { ...m, done: m.bytes, state: msg.event } : m))
        } else if (msg.event === 'error') {
          error = msg.message
        }
        this.set({ models, progress: overall() })
      })
      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(error || `model download failed (${code}): ${stderr.slice(-3).join(' | ')}`))
      })
    })
  }
}

export const setup = new Setup()
