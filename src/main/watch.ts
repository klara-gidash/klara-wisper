import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { queueCloud } from './cloud'
import { recorder } from './meetings/recorder'
import { settings } from './settings'
import { db } from './storage/db'
import { meetingsRoot, readMeeting } from './storage/files'
import { broadcast } from './windows'

/**
 * Picks up edits made outside the app (Claude saving notes or naming a speaker through MCP,
 * the user editing meta.json) and re-indexes that meeting.
 */
let watcher: FSWatcher | null = null
const timers = new Map<string, NodeJS.Timeout>()

export function watchLibrary(): void {
  watcher?.close()
  const root = meetingsRoot()
  mkdirSync(root, { recursive: true })
  try {
    watcher = watch(root, { recursive: true }, onChange)
    watcher.on('error', (err) => {
      console.warn('library watch stopped, retrying', String(err))
      setTimeout(watchLibrary, 60_000)
    })
  } catch (err) {
    console.warn('library watch failed, retrying', String(err))
    setTimeout(watchLibrary, 60_000)
  }
}

function onChange(_event: string, filename: string | null): void {
  const root = meetingsRoot()
  if (!filename || !/(^|\/)(meta\.json|summary\.md)$/.test(filename)) return
  const folder = dirname(join(root, filename))
  clearTimeout(timers.get(folder))
  timers.set(
    folder,
    setTimeout(() => {
      timers.delete(folder)
      const m = readMeeting(folder)
      if (!m || m.meta.status !== 'done' || m.meta.id === recorder.live?.id) return
      db().indexMeeting({ ...m.meta, folder }, m.segments)
      broadcast('meetings:changed', m.meta.id)
      queueCloud(m.meta.id) // optional Cloudflare copy: saved, summarized or renamed
    }, 600)
  )
}


settings.on('change', (_v, patch) => {
  if (patch.folder) watchLibrary()
})
