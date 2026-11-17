import { app, net, session } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { cpus, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { PreflightReport } from '@shared/types'
import { DEFAULT_WISHES, MODEL_GB, problems, recommend, type Machine, type Wishes } from '@shared/plan'
import * as claude from './claude'
import { dataDir, isWindows, modelsDir } from './paths'
import { settings } from './settings'

const run = promisify(execFile)

/**
 * Looks at this computer before anything is installed: what it is, whether the app can run on it,
 * whether there is room and a connection for the downloads, and what is already installed.
 * The decision itself (which "version" fits) is in src/shared/plan.ts.
 */

/** The three servers the first launch downloads from. Any HTTP answer counts as "reachable". */
const SERVERS = [
  { name: 'GitHub', url: 'https://github.com/astral-sh/python-build-standalone' }, // Python
  { name: 'PyPI', url: 'https://pypi.org/simple/pip/' }, // the packages
  { name: 'Hugging Face', url: 'https://huggingface.co/api/models/openai/whisper-tiny' } // the models
]

async function sysctl(name: string): Promise<string> {
  try {
    const { stdout } = await run('/usr/sbin/sysctl', ['-n', name], { timeout: 3000 })
    return stdout.trim()
  } catch {
    return ''
  }
}

/** "MacBook Air", "Mac mini"… from the hardware id (Mac14,2 / MacBookPro18,3). */
function macModelName(id: string): string {
  return /MacBookAir/i.test(id) ? 'MacBook Air' : /MacBookPro/i.test(id) ? 'MacBook Pro' : /Macmini/i.test(id) ? 'Mac mini'
    : /iMac/i.test(id) ? 'iMac' : /MacPro/i.test(id) ? 'Mac Pro' : /MacStudio/i.test(id) ? 'Mac Studio' : 'Mac'
}

/** Free space (GB) on the volume of `dir`, or of its nearest folder that exists; -1 when unknown. */
export function freeGB(dir: string): number {
  let at = dir
  for (let i = 0; i < 12 && !existsSync(at); i++) at = dirname(at)
  try {
    const s = statfsSync(at)
    return Math.round((Number(s.bavail) * Number(s.bsize)) / 2 ** 30 * 10) / 10
  } catch {
    return -1
  }
}

let cached: Machine | null = null

export async function machine(fresh = false): Promise<Machine> {
  if (cached && !fresh) return { ...cached, freeGB: freeGB(dataDir) }
  const chip = cpus()[0]?.model?.trim() ?? ''
  const m: Machine = {
    platform: process.platform as Machine['platform'],
    arch: process.arch,
    translated: false,
    osVersion: isWindows ? release() : process.getSystemVersion(),
    chip,
    cores: cpus().length,
    ramGB: Math.round(totalmem() / 2 ** 30),
    freeGB: freeGB(dataDir),
    model: '',
    gpu: ''
  }
  if (process.platform === 'darwin') {
    const [arm, translated, hwModel] = await Promise.all([sysctl('hw.optional.arm64'), sysctl('sysctl.proc_translated'), sysctl('hw.model')])
    m.arch = arm === '1' ? 'arm64' : 'x64'
    m.translated = translated === '1'
    m.model = macModelName(hwModel)
  } else if (isWindows) {
    // An x64 app on Windows on ARM still sees the real processor's name.
    const real = `${process.env.PROCESSOR_IDENTIFIER ?? ''} ${process.env.PROCESSOR_ARCHITEW6432 ?? ''} ${chip}`
    if (process.arch === 'arm64' || /ARM|Snapdragon|Qualcomm/i.test(real)) {
      m.arch = 'arm64'
      m.translated = process.arch !== 'arm64'
    }
    m.gpu = await windowsGpu()
  }
  cached = m
  return m
}

async function windowsGpu(): Promise<string> {
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name -join "; "'],
      { timeout: 8000, windowsHide: true }
    )
    return stdout.trim().slice(0, 200)
  } catch {
    return ''
  }
}

/** Which of the three download servers do not answer (through the system's proxy, like a browser). */
export async function unreachableServers(timeoutMs = 9000): Promise<string[]> {
  const results = await Promise.all(
    SERVERS.map(async (s) => {
      try {
        await net.fetch(s.url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
        return null
      } catch {
        return s.name
      }
    })
  )
  return results.filter((r): r is string => r !== null)
}

/**
 * Proxy settings for the tools that download (uv, Python): they read HTTPS_PROXY, not the
 * system's proxy settings that the browser and this app use. Empty when there is no proxy or the
 * variables are already set.
 */
export async function proxyEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return {}
  try {
    const rule = await session.defaultSession.resolveProxy('https://huggingface.co/')
    const m = /^\s*(?:PROXY|HTTPS)\s+([^;\s]+)/i.exec(rule)
    if (!m) return {}
    const url = `http://${m[1]}`
    return { HTTPS_PROXY: url, HTTP_PROXY: url }
  } catch {
    return {}
  }
}

/** The data folder can be written to (a full disk, a read-only profile or security software can prevent it). */
export function canWrite(dir: string): boolean {
  const probe = join(dir, `.write-test-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** Models with a `.complete` marker in the models folder. */
export function installedModels(): string[] {
  return Object.keys(MODEL_GB).filter((k) => existsSync(join(modelsDir, k, '.complete')))
}

/** macOS: started from the disk image, Downloads or a zip instead of the Applications folder. */
export function misplaced(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  try {
    return !app.isInApplicationsFolder()
  } catch {
    return false
  }
}

export async function preflight(wishes: Wishes | null, engineInstalled: boolean): Promise<PreflightReport> {
  const m = await machine()
  const plan = recommend(m, wishes ?? settings.value.wishes ?? DEFAULT_WISHES)
  const installed = { engine: engineInstalled, models: installedModels() }
  const everythingHere = installed.engine && plan.models.every((k) => installed.models.includes(k))
  // Nothing left to download: no need to wait for (or complain about) the network.
  const unreachable = everythingHere ? [] : await unreachableServers()
  return {
    machine: m,
    plan,
    problems: problems(m, plan, installed),
    installed,
    internet: { ok: unreachable.length === 0, unreachable },
    misplaced: misplaced(),
    claude: { desktopInstalled: claude.desktopInstalled(), codeCli: !!claude.claudeCli() }
  }
}
