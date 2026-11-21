/**
 * What gets installed on which computer. Pure functions (no Electron, no Node), so the same rules
 * run in the app, in the install wizard and in the unit tests (test/plan.test.mts).
 *
 *   machine (detected by src/main/preflight.ts) + wishes (two questions in the wizard)
 *     -> problems()  what stops or slows the install on this computer
 *     -> recommend() the "version": which transcription model, with or without speaker models
 */

export type Use = 'dictation' | 'calls' | 'inperson'
export type Tier = 'light' | 'standard' | 'strong'

/** The answers of the wizard. */
export interface Wishes {
  uses: Use[]
  /** "he": Hebrew only (fastest, most accurate Hebrew); "auto": Hebrew + English per sentence. */
  language: 'he' | 'auto'
  /** Only offered on a strong Mac with "auto": the biggest Whisper instead of turbo. */
  accurate?: boolean
}

export const DEFAULT_WISHES: Wishes = { uses: ['dictation', 'calls', 'inperson'], language: 'he' }

export interface Machine {
  platform: 'darwin' | 'win32' | 'linux'
  /** The computer's own architecture ("arm64" / "x64"), not the app's. */
  arch: string
  /** The app runs translated (Rosetta on an Apple Silicon Mac, x64 emulation on Windows on ARM). */
  translated: boolean
  /** macOS: "15.2"; Windows: "10.0.22631". */
  osVersion: string
  /** e.g. "Apple M2", "Intel(R) Core(TM) i7-1165G7". */
  chip: string
  /** Logical cores. */
  cores: number
  ramGB: number
  /** Free space on the volume that holds the app's data folder. */
  freeGB: number
  /** "MacBook Air", "Mac mini"…; empty on Windows. */
  model: string
  /** Windows: the graphics card(s), for the report only. */
  gpu: string
}

export interface Problem {
  id: 'intelMac' | 'oldMac' | 'oldWindows' | 'win32bit' | 'winArm' | 'linux' | 'ramTooLow' | 'ramLow' | 'slowCpu' | 'disk' | 'translated'
  /** "block": the app cannot work here; "warn": it works, with a caveat shown to the user. */
  severity: 'block' | 'warn'
  /** Numbers for the message (GB needed / free, versions). */
  values?: Record<string, string | number>
}

export interface Plan {
  tier: Tier
  /** Model key of engine/klara_engine/models.py. */
  asr: string
  language: 'he' | 'auto'
  /** Telling the speakers apart (Nemotron diarization): on, unless the computer is light. */
  speakers: boolean
  /** Recognising the user's own voice (ECAPA voiceprint, 90 MB): always on. */
  voiceprint: boolean
  /** Separate the remote participants of a call from each other (needs `speakers`). */
  diarizeRemote: boolean
  /** Start recording by itself when a call is detected. */
  autoRecord: boolean
  /** Every model this plan needs, in download order. */
  models: string[]
  /** What the first launch downloads, engine included. */
  downloadGB: number
  /** Free space the install needs (downloads + unpacked packages + headroom). */
  diskGB: number
}

/** Download sizes (GB) of the models, as in engine/klara_engine/models.py. */
export const MODEL_GB: Record<string, number> = {
  'whisper-ivrit-turbo': 1.6,
  'whisper-ivrit-turbo-ct2': 1.6,
  'whisper-large-v3-turbo': 1.6,
  'whisper-large-v3': 3.1,
  'nemotron-diarization': 0.4,
  ecapa: 0.09
}
export const DIARIZATION_MODEL = 'nemotron-diarization'
export const VOICEPRINT_MODEL = 'ecapa'

/** Python + the locked packages: what is downloaded, and what it takes on disk once unpacked. */
const ENGINE_DOWNLOAD_GB = 0.4
const ENGINE_DISK_GB = 1.6
/** Room for the download cache while packages are unpacked, logs, and the first recordings. */
const HEADROOM_GB = 1.5

const MIN_MACOS = [14, 4]
const MIN_WINDOWS_BUILD = 17763 // Windows 10 1809: the oldest Windows this Electron runs on
const GOOD_WINDOWS_BUILD = 19045 // Windows 10 22H2: what the app is built and tested for

function versionParts(v: string): number[] {
  return v.split('.').map((p) => Number.parseInt(p, 10) || 0)
}

/** a >= b, comparing "14.4" style versions part by part. */
export function versionAtLeast(v: string, min: number[]): boolean {
  const have = versionParts(v)
  for (let i = 0; i < min.length; i++) {
    const h = have[i] ?? 0
    if (h !== min[i]) return h > min[i]
  }
  return true
}

/** Windows build number out of "10.0.22631". */
export const windowsBuild = (osVersion: string): number => versionParts(osVersion)[2] ?? 0

export function tierOf(m: Machine): Tier {
  if (m.platform === 'darwin') {
    if (/\b(Pro|Max|Ultra)\b/.test(m.chip) || m.ramGB >= 32) return 'strong'
    return m.ramGB <= 8 ? 'light' : 'standard'
  }
  // Windows transcribes on the processor: cores and memory decide.
  if (m.cores >= 12 && m.ramGB >= 16) return 'strong'
  if (m.cores < 6 || m.ramGB < 12) return 'light'
  return 'standard'
}

export function recommend(m: Machine, wishes: Wishes = DEFAULT_WISHES): Plan {
  const tier = tierOf(m)
  const uses = new Set(wishes.uses.length ? wishes.uses : DEFAULT_WISHES.uses)
  const mac = m.platform === 'darwin'
  // The Windows engine has one model so far: ivrit.ai's Hebrew turbo on CTranslate2.
  const language: Plan['language'] = mac && wishes.language === 'auto' ? 'auto' : 'he'
  const asr = !mac
    ? 'whisper-ivrit-turbo-ct2'
    : language === 'he'
      ? 'whisper-ivrit-turbo'
      : wishes.accurate && tier === 'strong'
        ? 'whisper-large-v3'
        : 'whisper-large-v3-turbo'
  // Speaker recognition is on everywhere, except that a light computer skips telling the other
  // people apart (Nemotron, run after each call): its memory goes to the transcription itself.
  // In-person meetings keep it even there, since one microphone hears everyone. The user's own
  // voice (the voiceprint, a 90 MB model) is recognised on every computer.
  const speakers = tier !== 'light' || uses.has('inperson')
  const voiceprint = true
  const models = [asr, ...(speakers ? [DIARIZATION_MODEL] : []), ...(voiceprint ? [VOICEPRINT_MODEL] : [])]
  const modelsGB = models.reduce((sum, k) => sum + (MODEL_GB[k] ?? 0), 0)
  return {
    tier,
    asr,
    language,
    speakers,
    voiceprint,
    diarizeRemote: speakers && tier !== 'light',
    autoRecord: uses.has('calls'),
    models,
    downloadGB: round1(modelsGB + ENGINE_DOWNLOAD_GB),
    diskGB: round1(modelsGB + ENGINE_DISK_GB + HEADROOM_GB)
  }
}

/**
 * What is wrong with this computer for this plan. `have` is what is already installed (an update or
 * a repair needs less room than a first install).
 */
export function problems(m: Machine, plan: Plan, have: { engine: boolean; models: string[] } = { engine: false, models: [] }): Problem[] {
  const out: Problem[] = []
  if (m.platform === 'darwin') {
    if (m.arch !== 'arm64') out.push({ id: 'intelMac', severity: 'block' })
    else if (m.translated) out.push({ id: 'translated', severity: 'block' })
    if (!versionAtLeast(m.osVersion, MIN_MACOS)) out.push({ id: 'oldMac', severity: 'block', values: { have: m.osVersion, need: MIN_MACOS.join('.') } })
  } else if (m.platform === 'win32') {
    const build = windowsBuild(m.osVersion)
    if (m.arch === 'ia32' || m.arch === 'x86') out.push({ id: 'win32bit', severity: 'block' })
    else if (m.arch === 'arm64' || m.translated) out.push({ id: 'winArm', severity: 'warn' })
    if (!versionAtLeast(m.osVersion, [10]) || build < MIN_WINDOWS_BUILD) out.push({ id: 'oldWindows', severity: 'block', values: { have: m.osVersion } })
    else if (build < GOOD_WINDOWS_BUILD) out.push({ id: 'oldWindows', severity: 'warn', values: { have: m.osVersion } })
    if (m.cores < 4) out.push({ id: 'slowCpu', severity: 'warn', values: { cores: m.cores } })
  } else {
    out.push({ id: 'linux', severity: 'block' })
  }
  // 8 GB computers report a little under 8.
  if (m.ramGB < 6) out.push({ id: 'ramTooLow', severity: 'block', values: { have: m.ramGB, need: 8 } })
  else if (m.ramGB < 7.5) out.push({ id: 'ramLow', severity: 'warn', values: { have: m.ramGB, need: 8 } })

  const need = neededGB(plan, have)
  if (m.freeGB >= 0 && m.freeGB < need) {
    // macOS counts space it can free on demand (caches, local snapshots) as used, so a Mac that
    // looks a little short usually still has room: only a nearly full disk stops the install there.
    const severity = m.platform === 'darwin' && m.freeGB >= 2 ? 'warn' : 'block'
    out.push({ id: 'disk', severity, values: { need: round1(need), have: round1(m.freeGB) } })
  }
  return out
}

/** Free space still needed, given what is already on the disk. */
export function neededGB(plan: Plan, have: { engine: boolean; models: string[] }): number {
  const models = plan.models.filter((k) => !have.models.includes(k)).reduce((sum, k) => sum + (MODEL_GB[k] ?? 0), 0)
  const engine = have.engine ? 0 : ENGINE_DISK_GB
  const todo = models + engine
  return todo === 0 ? 0.5 : round1(todo + HEADROOM_GB)
}

export const blocked = (list: Problem[]): boolean => list.some((p) => p.severity === 'block')

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Why a download or an install step failed, from the text of the error. */
export type FailureKind = 'network' | 'disk' | 'blocked' | 'tls' | 'unknown'

export function classifyFailure(message: string): FailureKind {
  const s = message.toLowerCase()
  if (/no space left|enospc|os error 28\b|os error 112\b|disk (is )?full|not enough (free )?(disk )?space|errno 28\b/.test(s)) return 'disk'
  if (/certificate|ssl|tls handshake|self.signed|unable to get local issuer/.test(s)) return 'tls'
  if (
    /could not reach|dns|name resolution|getaddrinfo|enotfound|econn|etimedout|timed out|timeout|network|unreachable|connection (reset|refused|closed|aborted|error)|error sending request|failed to (fetch|download)|temporary failure|os error 1100[14]\b|incomplete|max retries|remote end closed|(http|status|error)[^|]{0,24}\b(429|50[234])\b/.test(
      s
    )
  ) {
    return 'network'
  }
  if (/access is denied|permission denied|eperm|eacces|os error 5\b|os error 32\b|used by another process|operation not permitted|blocked by|virus/.test(s)) return 'blocked'
  return 'unknown'
}

/** A file error worth trying again after a moment (Windows: a file still open, an antivirus scan). */
export function retryableFsError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY'
}

/** Engine files whose change means the copy next to the virtualenv must be refreshed (path relative to the engine folder). */
export function isEngineCodeFile(rel: string): boolean {
  const p = rel.replace(/\\/g, '/')
  return p.endsWith('.py') && !p.split('/').includes('__pycache__')
}

/** The engine's stderr minus the noise (warnings, download redirects), line by line: tracebacks stay. */
export function engineErrorLines(chunk: string): string {
  return chunk
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/Warning|warn\(|redirects|Loading weights/i.test(l))
    .join('\n')
}

/**
 * What the health check's main button does: 'repair' rebuilds the engine (only when the engine itself
 * is broken), 'retry' re-runs the install (a model download failed, transcription was slow: the working
 * engine stays), null when there is nothing to fix automatically.
 */
export function healthFix(items: { id: string; status: string; code?: string }[] | null | undefined): 'repair' | 'retry' | null {
  const failed = (items ?? []).filter((i) => i.status === 'fail')
  if (failed.some((i) => i.id === 'engine' || i.id === 'speakers' || (i.id === 'claude' && i.code === 'serverFailed'))) return 'repair'
  if (failed.some((i) => i.id === 'models' || i.id === 'transcribe')) return 'retry'
  return null
}

/** The install should carry on at launch: after the wizard, or once a plan was chosen (the app was quit mid-install). */
export function resumeSetupAtLaunch(s: { onboarded: boolean; setupModels: string[] | null }): boolean {
  return s.onboarded || !!s.setupModels?.length
}
