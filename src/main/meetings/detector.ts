import { EventEmitter } from 'node:events'
import type { MeetingSource } from '@shared/types'

export interface Candidate {
  key: string
  source: MeetingSource
  appName: string
  title?: string
  url?: string
  micUids: string[]
}

interface MicUser {
  pid: number
  bundleID: string
  name: string
  input: boolean
  inputDevices: string[]
}

type Tabs = Record<string, { url: string; title: string }[]>

/** Desktop apps: their process using the microphone means a call. */
const APPS: { prefix: string; source: MeetingSource; name: string }[] = [
  { prefix: 'us.zoom.xos', source: 'zoom', name: 'Zoom' },
  { prefix: 'us.zoom.CptHost', source: 'zoom', name: 'Zoom' }, // Zoom's sharing/audio host process
  { prefix: 'com.microsoft.teams', source: 'teams', name: 'Microsoft Teams' },
  { prefix: 'com.tinyspeck.slackmacgap', source: 'slack', name: 'Slack' },
  { prefix: 'com.apple.FaceTime', source: 'facetime', name: 'FaceTime' },
  { prefix: 'com.cisco.webexmeetingsapp', source: 'webex', name: 'Webex' },
  { prefix: 'Cisco-Systems.Spark', source: 'webex', name: 'Webex' },
  { prefix: 'io.aircall.workspace', source: 'aircall', name: 'Aircall' },
  // Windows: the helper reports the executable name (lower case) or the Store package family name.
  { prefix: 'zoom.exe', source: 'zoom', name: 'Zoom' },
  { prefix: 'ms-teams.exe', source: 'teams', name: 'Microsoft Teams' },
  { prefix: 'msteams_', source: 'teams', name: 'Microsoft Teams' },
  { prefix: 'teams.exe', source: 'teams', name: 'Microsoft Teams' },
  { prefix: 'slack.exe', source: 'slack', name: 'Slack' },
  { prefix: 'webex.exe', source: 'webex', name: 'Webex' },
  { prefix: 'ciscocollabhost.exe', source: 'webex', name: 'Webex' },
  { prefix: 'aircall', source: 'aircall', name: 'Aircall' }
]

const BROWSERS: { prefix: string; name: string; tabsKey: string[] }[] = [
  { prefix: 'com.google.Chrome', name: 'Chrome', tabsKey: ['com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.canary'] },
  { prefix: 'company.thebrowser.Browser', name: 'Arc', tabsKey: ['company.thebrowser.Browser'] },
  { prefix: 'com.microsoft.edgemac', name: 'Edge', tabsKey: ['com.microsoft.edgemac'] },
  { prefix: 'com.brave.Browser', name: 'Brave', tabsKey: ['com.brave.Browser'] },
  { prefix: 'com.vivaldi.Vivaldi', name: 'Vivaldi', tabsKey: ['com.vivaldi.Vivaldi'] },
  { prefix: 'com.apple.Safari', name: 'Safari', tabsKey: ['com.apple.Safari', 'com.apple.SafariTechnologyPreview'] },
  { prefix: 'com.apple.WebKit', name: 'Safari', tabsKey: ['com.apple.Safari', 'com.apple.SafariTechnologyPreview'] },
  // Windows: tabs are the browser's window titles (the active tab of each window).
  { prefix: 'chrome.exe', name: 'Chrome', tabsKey: ['chrome.exe'] },
  { prefix: 'msedge.exe', name: 'Edge', tabsKey: ['msedge.exe'] },
  { prefix: 'brave.exe', name: 'Brave', tabsKey: ['brave.exe'] },
  { prefix: 'firefox.exe', name: 'Firefox', tabsKey: ['firefox.exe'] },
  { prefix: 'vivaldi.exe', name: 'Vivaldi', tabsKey: ['vivaldi.exe'] },
  { prefix: 'opera.exe', name: 'Opera', tabsKey: ['opera.exe'] },
  { prefix: 'arc.exe', name: 'Arc', tabsKey: ['arc.exe'] }
]

/**
 * Windows has no way to read tab URLs without an extension, so a meeting tab is recognised by the
 * window title ("Meet - abc-defg-hij - Google Chrome"); the title is matched without the browser name.
 */
const WEB_TITLES: { re: RegExp; source: MeetingSource; clean: (t: string) => string }[] = [
  { re: /^Meet\s*[-–—:]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}\b|\bGoogle Meet\b/i, source: 'meet', clean: (t) => t.replace(/^Meet\s*[-–—:]\s*/i, '').replace(/\s*[-–—]\s*Google Meet$/i, '') },
  { re: /\|\s*Microsoft Teams\b/i, source: 'teams', clean: (t) => t.replace(/\s*\|\s*Microsoft Teams.*$/i, '') },
  { re: /\bZoom (Meeting|Workplace|Webinar)\b/i, source: 'zoom', clean: () => '' },
  { re: /\bHuddle\b.*\bSlack\b|\bSlack\b.*\bHuddle\b/i, source: 'slack', clean: () => '' }
]
const BROWSER_SUFFIX = /\s*[-–—]\s*(Google Chrome|Microsoft Edge|Brave|Mozilla Firefox|Vivaldi|Opera|Arc)$/i

const noQuery = (url: string): string => url.replace(/[?#].*$/, '')

/**
 * Web meeting tabs, in priority order: a tab that names one meeting (Meet code, Zoom web client)
 * wins over Teams and Slack tabs, which stay open all day. `id` is what stays the same for the
 * whole call (the URL changes while joining, e.g. Zoom's /wc/123/join → /wc/123/start).
 */
const WEB: { re: RegExp; source: MeetingSource; id: (url: string) => string; clean: (t: string) => string }[] = [
  {
    re: /^https:\/\/meet\.google\.com\/(?:_meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i,
    source: 'meet',
    id: (url) => `https://meet.google.com/${/meet\.google\.com\/(?:_meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(url)![1].toLowerCase()}`,
    clean: (t) => t.replace(/^Meet\s*[-–—:]\s*/i, '').replace(/\s*[-–—]\s*Google Meet$/i, '')
  },
  {
    // Zoom web client: app.zoom.us/wc/…, zoom.us/wc/join/…, us02web.zoom.us/wc/…, webinars at /w/.
    re: /^https:\/\/([\w-]+\.)*zoom\.(us|com)\/(wc|j|w)\//i,
    source: 'zoom',
    id: (url) => {
      const n = /\/(?:wc|j|w)\/(?:join\/)?(\d{8,})/i.exec(url)
      return n ? `zoom.us/wc/${n[1]}` : noQuery(url)
    },
    clean: (t) => t.replace(/\s*[-–—|]\s*Zoom.*$/i, '')
  },
  { re: /^https:\/\/(whereby\.com|app\.around\.co|meet\.jit\.si)\//i, source: 'other', id: noQuery, clean: (t) => t },
  {
    // The Teams URL doesn't name the call (it stays …/v2/ all along), so the key is the site.
    re: /^https:\/\/([\w-]+\.)*(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|teams\.microsoft\.us)(\/|$)/i,
    source: 'teams',
    id: (url) => new URL(url).host.toLowerCase(),
    clean: (t) => t.replace(/\s*\|\s*Microsoft Teams.*$/i, '')
  },
  // Slack in a browser: app.slack.com, or a workspace address (acme.slack.com) before it redirects.
  { re: /^https:\/\/(?!www\.)[\w-]+\.slack\.com\//i, source: 'slack', id: () => 'slack', clean: () => '' }
]

const START_AFTER_MS = 3000
const UNKNOWN_BROWSER_AFTER_MS = 15000 // a browser using the mic without a known meeting tab: ask after 15 s
// Aircall takes the mic for ~1 s every so often without a call (many times a day in the log).
const AIRCALL_AFTER_MS = 5000
// A Slack or Teams tab is open all day, so mic use in that browser may be something else
// (dictation, a voice note): wait a little longer before calling it a call.
const SHARED_TAB_AFTER_MS = 8000

/** How long a candidate must hold the mic, without a break, before it counts as a call. */
export function startAfterMs(c: Candidate): number {
  if (c.key.startsWith('web:unknown')) return UNKNOWN_BROWSER_AFTER_MS
  if (c.source === 'aircall') return AIRCALL_AFTER_MS
  if (c.key.startsWith('web:slack') || c.key.startsWith('web:teams')) return SHARED_TAB_AFTER_MS
  return START_AFTER_MS
}

/**
 * Calls that are announced instead of recorded right away. Only a browser on the mic with no
 * meeting tab we know (could be dictation, voice search, or tabs we can't read): every known call
 * app records by itself.
 */
export function needsConfirmation(c: Candidate): boolean {
  return c.key.startsWith('web:unknown')
}

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * Tab entries from the helper are "url<TAB>title". An older helper script wrote the word "tab"
 * instead of a tab character (inside `tell application`, `tab` means the browser's tab object),
 * so the title ended up glued to the URL; split it back here.
 */
export function normalizeTab(t: { url: string; title: string }): { url: string; title: string } {
  if (t.title || !t.url.includes('tab')) return { url: t.url, title: t.title.replace(BIDI, '').trim() }
  const head = t.url.split(/\s/)[0]
  const at = head.lastIndexOf('tab')
  if (at <= 0) return t
  return { url: t.url.slice(0, at), title: t.url.slice(at + 3).replace(BIDI, '').trim() }
}
const END_AFTER_MS = 15000

/**
 * Turns "who uses the microphone" snapshots from the helper into meeting start/end events.
 * Emits 'start' (Candidate) once a call has held the mic without a break for 3 s (longer for
 * some sources, see startAfterMs), and 'end' (key) once it released it for 15 s.
 */
export class Detector extends EventEmitter {
  private seen = new Map<string, { cand: Candidate; since: number; absentSince: number | null }>()
  private active: string | null = null
  private dismissed = new Map<string, number>()
  private retryAt = new Map<string, number>()
  /** Last meeting tab seen per browser, for the moments its tabs can't be read. */
  private lastWeb = new Map<string, string>()
  private enabled: (source: MeetingSource) => boolean
  private timer: NodeJS.Timeout

  constructor(enabled: (source: MeetingSource) => boolean) {
    super()
    this.enabled = enabled
    this.timer = setInterval(() => this.tick(), 1000)
  }

  dispose(): void {
    clearInterval(this.timer)
  }

  get activeKey(): string | null {
    return this.active
  }

  /** The user stopped this recording: don't restart it while the same call continues. */
  dismiss(key: string): void {
    this.dismissed.set(key, Date.now())
    if (this.active === key) this.active = null
  }

  /**
   * The app couldn't take this call right now (busy, engine starting): forget that it was
   * announced, so it's announced again in a few seconds instead of being skipped.
   */
  release(key: string): void {
    if (this.active === key) this.active = null
    this.retryAt.set(key, Date.now() + 5000)
  }

  /** Recording started by hand: treat a call that is already on as handled. */
  claim(key: string | null): void {
    this.active = key
  }

  update(users: MicUser[], tabs: Tabs): void {
    const now = Date.now()
    const current = new Map<string, Candidate>()
    for (const u of users) {
      const c = this.classify(u, tabs)
      if (c && !current.has(c.key)) current.set(c.key, c)
    }
    for (const [key, c] of current) {
      const s = this.seen.get(key)
      if (s) {
        // Back after a break: the "held for N s" count starts over, so short mic blips a few
        // seconds apart (Aircall) never add up to a call. A call that's already on keeps going.
        if (s.absentSince !== null && key !== this.active) s.since = now
        s.cand = c
        s.absentSince = null
      } else {
        this.seen.set(key, { cand: c, since: now, absentSince: null })
      }
    }
    for (const [key, s] of this.seen) {
      if (!current.has(key) && s.absentSince === null) s.absentSince = now
    }
  }

  current(): Candidate | null {
    for (const s of this.seen.values()) if (s.absentSince === null) return s.cand
    return null
  }

  private classify(u: MicUser, tabs: Tabs): Candidate | null {
    // Case-insensitive: helper bundles don't always keep the app's case (e.g. Arc's helper).
    const bundle = (u.bundleID || '').toLowerCase()
    const app = APPS.find((a) => bundle.startsWith(a.prefix.toLowerCase()))
    if (app) return { key: `app:${app.source}`, source: app.source, appName: app.name, micUids: u.inputDevices }
    const browser = BROWSERS.find((b) => bundle.startsWith(b.prefix.toLowerCase()))
    if (!browser) return null
    const open = browser.tabsKey.flatMap((k) => tabs[k] ?? []).map(normalizeTab)
    if (open.length === 0) {
      // The tab list couldn't be read this time (the browser was busy, the read timed out): stay
      // with the meeting this browser was on, instead of ending it and asking about an unknown call.
      const prev = this.lastWeb.get(browser.name)
      const s = prev ? this.seen.get(prev) : undefined
      if (s) return { ...s.cand, micUids: u.inputDevices }
    }
    for (const w of WEB) {
      const tab = open.find((t) => w.re.test(t.url))
      if (!tab) continue
      const key = `web:${w.source}:${w.id(tab.url)}`
      this.lastWeb.set(browser.name, key)
      return {
        key,
        source: w.source,
        appName: browser.name,
        title: w.clean(tab.title).trim() || undefined,
        url: tab.url,
        micUids: u.inputDevices
      }
    }
    for (const w of WEB_TITLES) {
      const tab = open.find((t) => !t.url && w.re.test(t.title.replace(BROWSER_SUFFIX, '')))
      if (!tab) continue
      const title = tab.title.replace(BROWSER_SUFFIX, '')
      // Titles change during a call (Teams shows the current view), so the key is per browser.
      const key = `web:${w.source}:${w.source === 'slack' ? 'slack' : browser.name}`
      this.lastWeb.set(browser.name, key)
      return {
        key,
        source: w.source,
        appName: browser.name,
        title: w.clean(title).trim() || undefined,
        micUids: u.inputDevices
      }
    }
    // The browser is on a call we can't identify (no meeting tab, or no permission to read tabs).
    return { key: `web:unknown:${browser.name}`, source: 'other', appName: browser.name, micUids: u.inputDevices }
  }

  private tick(): void {
    const now = Date.now()
    if (this.active) {
      const s = this.seen.get(this.active)
      if (!s || (s.absentSince !== null && now - s.absentSince >= END_AFTER_MS)) {
        const key = this.active
        this.active = null
        this.emit('end', key)
      }
    } else {
      for (const [key, s] of this.seen) {
        if (s.absentSince !== null || now - s.since < startAfterMs(s.cand)) continue
        if (this.dismissed.has(key) || !this.enabled(s.cand.source)) continue
        if ((this.retryAt.get(key) ?? 0) > now) continue
        this.active = key
        this.emit('start', s.cand)
        break
      }
    }
    for (const [key, s] of this.seen) {
      if (s.absentSince !== null && now - s.absentSince > END_AFTER_MS && key !== this.active) {
        this.seen.delete(key)
        this.dismissed.delete(key)
        this.retryAt.delete(key)
      }
    }
    // Stop pressed after the call had already ended (its entry is gone): without this the key
    // stayed dismissed forever, and e.g. every later Zoom call (always "app:zoom") was ignored.
    for (const key of this.dismissed.keys()) if (!this.seen.has(key)) this.dismissed.delete(key)
    for (const [browser, key] of this.lastWeb) if (!this.seen.has(key)) this.lastWeb.delete(browser)
  }
}
