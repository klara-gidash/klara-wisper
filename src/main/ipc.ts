import { clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState, Attendee, CalendarEvent, FollowUp, MeetingMeta, Permissions, Settings } from '@shared/types'
import { toMarkdown } from '@shared/transcript'
import { audio } from './audio'
import { eventsBetween, requestCalendar, upcoming } from './calendar'
import * as claude from './claude'
import { engine } from './engine'
import { helper } from './helper'
import type { Detector } from './meetings/detector'
import { recorder, type StartOptions } from './meetings/recorder'
import { dataDir, devMode } from './paths'
import { dictation } from './dictation'
import { explainMicDenied, isMicDenied } from './micPermission'
import { isAppUrl, safeExternal } from './security'
import { settings } from './settings'
import { setup } from './setup'
import { asrChoices, selectAsr, selectLanguage } from './models'
import { checkCloud, cloudState, configureCloud, deleteCloud, forgetCloud, syncAllCloud } from './cloud'
import { disableObsidian, enableObsidian, exportAllObsidian, obsidianState, pickObsidianVault } from './obsidian'
import { autoSummary } from './summarize'
import { db } from './storage/db'
import { readMeeting, renameMeetingFolder, writeMeeting, writeMeta } from './storage/files'
import { broadcast, hideLive, showLibrary, showLive } from './windows'

let permissions: Permissions | null = null

/** The Claude connection (MCP) reads upcoming events from this file instead of touching the calendar. */
export function cacheUpcoming(events: CalendarEvent[]): void {
  try {
    writeFileSync(join(dataDir, 'upcoming.json'), JSON.stringify({ at: new Date().toISOString(), events }))
  } catch {
    /* not critical */
  }
}

const EDITABLE: (keyof Settings)[] = [
  'uiLanguage', 'theme', 'userName', 'hotkey', 'autoRecord', 'detect', 'micUid', 'vocabulary',
  'keepAudio', 'diarizeRemote', 'restoreClipboard', 'launchAtLogin', 'onboarded', 'calendars', 'autoSummary', 'claudePush', 'claudeConnected'
]

/** Settings the pages may change; the folder only changes through the folder picker. */
function cleanPatch(patch: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {}
  for (const key of EDITABLE) {
    if (!(key in patch)) continue
    const value = patch[key]
    const kind = typeof settings.value[key]
    if (key === 'claudePush') {
      if (value === 'off' || value === 'notify' || value === 'open') out.claudePush = value
      continue
    }
    if (key === 'calendars') {
      if (value === null || Array.isArray(value)) out.calendars = value === null ? null : (value as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 50)
      continue
    }
    if (key === 'micUid' ? value === null || typeof value === 'string' : kind === 'object' ? typeof value === 'object' && value !== null : typeof value === kind) {
      ;(out as any)[key] = value
    }
  }
  if (out.vocabulary) out.vocabulary = out.vocabulary.filter((v) => typeof v === 'string').slice(0, 200).map((v) => v.slice(0, 80))
  if (out.userName) out.userName = out.userName.slice(0, 60)
  return out
}

export function appState(): AppState {
  const pickedUid = audio.current?.uid ?? audio.pick()
  return {
    platform: process.platform as AppState['platform'],
    settings: settings.value,
    engine: engine.status,
    setup: setup.state,
    helperReady: helper.ready,
    permissions,
    live: recorder.live,
    mic: {
      current: pickedUid,
      currentName: audio.current?.name ?? audio.devices.find((d) => d.uid === pickedUid)?.name ?? null,
      auto: !settings.value.micUid,
      devices: audio.devices
    }
  }
}

let stateTimer: NodeJS.Timeout | null = null
export function pushState(): void {
  if (stateTimer) return
  stateTimer = setTimeout(() => {
    stateTimer = null
    broadcast('state', appState())
  }, 50)
}

export async function refreshPermissions(): Promise<Permissions | null> {
  try {
    permissions = await helper.request('permissions')
  } catch {
    /* helper not up yet */
  }
  pushState()
  return permissions
}

function meetingFolder(id: string): string {
  const folder = db().getFolder(id)
  if (!folder) throw new Error('meeting not found')
  return folder
}

/** People to write to after a meeting: its calendar guests, minus me and room/resource calendars. */
function recipients(meta: MeetingMeta): Attendee[] {
  const seen = new Set<string>()
  return (meta.attendees ?? meta.calendarEvent?.attendees ?? []).filter((a) => {
    const email = a.email?.toLowerCase() ?? ''
    if (a.isMe || !email.includes('@') || /resource\.calendar\.google\.com|group\.calendar\.google\.com/.test(email) || seen.has(email)) return false
    seen.add(email)
    return true
  })
}

/**
 * "Suggested follow-up emails" on the home screen: finished calls from the last week that had other
 * people on the invite, or that Claude already summarized.
 */
function followUps(): FollowUp[] {
  const weekAgo = Date.now() - 7 * 86400_000
  const out: FollowUp[] = []
  for (const m of db().listMeetings({ mode: 'meeting', limit: 60 })) {
    if (new Date(m.startedAt).getTime() < weekAgo) break
    if (m.status !== 'done') continue
    const people = recipients(m)
    const hasSummary = existsSync(join(m.folder, 'summary.md'))
    if (people.length === 0 && !hasSummary) continue
    out.push({ id: m.id, title: m.title, startedAt: m.startedAt, source: m.source, people, hasSummary })
    if (out.length >= 4) break
  }
  return out
}

/** A Gmail draft addressed to the meeting's guests, with Claude's summary (if there is one) as the body. */
function followUpUrl(id: string): string | null {
  const m = readMeeting(meetingFolder(id))
  if (!m) return null
  const he = settings.value.uiLanguage === 'he'
  const plain = (m.summary ?? '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+\[[ x]\]\s*/gim, '- ')
    .trim()
  const body = plain
    ? `${he ? 'היי,\n\nתודה על הפגישה. מצורף סיכום קצר:' : 'Hi,\n\nThanks for the meeting. A short summary:'}\n\n${plain.slice(0, 5000)}`
    : he
      ? 'היי,\n\nתודה על הפגישה.\n'
      : 'Hi,\n\nThanks for the meeting.\n'
  const q = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: recipients(m.meta).map((a) => a.email).join(','),
    su: `${he ? 'סיכום' : 'Follow-up'}: ${m.meta.title}`,
    body
  })
  return `https://mail.google.com/mail/?${q.toString()}`
}

function saveMeta(meta: MeetingMeta): void {
  const m = readMeeting(meta.folder)
  if (m) writeMeeting(meta.folder, meta, m.segments)
  else writeMeta(meta.folder, meta)
  db().updateMeta(meta)
  broadcast('meetings:changed', meta.id)
}

// Voiceprint enrollment: a short recording of the user's voice.
let enrollChunks: Buffer[] | null = null
audio.on('pcm', (stream, buf: Buffer) => {
  if (enrollChunks && stream === 'mic') enrollChunks.push(buf)
})

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24)
  h.writeUInt32LE(32000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

export function registerIpc(detector: Detector): void {
  // Every call must come from one of the app's own pages (not a page that somehow got navigated to).
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(channel, (e, ...args) => {
      const url = e.senderFrame?.url ?? ''
      if (!isAppUrl(url)) throw new Error(`blocked IPC ${channel} from ${url}`)
      return fn(...args)
    })
  }

  handle('state', () => appState())
  handle('setup:run', () => void setup.run())
  handle('settings:set', (patch: Partial<Settings>) => settings.update(cleanPatch(patch)))

  // Library
  handle('meetings:list', (opts?: { source?: string; mode?: string }) => db().listMeetings(opts))
  handle('meetings:get', (id: string) => readMeeting(meetingFolder(id)))
  handle('meetings:rename', (id: string, title: string) => {
    const m = readMeeting(meetingFolder(id))
    if (!m) return
    const old = m.meta.folder
    const meta = { ...m.meta, title, titleSource: 'user' as const }
    meta.folder = renameMeetingFolder(old, meta)
    saveMeta(meta)
  })
  handle('meetings:renameSpeaker', (id: string, label: string, name: string, remember: boolean) => {
    const m = readMeeting(meetingFolder(id))
    if (!m) return
    const info = { ...(m.meta.speakers[label] ?? { isMe: false }), name }
    m.meta.speakers = { ...m.meta.speakers, [label]: info }
    saveMeta(m.meta)
    if (remember && info.embedding?.length) {
      const key = info.key || `v_${Date.now().toString(36)}`
      engine.send({ type: 'voiceprint.remember', key, name, embedding: info.embedding, isMe: info.isMe })
      m.meta.speakers[label] = { ...info, key }
      saveMeta(m.meta)
    }
  })
  handle('meetings:delete', async (id: string) => {
    const folder = meetingFolder(id)
    await shell.trashItem(folder)
    db().removeMeeting(id)
    broadcast('meetings:changed', id)
    // The cloud copy goes too, in the background (the local delete never waits for it).
    if (settings.value.cloudSync) {
      void deleteCloud(id).catch((err) => console.warn(`cloud sync: could not delete ${id} from the Worker: ${(err as Error).message}`))
    }
  })
  handle('meetings:reveal', (id: string) => shell.showItemInFolder(join(meetingFolder(id), 'transcript.md')))
  handle('meetings:copy', (id: string) => {
    const m = readMeeting(meetingFolder(id))
    if (m) clipboard.writeText(toMarkdown(m.meta, m.segments, settings.value.userName))
  })
  handle('search', (q: string) => db().search(q))
  handle('dictations:list', (q?: string) => db().listDictations(q ?? ''))
  handle('clipboard:write', (text: string) => clipboard.writeText(text))

  // Recording
  handle('live:snapshot', () => recorder.snapshot())
  handle('live:start', async (opts: StartOptions) => {
    const current = detector.current()
    const session = await recorder.start(
      opts.mode === 'meeting' && current ? { ...opts, source: current.source, appName: current.appName, url: current.url, title: current.title } : opts
    ).catch(async (err) => {
      if (!isMicDenied(err)) throw err
      await explainMicDenied()
      return null
    })
    if (!session) return null
    if (opts.mode === 'meeting' && current) {
      detector.claim(current.key)
      recorder.detectorKey = current.key
    }
    return session
  })
  handle('live:stop', () => {
    if (recorder.detectorKey) detector.dismiss(recorder.detectorKey)
    return recorder.stop()
  })
  handle('live:pause', (paused: boolean) => recorder.setPaused(paused))
  handle('live:bookmark', () => recorder.bookmark())
  handle('live:rename', (title: string) => recorder.rename(title))
  handle('live:renameSpeaker', (label: string, name: string) => recorder.renameSpeaker(label, name))
  handle('live:hide', () => hideLive())
  handle('live:show', () => void showLive())
  handle('library:show', (route?: string) => void showLibrary(route))

  // Calendar, microphones, permissions
  handle('calendar:upcoming', async () => {
    const events = await upcoming()
    cacheUpcoming(events)
    return events
  })
  // The home screen's "coming up": whole days, from today (offset 0) or later pages.
  handle('calendar:days', async (offsetDays = 0, days = 7) => {
    const from = new Date()
    if (offsetDays > 0) {
      from.setHours(0, 0, 0, 0)
      from.setDate(from.getDate() + Math.min(Number(offsetDays) || 0, 365))
    }
    const to = new Date(from)
    to.setHours(0, 0, 0, 0)
    to.setDate(to.getDate() + Math.max(1, Math.min(Number(days) || 7, 31)))
    const all = (await eventsBetween(from, to)).filter((e) => new Date(e.end).getTime() > Date.now())
    // Shared calendars (team coverage, a partner's…) would crowd the list: by default show only the
    // account's own calendars, which macOS names after the email address.
    const names = [...new Set(all.map((e) => e.calendar))]
    const own = names.filter((n) => n.includes('@'))
    const shown = new Set(settings.value.calendars ?? (own.length ? own : names))
    const events = all.filter((e) => shown.has(e.calendar))
    if (!offsetDays) cacheUpcoming(events) // what Claude's list_upcoming_meetings reads
    const calendars = names.map((name) => ({ name, color: all.find((e) => e.calendar === name)?.color ?? null, shown: shown.has(name) }))
    return { events, calendars }
  })
  // System Settings > Internet Accounts, where a Google (Workspace) calendar is added to the Mac.
  handle('calendar:openAccounts', () => shell.openExternal('x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension'))
  handle('followups:list', () => followUps())
  handle('followups:compose', (id: string) => {
    const url = followUpUrl(id)
    if (url) void shell.openExternal(url)
  })
  handle('mic:scan', async () => {
    const r = await audio.scan()
    pushState()
    return r
  })
  handle('mic:set', (uid: string | null) => settings.update({ micUid: uid }))
  handle('permissions:get', () => refreshPermissions())
  handle('permissions:request', async (kind: string, bundleID?: string) => {
    const result = kind === 'calendar' ? await requestCalendar() : (await helper.request('requestPermission', { kind, bundleID }, 180_000)).result
    await refreshPermissions()
    return result
  })
  handle('permissions:open', (pane: string) => helper.request('openSettings', { pane }))

  // Voiceprint
  handle('voiceprint:start', async () => {
    enrollChunks = []
    try {
      await audio.acquireMic('enroll')
    } catch (err) {
      enrollChunks = null
      if (isMicDenied(err)) await explainMicDenied()
      throw err
    }
  })
  handle('voiceprint:stop', async () => {
    const chunks = enrollChunks ?? []
    enrollChunks = null
    await audio.releaseMic('enroll')
    const path = join(dataDir, 'voice-me.wav')
    writeFileSync(path, wav(Buffer.concat(chunks)))
    const name = settings.value.userName || (settings.value.uiLanguage === 'he' ? 'אני' : 'Me')
    engine.send({ type: 'voiceprint.enroll', key: 'me', name, isMe: true, path })
    await engine.waitFor('voiceprint.enrolled', undefined as unknown as string, 30_000).catch(() => undefined)
    rmSync(path, { force: true }) // only the voiceprint is kept, not the recording
    return engine.status.voiceprintKeys ?? {}
  })
  handle('voiceprint:remove', (key: string) => engine.send({ type: 'voiceprint.remove', key }))

  // Claude
  // Transcription model (Settings): ivrit.ai Hebrew turbo by default, bigger OpenAI models on strong Macs.
  handle('asr:list', () => asrChoices())
  handle('asr:select', (key: string) => selectAsr(String(key)))
  handle('asr:language', (lang: string) => selectLanguage(lang === 'auto' ? 'auto' : 'he'))
  // Optional Cloudflare copy of transcripts + summaries (phone connector).
  handle('cloud:state', () => cloudState())
  handle('cloud:configure', (opts: { url: string; token?: string; enabled: boolean }) =>
    configureCloud({ url: String(opts?.url ?? ''), token: opts?.token === undefined ? undefined : String(opts.token), enabled: !!opts?.enabled }))
  handle('cloud:check', () => checkCloud())
  handle('cloud:syncAll', () => syncAllCloud())
  handle('cloud:forget', () => forgetCloud())
  // Optional Obsidian export: one note per call in the vault the user picks.
  handle('obsidian:state', () => obsidianState())
  handle('obsidian:pickVault', () => pickObsidianVault())
  handle('obsidian:enable', () => enableObsidian())
  handle('obsidian:disable', () => disableObsidian())
  handle('obsidian:exportAll', () => exportAllObsidian())
  handle('claude:status', () => claude.status())
  // The automatic summaries need the Claude Code CLI signed in (Settings > Claude).
  handle('claude:auth', async () => {
    const cli = claude.claudeCli()
    const signedIn = cli ? await claude.signedIn(cli) : false
    if (signedIn) void autoSummary.backfill() // just signed in: the earlier calls get their notes too
    return { cli: !!cli, signedIn }
  })
  handle('claude:signIn', async () => {
    const err = await shell.openPath(claude.openSignIn(dataDir))
    if (err) throw new Error(err)
  })
  handle('claude:connect', async (target: 'desktop' | 'code') => {
    if (target === 'desktop') {
      const he = settings.value.uiLanguage === 'he'
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: [he ? 'חיבור' : 'Connect', he ? 'ביטול' : 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: he ? 'לחבר את Klara Wisper ל-Claude Desktop?' : 'Connect Klara Wisper to Claude Desktop?',
        detail: he
          ? 'תתווסף רשומה "klara-wisper" לקובץ ההגדרות של Claude Desktop (עותק של הקובץ הקודם יישמר כ-.bak). אחרי זה צריך לסגור ולפתוח מחדש את Claude.'
          : 'A "klara-wisper" entry will be added to Claude Desktop\'s config (the previous file is kept as .bak). Restart Claude afterwards.'
      })
      if (response !== 0) return claude.status()
      claude.connectDesktop()
    } else {
      await claude.connectCode()
    }
    // Connected on purpose: from now on the app may restore the connection at startup (index.ts).
    if (!settings.value.claudeConnected) settings.update({ claudeConnected: true })
    return claude.status()
  })

  handle('app:openExternal', (url: string) => {
    if (!safeExternal(url)) throw new Error('blocked URL')
    return shell.openExternal(url)
  })
  handle('dictation:toggle', () => dictation.toggle('button'))
  handle('dictation:state', () => dictation.publicState())
  if (devMode() && process.env.KLARA_SHOTS) {
    // Test hooks for scripts/e2e.cjs (development builds only): simulate the dictation key.
    handle('debug:hotkey', (state: string) => helper.emit('hotkey', { state }))
  }
  handle('app:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: settings.value.folder })
    if (r.canceled || !r.filePaths[0]) return null
    settings.update({ folder: r.filePaths[0] })
    db().rebuild()
    broadcast('meetings:changed', null)
    return r.filePaths[0]
  })
}
