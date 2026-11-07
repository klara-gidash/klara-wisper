// Deterministic tests for the meeting detector: helper snapshots in, 'start'/'end' events out.
// Run with `npm run test:detector` (Node's own test runner and fake timers, no extra packages).
import { afterEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { Detector, needsConfirmation, type Candidate } from '../src/main/meetings/detector.ts'

type Tabs = Record<string, { url: string; title: string }[]>
type Ev = { type: 'start'; key: string; source: string; at: number; cand: Candidate } | { type: 'end'; key: string; at: number }

const user = (bundleID: string) => ({ pid: 100, bundleID, name: bundleID, input: true, inputDevices: ['BuiltInMicrophoneDevice'] })

let det: Detector | null = null

/** A detector on fake time. Ticks fall on whole seconds; helper snapshots arrive half a second later. */
function harness(enabled: (s: string) => boolean = () => true) {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 })
  const d = new Detector(enabled as never)
  det = d
  const events: Ev[] = []
  d.on('start', (c: Candidate) => events.push({ type: 'start', key: c.key, source: c.source, at: Date.now(), cand: c }))
  d.on('end', (k: string) => events.push({ type: 'end', key: k, at: Date.now() }))
  mock.timers.tick(500)
  return {
    d,
    events,
    /** The helper reports who holds the mic (and the open tabs of browsers that do). */
    mic(bundles: string[], tabs: Tabs = {}) {
      d.update(bundles.map(user), tabs)
    },
    wait(ms: number) {
      // Small steps: Node's fake clock jumps to the end of a tick() before running the timers in it.
      for (let left = ms; left > 0; left -= 500) mock.timers.tick(Math.min(500, left))
    },
    get now() {
      return Date.now()
    },
    starts: () => events.filter((e) => e.type === 'start') as Extract<Ev, { type: 'start' }>[],
    ends: () => events.filter((e) => e.type === 'end') as Extract<Ev, { type: 'end' }>[]
  }
}

afterEach(() => {
  det?.dispose()
  det = null
  mock.timers.reset()
})

/** Holds the mic for `holdMs`, releases it, and checks one start (and when) and one end. */
function callCycle(o: { bundles: string[]; tabs?: Tabs; key: string; source: string; startWithinMs: [number, number]; holdMs?: number; title?: string }) {
  const h = harness()
  const t0 = h.now
  h.mic(o.bundles, o.tabs ?? {})
  h.wait(o.holdMs ?? 60_000)
  const s = h.starts()
  assert.equal(s.length, 1, `one start, got ${JSON.stringify(h.events.map((e) => e.key))}`)
  assert.equal(s[0].key, o.key)
  assert.equal(s[0].source, o.source)
  const after = s[0].at - t0
  assert.ok(after >= o.startWithinMs[0] && after <= o.startWithinMs[1], `started ${after} ms after the mic was taken`)
  if (o.title !== undefined) assert.equal(s[0].cand.title, o.title)
  assert.equal(h.ends().length, 0, 'no end while the call holds the mic')
  const off = h.now
  h.mic([], {})
  h.wait(14_000)
  assert.equal(h.ends().length, 0, 'no end before 15 s without the mic')
  h.wait(2_000)
  const e = h.ends()
  assert.equal(e.length, 1, 'ended')
  assert.equal(e[0].key, o.key)
  assert.ok(e[0].at - off >= 15_000 && e[0].at - off <= 16_000)
  h.wait(60_000)
  assert.equal(h.starts().length, 1, 'no restart after the call')
  return { h, cand: s[0].cand }
}

// ---------------------------------------------------------------- desktop apps

test('Zoom desktop (us.zoom.xos): starts ~3 s after the mic is taken, ends 15 s after release', () => {
  const { cand } = callCycle({ bundles: ['us.zoom.xos'], key: 'app:zoom', source: 'zoom', startWithinMs: [3000, 4000] })
  assert.equal(needsConfirmation(cand), false)
})

test('Zoom desktop: sharing host us.zoom.CptHost also counts as the Zoom call', () => {
  callCycle({ bundles: ['us.zoom.CptHost'], key: 'app:zoom', source: 'zoom', startWithinMs: [3000, 4000] })
})

test('Zoom desktop: main + CptHost together are one call', () => {
  callCycle({ bundles: ['us.zoom.xos', 'us.zoom.CptHost'], key: 'app:zoom', source: 'zoom', startWithinMs: [3000, 4000] })
})

for (const b of ['com.microsoft.teams2', 'com.microsoft.teams2.helper', 'com.microsoft.teams', 'com.microsoft.teams.helper']) {
  test(`Teams desktop (${b})`, () => {
    const { cand } = callCycle({ bundles: [b], key: 'app:teams', source: 'teams', startWithinMs: [3000, 4000] })
    assert.equal(needsConfirmation(cand), false)
  })
}

for (const b of ['com.tinyspeck.slackmacgap', 'com.tinyspeck.slackmacgap.helper']) {
  test(`Slack desktop huddle (${b}) records by itself`, () => {
    const { cand } = callCycle({ bundles: [b], key: 'app:slack', source: 'slack', startWithinMs: [3000, 4000] })
    assert.equal(needsConfirmation(cand), false)
  })
}

test('Aircall call (io.aircall.workspace.helper): records by itself after 5 s held', () => {
  const { cand } = callCycle({ bundles: ['io.aircall.workspace.helper'], key: 'app:aircall', source: 'aircall', startWithinMs: [5000, 6000] })
  assert.equal(needsConfirmation(cand), false)
})

test('Aircall 1 s mic blip (as in the log, many times a day) does not start', () => {
  const h = harness()
  h.mic(['io.aircall.workspace.helper'])
  h.wait(1000)
  h.mic([])
  h.wait(120_000)
  assert.deepEqual(h.events, [])
})

test('Aircall: repeated 1 s blips a few seconds apart never add up to a call', () => {
  const h = harness()
  for (let i = 0; i < 30; i++) {
    h.mic(['io.aircall.workspace.helper'])
    h.wait(1000)
    h.mic([])
    h.wait(3000)
  }
  h.wait(60_000)
  assert.deepEqual(h.events, [])
})

test('Aircall: 4 s held is still not a call', () => {
  const h = harness()
  h.mic(['io.aircall.workspace.helper'])
  h.wait(4000)
  h.mic([])
  h.wait(60_000)
  assert.deepEqual(h.events, [])
})

test('Zoom/Teams/Slack desktop: a 2 s blip does not start', () => {
  for (const b of ['us.zoom.xos', 'com.microsoft.teams2', 'com.tinyspeck.slackmacgap.helper']) {
    const h = harness()
    h.mic([b])
    h.wait(2000)
    h.mic([])
    h.wait(60_000)
    assert.deepEqual(h.events, [], b)
    det!.dispose()
    mock.timers.reset()
  }
})

test('apps that are not calls (Granola, Siri/CoreSpeech, Claude, Cursor) are ignored', () => {
  const h = harness()
  h.mic(['com.granola.app.helper', 'com.apple.CoreSpeech', 'com.anthropic.claudefordesktop.helper', 'com.anysphere.sand.electron-helper'])
  h.wait(120_000)
  assert.deepEqual(h.events, [])
})

test('a source switched off in settings does not start', () => {
  const h = harness((s) => s !== 'zoom')
  h.mic(['us.zoom.xos'])
  h.wait(60_000)
  assert.deepEqual(h.events, [])
})

// ---------------------------------------------------------------- browsers

const MEET = 'https://meet.google.com/abc-defg-hij'
const meetTab = (url = MEET) => ({ url, title: 'Meet - abc-defg-hij' })

const browsers: [string, string, string][] = [
  ['Chrome', 'com.google.Chrome.helper', 'com.google.Chrome'],
  ['Safari', 'com.apple.WebKit.GPU', 'com.apple.Safari'],
  ['Arc', 'company.thebrowser.Browser.helper', 'company.thebrowser.Browser'],
  ['Arc', 'company.thebrowser.browser.helper', 'company.thebrowser.Browser'], // lower-case helper id
  ['Edge', 'com.microsoft.edgemac.helper', 'com.microsoft.edgemac'],
  ['Brave', 'com.brave.Browser.helper', 'com.brave.Browser']
]

for (const [name, helper, app] of browsers) {
  test(`Google Meet in ${name} (${helper})`, () => {
    const { cand } = callCycle({
      bundles: [helper],
      tabs: { [app]: [{ url: 'https://mail.google.com/mail/u/0/', title: 'Inbox' }, meetTab()] },
      key: `web:meet:${MEET}`,
      source: 'meet',
      startWithinMs: [3000, 4000],
      title: 'abc-defg-hij'
    })
    assert.equal(cand.appName, name)
    assert.equal(needsConfirmation(cand), false)
  })
}

test('Meet: ?authuser and /_meet/ forms of the URL are the same call', () => {
  const h = harness()
  h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [meetTab(`${MEET}?authuser=1`)] })
  h.wait(5000)
  h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [meetTab('https://meet.google.com/_meet/abc-defg-hij?hs=1')] })
  h.wait(60_000)
  assert.deepEqual(h.events.map((e) => `${e.type} ${e.key}`), [`start web:meet:${MEET}`])
})

test('Meet: muting for 10 s (Meet lets go of the mic) neither ends nor restarts the call', () => {
  const h = harness()
  const tabs = { 'com.google.Chrome': [meetTab()] }
  h.mic(['com.google.Chrome.helper'], tabs)
  h.wait(10_000)
  h.mic([], {})
  h.wait(10_000)
  h.mic(['com.google.Chrome.helper'], tabs)
  h.wait(60_000)
  assert.deepEqual(h.events.map((e) => e.type), ['start'])
})

const zoomWeb: [string, string][] = [
  ['https://app.zoom.us/wc/81234567890/join?fromPWA=1&pwd=x', 'https://app.zoom.us/wc/81234567890/start'],
  ['https://zoom.us/wc/join/81234567890', 'https://zoom.us/wc/81234567890/start'],
  ['https://us02web.zoom.us/wc/81234567890/join', 'https://us02web.zoom.us/wc/81234567890/start']
]
for (const [joinUrl, inCallUrl] of zoomWeb) {
  test(`Zoom in the browser (${new URL(joinUrl).host}): one call through join → in call, ends on release`, () => {
    const h = harness()
    h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [{ url: joinUrl, title: 'Zoom' }] })
    h.wait(5000)
    h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [{ url: inCallUrl, title: 'Zoom Meeting - Zoom' }] })
    h.wait(60_000)
    h.mic([], {})
    h.wait(16_000)
    assert.deepEqual(h.events.map((e) => `${e.type} ${e.key}`), ['start web:zoom:zoom.us/wc/81234567890', 'end web:zoom:zoom.us/wc/81234567890'])
    assert.equal((h.events[0] as { source: string }).source, 'zoom')
  })
}

for (const url of ['https://teams.microsoft.com/v2/', 'https://teams.live.com/v2/?ring=x', 'https://teams.cloud.microsoft/']) {
  test(`Teams on the web (${new URL(url).host}): starts after 8 s held`, () => {
    const host = new URL(url).host
    const { cand } = callCycle({
      bundles: ['com.microsoft.edgemac.helper'],
      tabs: { 'com.microsoft.edgemac': [{ url, title: 'Meeting with Dana | Microsoft Teams' }] },
      key: `web:teams:${host}`,
      source: 'teams',
      startWithinMs: [8000, 9000],
      title: 'Meeting with Dana'
    })
    assert.equal(needsConfirmation(cand), false)
  })
}

test('Slack huddle in the browser: records by itself after 8 s held', () => {
  const { cand } = callCycle({
    bundles: ['com.google.Chrome.helper'],
    tabs: { 'com.google.Chrome': [{ url: 'https://app.slack.com/client/T0123/C0456', title: 'general (Channel) - Acme - Slack' }] },
    key: 'web:slack:slack',
    source: 'slack',
    startWithinMs: [8000, 9000]
  })
  assert.equal(needsConfirmation(cand), false)
})

test('Slack tab open + 5 s of mic use in the browser (voice note, dictation) does not start', () => {
  const h = harness()
  h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [{ url: 'https://app.slack.com/client/T0123/C0456', title: 'Slack' }] })
  h.wait(5000)
  h.mic([], {})
  h.wait(60_000)
  assert.deepEqual(h.events, [])
})

test('a Meet tab wins over idle Slack and Teams tabs in the same browser', () => {
  const h = harness()
  h.mic(['com.google.Chrome.helper'], {
    'com.google.Chrome': [
      { url: 'https://app.slack.com/client/T0123/C0456', title: 'Slack' },
      { url: 'https://teams.microsoft.com/v2/', title: 'Chat | Microsoft Teams' },
      meetTab()
    ]
  })
  h.wait(30_000)
  assert.deepEqual(h.starts().map((e) => e.key), [`web:meet:${MEET}`])
})

test('browser on the mic, tabs unreadable (no Automation permission): web:unknown after 15 s, asks first', () => {
  const h = harness()
  h.mic(['com.google.Chrome.helper'], {})
  h.wait(14_000)
  assert.equal(h.starts().length, 0)
  h.wait(2000)
  const s = h.starts()
  assert.equal(s.length, 1)
  assert.equal(s[0].key, 'web:unknown:Chrome')
  assert.equal(needsConfirmation(s[0].cand), true)
  h.mic([], {})
  h.wait(16_000)
  assert.deepEqual(h.ends().map((e) => e.key), ['web:unknown:Chrome'])
})

test('Meet tab closed: Chrome lets go of the mic → the call ends 15 s later', () => {
  const h = harness()
  h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [meetTab(), { url: 'https://www.google.com/', title: 'Google' }] })
  h.wait(60_000)
  h.mic([], {}) // tab closed: no mic user, and the helper sends no tabs for browsers off the mic
  h.wait(16_000)
  assert.deepEqual(h.events.map((e) => `${e.type} ${e.key}`), [`start web:meet:${MEET}`, `end web:meet:${MEET}`])
})

test('Meet tab closed while the browser still uses the mic: the Meet call ends, the rest is only offered', () => {
  const h = harness()
  h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [meetTab(), { url: 'https://www.google.com/', title: 'Google' }] })
  h.wait(60_000)
  h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [{ url: 'https://www.google.com/', title: 'Google' }] })
  h.wait(40_000)
  assert.deepEqual(h.events.map((e) => `${e.type} ${e.key}`), [`start web:meet:${MEET}`, `end web:meet:${MEET}`, 'start web:unknown:Chrome'])
  assert.equal(needsConfirmation(h.starts()[1].cand), true)
})

test('tabs briefly unreadable mid-call (osascript timed out): the Meet call neither ends nor turns "unknown"', () => {
  const h = harness()
  const tabs = { 'com.google.Chrome': [meetTab()] }
  h.mic(['com.google.Chrome.helper'], tabs)
  h.wait(30_000)
  h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [] })
  h.wait(30_000)
  h.mic(['com.google.Chrome.helper'], tabs)
  h.wait(30_000)
  assert.deepEqual(h.events.map((e) => `${e.type} ${e.key}`), [`start web:meet:${MEET}`])
})

// ---------------------------------------------------------------- several candidates, stop, retry

test('two calls at once: the first one is recorded; the other starts once the first ends', () => {
  const h = harness()
  h.mic(['us.zoom.xos'])
  h.wait(2000)
  h.mic(['us.zoom.xos', 'com.google.Chrome.helper'], { 'com.google.Chrome': [meetTab()] })
  h.wait(60_000)
  assert.deepEqual(h.starts().map((e) => e.key), ['app:zoom'])
  h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [meetTab()] })
  h.wait(17_000)
  assert.deepEqual(h.events.map((e) => `${e.type} ${e.key}`), ['start app:zoom', 'end app:zoom', `start web:meet:${MEET}`])
})

test('Aircall blips during a Meet call do not take over', () => {
  const h = harness()
  const tabs = { 'com.google.Chrome': [meetTab()] }
  h.mic(['com.google.Chrome.helper'], tabs)
  h.wait(10_000)
  h.mic(['com.google.Chrome.helper', 'io.aircall.workspace.helper'], tabs)
  h.wait(1000)
  h.mic(['com.google.Chrome.helper'], tabs)
  h.wait(60_000)
  assert.deepEqual(h.events.map((e) => `${e.type} ${e.key}`), [`start web:meet:${MEET}`])
})

test('stopped by the user: not restarted while that call goes on, but the next call is recorded', () => {
  const h = harness()
  h.mic(['us.zoom.xos'])
  h.wait(10_000)
  h.d.dismiss('app:zoom')
  h.wait(60_000)
  assert.equal(h.starts().length, 1)
  h.mic([])
  h.wait(30_000)
  h.mic(['us.zoom.xos'])
  h.wait(5000)
  assert.equal(h.starts().length, 2)
})

test('stopped by the user after the call had already ended: the next call is still recorded', () => {
  const h = harness()
  h.mic(['us.zoom.xos'])
  h.wait(60_000)
  h.mic([])
  h.wait(40_000) // 'end' fired, the entry is gone; the recording waits for quiet audio
  assert.equal(h.ends().length, 1)
  h.d.dismiss('app:zoom') // the user presses Stop now
  h.wait(10 * 60_000)
  h.mic(['us.zoom.xos']) // next day's Zoom call
  h.wait(5000)
  assert.equal(h.starts().length, 2, 'a later Zoom call must not stay dismissed forever')
})

test('release(): the app was busy, the same call is announced again 5 s later', () => {
  const h = harness()
  h.mic(['us.zoom.xos'])
  h.wait(4000)
  assert.equal(h.starts().length, 1)
  h.d.release('app:zoom')
  h.wait(3000)
  assert.equal(h.starts().length, 1)
  h.wait(3000)
  assert.equal(h.starts().length, 2)
})

test('claim(): a recording started by hand for the current call is not announced again', () => {
  const h = harness()
  h.mic(['us.zoom.xos'])
  h.wait(1000)
  h.d.claim(h.d.current()!.key)
  h.wait(60_000)
  assert.equal(h.starts().length, 0)
  h.mic([])
  h.wait(16_000)
  assert.deepEqual(h.ends().map((e) => e.key), ['app:zoom'])
})

// ---------------------------------------------------------------- chat apps, more sites, unknown apps

test('WhatsApp desktop (net.whatsapp.WhatsApp): records after 10 s (voice messages are shorter)', () => {
  const { cand } = callCycle({ bundles: ['net.whatsapp.WhatsApp'], key: 'app:whatsapp', source: 'whatsapp', startWithinMs: [10_000, 11_000] })
  assert.equal(needsConfirmation(cand), false)
})

test('a short WhatsApp voice message (6 s) is not a call', () => {
  const h = harness()
  h.mic(['net.whatsapp.WhatsApp'])
  h.wait(6_000)
  h.mic([])
  h.wait(60_000)
  assert.equal(h.starts().length, 0)
})

test('WhatsApp Web in Chrome records by itself', () => {
  callCycle({
    bundles: ['com.google.Chrome.helper'],
    tabs: { 'com.google.Chrome': [{ url: 'https://web.whatsapp.com/', title: 'WhatsApp' }] },
    key: 'web:whatsapp:whatsapp',
    source: 'whatsapp',
    startWithinMs: [10_000, 11_000]
  })
})

for (const [bundle, source] of [
  ['ru.keepcoder.Telegram', 'telegram'],
  ['org.telegram.desktop', 'telegram'],
  ['com.hnc.Discord.helper', 'discord'],
  ['org.whispersystems.signal-desktop.helper', 'signal'],
  ['com.facebook.archon', 'messenger'],
  ['com.logmein.goto', 'goto']
] as const) {
  test(`${source} desktop (${bundle}) records by itself`, () => {
    const after = source === 'goto' ? [3000, 4000] : [10_000, 11_000]
    callCycle({ bundles: [bundle], key: `app:${source}`, source, startWithinMs: after as [number, number] })
  })
}

for (const [url, source, key] of [
  ['https://web.telegram.org/a/', 'telegram', 'web:telegram:telegram'],
  ['https://discord.com/channels/123/456', 'discord', 'web:discord:discord'],
  ['https://www.messenger.com/t/123', 'messenger', 'web:messenger:messenger'],
  ['https://acme.webex.com/meet/someone', 'webex', 'web:webex:acme.webex.com'],
  ['https://app.goto.com/meeting/123456789', 'goto', 'web:goto:https://app.goto.com/meeting/123456789'],
  ['https://us02web.zoom.us/s/81234567890', 'zoom', 'web:zoom:zoom.us/wc/81234567890']
] as const) {
  test(`${source} in the browser (${url}) records by itself`, () => {
    const chat = ['telegram', 'discord', 'messenger'].includes(source)
    callCycle({
      bundles: ['com.google.Chrome.helper'],
      tabs: { 'com.google.Chrome': [{ url, title: 'x' }] },
      key,
      source,
      startWithinMs: chat ? [10_000, 11_000] : [3000, 4000]
    })
  })
}

test('Meet inside Gmail (the title shows the meeting code) counts as Meet', () => {
  callCycle({
    bundles: ['com.google.Chrome.helper'],
    tabs: { 'com.google.Chrome': [{ url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Meet - abc-defg-hij - Gmail' }] },
    key: 'web:meet:gmail',
    source: 'meet',
    startWithinMs: [3000, 4000]
  })
})

test('Gmail without a meeting code in the title is not a Meet call', () => {
  const h = harness()
  h.mic(['com.google.Chrome.helper'], { 'com.google.Chrome': [{ url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox (3) - Gmail' }] })
  h.wait(20_000)
  const s = h.starts()
  assert.equal(s.length, 1)
  assert.equal(s[0].key, 'web:unknown:Chrome')
})

test('Firefox on the mic (tabs unreadable) asks first after 15 s', () => {
  const h = harness()
  h.mic(['org.mozilla.firefox'])
  h.wait(16_000)
  const s = h.starts()
  assert.equal(s.length, 1)
  assert.equal(s[0].key, 'web:unknown:Firefox')
  assert.equal(needsConfirmation(s[0].cand), true)
})

test('an unknown desktop app on the mic is announced after 15 s ("click to record")', () => {
  const h = harness()
  h.mic(['com.example.softphone'])
  h.wait(14_000)
  assert.equal(h.starts().length, 0)
  h.wait(2_000)
  const s = h.starts()
  assert.equal(s.length, 1)
  assert.equal(s[0].key, 'app:unknown:com.example.softphone')
  assert.equal(needsConfirmation(s[0].cand), true)
})

test('a parked unknown call does not block a known call that starts meanwhile', () => {
  const h = harness()
  h.mic(['com.example.softphone'])
  h.wait(16_000)
  assert.equal(h.starts()[0].key, 'app:unknown:com.example.softphone')
  h.d.park('app:unknown:com.example.softphone')
  h.mic(['com.example.softphone', 'us.zoom.xos'])
  h.wait(5_000)
  const keys = h.starts().map((s) => s.key)
  assert.deepEqual(keys, ['app:unknown:com.example.softphone', 'app:zoom'])
})

test('Meet A then Meet B in the same browser: A ends at once, B starts', () => {
  const h = harness()
  const tabA = { 'com.google.Chrome': [{ url: 'https://meet.google.com/aaa-bbbb-ccc', title: 'Meet - A' }] }
  const tabB = { 'com.google.Chrome': [{ url: 'https://meet.google.com/ddd-eeee-fff', title: 'Meet - B' }] }
  h.mic(['com.google.Chrome.helper'], tabA)
  h.wait(10_000)
  h.mic(['com.google.Chrome.helper'], tabB)
  h.wait(2_000)
  assert.deepEqual(h.ends().map((e) => e.key), ['web:meet:https://meet.google.com/aaa-bbbb-ccc'])
  h.wait(5_000)
  assert.deepEqual(h.starts().map((s) => s.key), ['web:meet:https://meet.google.com/aaa-bbbb-ccc', 'web:meet:https://meet.google.com/ddd-eeee-fff'])
})

// ---------------------------------------------------------------- Windows inputs

for (const [bundle, source] of [
  ['zoom.exe', 'zoom'],
  ['ms-teams.exe', 'teams'],
  ['5319275a.whatsappdesktop_cv1g1gvanyjgm', 'whatsapp'],
  ['91750d7e.slack_8she8kybcnzg4', 'slack'],
  ['discord.exe', 'discord']
] as const) {
  test(`Windows: ${bundle} → ${source}`, () => {
    const h = harness()
    h.mic([bundle])
    h.wait(12_000)
    const s = h.starts()
    assert.equal(s.length, 1)
    assert.equal(s[0].key, `app:${source}`)
  })
}

test('Windows: a Meet window title in Chrome counts as Meet', () => {
  const h = harness()
  h.mic(['chrome.exe'], { 'chrome.exe': [{ url: '', title: 'Meet - abc-defg-hij - Google Chrome' }] })
  h.wait(4_000)
  assert.equal(h.starts()[0]?.source, 'meet')
})

test('dictation and voice apps (Superwhisper, Wispr, Siri, Voice Memos, QuickTime) are never announced', () => {
  const h = harness()
  h.mic(['com.superduper.superwhisper', 'com.electron.wispr-flow', 'com.apple.siri.helper', 'com.apple.VoiceMemos', 'com.apple.QuickTimePlayerX', 'com.openai.chat'])
  h.wait(60_000)
  assert.deepEqual(h.events, [])
})
