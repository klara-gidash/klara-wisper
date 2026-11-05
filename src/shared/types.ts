export type Lang = 'he' | 'en'
export type Stream = 'mic' | 'system'
export type MeetingSource = 'zoom' | 'meet' | 'teams' | 'slack' | 'facetime' | 'webex' | 'aircall' | 'inperson' | 'other'
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
  detect: Record<Exclude<MeetingSource, 'inperson' | 'other'>, boolean>
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
  inperson: 'In person',
  other: 'Call'
}
