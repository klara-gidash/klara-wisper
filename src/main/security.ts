import { app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Only these may be opened outside the app: web links and the Claude app. */
export function safeExternal(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:' || url === 'claude://'
  } catch {
    return false
  }
}

/** The renderer page windows.ts loads (out/renderer/index.html next to this bundle, inside app.asar when packaged). */
const RENDERER_INDEX = pathToFileURL(join(__dirname, '../renderer/index.html')).href

/** The app's own pages (packaged renderer files, or the Vite dev server in development). */
export function isAppUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  u.hash = '' // the route (#/library, #/live…) doesn't matter, the document does
  if (u.href === RENDERER_INDEX) return true
  const dev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  if (!dev) return false
  try {
    const server = new URL(dev)
    return (server.protocol === 'http:' || server.protocol === 'https:') && u.origin === server.origin
  } catch {
    return false
  }
}
