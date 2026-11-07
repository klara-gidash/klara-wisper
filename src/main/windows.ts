import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

type Route = 'library' | 'live' | 'pill'

export const windows: Record<Route, BrowserWindow | null> = { library: null, live: null, pill: null }

function load(win: BrowserWindow, route: string): void {
  const dev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  if (dev) void win.loadURL(`${dev}#/${route}`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
}

const webPreferences = (): Electron.WebPreferences => ({
  preload: join(__dirname, '../preload/index.js'),
  sandbox: true,
  contextIsolation: true,
  spellcheck: false
})

/**
 * Floating panels (the dictation pill, the live panel) are NSPanels, and creating one switches an
 * Electron app to "accessory" mode — no Dock icon. Klara Wisper is a regular app, so switch back.
 */
export function keepInDock(): void {
  if (process.platform !== 'darwin') return // macOS only (on Windows this would throw at startup)
  app.setActivationPolicy('regular')
  void app.dock?.show()
}

/** Sends to every open window. */
export function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

export function showLibrary(route = 'library'): BrowserWindow {
  let win = windows.library
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 580,
      show: false,
      title: 'Klara Wisper',
      // macOS: traffic lights over the page; Windows: the system's window buttons drawn over it.
      ...(process.platform === 'win32'
        ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#00000000', symbolColor: '#888888', height: 40 } }
        : { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } }),
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
      webPreferences: webPreferences()
    })
    windows.library = win
    win.on('ready-to-show', () => win!.show())
    win.on('closed', () => (windows.library = null))
    load(win, route)
  } else {
    if (route !== 'library') win.webContents.send('navigate', route)
    win.show()
    win.focus()
  }
  return win
}

export function showLive(): BrowserWindow {
  let win = windows.live
  if (!win || win.isDestroyed()) {
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const width = 380
    const height = Math.min(640, wa.height - 80)
    win = new BrowserWindow({
      width,
      height,
      x: wa.x + wa.width - width - 20,
      y: wa.y + 40,
      minWidth: 320,
      minHeight: 260,
      show: false,
      frame: false,
      transparent: true,
      type: 'panel',
      vibrancy: 'hud',
      visualEffectState: 'active',
      roundedCorners: true,
      hasShadow: true,
      fullscreenable: false,
      minimizable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: webPreferences()
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    windows.live = win
    keepInDock()
    win.on('ready-to-show', () => win!.showInactive())
    win.on('closed', () => (windows.live = null))
    load(win, 'live')
  } else if (!win.isVisible()) {
    win.showInactive()
  }
  return win
}

export function hideLive(): void {
  windows.live?.hide()
}

/** The dictation pill is created once and kept hidden so it appears instantly. */
export function pillWindow(): BrowserWindow {
  let win = windows.pill
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 320,
    height: 84,
    show: false,
    frame: false,
    transparent: true,
    type: 'panel',
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: webPreferences()
  })
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  windows.pill = win
  keepInDock()
  win.on('closed', () => (windows.pill = null))
  load(win, 'pill')
  return win
}

export function showPill(): void {
  const win = pillWindow()
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const [w, h] = win.getSize()
  win.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + wa.height - h - 18))
  if (!win.isVisible()) win.showInactive()
}

export function hidePill(): void {
  windows.pill?.hide()
}
