import { clipboard } from 'electron'
import type { Dictation, PillState } from '@shared/types'
import { audio } from './audio'
import { engine } from './engine'
import { helper } from './helper'
import { explainMicDenied, isMicDenied } from './micPermission'
import { settings } from './settings'
import { db } from './storage/db'
import { appendDictation } from './storage/files'
import { broadcast, hidePill, pillWindow, showPill } from './windows'

const TAP_MS = 300
const DOUBLE_TAP_MS = 450

export const TOGGLE_SHORTCUT = 'Control+Alt+Space'

type Source = 'key' | 'shortcut' | 'button'

/**
 * Dictation (like Wispr Flow), three ways in:
 * - hold the dictation key (Fn by default) and speak, release to paste into the focused field;
 *   double-tap for hands-free, press again to finish; Esc cancels;
 * - ⌃⌥Space toggles hands-free dictation and pastes into the focused field (no key permissions needed);
 * - the record button in the app: the text goes to the clipboard and the dictations list.
 */
class DictationController {
  private state: 'idle' | 'recording' | 'transcribing' = 'idle'
  private source: Source = 'key'
  private lastText = ''
  private handsFree = false
  private downAt = 0
  private lastTapAt = 0
  private sessionId: string | null = null
  private startedAt = 0
  private app = ''
  private hideTimer: NodeJS.Timeout | null = null

  constructor() {
    helper.on('hotkey', (m: { state: 'down' | 'up' | 'chord' }) => this.onHotkey(m.state))
    helper.on('key', (m: { key: string }) => m.key === 'escape' && this.cancel())
    audio.on('pcm', (stream, _buf, b64) => {
      if (stream === 'mic' && this.state === 'recording' && this.sessionId) {
        engine.send({ type: 'audio', id: this.sessionId, stream: 'mic', pcm: b64 })
      }
    })
    engine.on('dictation.partial', (m) => {
      if (m.id === this.sessionId && this.state === 'transcribing') this.pill({ phase: 'transcribing', partial: m.text })
    })
  }

  publicState(): { phase: string; handsFree: boolean; source: Source; lastText: string } {
    return { phase: this.state, handsFree: this.handsFree, source: this.source, lastText: this.lastText }
  }

  private publish(): void {
    broadcast('dictation:state', this.publicState())
  }

  /** Start hands-free dictation, or finish the one in progress. */
  toggle(source: Source): void {
    if (this.state === 'idle') {
      void this.begin(source, true)
    } else if (this.state === 'recording') {
      void this.finish()
    }
  }

  private pill(state: PillState): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
    pillWindow().webContents.send('pill', state)
    if (state.phase === 'hidden') hidePill()
    else showPill()
  }

  private hideSoon(ms: number): void {
    this.hideTimer = setTimeout(() => this.pill({ phase: 'hidden' }), ms)
  }

  private onHotkey(state: 'down' | 'up' | 'chord'): void {
    const now = Date.now()
    if (state === 'down') {
      if (this.state === 'recording' && this.handsFree) return void this.finish()
      if (this.state === 'idle') {
        this.downAt = now
        void this.begin('key', false)
      }
    } else if (state === 'up') {
      if (this.state !== 'recording' || this.handsFree) return
      if (now - this.downAt < TAP_MS) {
        if (now - this.lastTapAt < DOUBLE_TAP_MS) {
          this.handsFree = true
          this.lastTapAt = 0
          this.pill({ phase: 'listening', handsFree: true })
        } else {
          this.lastTapAt = now
          this.cancel(true)
        }
        return
      }
      void this.finish()
    } else if (state === 'chord' && this.state === 'recording' && !this.handsFree) {
      this.cancel()
    }
  }

  private async begin(source: Source, handsFree: boolean): Promise<void> {
    if (engine.status.state !== 'ready') {
      this.pill({ phase: 'error', message: settings.value.uiLanguage === 'he' ? 'המנוע עדיין נטען…' : 'Engine is still loading…' })
      return this.hideSoon(1600)
    }
    this.state = 'recording'
    this.source = source
    this.handsFree = handsFree
    this.startedAt = Date.now()
    this.sessionId = `d_${this.startedAt.toString(36)}`
    engine.send({ type: 'session.start', id: this.sessionId, mode: 'dictation', streams: ['mic'], vocabulary: settings.value.vocabulary })
    this.pill({ phase: 'listening', handsFree })
    this.publish()
    void helper.request('armEscape', { value: true }).catch(() => undefined)
    helper.request('frontmostApp').then((r) => (this.app = source === 'button' ? '' : r.name ?? ''), () => (this.app = ''))
    try {
      await audio.acquireMic('dictation')
    } catch (err) {
      if (this.sessionId) engine.send({ type: 'session.cancel', id: this.sessionId })
      this.state = 'idle'
      this.sessionId = null
      const denied = isMicDenied(err)
      if (denied) void explainMicDenied()
      this.pill({ phase: 'error', message: denied ? (settings.value.uiLanguage === 'he' ? 'אין הרשאה למיקרופון' : 'No microphone permission') : String((err as Error).message) })
      this.hideSoon(2400)
      this.publish()
    }
  }

  private cancel(silent = false): void {
    if (this.state === 'idle') return
    if (this.sessionId) engine.send({ type: 'session.cancel', id: this.sessionId })
    void audio.releaseMic('dictation')
    void helper.request('armEscape', { value: false }).catch(() => undefined)
    this.state = 'idle'
    this.sessionId = null
    this.handsFree = false
    this.publish()
    if (silent) this.pill({ phase: 'hidden' })
    else {
      this.pill({ phase: 'error', message: settings.value.uiLanguage === 'he' ? 'בוטל' : 'Cancelled' })
      this.hideSoon(700)
    }
  }

  private async finish(): Promise<void> {
    const id = this.sessionId
    if (!id || this.state !== 'recording') return
    this.state = 'transcribing'
    this.handsFree = false
    this.pill({ phase: 'transcribing' })
    this.publish()
    // A short tail so the last syllable isn't cut off.
    await new Promise((r) => setTimeout(r, 150))
    void audio.releaseMic('dictation')
    void helper.request('armEscape', { value: false }).catch(() => undefined)
    engine.send({ type: 'session.stop', id })
    let text = ''
    let lang: 'he' | 'en' | null = null
    try {
      const r = await engine.waitFor('dictation.result', id, 45_000)
      text = (r.text ?? '').trim()
      lang = r.lang
    } catch {
      /* timeout */
    }
    if (this.sessionId !== id) return // cancelled meanwhile
    this.state = 'idle'
    this.sessionId = null
    this.publish()
    if (!text) {
      this.pill({ phase: 'error', message: settings.value.uiLanguage === 'he' ? 'לא נקלט דיבור' : 'No speech heard' })
      return this.hideSoon(1200)
    }
    let pasted = false
    if (this.source === 'button') {
      clipboard.writeText(text) // dictated from inside the app: hand it over on the clipboard
    } else {
      try {
        pasted = (await helper.request('paste', { text, restore: settings.value.restoreClipboard })).pasted
      } catch {
        pasted = false
      }
    }
    this.lastText = text
    this.publish()
    this.pill({ phase: 'done', text, pasted })
    this.hideSoon(pasted ? 900 : 2600)
    const d: Dictation = {
      id, at: new Date(this.startedAt).toISOString(), text, lang, app: this.app || undefined,
      seconds: Math.round((Date.now() - this.startedAt) / 100) / 10
    }
    appendDictation(d)
    db().indexDictation(d)
    broadcast('dictations:changed', d)
  }
}

export const dictation = new DictationController()
