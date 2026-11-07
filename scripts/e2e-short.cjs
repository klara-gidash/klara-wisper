// Short recording smoke test: start a call, play one sentence, stop, wait until the transcript is
// saved, check it and print it.
// Usage: node scripts/e2e-short.cjs [meeting|inperson] [audio name in engine/tests/audio] [volume]
// Exit code 1 = a check failed.
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
const { execFile } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SAVE_TIMEOUT_MS = 12 * 60_000 // the finalizer itself gives up on the engine after 10 idle minutes
const mode = process.argv[2] || 'meeting'

;(async () => {
  const failures = []
  const check = (ok, what) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`)
    if (!ok) failures.push(what)
  }
  const app = await electron.launch({ args: [root], env: { ...process.env, KLARA_SHOTS: '1' } })
  try {
    let win = null
    for (let i = 0; i < 40 && !win; i++) {
      win = app.windows().find((w) => !/#\/(pill|live)/.test(w.url())) ?? null
      if (!win) await sleep(250)
    }
    if (!win) throw new Error('the library window did not open (is the installed app running?)')
    const invoke = (ch, ...args) => win.evaluate(([c, a]) => window.klara.invoke(c, ...a), [ch, args])
    for (let i = 0; i < 120 && (await invoke('state')).engine.state !== 'ready'; i++) await sleep(1000)
    await win.evaluate(() => {
      window.__segs = []
      window.__changed = []
      window.klara.on('live:segment', (s) => window.__segs.push(s))
      window.klara.on('meetings:changed', (id) => window.__changed.push(id))
    })
    const session = await invoke('live:start', { mode, source: mode === 'inperson' ? 'inperson' : 'other', title: 'Smoke test' })
    if (!session) throw new Error('the recording did not start (microphone permission denied?)')
    const id = session.id
    await sleep(1000)
    await new Promise((r) => execFile('afplay', ['-v', process.argv[4] || '0.35', path.join(root, 'engine/tests/audio', (process.argv[3] || 'en2') + '.wav')], r))
    await sleep(1500)
    await invoke('live:stop')

    // Wait for the background finalizer: meetings:get throws "meeting not found" until it is indexed.
    const t0 = Date.now()
    let m = null
    while (Date.now() - t0 < SAVE_TIMEOUT_MS) {
      m = await invoke('meetings:get', id).catch(() => null)
      if (m && (m.meta.status === 'done' || m.meta.status === 'error')) break
      await sleep(1000)
    }
    if (!m || m.meta.status !== 'done') {
      throw new Error(`meeting ${id} was not saved within ${SAVE_TIMEOUT_MS / 60_000} minutes (status: ${m ? m.meta.status : 'not indexed'}${m?.meta.error ? `, ${m.meta.error}` : ''})`)
    }
    const changed = await win.evaluate((i) => window.__changed.includes(i), id)
    console.log(`saved ${Math.round((Date.now() - t0) / 1000)}s after stopping (meetings:changed ${changed ? 'received' : 'not seen'})`)
    console.log(m.meta.title, '| audio:', m.meta.hasAudio, '| folder:', m.meta.folder)
    m.segments.forEach((s) => console.log('  ', s.stream, s.speaker, s.text))

    check(m.segments.length > 0, `the saved transcript has lines (${m.segments.length})`)
    if (mode === 'meeting') {
      // A mic line that repeats what the speakers played is dropped from the saved transcript as an
      // echo (engine.py _dedupe_echo), and here the audio comes from the speakers, so a stream also
      // counts when it showed up in the live transcript.
      const liveSegs = await win.evaluate(() => window.__segs)
      for (const stream of ['mic', 'system']) {
        const saved = m.segments.filter((s) => s.stream === stream).length
        const live = liveSegs.filter((s) => s.stream === stream).length
        check(saved > 0 || live > 0, `the ${stream} stream is present (saved ${saved}, live ${live})`)
      }
    }
  } finally {
    await app.close().catch(() => undefined)
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('all checks passed')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
