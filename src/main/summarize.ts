import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Notification } from 'electron'
import { claudeCli, mcpEntry, signedIn } from './claude'
import { dataDir, enginePython } from './paths'
import { settings } from './settings'
import { db } from './storage/db'
import { listMeetingFolders, readMeeting } from './storage/files'
import { broadcast, showLibrary } from './windows'

const run = promisify(execFile)

const MIN_SECONDS = 180      // shorter calls aren't worth a summary
const MIN_LINES = 10
const TIMEOUT_MS = 8 * 60_000

/** The only things the automatic Claude may do: read the transcript, save its notes, name an ad-hoc call. */
const ALLOWED = ['mcp__klara-wisper__get_transcript', 'mcp__klara-wisper__save_meeting_notes', 'mcp__klara-wisper__set_meeting_details']

/**
 * The summary prompt comes from the engine's MCP server (summarize_meeting), the same text Claude
 * Desktop shows under "+ → klara-wisper", so the format lives in one place.
 */
async function prompt(id: string): Promise<string> {
  const code = 'import sys; from klara_engine.mcp_server import summarize_meeting; print(summarize_meeting(sys.argv[1]))'
  const { stdout } = await run(enginePython(), ['-I', '-c', code, id], { timeout: 60_000, cwd: dataDir })
  return (
    stdout.trim() +
    `

This runs automatically, right after the call ended and its transcript was saved. Nobody is reading your reply:
- The transcript is final. Don't wait for speaker labels; if the status line still mentions them, summarize anyway.
- Set the meeting details (set_meeting_details) as step 3 says, then save the notes with save_meeting_notes("${id}", ...). Do nothing else.`
  )
}

/**
 * After a call: Claude (the Claude Code CLI, signed in with the user's Claude subscription, no API
 * key) reads the transcript through the Klara Wisper MCP server and saves summary.md next to it.
 * The transcript is what other people said, so this Claude gets no built-in tools (no shell, files
 * or web) and only the two Klara Wisper tools above; anything else is refused without asking.
 * One summary at a time, never holding up the recordings.
 */
const STATE = join(dataDir, 'auto-summary.json')

class AutoSummary {
  /** Set at startup: true while a call is recording (Claude waits, so it never slows the live transcript). */
  isBusy: () => boolean = () => false
  private chain: Promise<void> = Promise.resolve()
  private warned = false
  private queued = new Set<string>()
  /** Meetings already handed to Claude once (each is tried once, so a failing one never loops). */
  private tried: Record<string, string> = (() => {
    try {
      return JSON.parse(readFileSync(STATE, 'utf8')).tried ?? {}
    } catch {
      return {}
    }
  })()

  enqueue(id: string): void {
    if (!settings.value.autoSummary || process.platform !== 'darwin' || this.queued.has(id)) return
    this.queued.add(id)
    this.chain = this.chain
      .then(() => this.run(id))
      .catch((err) => console.error(`auto-summary ${id} failed`, err))
      .finally(() => this.queued.delete(id))
  }

  /**
   * Earlier calls without notes, newest first, once each: Claude names the ad-hoc ones, writes
   * participants and scope, and saves a summary. Only when signed in; runs one at a time in the background.
   */
  async backfill(): Promise<void> {
    if (!settings.value.autoSummary || process.platform !== 'darwin') return
    const cli = claudeCli()
    if (!cli || !(await signedIn(cli))) return
    const todo = listMeetingFolders()
      .map((f) => readMeeting(f)?.meta)
      .filter((m): m is NonNullable<typeof m> => !!m && m.status === 'done' && !this.tried[m.id] && (m.durationSec ?? 0) >= MIN_SECONDS)
      .filter((m) => !existsSync(join(m.folder, 'summary.md')))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    if (todo.length) console.log(`auto-summary: ${todo.length} earlier calls without notes, queued`)
    for (const m of todo) this.enqueue(m.id)
  }

  private markTried(id: string): void {
    this.tried[id] = new Date().toISOString()
    try {
      writeFileSync(STATE, JSON.stringify({ tried: this.tried }, null, 1), { mode: 0o600 })
    } catch {
      /* not critical */
    }
  }

  private async run(id: string): Promise<void> {
    if (!settings.value.autoSummary) return
    const folder = db().getFolder(id)
    const m = folder ? readMeeting(folder) : null
    if (!folder || !m) return
    if (existsSync(join(folder, 'summary.md'))) return
    if ((m.meta.durationSec ?? 0) < MIN_SECONDS || m.segments.length < MIN_LINES) {
      console.log(`auto-summary ${id}: skipped (${m.meta.durationSec ?? 0}s, ${m.segments.length} lines)`)
      return
    }
    const cli = claudeCli()
    if (!cli || !(await signedIn(cli))) {
      console.log(`auto-summary ${id}: skipped, ${cli ? 'Claude Code is not signed in' : 'no Claude Code CLI'}`)
      this.warnOnce(!cli)
      return
    }

    const he = settings.value.uiLanguage === 'he'
    const cwd = join(dataDir, 'claude-run') // empty: no project CLAUDE.md or settings get picked up
    mkdirSync(cwd, { recursive: true })
    const config = JSON.stringify({ mcpServers: { 'klara-wisper': { type: 'stdio', ...mcpEntry() } } })
    const args = [
      '-p',
      '--strict-mcp-config', '--mcp-config', config,
      '--tools', '',
      '--allowedTools', ALLOWED.join(','),
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--no-session-persistence',
      '--model', 'sonnet',
      '--output-format', 'json'
    ]
    while (this.isBusy()) await new Promise((r) => setTimeout(r, 30_000))
    if (existsSync(join(db().getFolder(id) ?? folder, 'summary.md'))) return // written meanwhile (e.g. from Claude Desktop)
    const text = await prompt(id)
    this.markTried(id)
    const t0 = Date.now()
    console.log(`auto-summary ${id}: asking Claude`)
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(cli, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS)
      child.stdout.on('data', (d) => (out = (out + d).slice(-64_000)))
      child.stderr.on('data', (d) => (err = (err + d).slice(-8_000)))
      child.on('error', (e) => (err += String(e)))
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, out, err })
      })
      child.stdin.end(text) // the prompt goes in on stdin: no quoting, no argument-length limits
    })
    const secs = Math.round((Date.now() - t0) / 1000)
    const latest = db().getFolder(id) ?? folder // the folder may have been renamed meanwhile
    if (existsSync(join(latest, 'summary.md'))) {
      console.log(`auto-summary ${id}: saved after ${secs}s`)
      broadcast('meetings:changed', id)
      const n = new Notification({ title: he ? 'הסיכום מוכן' : 'Summary ready', body: m.meta.title, silent: true })
      n.on('click', () => showLibrary(`meeting/${id}`))
      n.show()
    } else {
      let detail = result.err.trim()
      try {
        const j = JSON.parse(result.out)
        detail = [j.subtype, j.is_error ? 'error' : '', String(j.result ?? '').slice(0, 300)].filter(Boolean).join(' · ') || detail
      } catch {
        /* not JSON */
      }
      console.warn(`auto-summary ${id}: no summary after ${secs}s (exit ${result.code}) ${detail.slice(0, 600)}`)
    }
  }

  /** Once per app run: tell the user why there was no summary, and where to fix it. */
  private warnOnce(noCli: boolean): void {
    if (this.warned) return
    this.warned = true
    const he = settings.value.uiLanguage === 'he'
    const n = new Notification({
      title: he ? 'סיכום אוטומטי לא רץ' : 'No automatic summary',
      body: noCli
        ? he ? 'צריך את Claude Desktop או Claude Code על המחשב.' : 'Needs Claude Desktop or Claude Code on this Mac.'
        : he ? 'צריך להתחבר ל-Claude פעם אחת: הגדרות > Claude.' : 'Sign in to Claude once: Settings > Claude.',
      silent: true
    })
    n.on('click', () => showLibrary('settings'))
    n.show()
  }
}

export const autoSummary = new AutoSummary()
