// End-to-end test of the real app: records a "call" (test audio played through the speakers and
// captured from system audio), checks the saved transcript, search, and a dictation.
// Usage: node scripts/e2e.cjs <shotsDir>
const { _electron: electron } = require('playwright')
const { execFile, execFileSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const audio = (n) => path.join(root, 'engine', 'tests', 'audio', `${n}.wav`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const play = (file, vol = '0.35') => new Promise((r) => execFile('afplay', ['-v', vol, file], () => r()))

;(async () => {
  const shots = process.argv[2] || 'shots'
  const app = await electron.launch({ args: [root], env: { ...process.env, KLARA_SHOTS: '1' } })
  let win = null
  for (let i = 0; i < 40 && !win; i++) {
    win = app.windows().find((w) => !/#\/(pill|live)/.test(w.url())) ?? null
    if (!win) await sleep(250)
  }
  win.on('pageerror', (e) => console.log('[pageerror]', e.message))
  const invoke = (ch, ...args) => win.evaluate(([c, a]) => window.klara.invoke(c, ...a), [ch, args])

  // wait for the engine
  for (let i = 0; i < 120; i++) {
    const s = await invoke('state')
    if (s.engine.state === 'ready' && s.helperReady) break
    await sleep(1000)
  }
  console.log('engine:', (await invoke('state')).engine)
  await win.evaluate(() => {
    window.__segs = []
    window.klara.on('live:segment', (s) => window.__segs.push(s))
  })

  // 1) an online "call": system audio = test speakers
  const t0 = Date.now()
  await invoke('live:start', { mode: 'meeting', source: 'other', title: 'E2E test call' })
  await sleep(1500)
  await play(audio('meeting4'))
  await play(audio('he'))
  await sleep(2500)
  const live = await win.evaluate(() => window.__segs.map((s) => `${s.stream}/${s.speaker}/${s.lang}: ${s.text}`))
  console.log('\nLIVE segments:', live.length)
  live.forEach((l) => console.log('  ', l))
  const liveWin = app.windows().find((w) => /#\/live/.test(w.url()))
  if (liveWin) await liveWin.screenshot({ path: path.join(shots, 'live-panel.png') })
  await invoke('live:stop')
  for (let i = 0; i < 120; i++) {
    const s = await invoke('state')
    if (!s.live) break
    await sleep(1000)
  }
  console.log(`\nrecorded + saved in ${Math.round((Date.now() - t0) / 1000)}s`)
  const list = await invoke('meetings:list')
  const m = await invoke('meetings:get', list[0].id)
  console.log('saved meeting:', m.meta.title, '| folder:', m.meta.folder, '| audio:', m.meta.hasAudio)
  console.log('speakers:', JSON.stringify(Object.fromEntries(Object.entries(m.meta.speakers).map(([k, v]) => [k, { name: v.name, isMe: v.isMe }]))))
  m.segments.forEach((s) => console.log(`   ${s.start.toFixed(1).padStart(5)} ${s.stream.padEnd(6)} ${String(s.speaker).padEnd(5)} ${s.lang} ${s.text}`))
  const hits = await invoke('search', 'תוכנית')
  console.log('\nsearch "תוכנית":', hits.map((h) => `${h.title} (${h.segments.length})`))
  const hits2 = await invoke('search', 'budget')
  console.log('search "budget":', hits2.map((h) => `${h.title} (${h.segments.length})`))

  await win.evaluate((id) => (window.location.hash = `/meeting/${id}`), m.meta.id)
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
  await app.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
