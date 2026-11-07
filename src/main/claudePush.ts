import { app, clipboard, Notification, shell } from 'electron'
import type { MeetingMeta } from '@shared/types'
import { safeExternal } from './security'
import { settings } from './settings'
import { db } from './storage/db'
import { readMeta } from './storage/files'

/**
 * Optional (Settings > Integrations, off by default): after a call, open Claude with a ready
 * prompt about it ("notify": a notification to click; "open": right away). Claude Desktop reads
 * the call through the klara-wisper connector. The prompt is only prefilled, never sent.
 *
 * Deep link: claude://claude.ai/new?q=<prompt> (Claude Desktop registers the "claude" URL scheme;
 * documented in "Open Claude Desktop with a link", support.claude.com/en/articles/14729294).
 * Without Claude Desktop: https://claude.ai/new?q=<prompt> in the browser.
 */
const DESKTOP_PREFIX = 'claude://claude.ai/new?q='
const WEB_PREFIX = 'https://claude.ai/new?q='
const MAX_PROMPT = 2000 // the link allows ~14,000 characters; ours is one line
const FRESH_MS = 3 * 3600_000 // only calls that just ended (never the earlier calls the backfill summarizes)
const MAX_WAIT_MS = 8 * 3600_000

const pushed = new Set<string>()
const shown = new Set<Notification>() // kept alive until clicked/closed, so the click still arrives

const pad = (n: number): string => String(n).padStart(2, '0')

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The prompt Claude opens with: show the saved summary, or (no summary yet) write one. */
export function claudePrompt(meta: Pick<MeetingMeta, 'id' | 'title' | 'startedAt'>, summarize = false): string {
  const title = (meta.title || '').replace(/\s+/g, ' ').trim()
  const at = when(meta.startedAt)
  if (settings.value.uiLanguage === 'en') {
    return summarize
      ? `Summarize the call "${title}"${at ? ` from ${at}` : ''} (Klara Wisper, id ${meta.id}): the main points, the decisions and my action items, and save the summary.`
      : `Summary of the call "${title}"${at ? ` from ${at}` : ''} (Klara Wisper, id ${meta.id}): show the summary, the decisions and my action items.`
  }
  return summarize
    ? `לסכם את השיחה "${title}"${at ? ` מ-${at}` : ''} (Klara Wisper, id ${meta.id}): עיקרי הדברים, ההחלטות והמשימות שלי, ולשמור את הסיכום.`
    : `סיכום השיחה "${title}"${at ? ` מ-${at}` : ''} (Klara Wisper, id ${meta.id}): להציג את הסיכום, ההחלטות והמשימות שלי.`
}

/** Claude Desktop when it is installed (it handles claude://), otherwise claude.ai in the browser. */
async function openClaude(prompt: string): Promise<void> {
  const q = encodeURIComponent(prompt.slice(0, MAX_PROMPT))
  clipboard.writeText(prompt) // fallback: if Claude opens without the text, it can be pasted
  if (app.getApplicationNameForProtocol('claude://')) {
    // Built here from a fixed prefix and an encoded prompt (security.ts allows only a bare "claude://").
    try {
      await shell.openExternal(DESKTOP_PREFIX + q)
      return
    } catch (err) {
      console.warn(`claude push: ${String((err as Error).message ?? err)}`)
    }
  }
  const web = WEB_PREFIX + q
  if (safeExternal(web)) await shell.openExternal(web)
}

function endedAt(meta: MeetingMeta): number {
  const end = Date.parse(meta.endedAt ?? '')
  if (!Number.isNaN(end)) return end
  return Date.parse(meta.startedAt) + (meta.durationSec ?? 0) * 1000
}

/**
 * After a call (summarize.ts): offer to open Claude with the call's summary, or with a request to
 * summarize it when no summary will be written. Never while a call is recording (waits for it).
 */
export async function pushToClaude(call: MeetingMeta | string, opts: { summarize?: boolean; isBusy?: () => boolean } = {}): Promise<void> {
  const id = typeof call === 'string' ? call : call.id
  try {
    if (settings.value.claudePush === 'off' || pushed.has(id)) return
    const at = typeof call === 'string' ? db().getFolder(call) : null
    const meta = typeof call === 'string' ? (at ? readMeta(at) : null) : call
    if (!meta || meta.status !== 'done') return
    if (!(Date.now() - endedAt(meta) < FRESH_MS)) return
    pushed.add(meta.id)
    const t0 = Date.now()
    while (opts.isBusy?.() && Date.now() - t0 < MAX_WAIT_MS) await new Promise((r) => setTimeout(r, 30_000))
    if (opts.isBusy?.()) return
    const mode = settings.value.claudePush as string // may have been turned off while waiting
    if (mode === 'off') return
    // The title may have changed meanwhile (Claude names ad-hoc calls while summarizing).
    const folder = db().getFolder(meta.id)
    const latest = (folder ? readMeta(folder) : null) ?? meta
    const prompt = claudePrompt(latest, !!opts.summarize)

    if (mode === 'open' || !Notification.isSupported()) {
      await openClaude(prompt)
      return
    }
    const he = settings.value.uiLanguage !== 'en'
    const n = new Notification({
      title: opts.summarize
        ? he ? 'השיחה נשמרה · לסכם ב-Claude' : 'Call saved · Summarize in Claude'
        : he ? 'הסיכום מוכן · לפתוח ב-Claude' : 'Summary ready · Open in Claude',
      body: he
        ? `${latest.title}. בלחיצה Claude נפתח עם בקשה מוכנה, והיא מועתקת גם ללוח.`
        : `${latest.title}. Click to open Claude with a ready request (also copied to the clipboard).`,
      silent: true
    })
    shown.add(n)
    n.on('click', () => {
      shown.delete(n)
      void openClaude(prompt).catch((err) => console.warn(`claude push: ${String(err)}`))
    })
    n.on('close', () => shown.delete(n))
    n.show()
  } catch (err) {
    console.warn(`claude push ${id}: ${String((err as Error).message ?? err)}`)
  }
}
