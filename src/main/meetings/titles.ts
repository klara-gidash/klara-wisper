// No imports: Node runs this file directly in tests (test/titles.test.mts).

/** What call apps and browser tabs name a call when they don't know its subject. */
const GENERIC = new Set([
  'meet', 'google meet', 'zoom', 'zoom meeting', 'zoom workplace', 'zoom webinar', 'chat', 'google chat',
  'microsoft teams', 'teams', 'meeting', 'call', 'slack', 'huddle', 'slack huddle', 'webex', 'gmail',
  'whatsapp', 'telegram', 'discord', 'signal', 'messenger', 'facetime', 'aircall', 'goto', 'goto meeting'
])

const MEET_CODE = /^(?:meet\s*[-–—:]\s*)?[a-z]{3}-[a-z]{4}-[a-z]{3}$/i
const DEFAULT_TIME = /^(.+?)\s+\d{1,2}:\d{2}$/

/**
 * True when a call's title says nothing about it, so the calendar event's title should replace it:
 * a Meet code ("abc-defg-hij"), an app or site name ("Zoom Meeting", "Microsoft Teams", "Chat"),
 * or the app's default "<App> HH:MM". `labels`: the app names used in default titles.
 */
export function isGenericTitle(title: string | null | undefined, labels: string[] = []): boolean {
  const t = (title ?? '').replace(/[‎‏‪-‮⁦-⁩]/g, '').trim()
  if (!t) return true
  if (MEET_CODE.test(t)) return true
  const lower = t.toLowerCase()
  if (GENERIC.has(lower)) return true
  const m = DEFAULT_TIME.exec(t)
  if (m) {
    const prefix = m[1].toLowerCase()
    if (GENERIC.has(prefix) || prefix === 'פגישה' || labels.some((l) => l.toLowerCase() === prefix)) return true
  }
  return false
}
