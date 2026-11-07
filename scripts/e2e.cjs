// End-to-end test of the app from this checkout: records a "call" (test audio played through the
// speakers and captured as system audio), waits until the transcript is saved, checks it, then
// search and a dictation.
// Usage: node scripts/e2e.cjs <shotsDir>      Exit code 1 = a check failed.
//
// DEVELOPMENT ONLY, never on CI and never against the installed app:
//  - It needs the debug helper (`bash scripts/build-helper.sh debug`): the release helper only
//    serves the signed Klara Wisper.app, not Electron started from this checkout.
//  - Quit the installed Klara Wisper first (single-instance lock: this copy would just exit).
//  - Don't run it on a Mac whose installed app's permissions matter: the debug helper is another
//    build of the same helper, so macOS asks for the microphone, system audio and other permissions
//    again and may tie them to this build instead of the installed one.
// See the README's helper notes (the "הרשאות macOS" and "אבטחה" sections).
//
// Stopping a recording returns at once; the transcript is saved later, in the background
// (src/main/meetings/finalize.ts). So this waits for that meeting's meetings:changed event and
// polls meetings:get until the meeting is "done".
const { _electron: electron } = require('playwright')
const { execFile, execFileSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const audio = (n) => path.join(root, 'engine', 'tests', 'audio', `${n}.wav`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const play = (file, vol = '0.35') => new Promise((r) => execFile('afplay', ['-v', vol, file], () => r()))
const SAVE_TIMEOUT_MS = 12 * 60_000 // the finalizer itself gives up on the engine after 10 idle minutes

const failures = []
function check(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`)
  if (!ok) failures.push(what)
}

/** Waits until the background finalizer has saved meeting `id` (status "done"), and returns it. */
async function waitSaved(win, invoke, id) {
  const t0 = Date.now()
  let status = 'not indexed yet'
  while (Date.now() - t0 < SAVE_TIMEOUT_MS) {
    const changed = await win.evaluate((i) => window.__changed.includes(i), id)
    // meetings:get throws "meeting not found" until the meeting is in the index.
    const m = await invoke('meetings:get', id).catch(() => null)
    if (m) status = m.meta.status
    if (m && m.meta.status === 'done') {
      console.log(`saved ${Math.round((Date.now() - t0) / 1000)}s after stopping (meetings:changed ${changed ? 'received' : 'not seen'})`)
      return m
    }
    if (m && m.meta.status === 'error') throw new Error(`meeting ${id} ended with an error: ${m.meta.error}`)
    await sleep(1000)
  }
  throw new Error(`meeting ${id} was not saved within ${SAVE_TIMEOUT_MS / 60_000} minutes (status: ${status})`)
}

;(async () => {
  const shots = process.argv[2] || 'shots'
  const app = await electron.launch({ args: [root], env: { ...process.env, KLARA_SHOTS: '1' } })
  try {
    let win = null
    for (let i = 0; i < 40 && !win; i++) {
      win = app.windows().find((w) => !/#\/(pill|live)/.test(w.url())) ?? null
      if (!win) await sleep(250)
    }
    if (!win) throw new Error('the library window did not open (is the installed app running?)')
    win.on('pageerror', (e) => console.log('[pageerror]', e.message))
    const invoke = (ch, ...args) => win.evaluate(([c, a]) => window.klara.invoke(c, ...a), [ch, args])

    // wait for the engine
    for (let i = 0; i < 120; i++) {
      const s = await invoke('state')
      if (s.engine.state === 'ready' && s.helperReady) break
      await sleep(1000)
    }
    const state = await invoke('state')
    console.log('engine:', state.engine)
    if (state.engine.state !== 'ready') throw new Error(`engine not ready: ${JSON.stringify(state.engine)}`)
    if (!state.helperReady) throw new Error('the helper is not running (build it with `bash scripts/build-helper.sh debug`)')
    await win.evaluate(() => {
      window.__segs = []
      window.__changed = []
      window.klara.on('live:segment', (s) => window.__segs.push(s))
      window.klara.on('meetings:changed', (id) => window.__changed.push(id))
    })

    // 1) an online "call": system audio = test speakers
    const t0 = Date.now()
    const session = await invoke('live:start', { mode: 'meeting', source: 'other', title: 'E2E test call' })
    if (!session) throw new Error('the recording did not start (microphone permission denied?)')
    const id = session.id
    await sleep(1500)
    await play(audio('meeting4'))
    await play(audio('he'))
    await sleep(2500)
    const liveSegs = await win.evaluate(() => window.__segs)
    console.log('\nLIVE segments:', liveSegs.length)
    liveSegs.forEach((s) => console.log('  ', `${s.stream}/${s.speaker}/${s.lang}: ${s.text}`))
    const liveWin = app.windows().find((w) => /#\/live/.test(w.url()))
    if (liveWin) await liveWin.screenshot({ path: path.join(shots, 'live-panel.png') })
    await invoke('live:stop')
    console.log(`\nrecorded and stopped in ${Math.round((Date.now() - t0) / 1000)}s; waiting for the transcript to be saved`)
    const m = await waitSaved(win, invoke, id)
    console.log('saved meeting:', m.meta.title, '| folder:', m.meta.folder, '| audio:', m.meta.hasAudio)
    console.log('speakers:', JSON.stringify(Object.fromEntries(Object.entries(m.meta.speakers).map(([k, v]) => [k, { name: v.name, isMe: v.isMe }]))))
    m.segments.forEach((s) => console.log(`   ${s.start.toFixed(1).padStart(5)} ${s.stream.padEnd(6)} ${String(s.speaker).padEnd(5)} ${s.lang} ${s.text}`))

    check(m.segments.length > 0, `the saved transcript has lines (${m.segments.length})`)
    // Both streams were recorded and transcribed. A mic line that repeats what the speakers played is
    // dropped from the saved transcript as an echo (engine.py _dedupe_echo), and here all the audio
    // comes from the speakers, so a stream also counts when it showed up in the live transcript.
    for (const stream of ['mic', 'system']) {
      const saved = m.segments.filter((s) => s.stream === stream).length
      const live = liveSegs.filter((s) => s.stream === stream).length
      check(saved > 0 || live > 0, `the ${stream} stream is present (saved ${saved}, live ${live})`)
    }

    const hits = await invoke('search', 'תוכנית')
    console.log('\nsearch "תוכנית":', hits.map((h) => `${h.title} (${h.segments.length})`))
    const hits2 = await invoke('search', 'budget')
    console.log('search "budget":', hits2.map((h) => `${h.title} (${h.segments.length})`))

    await win.evaluate((mid) => (window.location.hash = `/meeting/${mid}`), m.meta.id)
    await sleep(1200)
    await win.screenshot({ path: path.join(shots, 'meeting-view.png') })

    // 2) dictation: simulated key, test sentence played aloud into the microphone
    const clip = execFileSync('pbpaste').toString()
    await win.evaluate(() => {
      window.__dict = null
      window.klara.on('dictations:changed', (d) => (window.__dict = d))
    })
    await invoke('debug:hotkey', 'down')
    await sleep(600)
    await play(audio('mixed'), '1')
    await sleep(500)
    await invoke('debug:hotkey', 'up')
    for (let i = 0; i < 40; i++) {
      const d = await win.evaluate(() => window.__dict)
      if (d) {
        console.log('\nDICTATION:', d.lang, '|', d.text)
        break
      }
      await sleep(500)
    }
    execFileSync('pbcopy', { input: clip })
  } finally {
    await app.close().catch(() => undefined)
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\nall checks passed')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
