import { app, net, powerSaveBlocker } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { SetupState } from '@shared/types'
import { classifyFailure, isEngineCodeFile, MODEL_GB, retryableFsError, type FailureKind } from '@shared/plan'
import { settings } from './settings'
import {
  bundledEngineSource, dataDir, engineDir, enginePython, isWindows, managedEngineDir, managesEngine, modelsDir, uvPath
} from './paths'
import { freeGB, proxyEnv } from './preflight'
import { stopEngineProcesses } from './uninstall'

/**
 * First-launch setup of an installed app, so it needs nothing but itself:
 *   1. the engine: Python 3.12 and the exact packages of engine/uv.lock, installed by the uv binary
 *      shipped in the app into <data folder>/engine (no admin rights, nothing outside that folder);
 *   2. the models (pinned revisions, SHA-256 checked) into <data folder>/models.
 * After an app update with a new lockfile the engine is synced again; new engine code alone is
 * just copied over.
 *
 * It runs without anyone watching: a dropped connection is tried again by itself (the downloads
 * resume where they stopped), a half-installed engine is rebuilt once, a model whose files do not
 * match their checksum is downloaded again, and the computer is kept awake while it works.
 */

const PYTHON = '3.12.15'
/** What an install downloads when the wizard has not chosen (OpenAI large-v3 / turbo only on request). */
export const DEFAULT_MODELS = [isWindows ? 'whisper-ivrit-turbo-ct2' : 'whisper-ivrit-turbo', 'nemotron-diarization', 'ecapa']

/** Waits between automatic tries after a network error (about 16 minutes in all, then it asks). */
const RETRY_DELAYS_S = [5, 15, 30, 60, 120, 120, 300, 300]
const ENGINE_NEEDS_GB = 2.5 // unpacked packages + the download cache next to them

/** Microsoft's permanent link to the current Visual C++ runtime (torch and CTranslate2 need it on Windows). */
const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
const execFileP = promisify(execFile)

/** Every Python launch: UTF-8 everywhere (a Hebrew Windows profile folder breaks .pth loading otherwise). */
export const PY_UTF8 = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } as const

const root = managedEngineDir
const stampFile = join(root, 'installed.json')
const srcDir = join(root, 'src')

interface Stamp {
  lock: string
  app: string
  /** Hash of the engine code shipped in the app (pyproject, uv.lock, the .py files). */
  code?: string
}

function lockHash(dir: string): string {
  const h = createHash('sha256')
  for (const f of ['pyproject.toml', 'uv.lock']) h.update(readFileSync(join(dir, f)))
  return h.digest('hex')
}

/** Hash of the bundled engine: pyproject.toml, uv.lock and every .py file (sorted, path included). */
export function codeHash(dir: string): string {
  const h = createHash('sha256')
  const files: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name !== '__pycache__') walk(p)
      } else if (isEngineCodeFile(relative(dir, p))) files.push(p)
    }
  }
  for (const f of ['pyproject.toml', 'uv.lock']) files.push(join(dir, f))
  walk(join(dir, 'klara_engine'))
  for (const f of files.sort()) {
    h.update(relative(dir, f).replace(/\\/g, '/') + '\0')
    h.update(readFileSync(f))
  }
  return h.digest('hex')
}

/** Deletes a folder; Windows keeps files of a Python that just exited (or an antivirus scan) busy for a moment. */
export async function rmRetry(path: string, tries = 5): Promise<void> {
  for (let n = 1; ; n++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      return
    } catch (err) {
      if (n >= tries || !retryableFsError(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (n - 1)))
    }
  }
}

function readStamp(): Stamp | null {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'))
  } catch {
    return null
  }
}

export const modelReady = (key: string): boolean => existsSync(join(modelsDir, key, '.complete'))

/** The models this install needs: the wizard's plan (Settings.setupModels), else the default three. */
export function requiredModels(): string[] {
  const picked = (settings.value.setupModels ?? []).filter((k) => k in MODEL_GB)
  return picked.length ? picked : DEFAULT_MODELS
}

/** The Whisper model the engine should load: the one picked in Settings, once it is downloaded. */
export function asrChoice(): string | null {
  const key = settings.value.asrModel
  return key && modelReady(key) ? key : null
}
export const missingModels = (): string[] => requiredModels().filter((k) => !modelReady(k))

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
  let code = ''
  try {
    code = codeHash(bundledEngineSource())
  } catch (err) {
    console.warn('engine code hash failed', String(err))
  }
  if (stamp?.app === app.getVersion() && (!code || stamp.code === code) && existsSync(join(srcDir, 'klara_engine')) && existsSync(pth)) return
  copySource()
  writeFileSync(pth, srcDir + '\n')
  if (stamp) writeFileSync(stampFile, JSON.stringify({ ...stamp, app: app.getVersion(), ...(code ? { code } : {}) }))
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

/** An error whose kind is already known (so the text need not be parsed again). */
class SetupError extends Error {
  constructor(message: string, readonly kind: FailureKind) {
    super(message)
  }
}

const kindOf = (err: unknown): FailureKind => (err instanceof SetupError ? err.kind : classifyFailure(String((err as Error)?.message ?? err)))

/** Clears what the last failure left in the state. */
const noError = { error: undefined, errorKind: undefined, retryAt: undefined } as const

class Setup extends EventEmitter {
  state: SetupState = { needed: false, running: false, phase: 'idle', progress: 0 }
  private job: Promise<void> | null = null
  /** false while only the engine may be installed (the wizard has not settled the models yet). */
  private modelsAllowed = true
  private child: ChildProcess | null = null
  private aborted = false
  private wake: (() => void) | null = null
  /** A company proxy re-signs HTTPS: use the computer's own trusted certificates (uv and Python). */
  private systemCerts = false
  /** run() was called again while a job ran (e.g. the wizard's plan changed): check once more at the end. */
  private again = false
  /** Windows: the Visual C++ runtime was already offered in this run of the app (don't ask twice). */
  private vcAsked = false

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

  /**
   * Installs whatever is missing. Safe to call again while it runs (returns the same job).
   * `engineOnly`: Python and the packages, which every plan needs, while the wizard still asks
   * which models to get; a later plain run() carries on with the models.
   */
  run(opts: { engineOnly?: boolean } = {}): Promise<void> {
    if (!opts.engineOnly) this.modelsAllowed = true
    if (this.job) {
      if (!opts.engineOnly) this.again = true
      return this.job
    }
    this.again = false
    if (opts.engineOnly) this.modelsAllowed = false
    this.aborted = false
    const awake = powerSaveBlocker.start('prevent-app-suspension') // a sleeping computer drops the downloads
    this.job = this.doRun()
      .then((complete) => {
        if (complete) {
          this.set({ running: false, phase: 'done', progress: 1, needed: false, engineMissing: false, modelsMissing: [], ...noError })
        } else {
          this.set({ running: false, phase: 'idle', progress: 0, detail: undefined, ...noError })
          this.refresh()
          this.emit('state', this.state)
        }
      })
      .catch((err: Error) => {
        if (this.aborted) return void this.set({ running: false, phase: 'idle', ...noError })
        console.error('setup failed', err)
        this.set({ running: false, phase: 'error', error: err.message, errorKind: kindOf(err), retryAt: undefined })
        this.refresh()
      })
      .finally(() => {
        this.job = null
        if (powerSaveBlocker.isStarted(awake)) powerSaveBlocker.stop(awake)
        // The plan changed while this job ran (and it could not pick that up): one more pass.
        if (this.again && !this.aborted && this.state.phase !== 'error') {
          this.again = false
          if (this.refresh().needed) void this.run()
        }
      })
    return this.job
  }

  /** "Try now" while waiting to retry after a network error. */
  kick(): void {
    this.wake?.()
  }

  /** The app is quitting: stop the download (it resumes at the next launch). */
  abort(): void {
    this.aborted = true
    this.child?.kill()
    this.wake?.()
  }

  /**
   * Rebuilds the engine from nothing (and re-checks the models): for an install that looks
   * complete but does not start, e.g. after the home folder was moved or files were removed.
   */
  async repair(badModels: string[] = []): Promise<void> {
    if (this.job) await this.job.catch(() => undefined)
    // Shown as "installing" right away, so the health check waits for the result.
    this.set({ running: true, phase: 'python', progress: 0, detail: undefined, models: undefined, ...noError })
    try {
      if (managesEngine()) {
        rmSync(stampFile, { force: true })
        // Windows keeps the files of a Python that just exited locked for a moment: retry the delete.
        await rmRetry(join(root, '.venv'), 6)
      }
      for (const key of badModels.filter((k) => k in MODEL_GB)) {
        rmSync(join(modelsDir, key), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      }
    } catch (err) {
      console.error('repair failed', err)
      this.set({ running: false, phase: 'error', error: (err as Error).message, errorKind: kindOf(err) })
      this.refresh()
      return
    }
    this.vcAsked = false // a repair may offer the Visual C++ runtime again
    this.set({ running: false })
    this.refresh()
    return this.run()
  }

  /** Resolves true when everything is installed, false when it stopped after the engine on purpose. */
  private async doRun(): Promise<boolean> {
    this.set({ running: true, progress: 0, attempt: undefined, ...noError })
    if (isWindows && !this.vcAsked) {
      this.vcAsked = true
      await this.ensureVcRuntime()
    }
    if (!engineInstalled()) {
      if (!managesEngine()) throw new Error(`engine not installed at ${enginePython()}`)
      // Windows: an MCP server Claude Desktop started keeps the venv's DLLs open ("os error 32").
      if (isWindows && existsSync(join(root, '.venv'))) await stopEngineProcesses()
      await this.retrying(() => this.installEngine(), () => this.wipeVenv())
    }
    syncEngineCode()
    // The wizard's plan may change while models download (Back, other answers, Install again):
    // check what is missing again after each pass.
    for (let pass = 0; pass < 3 && this.modelsAllowed; pass++) {
      if (!missingModels().length) break
      await this.retrying(() => this.downloadModels(missingModels()), (err) => this.dropBadModel(err))
    }
    return missingModels().length === 0
  }

  /**
   * Runs a step; after a network error waits and tries again (the downloads resume), after any
   * other error calls `fix` once and tries again when it says it changed something.
   */
  private async retrying(step: () => Promise<void>, fix: (err: Error) => boolean | Promise<boolean>): Promise<void> {
    let fixed = false
    for (let n = 0; ; n++) {
      try {
        await step()
        this.set({ attempt: undefined, ...noError })
        return
      } catch (err) {
        if (this.aborted) throw err
        const kind = kindOf(err)
        const message = (err as Error).message
        if (kind === 'network' || kind === 'tls') {
          if (n >= RETRY_DELAYS_S.length) throw err
          if (kind === 'tls') {
            // A company proxy with its own certificate: try once with the computer's trusted
            // certificates; if that fails too, waiting won't help.
            if (this.systemCerts) throw err
            this.systemCerts = true
          }
          const wait = RETRY_DELAYS_S[n] * 1000
          console.warn(`setup: ${kind} problem, trying again in ${wait / 1000} s (${n + 1}/${RETRY_DELAYS_S.length}): ${message}`)
          this.set({ error: message, errorKind: kind, retryAt: Date.now() + wait, attempt: n + 1 })
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, wait)
            this.wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          this.wake = null
          if (this.aborted) throw err
          this.set({ retryAt: undefined })
          continue
        }
        if (kind === 'unknown' && !fixed && (await fix(err as Error))) {
          fixed = true
          console.warn(`setup: ${message}; repaired, trying once more`)
          continue
        }
        throw err
      }
    }
  }

  /**
   * Windows: PyTorch and CTranslate2 load Microsoft's Visual C++ runtime, which most PCs have but a
   * fresh Windows may not. When it is missing (or too old), download Microsoft's installer, check
   * that Microsoft signed it, and run it: Windows asks once for permission ("Yes"). Never fatal:
   * if it is refused, the health check names the missing part and links to it.
   */
  private async ensureVcRuntime(): Promise<void> {
    if (await vcRuntimeOk()) return
    this.set({ phase: 'python', progress: 0.01, detail: 'Microsoft Visual C++' })
    const exe = join(app.getPath('temp'), `klara-vc_redist-${process.pid}.exe`)
    try {
      const res = await net.fetch(VC_REDIST_URL, { signal: AbortSignal.timeout(180_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      writeFileSync(exe, Buffer.from(await res.arrayBuffer()))
      const ps = (command: string): Promise<{ stdout: string }> =>
        execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          timeout: 600_000, windowsHide: true, env: { ...process.env, KLARA_VC: exe }
        })
      const sig = (await ps('$s = Get-AuthenticodeSignature -LiteralPath $env:KLARA_VC; "$($s.Status)|$($s.SignerCertificate.Subject)"')).stdout.trim()
      if (!/^Valid\|.*O=Microsoft Corporation/i.test(sig)) throw new Error(`not signed by Microsoft: ${sig}`)
      const code = Number(
        (await ps("(Start-Process -FilePath $env:KLARA_VC -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru).ExitCode")).stdout.trim()
      )
      // 1638: a newer version is already there; 3010 / 1641: done, a restart finishes it.
      if (![0, 1638, 3010, 1641].includes(code)) throw new Error(`vc_redist exit code ${code}`)
      console.log(`Visual C++ runtime installed (exit code ${code})`)
    } catch (err) {
      console.warn(`Visual C++ runtime not installed: ${(err as Error).message}`)
    } finally {
      rmSync(exe, { force: true })
    }
  }

  /** A half-built virtualenv (the app was quit mid-install, a file was locked…): start it over. */
  private async wipeVenv(): Promise<boolean> {
    if (!existsSync(join(root, '.venv')) && !existsSync(join(root, 'uv-cache'))) return false
    if (isWindows) await stopEngineProcesses()
    await rmRetry(join(root, '.venv'))
    await rmRetry(join(root, 'uv-cache')).catch((err) => console.warn('uv cache not deleted', String(err)))
    return true
  }

  /** "model file <key>/<name> does not match its pinned hash": a damaged download; fetch that model again. */
  private dropBadModel(err: Error): boolean {
    const m = /model file ([\w.-]+)\/\S+ does not match/.exec(err.message)
    if (!m || !(m[1] in MODEL_GB)) return false
    rmSync(join(modelsDir, m[1]), { recursive: true, force: true })
    return true
  }

  private needRoom(gb: number): void {
    // macOS frees purgeable space when a download needs it, so only a nearly full disk is certain there.
    const free = freeGB(dataDir)
    const short = process.platform === 'darwin' ? free < Math.min(gb, 1) : free < gb
    if (free >= 0 && short) throw new SetupError(`not enough free disk space: ${gb.toFixed(1)} GB needed, ${free.toFixed(1)} GB free`, 'disk')
  }

  /** Runs a program; calls `onLine` for every output line; rejects with the tail of its output. */
  private exec(cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine?: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.aborted) return reject(new Error('setup stopped (the app is quitting)'))
      const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      this.child = proc
      const tail: string[] = []
      const take = (line: string): void => {
        tail.push(line)
        if (tail.length > 20) tail.shift()
        onLine?.(line)
      }
      createInterface({ input: proc.stdout }).on('line', take)
      createInterface({ input: proc.stderr }).on('line', take)
      proc.on('error', (err) => {
        this.child = null
        reject(err)
      })
      proc.on('exit', (code) => {
        this.child = null
        if (code === 0) resolve()
        else reject(new Error(`${cmd.split(/[\\/]/).pop()} failed (${code}): ${tail.slice(-6).join(' | ')}`))
      })
    })
  }

  private async installEngine(): Promise<void> {
    const uv = uvPath()
    if (!existsSync(uv)) throw new Error(`uv missing from the app: ${uv}`)
    // A fresh install needs the room; an update re-syncs a few changed packages.
    if (!existsSync(join(root, '.venv'))) this.needRoom(ENGINE_NEEDS_GB)
    mkdirSync(root, { recursive: true })
    rmSync(stampFile, { force: true })
    copySource()
    const cache = join(root, 'uv-cache')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(await proxyEnv()),
      UV_PYTHON_INSTALL_DIR: join(root, 'python'),
      UV_CACHE_DIR: cache,
      UV_PROJECT_ENVIRONMENT: join(root, '.venv'),
      UV_PYTHON_PREFERENCE: 'only-managed', // never a Python already on the machine
      UV_NO_CONFIG: '1', // ignore any uv.toml of the user
      UV_PYTHON_DOWNLOADS: 'automatic',
      ...PY_UTF8,
      UV_HTTP_TIMEOUT: '120', // slow connections: wait for a stalled download instead of failing after 30 s
      ...(this.systemCerts ? { UV_SYSTEM_CERTS: '1' } : {})
    }
    // 1. Python
    this.set({ phase: 'python', progress: 0.01, detail: `Python ${PYTHON}` })
    await this.exec(uv, ['python', 'install', PYTHON, '--no-bin', ...(isWindows ? ['--no-registry'] : [])], env)
    // 2. Packages, exactly as locked. Progress = packages unpacked into the cache / packages to install.
    const sync = ['sync', '--project', srcDir, '--locked', '--no-dev', '--no-install-project', '--python', PYTHON]
    let total = 90
    await this.exec(uv, [...sync, '--dry-run'], env, (line) => {
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
      await this.exec(uv, sync, env)
    } finally {
      clearInterval(timer)
    }
    writeFileSync(join(sitePackages(), 'klara_engine.pth'), srcDir + '\n')
    const from = bundledEngineSource()
    writeFileSync(stampFile, JSON.stringify({ lock: lockHash(from), app: app.getVersion(), code: codeHash(from) } satisfies Stamp))
    // Packages are cloned out of the cache (copy-on-write), so the cache is only a duplicate now.
    // The install is done: a cache that won't delete (a file still busy) is only wasted space.
    await rmRetry(cache).catch((err) => console.warn('uv cache not deleted', String(err)))
    this.set({ progress: 1 })
  }

  /** Downloads models picked later in Settings (e.g. a bigger Whisper on a strong Mac), with progress. */
  fetchModels(keys: string[]): Promise<void> {
    if (this.job) return this.job.then(() => this.fetchModels(keys))
    const todo = keys.filter((k) => !modelReady(k))
    if (!todo.length) return Promise.resolve()
    this.aborted = false
    this.set({ running: true, ...noError })
    const job = this.downloadModels(todo)
      .then(() => this.set({ running: false, phase: 'idle', progress: 1, models: undefined }))
      .catch((err: Error) => {
        this.set({ running: false, phase: 'error', error: err.message, errorKind: kindOf(err) })
        throw err
      })
      .finally(() => {
        this.job = null
      })
    this.job = job.catch(() => undefined)
    return job
  }

  private async downloadModels(keys: string[]): Promise<void> {
    if (!keys.length) return
    this.needRoom(keys.reduce((sum, k) => sum + (MODEL_GB[k] ?? 0), 0) + 0.3)
    // On a retry the progress so far stays on screen while it reconnects.
    if (this.state.phase !== 'models') this.set({ phase: 'models', progress: 0, detail: undefined, models: undefined })
    const sizes = new Map<string, number>()
    const done = new Map<string, number>()
    let models: NonNullable<SetupState['models']> = []
    const overall = (): number => {
      const total = [...sizes.values()].reduce((a, b) => a + b, 0)
      return total ? [...done.values()].reduce((a, b) => a + b, 0) / total : 0
    }
    const proxy = await proxyEnv()
    const certs = this.systemCerts ? await systemCaEnv() : {}
    return new Promise((resolve, reject) => {
      if (this.aborted) return reject(new Error('setup stopped (the app is quitting)'))
      const proc = spawn(enginePython(), ['-m', 'klara_engine.models', 'fetch', ...keys], {
        cwd: engineDir(),
        env: {
          ...process.env,
          ...proxy,
          ...certs,
          KLARA_DATA_DIR: dataDir,
          KLARA_MODELS_DIR: modelsDir,
          PYTHONUNBUFFERED: '1',
          ...PY_UTF8,
          TOKENIZERS_PARALLELISM: 'false',
          HF_HUB_DOWNLOAD_TIMEOUT: '60', // the default (10 s) gives up on slow connections
          HF_HUB_ETAG_TIMEOUT: '30'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.child = proc
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
        if (models.length) this.set({ models, progress: overall(), ...noError })
      })
      proc.on('error', (err) => {
        this.child = null
        reject(err)
      })
      proc.on('exit', (code) => {
        this.child = null
        if (code === 0) resolve()
        else reject(new Error(error || `model download failed (${code}): ${stderr.slice(-3).join(' | ')}`))
      })
    })
  }
}

/**
 * The computer's trusted certificates as one PEM file, for Python's downloads (huggingface_hub uses
 * httpx/requests with their own certificate list, which a company's HTTPS-inspecting proxy breaks).
 * IT departments add their proxy's certificate to the system store, so it is in here.
 */
async function systemCaEnv(): Promise<NodeJS.ProcessEnv> {
  const file = join(dataDir, 'system-ca.pem')
  try {
    let pem = ''
    if (isWindows) {
      await execFileP(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          "$c = Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root, Cert:\\LocalMachine\\CA, Cert:\\CurrentUser\\CA; " +
          "$out = foreach ($x in $c) { '-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String($x.RawData, 'InsertLineBreaks'); '-----END CERTIFICATE-----' }; " +
          "[IO.File]::WriteAllLines($env:KLARA_CA, [string[]]$out)"],
        { timeout: 60_000, windowsHide: true, env: { ...process.env, KLARA_CA: file } }
      )
      pem = readFileSync(file, 'utf8')
    } else {
      const keychains = [
        '/System/Library/Keychains/SystemRootCertificates.keychain',
        '/Library/Keychains/System.keychain',
        join(app.getPath('home'), 'Library', 'Keychains', 'login.keychain-db')
      ].filter((k) => existsSync(k))
      pem = (await execFileP('/usr/bin/security', ['find-certificate', '-a', '-p', ...keychains], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout
      writeFileSync(file, pem)
    }
    if (!pem.includes('BEGIN CERTIFICATE')) return {}
    return { SSL_CERT_FILE: file, REQUESTS_CA_BUNDLE: file, CURL_CA_BUNDLE: file }
  } catch (err) {
    console.warn(`could not export the system certificates: ${(err as Error).message}`)
    return {}
  }
}

/** Windows: the Visual C++ 2015–2022 runtime (x64) is installed, from Visual Studio 2022 or later (14.30+). */
async function vcRuntimeOk(): Promise<boolean> {
  for (const key of ['HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64']) {
    try {
      const { stdout } = await execFileP('reg', ['query', key], { timeout: 8000, windowsHide: true })
      const installed = /Installed\s+REG_DWORD\s+0x1\b/i.test(stdout)
      const minor = Number.parseInt(/Minor\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout)?.[1] ?? '0', 16)
      if (installed && minor >= 30) return true
    } catch {
      /* no such key */
    }
  }
  return false
}

export const setup = new Setup()
