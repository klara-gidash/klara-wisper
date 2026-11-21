import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { EngineStatus } from '@shared/types'
import { dataDir, engineDir, enginePython, modelsDir } from './paths'
import { asrChoice, missingModels, PY_UTF8, setup, syncEngineCode } from './setup'
import { engineErrorLines } from '@shared/plan'
import { settings } from './settings'

/**
 * The Python transcription engine (Whisper large-v3 on MLX, Silero VAD, Nemotron diarization,
 * voiceprints). Spawned with a random token (sent on stdin), reached over a localhost WebSocket.
 *
 * Re-emits every engine message by its `type` ('segment', 'session.final', 'dictation.result', …).
 */
export class Engine extends EventEmitter {
  private proc: ChildProcess | null = null
  private ws: WebSocket | null = null
  private queue: string[] = []
  private restarts = 0
  private stopping = false
  /** The end of what the engine last wrote to stderr (why it failed to start, a missing DLL…). */
  lastErrors = ''
  status: EngineStatus = { state: 'starting' }

  start(): void {
    const dir = engineDir()
    const python = enginePython(dir)
    setup.refresh()
    if (!existsSync(python) || setup.state.engineMissing) {
      this.setStatus({ state: 'missing', error: `engine not installed at ${dir}` })
      return
    }
    if (missingModels().length) {
      this.setStatus({ state: 'missing', error: `models not downloaded: ${missingModels().join(', ')}` })
      return
    }
    try {
      syncEngineCode()
    } catch (err) {
      console.error('engine code update failed', err)
    }
    this.stopping = false
    const token = randomBytes(16).toString('hex')
    const proc = spawn(python, ['-m', 'klara_engine.server'], {
      cwd: dir,
      env: {
        ...process.env,
        KLARA_DATA_DIR: dataDir,
        KLARA_MODELS_DIR: modelsDir,
        HF_HUB_OFFLINE: '1',
        TOKENIZERS_PARALLELISM: 'false',
        ...PY_UTF8, // Windows: read and write text as UTF-8 whatever the system's code page is
        ...(asrChoice() ? { KLARA_ASR_MODEL: asrChoice()! } : {}), // Settings > transcription model
        KLARA_ASR_LANGUAGE: settings.value.asrLanguage === 'auto' ? 'auto' : 'he'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.proc = proc
    proc.stdin!.write(token + '\n') // the token never appears in the environment
    this.setStatus({ state: 'loading' })
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.event === 'listening') this.connect(msg.port, token)
      } catch {
        /* ignore */
      }
    })
    proc.stderr!.on('data', (d) => {
      // Per line: a chunk with a warning may also carry an ImportError or DLL traceback.
      const s = engineErrorLines(String(d))
      if (!s) return
      console.warn(`[engine] ${s.trim()}`)
      this.lastErrors = (this.lastErrors + s).slice(-2000) // for the health check's report
    })
    proc.on('exit', (code) => {
      this.ws = null
      this.proc = null
      // Sessions die with the process: anyone waiting for a reply gives up now, not after a timeout.
      this.emit('exited', code)
      if (this.stopping) return
      console.error(`engine exited (${code})`)
      this.setStatus({ state: 'error', error: `engine exited (${code})` })
      if (this.restarts++ < 10) setTimeout(() => this.start(), 3000)
    })
  }

  stop(): void {
    this.stopping = true
    this.ws?.close()
    this.proc?.kill('SIGTERM')
  }

  /** Starts the engine (again), e.g. once setup has installed it and its models. */
  restart(): void {
    if (this.proc) {
      const old = this.proc
      old.once('exit', () => this.start())
      this.stop()
    } else {
      this.restarts = 0
      this.start()
    }
  }

  private connect(port: number, token: string): void {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
    ws.onopen = () => {
      this.ws = ws
      for (const m of this.queue.splice(0)) ws.send(m)
    }
    ws.onmessage = (ev) => {
      let msg: any
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.type === 'ready' || msg.type === 'loading') {
        this.restarts = 0
        this.setStatus({
          state: msg.type,
          asr: msg.asr,
          diarization: msg.diarization,
          voiceprints: msg.voiceprints,
          voiceprintKeys: msg.voiceprintKeys
        })
      }
      if (msg.type === 'error') {
        console.error(`[engine] ${msg.message}`)
        this.lastErrors = `${this.lastErrors}\n${msg.message}`.slice(-2000)
      }
      this.emit('message', msg)
      this.emit(msg.type, msg)
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      // The engine is still running (e.g. the Mac slept and the socket dropped): reconnect.
      if (!this.stopping && this.proc && this.proc.exitCode === null) {
        console.warn('engine connection closed, reconnecting')
        setTimeout(() => {
          if (!this.ws && !this.stopping && this.proc && this.proc.exitCode === null) this.connect(port, token)
        }, 1000)
      }
    }
    ws.onerror = () => undefined
  }

  /** The app is talking to the engine right now (the WebSocket is open). */
  get connected(): boolean {
    return this.ws !== null
  }

  private setStatus(s: EngineStatus): void {
    this.status = s
    this.emit('status', s)
  }

  send(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
    else if (msg.type !== 'audio') this.queue.push(data)
  }

  /**
   * Resolves with the first message of `type` for session `id`; gives up only when the engine has
   * sent nothing at all for that session for `idleMs` (a long call may legitimately take a while).
   */
  waitIdle<T = any>(type: string, id: string, idleMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let timer = setTimeout(fail, idleMs)
      function fail(): void {
        cleanup()
        reject(new Error(`no ${type} (engine idle ${Math.round(idleMs / 1000)}s)`))
      }
      const onMsg = (msg: any): void => {
        if (msg.id !== id) return
        if (msg.type === type) {
          cleanup()
          resolve(msg)
          return
        }
        clearTimeout(timer)
        timer = setTimeout(fail, idleMs)
      }
      const onExit = (): void => {
        cleanup()
        reject(new Error(`no ${type}: the engine stopped`))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('message', onMsg)
        this.off('exited', onExit)
      }
      this.on('message', onMsg)
      this.once('exited', onExit)
    })
  }

  /** Resolves with the first message of `type` for session `id`. */
  waitFor<T = any>(type: string, id: string, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const onMsg = (msg: any): void => {
        if (msg.id !== id) return
        cleanup()
        resolve(msg)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timeout waiting for ${type}`))
      }, timeoutMs)
      const onExit = (): void => {
        cleanup()
        reject(new Error(`no ${type}: the engine stopped`))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off(type, onMsg)
        this.off('exited', onExit)
      }
      this.on(type, onMsg)
      this.once('exited', onExit)
    })
  }
}

export const engine = new Engine()
