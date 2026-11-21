// Walks the install wizard (src/renderer/src/views/Onboarding.tsx) like a novice would: it only ever
// clicks the big button at the bottom right of the wizard, waits while it is disabled, and screenshots
// every step. Connects to the running app over the Chrome DevTools Protocol
// ("Klara Wisper --remote-debugging-port=9222") with playwright-core's chromium.connectOverCDP.
//
//   node wizard.cjs <screenshot dir>
// env: PW_DIR       folder where playwright-core is installed (npm install --prefix PW_DIR playwright-core@x)
//      CDP_URL      default http://127.0.0.1:9222
//      DEAD_MIN     minutes the same step may keep its button disabled (default 35: model downloads)
//      PERM_DEAD_MIN  the same for the permissions step (default 4: macOS prompts can't be clicked on CI)
//      TOTAL_MIN    whole walk (default 75)
// Exit: 0 = wizard finished (its last button closed it), 1 = failure / dead end,
//       3 = blocked on the permissions step (a macOS prompt nobody can click on CI).
// Writes <dir>/wizard-result.json with every step seen.
//
// The footer markup it relies on (Onboarding.tsx):
//   <div className="mt-10 flex items-center justify-between"> [Back] <div> [secondary] [PRIMARY] </div></div>
// The primary button is the LAST button in that row. Every step's primary shows a <Next> arrow icon
// except the 'done' step ("Start"), whose click calls finish() and closes the wizard.
const path = require('path')
const fs = require('fs')
const { chromium } = require(path.join(process.env.PW_DIR || '.', 'node_modules', 'playwright-core'))

const outDir = process.argv[2] || 'wizard-shots'
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'
const DEAD_MS = Number(process.env.DEAD_MIN || 35) * 60_000
const PERM_DEAD_MS = Number(process.env.PERM_DEAD_MIN || 4) * 60_000
const TOTAL_MS = Number(process.env.TOTAL_MIN || 75) * 60_000
const FOOTER = 'div.mt-10.flex.items-center.justify-between button'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (m) => console.log(`ok: ${m}`)
const fail = (m) => console.log(`FAIL: ${m}`)

async function connect() {
  const until = Date.now() + 3 * 60_000
  let last
  while (Date.now() < until) {
    try {
      return await chromium.connectOverCDP(CDP)
    } catch (e) {
      last = e
      await sleep(2000)
    }
  }
  throw new Error(`could not connect to ${CDP}: ${last}`)
}

async function appPage(browser) {
  const until = Date.now() + 2 * 60_000
  while (Date.now() < until) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const url = p.url()
        // The app also has a small floating "pill" window (#/pill): the wizard is in the main window.
        if (!url.startsWith('devtools://') && url !== 'about:blank' && !url.includes('#/pill')) return p
      }
    }
    await sleep(1000)
  }
  throw new Error('no app window over CDP')
}

;(async () => {
  fs.mkdirSync(outDir, { recursive: true })
  const steps = []
  const result = { finished: false, blocked: null, steps }
  const save = () => fs.writeFileSync(path.join(outDir, 'wizard-result.json'), JSON.stringify(result, null, 2))
  let code = 1
  let browser
  try {
    browser = await connect()
    ok(`connected to ${CDP}`)
    const page = await appPage(browser)
    ok(`app window: ${page.url()}`)
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

    const start = Date.now()
    let n = 0
    let current = null // { label, since, disabledSince, clicks }
    let clickedFinish = false
    let sawFooter = false
    while (true) {
      if (Date.now() - start > TOTAL_MS) throw new Error(`wizard not finished after ${TOTAL_MS / 60_000} min`)
      const buttons = page.locator(FOOTER)
      const count = await buttons.count().catch(() => 0)
      if (count === 0) {
        if (clickedFinish) {
          result.finished = true
          ok(`wizard closed after its last step (${steps.length} steps, ${((Date.now() - start) / 60_000).toFixed(1)} min)`)
          await page.screenshot({ path: path.join(outDir, `${String(++n).padStart(2, '0')}-after-wizard.png`) }).catch(() => {})
          code = 0
          break
        }
        if (!sawFooter && Date.now() - start > 2 * 60_000) throw new Error('the wizard never showed (already onboarded?)')
        if (sawFooter && Date.now() - start > 60_000) {
          // a moment between steps (animation) is fine; a long absence is not
          await sleep(5000)
          if ((await page.locator(FOOTER).count().catch(() => 0)) === 0) throw new Error('the wizard footer disappeared without the last step being clicked')
        }
        await sleep(1000)
        continue
      }
      sawFooter = true
      const primary = buttons.last()
      const label = ((await primary.innerText().catch(() => '')) || '').trim()
      const disabled = await primary.isDisabled().catch(() => true)
      const isFinish = (await primary.locator('svg').count().catch(() => 1)) === 0
      const heading = ((await page.locator('h1, h2').first().innerText().catch(() => '')) || '').trim().slice(0, 80)

      if (!current || current.label !== label || current.heading !== heading) {
        current = { label, heading, since: Date.now(), disabledSince: disabled ? Date.now() : null, clicks: 0 }
        const shot = path.join(outDir, `${String(++n).padStart(2, '0')}-${label.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 30) || 'step'}.png`)
        await page.screenshot({ path: shot }).catch(() => {})
        steps.push({ heading, label, disabled, at: new Date().toISOString(), shot: path.basename(shot) })
        console.log(`step ${steps.length}: "${heading}" button "${label}"${disabled ? ' (disabled)' : ''}`)
        save()
      }

      if (disabled) {
        current.disabledSince ??= Date.now()
        const waited = Date.now() - current.disabledSince
        const permissions = /perm|הרשא|אישור/i.test(heading + ' ' + label)
        if (permissions && waited > PERM_DEAD_MS) {
          result.blocked = `permissions step: "${heading}" / "${label}" disabled for ${(waited / 60_000).toFixed(1)} min`
          await page.screenshot({ path: path.join(outDir, `${String(++n).padStart(2, '0')}-blocked.png`) }).catch(() => {})
          fail(`blocked: ${result.blocked}`)
          code = 3
          break
        }
        if (waited > DEAD_MS) throw new Error(`dead end: "${heading}" button "${label}" disabled for ${(waited / 60_000).toFixed(1)} min`)
        if (Math.round(waited / 1000) % 60 < 2) console.log(`... waiting on "${label}" (${Math.round(waited / 1000)} s)`)
        await sleep(2000)
        continue
      }
      current.disabledSince = null
      if (current.clicks >= 8) throw new Error(`dead end: clicked "${label}" on "${heading}" 8 times and the wizard did not move on`)
      await sleep(1500) // a person reads the page first; also lets state settle
      await primary.click({ timeout: 15_000 })
      current.clicks++
      if (isFinish) clickedFinish = true
      console.log(`  clicked "${label}"${isFinish ? ' (last step)' : ''}`)
      await sleep(isFinish ? 3000 : 2500)
      // a button that stays the same after a click (e.g. "repair"): wait longer before the next click
      if (current.clicks > 1) await sleep(30_000)
    }
    if (errors.length) {
      console.log(`renderer errors (${errors.length}):\n  ${errors.slice(0, 20).join('\n  ')}`)
      result.rendererErrors = errors.slice(0, 50)
    }
  } catch (e) {
    fail(String(e && e.message ? e.message : e))
    result.error = String(e && e.message ? e.message : e)
    code = 1
  } finally {
    save()
    // disconnect only: closing would quit the app
    if (browser) await browser.close().catch(() => {})
    process.exit(code)
  }
})()
