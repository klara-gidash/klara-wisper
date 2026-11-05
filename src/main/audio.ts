import { EventEmitter } from 'node:events'
import type { Levels, MicDevice, Stream } from '@shared/types'
import { helper } from './helper'
import { settings } from './settings'
import { broadcast } from './windows'

/**
 * Audio plumbing between the helper and the recorders.
 * - The microphone is shared: dictation and a meeting can use it at the same time.
 * - Chooses which microphone to use (manual choice, the one the call app uses,
 *   the winner of the last scan, or the system default).
 * Emits 'pcm' (stream, Buffer, base64) for every 50 ms chunk.
 */
class Audio extends EventEmitter {
  devices: MicDevice[] = []
  defaultUid: string | null = null
  scanWinner: string | null = null
  current: MicDevice | null = null
  private micUsers = new Set<string>()
  levels: Levels = {}
  private appMics: string[] = []
  private levelTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    helper.on('audio', (msg: { stream: Stream; pcm: string; db: number }) => {
      this.levels[msg.stream] = msg.db
      this.emit('pcm', msg.stream, Buffer.from(msg.pcm, 'base64'), msg.pcm)
      this.scheduleLevels()
    })
    helper.on('devices', (snap) => this.applyDevices(snap))
  }

  private scheduleLevels(): void {
    if (this.levelTimer) return
    this.levelTimer = setTimeout(() => {
      this.levelTimer = null
      broadcast('levels', this.levels)
    }, 66)
  }

  applyDevices(snap: { inputs: any[]; defaultInput: string | null }): void {
    const before = this.defaultUid
    this.devices = snap.inputs.map((d) => ({
      uid: d.uid, name: d.name, transport: d.transport, virtual: d.virtual, isDefault: d.isDefault
    }))
    this.defaultUid = snap.defaultInput
    if (this.scanWinner && !this.devices.some((d) => d.uid === this.scanWinner)) this.scanWinner = null
    this.emit('devices')
    if (this.micUsers.size > 0) void this.followDevice(before)
  }

  /**
   * A headset was plugged in or out mid-recording: move to the microphone we'd pick now,
   * if the one in use disappeared or the system default changed (automatic mode only).
   */
  private async followDevice(previousDefault: string | null): Promise<void> {
    if (settings.value.micUid && this.devices.some((d) => d.uid === settings.value.micUid)) return
    const current = this.current?.uid ?? null
    const gone = !!current && !this.devices.some((d) => d.uid === current)
    if (!gone && previousDefault === this.defaultUid) return
    const want = this.pick(this.appMics)
    if (!want || want === current) return
    try {
      const r = await helper.request('startMic', { uid: want }, 120_000)
      this.current = this.devices.find((d) => d.uid === r.device?.uid) ?? this.current
      console.log(`mic switched to "${this.current?.name}" (device change)`)
      this.emit('devices')
    } catch (err) {
      console.error('mic switch failed:', String((err as Error)?.message ?? err))
    }
  }

  async refreshDevices(): Promise<void> {
    this.applyDevices(await helper.request('devices'))
  }

  /** Which microphone to open. `appMics`: inputs the call app itself is using. */
  pick(appMics: string[] = []): string | null {
    const present = (uid: string | null): boolean => !!uid && this.devices.some((d) => d.uid === uid && !d.virtual)
    if (present(settings.value.micUid)) return settings.value.micUid
    const fromApp = appMics.find((u) => present(u))
    if (fromApp) return fromApp
    if (present(this.scanWinner)) return this.scanWinner
    return this.defaultUid
  }

  async acquireMic(user: string, appMics: string[] = []): Promise<void> {
    const first = this.micUsers.size === 0
    this.micUsers.add(user)
    if (appMics.length) this.appMics = appMics
    if (!first) return
    const uid = this.pick(appMics)
    const r = await helper.request('startMic', { uid }, 120_000).catch((err) => {
      console.error(`startMic for ${user} failed:`, String(err?.message ?? err))
      this.micUsers.delete(user)
      throw err
    })
    this.current = this.devices.find((d) => d.uid === r.device?.uid) ?? {
      uid: r.device?.uid, name: r.device?.name, transport: r.device?.transport, virtual: false, isDefault: false
    }
    console.log(`mic opened for ${user}: "${this.current.name}" (${this.current.transport})`)
    this.emit('devices')
  }

  async releaseMic(user: string): Promise<void> {
    if (!this.micUsers.delete(user) || this.micUsers.size > 0) return
    this.current = null
    this.appMics = []
    this.levels.mic = undefined
    await helper.request('stopMic').catch(() => undefined)
    this.emit('devices')
  }

  get micBusy(): boolean {
    return this.micUsers.size > 0
  }

  /** Listens to every microphone for a moment and keeps the one the user is talking into. */
  async scan(durationMs = 2500): Promise<{ winner: string | null; results: any[] }> {
    if (this.micBusy) throw new Error('busy')
    const r = await helper.request('scan', { durationMs }, durationMs + 5000)
    const best = r.results?.[0]
    const clear = best && best.speech >= 0.12 && best.peakDb > -50
    if (clear) this.scanWinner = best.uid
    this.emit('devices')
    return { winner: clear ? best.uid : null, results: r.results ?? [] }
  }
}

export const audio = new Audio()
