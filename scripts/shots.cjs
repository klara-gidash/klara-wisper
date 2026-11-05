// Launches the built app with Playwright and saves screenshots of its windows.
// Usage: node scripts/shots.cjs <outDir> [route ...]   (routes: library, settings, onboarding, meeting/<id>, ...)
const { _electron: electron } = require('playwright')
const path = require('node:path')
const fs = require('node:fs')

;(async () => {
  const out = process.argv[2] || 'shots'
  const routes = process.argv.slice(3)
  fs.mkdirSync(out, { recursive: true })
  const app = await electron.launch({ args: [path.resolve(__dirname, '..')], env: { ...process.env, KLARA_SHOTS: '1' } })
  let win = null
  for (let i = 0; i < 40 && !win; i++) {
    win = app.windows().find((w) => !/#\/(pill|live)/.test(w.url())) ?? null
    if (!win) await new Promise((r) => setTimeout(r, 250))
  }
  if (!win) throw new Error('library window not found')
  win.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()))
  win.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await win.setViewportSize({ width: 1200, height: 800 }).catch(() => {})
  await win.waitForTimeout(2500)
  // ipc-check: the sandboxed page can still reach the main process
  console.log('ipc-check state:', JSON.stringify(await win.evaluate(() => window.klara.invoke('state').then((s) => ({ engine: s.engine.state, lang: s.settings.uiLanguage })))))
  console.log('ipc-check node in page:', await win.evaluate(() => typeof require + '/' + typeof process))
  for (const route of routes.length ? routes : ['library']) {
    for (const theme of ['light', 'dark']) {
      await win.evaluate(([r, th]) => {
        window.location.hash = `/${r}`
        document.documentElement.classList.toggle('dark', th === 'dark')
      }, [route, theme])
      await win.waitForTimeout(900)
      const file = path.join(out, `${route.replace(/[/?=&]/g, '_')}-${theme}.png`)
      await win.screenshot({ path: file })
      console.log('saved', file)
    }
  }
  await app.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
