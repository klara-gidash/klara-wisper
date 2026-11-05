import { execFileSync } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { engine } from './engine'
import { finalizer } from './meetings/finalize'
import { recorder } from './meetings/recorder'
import { settings } from './settings'
import { modelReady, setup } from './setup'

/** The Whisper models one can pick on a Mac (keys of engine/klara_engine/models.py). */
export const DEFAULT_ASR = 'whisper-ivrit-turbo'
const CHOICES = [
  { key: 'whisper-ivrit-turbo', gb: 1.6, heavy: false },    // Hebrew fine-tune: fastest, best Hebrew; any Mac
  { key: 'whisper-large-v3-turbo', gb: 1.6, heavy: false }, // OpenAI turbo: Hebrew + English, auto language
  { key: 'whisper-large-v3', gb: 3.1, heavy: true }         // OpenAI large-v3: biggest, several times slower
]

export interface AsrChoices {
  hardware: { chip: string; ramGB: number; strong: boolean; model: string }
  language: 'he' | 'auto'
  current: string
  active: string | null
  models: { key: string; gb: number; downloaded: boolean; fits: boolean }[]
}

/** A strong Mac (Pro/Max/Ultra chip or 32 GB+) runs the big model comfortably next to a call. */
function hardware(): AsrChoices['hardware'] {
  const chip = cpus()[0]?.model?.trim() ?? ''
  const ramGB = Math.round(totalmem() / 2 ** 30)
  return { chip, ramGB, strong: /\b(Pro|Max|Ultra)\b/.test(chip) || ramGB >= 32, model: macModel() }
}

let modelName: string | null = null
/** "MacBook Air", "MacBook Pro", "Mac mini"… (from the hardware model id, e.g. Mac14,2 / MacBookPro18,3). */
function macModel(): string {
  if (modelName !== null) return modelName
  try {
    const id = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 3000 }).trim()
    modelName = /MacBookAir/i.test(id) ? 'MacBook Air' : /MacBookPro/i.test(id) ? 'MacBook Pro' : /Macmini/i.test(id) ? 'Mac mini'
      : /iMac/i.test(id) ? 'iMac' : /MacPro/i.test(id) ? 'Mac Pro' : 'Mac'
  } catch {
    modelName = 'Mac'
  }
  return modelName
}

export function asrChoices(): AsrChoices {
  const hw = hardware()
  return {
    hardware: hw,
    language: settings.value.asrLanguage === 'auto' ? 'auto' : 'he',
    current: settings.value.asrModel ?? DEFAULT_ASR,
    active: engine.status.asr ?? null,
    models: CHOICES.map((m) => ({ key: m.key, gb: m.gb, downloaded: modelReady(m.key), fits: !m.heavy || hw.strong }))
  }
}

/** Picks a model: downloads it if needed (progress shows in Settings), then reloads the engine between calls. */
export async function selectAsr(key: string): Promise<AsrChoices> {
  if (process.platform !== 'darwin' || !CHOICES.some((m) => m.key === key)) throw new Error(`unknown model ${key}`)
  await setup.fetchModels([key])
  settings.update({ asrModel: key === DEFAULT_ASR ? null : key })
  console.log(`transcription model: ${key}`)
  restartEngineWhenIdle()
  return asrChoices()
}

/**
 * Hebrew only, or Hebrew + English detected per sentence. The Hebrew fine-tune can't tell the two
 * apart, so "auto" runs OpenAI's turbo (downloaded first if needed) unless a bigger OpenAI model is picked.
 */
export async function selectLanguage(lang: 'he' | 'auto'): Promise<AsrChoices> {
  if (lang === 'auto') await setup.fetchModels(['whisper-large-v3-turbo'])
  settings.update({ asrLanguage: lang === 'auto' ? 'auto' : 'he' })
  console.log(`transcription language: ${lang}`)
  restartEngineWhenIdle()
  return asrChoices()
}

let waiting: NodeJS.Timeout | null = null

/** Restarting the engine mid-call would lose the live transcript: wait until no call is recording or finishing. */
export function restartEngineWhenIdle(): void {
  const idle = (): boolean => !recorder.live && finalizer.pending.size === 0
  if (waiting) return
  if (idle()) return engine.restart()
  waiting = setInterval(() => {
    if (!idle()) return
    clearInterval(waiting!)
    waiting = null
    engine.restart()
  }, 15_000)
}
