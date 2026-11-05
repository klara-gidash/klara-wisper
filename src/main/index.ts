import { app, globalShortcut, Notification, protocol, session, shell } from 'electron'
import { appendFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { audio } from './audio'
import { matchPastMeetings } from './backfill'
import { restartEngineWhenIdle } from './models'
import * as claude from './claude'
import { dictation, TOGGLE_SHORTCUT } from './dictation'
import { engine } from './engine'
import { helper } from './helper'
import { appState, pushState, refreshPermissions, registerIpc } from './ipc'
import { Detector, needsConfirmation } from './meetings/detector'
import { recorder } from './meetings/recorder'
import { dataDir } from './paths'
import { explainMicDenied, isMicDenied } from './micPermission'
import { recoverInterrupted } from './recovery'
import { isAppUrl, safeExternal } from './security'
import { settings } from './settings'
import { setup } from './setup'
import { autoSummary } from './summarize'
import { db } from './storage/db'
import { createTray } from './tray'
import { watchLibrary } from './watch'
import { broadcast, pillWindow, showLibrary } from './windows'

app.setName('Klara Wisper')
// Chromium's own files (cache, local storage, crash reports) go to the same folder as everything else.
app.setPath('userData', dataDir)
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
process.umask(0o077) // transcripts, audio, voiceprints and logs are private to this user

// Keep a log next to the settings for troubleshooting (also shown in the terminal in dev).
const logFile = join(dataDir, 'main.log')
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    orig(...args)
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`)
    } catch {
      /* ignore */
    }
  }
}
void dictation // starts listening to the push-to-talk key

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showLibrary())
}

protocol.registerSchemesAsPrivileged([{ scheme: 'klara-media', privileges: { stream: true, supportFetchAPI: true } }])

/**
 * Windows only ever show the app's own pages: no navigation (e.g. a link dropped on the window),
 * no new windows, no web permissions (camera, mic, notifications…) for page content.
 */
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => {
    if (!isAppUrl(url)) ev.preventDefault()
  })
  contents.on('will-frame-navigate', (ev) => {
    if (!isAppUrl(ev.url)) ev.preventDefault()
  })
  contents.on('will-attach-webview', (ev) => ev.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    if (safeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})


/** klara-media://<meeting id>/audio.m4a — the meeting's audio, with byte ranges for seeking. */
function registerMedia(): void {
  protocol.handle('klara-media', (req) => {
    const url = new URL(req.url)
    const folder = db().getFolder(url.hostname)
    const file = folder ? join(folder, 'audio.m4a') : ''
    if (!file || !existsSync(file)) return new Response('not found', { status: 404 })
    const size = statSync(file).size
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
    let start = 0
    let end = size - 1
    if (range) {
      if (range[1]) {
        start = Number(range[1])
        if (range[2]) end = Math.min(Number(range[2]), size - 1)
      } else if (range[2]) {
        start = Math.max(0, size - Number(range[2])) // suffix range: the last N bytes
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
    }
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        'Content-Type': 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
      }
    })
  })
}

const detector = new Detector((source) => settings.value.detect[source as keyof typeof settings.value.detect] ?? true)

detector.on('start', async (cand) => {
  console.log(`call detected: ${cand.key} (${cand.appName})`)
  const live = recorder.live
  if (live && live.phase === 'recording') {
    const sameCall = recorder.detectorKey === cand.key || recorder.detectorKey?.split(':')[1] === cand.source
    if (sameCall || !recorder.detectorKey) {
      // Same call again (unmuted, rejoined), or a recording started by hand: keep this recording.
      recorder.cancelAutoStop(sameCall ? 'the call is using the microphone again' : `adopted ${cand.key}`)
      detector.claim(cand.key)
      recorder.detectorKey = cand.key
      return
    }
    if (!recorder.winding) {
      // Another call while this one is still going: try again in a moment.
      detector.release(cand.key)
      return
    }
    // The previous call already ended (we were only waiting for its audio to go quiet): close it now.
    console.log(`recording ${live.id}: closing it, a new call started`)
    await recorder.stop()
  }
  const he = settings.value.uiLanguage === 'he'
  // Known call apps (incl. Slack huddles and Aircall, which the detector only reports after the mic
  // was held without a break for a few seconds) record by themselves; a browser on the mic with
  // no meeting tab we recognise asks first.
  const sure = !needsConfirmation(cand)
  if (!settings.value.autoRecord || !sure) {
    const n = new Notification({
      title: he ? `שיחה ב-${cand.appName}` : `Call in ${cand.appName}`,
      body: he ? 'ללחוץ כדי להקליט ולתמלל' : 'Click to record and transcribe',
      silent: true
    })
    n.on('click', () => void recorder.start({ mode: 'meeting', ...cand, detectorKey: cand.key }).catch(() => undefined))
    n.show()
    return
  }
  if (engine.status.state !== 'ready') {
    detector.release(cand.key) // the engine is still starting up: retry shortly
    return
  }
  try {
    await recorder.start({ mode: 'meeting', source: cand.source, title: cand.title, appName: cand.appName, url: cand.url, micUids: cand.micUids, detectorKey: cand.key })
    new Notification({
      title: he ? `מקליטה את השיחה ב-${cand.appName}` : `Recording your ${cand.appName} call`,
      body: he ? 'התמלול מופיע בפאנל. אפשר לעצור בכל רגע.' : 'The transcript shows in the panel. Stop any time.',
      silent: true
    }).show()
  } catch (err) {
    console.error('auto-record failed', err)
    if (isMicDenied(err)) {
      detector.dismiss(cand.key)
      void explainMicDenied()
    } else {
      detector.release(cand.key)
    }
  }
})

detector.on('end', (key) => {
  console.log(`call released the microphone: ${key}`)
  if (recorder.live && recorder.detectorKey === key) recorder.requestAutoStop('the call app released the microphone')
})

async function configureHelper(): Promise<void> {
  try {
    await helper.request('setHotkey', { key: settings.value.hotkey })
    await helper.request('watchMeetings', { enabled: true })
    await audio.refreshDevices()
  } catch (err) {
    console.error('helper setup failed', err)
  }
  const perms = await refreshPermissions()
  console.log('helper permissions', JSON.stringify(perms))
  // macOS ties calendar access to this exact build (ad-hoc signature), so after an update it is
  // "not asked yet" again. Ask once right away instead of losing meeting names and attendees
  // until someone notices the "connect calendar" card. (A "no" for this build is not re-asked.)
  if (perms?.calendar === 'notDetermined' && settings.value.onboarded && !askedCalendar) {
    askedCalendar = true
    void helper
      .request('requestPermission', { kind: 'calendar' }, 180_000)
      .then((r) => console.log(`calendar asked after update: ${r.result}`))
      .catch(() => undefined)
      .finally(() => void refreshPermissions().then((p) => p?.calendar === 'granted' && catchUp()))
  } else if (perms?.calendar === 'granted') {
    catchUp()
  }
}
let askedCalendar = false
let caughtUp = false

/** Once per run, in the background: past calls get their calendar names, then Claude's notes. */
function catchUp(): void {
  if (caughtUp) return
  caughtUp = true
  setTimeout(() => {
    void matchPastMeetings()
      .catch((err) => console.warn('calendar look-up of past calls failed', err))
      .finally(() => void autoSummary.backfill())
  }, 30_000) // let the app settle first
}

app.whenReady().then(async () => {
  console.log(`Klara Wisper ${app.getVersion()} started (packaged: ${app.isPackaged})`)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  registerMedia()
  const index = db()
  if (index.isEmpty()) index.rebuild()
  registerIpc(detector)
  watchLibrary()

  helper.on('hello', () => void configureHelper())
  let micHolders = new Set<string>()
  helper.on('micUsers', (m) => {
    detector.update(m.users ?? [], m.tabs ?? {})
    // Log who takes and releases the microphone (helps tell when an app is really in a call).
    const now = new Set<string>((m.users ?? []).map((u: any) => u.bundleID || u.name).filter(Boolean))
    for (const id of now) if (!micHolders.has(id)) console.log(`microphone taken by ${id}`)
    for (const id of micHolders) if (!now.has(id)) console.log(`microphone released by ${id}`)
    micHolders = now
  })
  helper.on('exit', pushState)
  helper.on('error', (err: Error) => console.error(`helper: ${err.message}`))
  helper.start()

  let recovered = false
  engine.on('status', (s) => {
    pushState()
    if (s.state === 'ready' && !recovered) {
      recovered = true
      void recoverInterrupted(recorder.live?.id ?? null)
    }
  })
  engine.start()

  // First launch of an installed app: onboarding starts the setup (engine + models) and shows
  // its progress. After an update that needs a new engine, it runs by itself.
  setup.on('state', (s) => {
    pushState()
    if (s.phase === 'done') restartEngineWhenIdle() // never in the middle of a call
  })
  if (setup.refresh().needed && settings.value.onboarded) void setup.run()

  recorder.on('state', pushState)
  autoSummary.isBusy = () => !!recorder.live
  audio.on('devices', pushState)
  settings.on('change', (_v, patch) => {
    if (patch.hotkey) void helper.request('setHotkey', { key: patch.hotkey }).catch(() => undefined)
    if (patch.launchAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin })
    pushState()
  })
  // Keep macOS in line with the setting: a reinstall (scripts/dist.sh replaces the app) or a
  // settings file from elsewhere could leave the login item missing or stale.
  if (app.isPackaged && app.getLoginItemSettings().openAtLogin !== settings.value.launchAtLogin) {
    app.setLoginItemSettings({ openAtLogin: settings.value.launchAtLogin })
    console.log(`open at login: ${settings.value.launchAtLogin ? 'on' : 'off'} (synced with the setting)`)
  }

  if (!globalShortcut.register(TOGGLE_SHORTCUT, () => dictation.toggle('shortcut'))) {
    console.warn('could not register', TOGGLE_SHORTCUT)
  }
  // Claude Desktop sometimes rewrites its config without our entry; put the connection back so
  // Claude can always read the calls (a dated copy of the old file is kept).
  void claude
    .status()
    .then(async (s) => {
      if (s.desktopInstalled && !s.desktop) {
        claude.connectDesktop()
        console.log('Claude Desktop: the Klara Wisper connection was missing, added it back')
      }
      // Claude Code too (the CLI, or the copy inside Claude Desktop), with the skills, so Claude
      // can use the calls before, during and after them without any setup.
      if (s.codeCli && !s.code) {
        await claude.connectCode()
        console.log('Claude Code: connected Klara Wisper (MCP)')
      }
      const skills = claude.installSkills()
      if (skills.length) console.log(`Claude Code skills installed/updated: ${skills.join(', ')}`)
    })
    .catch((err) => console.warn('Claude connection check failed', err))
  createTray()
  pillWindow()
  if (!app.getLoginItemSettings().wasOpenedAtLogin || !settings.value.onboarded) {
    showLibrary(settings.value.onboarded ? 'library' : 'onboarding')
  }
  broadcast('state', appState())
})

app.on('activate', () => showLibrary())
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  /* keep running in the menu bar */
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  if (recorder.live && recorder.live.phase === 'recording') {
    e.preventDefault()
    quitting = true
    void recorder.stop().finally(() => {
      helper.stop()
      engine.stop()
      app.quit()
    })
    return
  }
  helper.stop()
  engine.stop()
})
