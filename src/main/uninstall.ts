import { app, dialog, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import * as claude from './claude'
import { engine } from './engine'
import { helper } from './helper'
import { dataDir, defaultFolder, managedEngineDir } from './paths'
import { settings } from './settings'
import { setup } from './setup'

const run = promisify(execFile)

/**
 * Stops every Python process that runs from the app's own engine folder: the engine, a model
 * download, and the MCP server Claude Desktop started (which would keep files open on Windows).
 */
export async function stopEngineProcesses(): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process -Name python* -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($env:KLARA_KILL_DIR, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force'],
        { timeout: 20_000, windowsHide: true, env: { ...process.env, KLARA_KILL_DIR: managedEngineDir } }
      )
    } else {
      await run('/usr/bin/pkill', ['-f', `${managedEngineDir}/`], { timeout: 5000 })
    }
  } catch {
    /* nothing was running */
  }
}

/** What "Klara Wisper.exe --cleanup" (the Windows uninstaller) and "Remove" on the Mac take out first. */
export async function cleanupOutside(): Promise<void> {
  app.setLoginItemSettings({ openAtLogin: false })
  await claude.disconnect().catch(() => undefined)
  await stopEngineProcesses()
}

/**
 * Settings > "Remove Klara Wisper". Asks first. The transcripts and audio in Documents stay.
 *  - Windows: runs the regular uninstaller (Settings > Apps does the same).
 *  - macOS: the Claude connection, the login item, the data folder (engine, models, settings,
 *    voiceprints), the privacy permissions, and the app itself (to the Trash).
 */
export async function removeApp(): Promise<boolean> {
  const he = settings.value.uiLanguage === 'he'
  if (!app.isPackaged) throw new Error('only an installed app can remove itself')
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: [he ? 'הסרה' : 'Remove', he ? 'ביטול' : 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: he ? 'להסיר את Klara Wisper מהמחשב?' : 'Remove Klara Wisper from this computer?',
    detail: he
      ? `יוסרו התוכנה, מנוע התמלול והמודלים (כ-3.5GB), ההגדרות, טביעות הקול והחיבור ל-Claude.\n\nהתמלולים וההקלטות נשארים ב:\n${settings.value.folder || defaultFolder}`
      : `This removes the app, the transcription engine and models (about 3.5 GB), the settings, the voiceprints and the Claude connection.\n\nTranscripts and recordings stay in:\n${settings.value.folder || defaultFolder}`
  })
  if (response !== 0) return false
  console.log('removing Klara Wisper')

  if (process.platform === 'win32') {
    const uninstaller = join(dirname(process.execPath), 'Uninstall Klara Wisper.exe')
    if (!existsSync(uninstaller)) throw new Error(`uninstaller not found: ${uninstaller}`)
    spawn(uninstaller, [], { detached: true, stdio: 'ignore' }).unref()
    app.quit() // the uninstaller waits for the app to close
    return true
  }

  // The app bundle: …/Klara Wisper.app/Contents/MacOS/Klara Wisper. It goes first: if it can't be
  // removed (the password prompt was cancelled), nothing else is touched.
  const bundle = resolve(process.execPath, '..', '..', '..')
  if (!bundle.endsWith('.app')) throw new Error(`not an app bundle: ${bundle}`)
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  await run(lsregister, ['-u', bundle], { timeout: 10_000 }).catch(() => undefined)
  if (!(await removeBundle(bundle))) {
    await dialog.showMessageBox({
      type: 'error',
      message: he ? 'לא הצלחנו להסיר את Klara Wisper' : 'Klara Wisper could not be removed',
      detail: he ? 'שום דבר לא נמחק. אפשר לנסות שוב, או לגרור את Klara Wisper מתיקיית Applications לפח.' : 'Nothing was deleted. Try again, or drag Klara Wisper from Applications to the Trash.'
    })
    return false
  }
  setup.abort()
  helper.stop()
  engine.stop()
  await cleanupOutside()
  await run('/usr/bin/tccutil', ['reset', 'All', 'io.klara.wisper'], { timeout: 10_000 }).catch(() => undefined)
  rmSync(dataDir, { recursive: true, force: true })
  app.exit(0)
  return true
}

/**
 * Moves the app to the Trash. An app installed by Klara Wisper.pkg belongs to root, which a normal
 * user can't move: then macOS asks for the administrator password and the app is deleted (and the
 * installer's receipt forgotten). Resolves false when that was cancelled or failed.
 */
async function removeBundle(bundle: string): Promise<boolean> {
  try {
    await shell.trashItem(bundle)
    return true
  } catch (err) {
    console.warn(`could not move the app to the Trash (${(err as Error).message}), asking for the password`)
  }
  const literal = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const script =
    `do shell script "/bin/rm -rf " & quoted form of ${literal(bundle)} & ` +
    `" ; /usr/sbin/pkgutil --forget io.klara.wisper.app >/dev/null 2>&1 ; true" with administrator privileges`
  try {
    await run('/usr/bin/osascript', ['-e', script], { timeout: 300_000 })
  } catch (err) {
    console.warn(`removing the app as administrator failed: ${(err as Error).message}`)
  }
  return !existsSync(bundle)
}
