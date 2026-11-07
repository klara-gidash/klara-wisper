import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { helperPath } from './paths'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/**
 * The native Swift helper (microphone, system audio tap, meeting detection, Fn key, paste,
 * calendar). Talks newline-delimited JSON over stdio; restarts itself if it crashes.
 *
 * Events: 'hello', 'audio' {stream, pcm(base64), db}, 'micUsers', 'devices', 'hotkey', 'key',
 * 'systemRestarted', 'error', 'exit'.
 */
export class Helper extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private restarts = 0
  private stopping = false
  ready = false

  start(): void {
    const bin = helperPath()
    if (!existsSync(bin)) {
      this.emit('error', new Error(`helper not built: ${bin} (run npm run build:helper)`))
      return
    }
    this.stopping = false
    const proc = spawn(bin, ['serve'], { stdio: 'pipe', windowsHide: true })
    this.proc = proc
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line))
    proc.stderr.on('data', (d) => process.stderr.write(`[helper] ${d}`))
    proc.on('exit', (code) => {
      this.ready = false
      this.proc = null
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('helper exited'))
      }
      this.pending.clear()
      this.emit('exit', code)
      if (!this.stopping && this.restarts < 20) {
        this.restarts++
        setTimeout(() => this.start(), Math.min(1000 * this.restarts, 10_000))
      }
    })
  }

  stop(): void {
    this.stopping = true
    this.proc?.kill('SIGTERM')
  }

  private onLine(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.reply !== undefined) {
      const p = this.pending.get(msg.reply)
      if (!p) return
      this.pending.delete(msg.reply)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg)
      else p.reject(new Error(msg.error ?? 'helper error'))
      return
    }
    if (msg.event === 'hello') {
      this.ready = true
      this.restarts = 0
    }
    if (msg.event) this.emit(msg.event, msg)
  }

  request<T = any>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('helper not running'))
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`helper timeout: ${cmd}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n')
    })
  }
}

export const helper = new Helper()
