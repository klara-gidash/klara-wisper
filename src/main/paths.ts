import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Project checkout root in development; where `engine/` and `build/KlaraHelper.app` live. */
export const projectRoot = resolve(__dirname, '../..')

export const isWindows = process.platform === 'win32'

export const dataDir = isWindows
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Klara Wisper')
  : join(homedir(), 'Library', 'Application Support', 'Klara Wisper')
export const defaultFolder = join(homedir(), 'Documents', 'Klara Wisper')
export const modelsDir = join(dataDir, 'models')

/** Where an installed app sets up its own Python engine on first launch (see setup.ts). */
export const managedEngineDir = join(dataDir, 'engine')

export function helperPath(): string {
  if (isWindows) {
    const packaged = join(process.resourcesPath, 'helper', 'KlaraHelper.exe')
    if (app.isPackaged && existsSync(packaged)) return packaged
    return join(projectRoot, 'build', 'win-helper', 'KlaraHelper.exe')
  }
  const packaged = join(process.resourcesPath, 'KlaraHelper.app', 'Contents', 'MacOS', 'KlaraHelper')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return join(projectRoot, 'build', 'KlaraHelper.app', 'Contents', 'MacOS', 'KlaraHelper')
}

/**
 * The Python engine (virtualenv with the engine's packages).
 * - Installed app: `<data folder>/engine`, created on first launch from the copy of the engine
 *   inside the app (setup.ts). A build made with scripts/dist.sh from a checkout instead records
 *   that checkout in resources/engine-path.txt and uses its engine/.venv.
 * - Development: the checkout's engine/ (KLARA_ENGINE_DIR overrides).
 */
export function engineDir(): string {
  if (!app.isPackaged && process.env.KLARA_ENGINE_DIR) return process.env.KLARA_ENGINE_DIR
  if (app.isPackaged) {
    const marker = join(process.resourcesPath, 'engine-path.txt')
    const checkout = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''
    return checkout || managedEngineDir
  }
  return join(projectRoot, 'engine')
}

/** True when this app installs and updates the engine itself (a build for colleagues). */
export const managesEngine = (): boolean => app.isPackaged && engineDir() === managedEngineDir

export function enginePython(dir = engineDir()): string {
  return isWindows ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python')
}

/** The engine's source and lockfile shipped inside the app. */
export const bundledEngineSource = (): string => join(process.resourcesPath, 'engine')

/** The pinned uv binary shipped inside the app (installs Python and the locked packages). */
export function uvPath(): string {
  return isWindows ? join(process.resourcesPath, 'bin', 'uv.exe') : join(process.resourcesPath, '..', 'MacOS', 'uv')
}

/** Development-only switches (Vite dev server, test hooks) are ignored in the installed app. */
export const devMode = (): boolean => !app.isPackaged
