// Short recording smoke test: start a call, play one sentence, stop, print the saved meeting.
const { _electron: electron } = require('playwright')
const { execFile } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const app = await electron.launch({ args: [root], env: { ...process.env, KLARA_SHOTS: '1' } })
  let win = null
  for (let i = 0; i < 40 && !win; i++) {
    win = app.windows().find((w) => !/#\/(pill|live)/.test(w.url())) ?? null
    if (!win) await sleep(250)
  }
  const invoke = (ch, ...args) => win.evaluate(([c, a]) => window.klara.invoke(c, ...a), [ch, args])
  for (let i = 0; i < 120 && (await invoke('state')).engine.state !== 'ready'; i++) await sleep(1000)
  await invoke('live:start', { mode: process.argv[2] || 'meeting', source: process.argv[2] === 'inperson' ? 'inperson' : 'other', title: 'Smoke test' })
  await sleep(1000)
  await new Promise((r) => execFile('afplay', ['-v', process.argv[4] || '0.35', path.join(root, 'engine/tests/audio', (process.argv[3] || 'en2') + '.wav')], r))
  await sleep(1500)
  await invoke('live:stop')
  const list = await invoke('meetings:list')
  const m = await invoke('meetings:get', list[0].id)
  console.log(m.meta.title, '| audio:', m.meta.hasAudio, '| folder:', m.meta.folder)
  m.segments.forEach((s) => console.log('  ', s.stream, s.speaker, s.text))
  await app.close()
})().catch((e) => { console.error(e); process.exit(1) })
