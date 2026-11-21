import type { FailureKind, Machine, Plan, Problem, Wishes } from './plan'

export type Lang = 'he' | 'en'
export type Stream = 'mic' | 'system'
export type MeetingSource =
  | 'zoom' | 'meet' | 'teams' | 'slack' | 'facetime' | 'webex' | 'aircall'
  | 'whatsapp' | 'telegram' | 'discord' | 'signal' | 'messenger' | 'goto'
  | 'inperson' | 'phone' | 'other'
export type RecordingMode = 'meeting' | 'inperson'
export type HotkeyName = 'fn' | 'rightOption' | 'rightCommand' | 'rightControl'

export interface Word {
  start: number
  end: number
  word: string
  p?: number
}

export interface Segment {
  id: string
  stream: Stream
  start: number
  end: number
  text: string
  lang: Lang
  langProbs?: { he: number; en: number }
  mixed?: boolean
  speaker: string | null
  model?: string
  words?: Word[]
}

export interface SpeakerInfo {
  name: string | null
  key?: string | null
  isMe: boolean
  embedding?: number[]
}

export interface Attendee {
  name: string
  email: string
  isMe?: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  calendar: string
  color: string | null
  location: string
  links: string[]
  organizer: string
  attendees: Attendee[]
}

export interface MeetingMeta {
  id: string
  title: string
  source: MeetingSource
  mode: RecordingMode
  startedAt: string
  endedAt?: string
  durationSec?: number
  folder: string
  status: 'recording' | 'processing' | 'done' | 'error'
  calendarEvent?: CalendarEvent | null
  attendees?: Attendee[]
  speakers: Record<string, SpeakerInfo>
  languages?: Lang[]
  bookmarks?: number[]
  hasAudio?: boolean
  appName?: string
  url?: string
  error?: string
  /** Where the title came from: the user renamed it, the calendar, or Claude (ad-hoc / in person). */
  titleSource?: 'user' | 'calendar' | 'claude'
  /** 1-2 sentences on what the meeting was about (Claude, through the MCP server). */
  scope?: string
  /** People Claude identified from the transcript; [] = could not be identified. */
  inferredParticipants?: string[] | null
  /** The past-meetings pass already looked for this meeting in the calendar. */
  calendarChecked?: boolean | number
  /** Made from a recording on the phone: its id in the user's Cloudflare Worker (phoneRecordings.ts). */
  cloudRecordingId?: string
}

/** A recent call worth a follow-up email (home screen). */
export interface FollowUp {
  id: string
  title: string
  startedAt: string
  source: MeetingSource
  people: Attendee[]
  hasSummary: boolean
}

export interface MeetingSummary extends MeetingMeta {
  preview?: string
  hasSummary?: boolean
}

export interface Meeting {
  meta: MeetingMeta
  segments: Segment[]
  summary?: string | null
}

export interface Dictation {
  id: string
  at: string
  text: string
  lang: Lang | null
  app?: string
  seconds?: number
}

export interface SearchHit {
  meetingId: string
  title: string
  startedAt: string
  source: MeetingSource
  segments: { id: string; start: number; speaker: string | null; text: string }[]
}

export interface Settings {
  uiLanguage: 'he' | 'en'
  theme: 'system' | 'light' | 'dark'
  userName: string
  hotkey: HotkeyName
  autoRecord: boolean
  detect: Record<Exclude<MeetingSource, 'inperson' | 'phone' | 'other'>, boolean>
  micUid: string | null // null = automatic
  vocabulary: string[]
  folder: string
  keepAudio: boolean
  diarizeRemote: boolean
  restoreClipboard: boolean
  launchAtLogin: boolean
  onboarded: boolean
  /** Calendars shown under "Coming up"; null = the account's own calendars (titled with an email). */
  calendars: string[] | null
  /** After each call, Claude (the Claude Code CLI) writes and saves the summary. */
  autoSummary: boolean
  /** Whisper model picked in Settings; null = the default (ivrit.ai Hebrew turbo). */
  asrModel: string | null
  /** "he": Hebrew only (default); "auto": Hebrew + English, detected per sentence (OpenAI turbo). */
  asrLanguage: 'he' | 'auto'
  /** Optional: copy transcripts + summaries to the user's own Cloudflare Worker (phone connector). */
  cloudSync: boolean
  cloudUrl: string
  /** Optional: one Markdown note per call in an Obsidian vault (folder picked in Settings). */
  obsidianEnabled: boolean
  obsidianVault: string
  /** Optional: after a call, open the summary in Claude ("notify": a notification to click; "open": by itself). */
  claudePush: 'off' | 'notify' | 'open'
  /** Keep the klara-wisper connection in Claude Desktop / Claude Code (re-added at launch only when true). */
  claudeConnected: boolean
  /** The microphone the last automatic scan picked (kept across restarts). */
  lastScanMic: string | null
  /** The models this install needs, chosen by the install wizard (src/shared/plan.ts); null = the default three. */
  setupModels: string[] | null
  /** The wizard's answers, kept so a repair or a later check uses the same plan. */
  wishes: Wishes | null
}

export interface MicDevice {
  uid: string
  name: string
  transport: string
  virtual: boolean
  isDefault: boolean
}

export interface Permissions {
  microphone: string
  accessibility: string
  inputMonitoring: string
  calendar: string
  systemAudio?: string
}

export interface EngineStatus {
  state: 'starting' | 'loading' | 'ready' | 'error' | 'missing'
  asr?: string | null
  diarization?: boolean
  voiceprints?: boolean
  voiceprintKeys?: Record<string, { name: string; isMe: boolean }>
  error?: string
}

/** First-launch setup of an installed app: the Python engine, then the models. */
export interface SetupState {
  needed: boolean
  running: boolean
  phase: 'idle' | 'python' | 'packages' | 'models' | 'done' | 'error'
  progress: number // 0..1 within the phase
  detail?: string
  error?: string
  /** Why it stopped, for a message in plain words; "network" is tried again by itself. */
  errorKind?: FailureKind
  /** When the next automatic try starts (ms since 1970), while waiting after a network error. */
  retryAt?: number
  /** Automatic tries so far for the current problem. */
  attempt?: number
  engineMissing?: boolean
  modelsMissing?: string[]
  models?: { key: string; title: string; bytes: number; done: number; state: 'waiting' | 'downloading' | 'verifying' | 'done' }[]
}

export interface LiveSession {
  id: string
  mode: RecordingMode
  source: MeetingSource
  title: string
  startedAt: string
  paused: boolean
  phase: 'recording' | 'processing' | 'done'
  mic: string | null
  appName?: string
}

export interface AppState {
  platform: 'darwin' | 'win32' | 'linux'
  settings: Settings
  engine: EngineStatus
  setup: SetupState
  helperReady: boolean
  permissions: Permissions | null
  live: LiveSession | null
  mic: { current: string | null; currentName: string | null; auto: boolean; devices: MicDevice[] }
}

export type PillState =
  | { phase: 'hidden' }
  | { phase: 'listening'; handsFree: boolean }
  | { phase: 'transcribing'; partial?: string }
  | { phase: 'done'; text: string; pasted: boolean }
  | { phase: 'error'; message: string }

export interface Levels {
  mic?: number
  system?: number
}

export const SOURCE_LABEL: Record<MeetingSource, string> = {
  zoom: 'Zoom',
  meet: 'Google Meet',
  teams: 'Teams',
  slack: 'Slack Huddle',
  facetime: 'FaceTime',
  webex: 'Webex',
  aircall: 'Aircall',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
  signal: 'Signal',
  messenger: 'Messenger',
  goto: 'GoTo',
  inperson: 'In person',
  phone: 'Phone',
  other: 'Call'
}

/** What the install wizard learns about this computer before installing (src/main/preflight.ts). */
export interface PreflightReport {
  machine: Machine
  plan: Plan
  problems: Problem[]
  /** Already on this computer (an update or a repair instead of a first install). */
  installed: { engine: boolean; models: string[] }
  /** The download servers answered: Python (GitHub), packages (PyPI), models (Hugging Face). */
  internet: { ok: boolean; unreachable: string[] }
  /** macOS: the app runs from the disk image or Downloads instead of the Applications folder. */
  misplaced: boolean
  claude: { desktopInstalled: boolean; codeCli: boolean }
}

export interface HealthItem {
  id: 'app' | 'helper' | 'engine' | 'models' | 'transcribe' | 'speakers' | 'microphone' | 'permissions' | 'calendar' | 'claude' | 'cloud' | 'storage'
  status: 'ok' | 'warn' | 'fail' | 'skip' | 'running'
  /** A short code for the message (strings.ts: health.<id>.<code>). */
  code?: string
  /** Extra text shown as is: a number, a name, or the raw error when nothing better is known. */
  detail?: string
  ms?: number
}

export interface HealthReport {
  at: string
  ok: boolean
  items: HealthItem[]
}

/** The Claude connection as the app made it by itself (src/main/claude.ts: autoConnect). */
export interface ClaudeAuto {
  desktopInstalled: boolean
  desktop: boolean
  desktopRunning: boolean
  codeCli: boolean
  code: boolean
  skills: number
  error?: string
}

/** Google Calendar through its secret iCal link (src/main/googleCalendar.ts). */
export interface GoogleCalendarState {
  linked: boolean
  /** The calendar's name: the user's address for a main calendar. */
  calendar: string | null
  lastSync: string | null
  /** "gcal:notFound"…, when the last fetch failed (the last good copy is still used). */
  lastError: string | null
  /** Events in the next 7 days, once the calendar was read. */
  upcoming: number | null
}
