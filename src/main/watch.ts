import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { queueCloud } from './cloud'
import { queueObsidian } from './obsidian'
import { recorder } from './meetings/recorder'
import { settings } from './settings'
import { db } from './storage/db'
import { meetingsRoot, readMeeting, refreshMarkdown } from './storage/files'
import { broadcast } from './windows'

/**
 * Picks up edits made outside the app (Claude saving notes or naming a speaker through MCP,
 * the user editing meta.json) and re-indexes that meeting.
 */
let watcher: FSWatcher | null = null
const timers = new Map<string, NodeJS.Timeout>()
let failures = 0
let retry: NodeJS.Timeout | null = null

/** Tries again later: 5 s, then longer each time, at most every 5 minutes (and logs only now and then). */
function retryLater(what: string, err: unknown): void {
  failures++
  if (failures <= 3 || failures % 20 === 0) console.warn(`library ${what}, retrying (${failures})`, String(err))
  if (retry) clearTimeout(retry)
  retry = setTimeout(watchLibrary, Math.min(5_000 * 2 ** Math.min(failures - 1, 6), 300_000))
}

export function watchLibrary(): void {
  retry = null
  watcher?.close()
  watcher = null
  const root = meetingsRoot()
  try {
    // Documents denied (macOS) or Controlled Folder Access (Windows): keep starting, health shows 'storage'
    mkdirSync(root, { recursive: true })
    watcher = watch(root, { recursive: true }, onChange)
    watcher.on('error', (err) => retryLater('watch stopped', err))
    failures = 0
  } catch (err) {
    retryLater('watch failed', err)
  }
}

/** meta.json or summary.md anywhere under the library, either separator. */
export function isWatchedFile(filename: string): boolean {
  return /(^|\/)(meta\.json|summary\.md)$/.test(filename.replace(/\\/g, '/'))
}

function onChange(_event: string, filename: string | null): void {
  const root = meetingsRoot()
  if (!filename) return
  filename = filename.replace(/\\/g, '/') // Windows reports backslashes
  if (!isWatchedFile(filename)) return
  const folder = dirname(join(root, filename))
  clearTimeout(timers.get(folder))
  timers.set(
    folder,
    setTimeout(() => {
      timers.delete(folder)
      const m = readMeeting(folder)
      if (!m || m.meta.status !== 'done' || m.meta.id === recorder.live?.id) return
      // A speaker Claude named (MCP set_speaker_name) shows in transcript.md too.
      try {
        refreshMarkdown(folder, m.meta, m.segments) // writes only when the text changed
      } catch (err) {
        console.warn('library: transcript.md not refreshed', String(err))
      }
      db().indexMeeting({ ...m.meta, folder }, m.segments)
      broadcast('meetings:changed', m.meta.id)
      queueCloud(m.meta.id) // optional Cloudflare copy: saved, summarized or renamed
      queueObsidian(m.meta.id) // optional note in the user's Obsidian vault
    }, 600)
  )
}


settings.on('change', (_v, patch) => {
  if (patch.folder) watchLibrary()
})
