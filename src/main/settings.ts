import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/types'
import { dataDir, defaultFolder } from './paths'

const file = join(dataDir, 'settings.json')

export const defaults: Settings = {
  uiLanguage: 'he',
  theme: 'system',
  userName: '',
  hotkey: process.platform === 'win32' ? 'rightControl' : 'fn', // no fn key events on Windows
  autoRecord: true,
  detect: {
    zoom: true, meet: true, teams: true, slack: true, facetime: true, webex: true, aircall: true,
    whatsapp: true, telegram: true, discord: true, signal: true, messenger: true, goto: true
  },
  micUid: null,
  vocabulary: [],
  folder: defaultFolder,
  keepAudio: true,
  diarizeRemote: true,
  restoreClipboard: true,
  calendars: null,
  autoSummary: true,
  asrModel: null,
  asrLanguage: 'he',
  cloudSync: false,
  cloudUrl: '',
  obsidianEnabled: false,
  obsidianVault: '',
  claudePush: 'off',
  claudeConnected: true,
  lastScanMic: null,
  launchAtLogin: false,
  onboarded: false
}

class SettingsStore extends EventEmitter {
  value: Settings

  constructor() {
    super()
    let saved: Partial<Settings> = {}
    try {
      if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      saved = {}
    }
    this.value = { ...defaults, ...saved, detect: { ...defaults.detect, ...(saved.detect ?? {}) } }
  }

  update(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch, detect: { ...this.value.detect, ...(patch.detect ?? {}) } }
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, JSON.stringify(this.value, null, 2))
    this.emit('change', this.value, patch)
    return this.value
  }
}

export const settings = new SettingsStore()
