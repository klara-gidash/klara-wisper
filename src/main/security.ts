import { app } from 'electron'

/** Only these may be opened outside the app: web links and the Claude app. */
export function safeExternal(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:' || url === 'claude://'
  } catch {
    return false
  }
}

/** The app's own pages (packaged renderer files, or the Vite dev server in development). */
export function isAppUrl(url: string): boolean {
  if (url.startsWith('file://') && url.includes('/out/renderer/index.html')) return true
  const dev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  return !!dev && url.startsWith(dev)
}
