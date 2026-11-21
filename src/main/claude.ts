import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeAuto } from '@shared/types'
import { enginePython, projectRoot } from './paths'

const run = promisify(execFile)
const SERVER_NAME = 'klara-wisper'
const CONFIG_FILE = 'claude_desktop_config.json'
const win = process.platform === 'win32'
const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
const desktopConfig = win
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', CONFIG_FILE)
  : join(homedir(), 'Library', 'Application Support', 'Claude', CONFIG_FILE)

/**
 * Claude Desktop from the Microsoft Store (or its MSIX installer) does not read %APPDATA%\Claude:
 * Windows gives a packaged app its own copy of "Roaming" under %LOCALAPPDATA%\Packages\Claude_<id>.
 */
function storeConfigs(): string[] {
  if (!win) return []
  try {
    const packages = join(localAppData, 'Packages')
    return readdirSync(packages)
      .filter((d) => /^(AnthropicPBC\.)?Claude_/i.test(d))
      // The package folder is enough: LocalCache\Roaming appears only once Claude has run, and
      // writeDesktop creates it (mkdir -p) when it writes the config.
      .map((d) => join(packages, d, 'LocalCache', 'Roaming', 'Claude', CONFIG_FILE))
  } catch {
    return []
  }
}

/** Every config file a Claude Desktop on this computer may read (the usual one first). */
export const desktopConfigs = (): string[] => [desktopConfig, ...storeConfigs()]

/** Claude Desktop is on this computer (it may never have been opened, so there may be no config yet). */
export function desktopInstalled(): boolean {
  if (existsSync(dirname(desktopConfig)) || storeConfigs().length > 0) return true
  const apps = win
    ? [join(localAppData, 'AnthropicClaude'), join(localAppData, 'Programs', 'Claude')]
    : ['/Applications/Claude.app', join(homedir(), 'Applications', 'Claude.app')]
  return apps.some((p) => existsSync(p))
}

/**
 * How Claude starts our MCP server: the engine's Python, separate from this app, so the app
 * binary never runs arbitrary scripts. The server reads the transcripts folder from settings.json.
 * In an installed app that is <data folder>/engine (set up on first launch), so the entry keeps
 * working when the app is moved or updated.
 */
export function mcpEntry(): { command: string; args: string[]; env: Record<string, string> } {
  // UTF-8 I/O: on Windows with a Hebrew user name Python's default code page can't encode the paths.
  return { command: enginePython(), args: ['-m', 'klara_engine.mcp_server'], env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }
}

/** Parsed config, `{}` if there is none yet (or it is empty); throws if the file isn't valid JSON. */
function readDesktop(file = desktopConfig): any {
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return text.trim() ? JSON.parse(text) : {}
}

/** Folders under nvm (mac: ~/.nvm/versions/node/<v>/bin; Windows: %NVM_HOME%\<v> or %APPDATA%\nvm\<v>), newest first. */
function nvmDirs(): string[] {
  const roots = win
    ? [process.env.NVM_HOME, join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'nvm')]
    : [join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node')]
  const out: string[] = []
  for (const root of roots) {
    if (!root) continue
    try {
      for (const v of readdirSync(root).filter((d) => /^v?\d/.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        out.push(win ? join(root, v) : join(root, v, 'bin'))
      }
    } catch {
      /* no nvm */
    }
  }
  return out
}

export function claudeCli(): string | null {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const npmWin = join(appData, 'npm')
  const candidates = win
    ? [
        join(homedir(), '.local', 'bin', 'claude.exe'),
        // npm i -g @anthropic-ai/claude-code: the native binary when the package ships one, else the shim.
        join(npmWin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        join(npmWin, 'claude.cmd'),
        ...nvmDirs().map((d) => join(d, 'claude.cmd'))
      ]
    : [
        join(homedir(), '.local', 'bin', 'claude'),
        join(homedir(), '.claude', 'local', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        join(homedir(), '.npm-global', 'bin', 'claude'),
        ...nvmDirs().map((d) => join(d, 'claude'))
      ]
  const found = candidates.find((p) => existsSync(p))
  if (found || process.platform !== 'darwin') return found ?? null
  // Claude Desktop ships its own copy of Claude Code: <support>/Claude/claude-code/<version>/<build>/claude.app
  try {
    const base = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code')
    for (const ver of readdirSync(base).sort().reverse()) {
      for (const build of readdirSync(join(base, ver))) {
        const bin = join(base, ver, build, 'claude.app', 'Contents', 'MacOS', 'claude')
        if (existsSync(bin)) return bin
      }
    }
  } catch {
    /* no Desktop copy */
  }
  return null
}

/**
 * The environment for running the CLI: an app started from the Dock/Start menu has a minimal PATH,
 * and an npm-installed `claude` is a script that needs `node` (next to it for nvm, else the usual
 * places), so those folders go first.
 */
export function cliEnv(cli = claudeCli()): NodeJS.ProcessEnv {
  const extra = [
    cli ? dirname(cli) : null,
    ...(win
      ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'), join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm')]
      : ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.npm-global', 'bin'), join(homedir(), '.local', 'bin')]),
    ...nvmDirs().slice(0, 1)
  ].filter((d): d is string => !!d && existsSync(d))
  const key = win ? Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path' : 'PATH'
  return { ...process.env, [key]: [...new Set([...extra, ...(process.env[key] ?? '').split(delimiter).filter(Boolean)])].join(delimiter) }
}

/**
 * How to start the CLI with these arguments. A Windows npm shim (claude.cmd) can't be spawned without
 * a shell (and a shell would mangle the JSON argument of `mcp add-json`), so it runs as node + cli.js.
 */
export function cliCommand(cli: string, args: string[]): { command: string; args: string[] } {
  if (win && /\.cmd$/i.test(cli)) {
    const script = join(dirname(cli), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    const node = [join(dirname(cli), 'node.exe'), join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')].find((p) => existsSync(p))
    if (node && existsSync(script)) return { command: node, args: [script, ...args] }
  }
  return { command: cli, args }
}

/** Runs the CLI (PATH with node, no console window on Windows). */
export function runCli(cli: string, args: string[], opts: { timeout: number; cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  const c = cliCommand(cli, args)
  return run(c.command, c.args, { ...opts, env: cliEnv(cli), windowsHide: true })
}

const sameEntry = (a: any): boolean => {
  const want = mcpEntry()
  return a?.command === want.command && JSON.stringify(a?.args) === JSON.stringify(want.args) && JSON.stringify(a?.env ?? null) === JSON.stringify(want.env)
}

export async function status(): Promise<{ desktop: boolean; desktopInstalled: boolean; code: boolean; codeCli: boolean; snippet: string }> {
  let desktop = false
  try {
    // Connected = every Claude Desktop on this computer has the entry (the usual config when there is none yet).
    const files = desktopConfigs().filter((f, i) => i === 0 || existsSync(dirname(f)))
    desktop = files.every((f) => sameEntry(readDesktop(f)?.mcpServers?.[SERVER_NAME]))
  } catch {
    desktop = false
  }
  const cli = claudeCli()
  let code = false
  if (cli) {
    try {
      const { stdout } = await runCli(cli, ['mcp', 'get', SERVER_NAME], { timeout: 8000 })
      code = stdout.includes('klara_engine.mcp_server')
    } catch {
      code = false
    }
  }
  return {
    desktop,
    desktopInstalled: desktopInstalled(),
    code,
    codeCli: !!cli,
    snippet: JSON.stringify({ mcpServers: { [SERVER_NAME]: mcpEntry() } }, null, 2)
  }
}

/**
 * Adds (or updates) our server in Claude Desktop's config. Refuses to touch a config it can't
 * parse; keeps a dated copy of the previous file and replaces it atomically.
 */
export function connectDesktop(): void {
  let first: Error | null = null
  for (const file of desktopConfigs()) {
    try {
      const cfg = readDesktop(file)
      if (sameEntry(cfg?.mcpServers?.[SERVER_NAME])) continue
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [SERVER_NAME]: mcpEntry() }
      writeDesktop(file, cfg)
    } catch (err) {
      first ??= err as Error // e.g. a config someone edited by hand into invalid JSON: left untouched
    }
  }
  if (first) throw first
}

function writeDesktop(file: string, cfg: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(file, `${file}.${stamp}.bak`)
  }
  const tmp = `${file}.tmp-klara`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Windows: the paths of the running Claude Desktop processes. Claude Code's CLI is also called
 * claude.exe, so only the Desktop app's folders count (Squirrel install or Microsoft Store).
 */
async function windowsDesktopPaths(): Promise<string[]> {
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }'],
      { timeout: 10_000, windowsHide: true }
    )
    const paths = stdout.split(/\r?\n/).map((p) => p.trim()).filter((p) => /\\(AnthropicClaude|Programs\\Claude|WindowsApps\\[^\\]*Claude)[^\\]*\\/i.test(p))
    return [...new Set(paths)]
  } catch {
    return []
  }
}

/** Claude Desktop is open right now (it reads its config only when it starts). */
export async function desktopRunning(): Promise<boolean> {
  if (win) return (await windowsDesktopPaths()).length > 0
  try {
    await run('/usr/bin/pgrep', ['-x', 'Claude'], { timeout: 5000 })
    return true
  } catch {
    return false // pgrep exits 1 when nothing matches
  }
}

/**
 * Quits Claude Desktop and opens it again, so it loads the new connection. Only ever called from a
 * button the user pressed. Resolves false when it could not (Claude would not quit, or a Store
 * install that can't be started by path): the screen then asks to do it by hand.
 */
export async function restartDesktop(): Promise<boolean> {
  const wait = async (): Promise<boolean> => {
    for (let i = 0; i < 40 && (await desktopRunning()); i++) await new Promise((r) => setTimeout(r, 250))
    return !(await desktopRunning())
  }
  if (win) {
    const paths = await windowsDesktopPaths()
    const exe = paths.find((p) => !/WindowsApps/i.test(p))
    if (!exe) return false
    await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:KLARA_CLAUDE } | Stop-Process -Force'],
      { timeout: 15_000, windowsHide: true, env: { ...process.env, KLARA_CLAUDE: exe } }
    ).catch(() => undefined)
    if (!(await wait())) return false
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return true
  }
  if (process.platform !== 'darwin') return false
  await run('/usr/bin/pkill', ['-TERM', '-x', 'Claude'], { timeout: 5000 }).catch(() => undefined)
  if (!(await wait())) return false
  await run('/usr/bin/open', ['-a', 'Claude'], { timeout: 10_000 })
  return true
}

/**
 * Everything the app can connect by itself, without a click: Claude Desktop (when installed),
 * Claude Code (when its CLI is found) and the skills. Never throws: what failed is in `error`.
 */
export async function autoConnect(): Promise<ClaudeAuto> {
  const out: ClaudeAuto = { desktopInstalled: false, desktop: false, desktopRunning: false, codeCli: false, code: false, skills: 0 }
  const errors: string[] = []
  try {
    let s = await status()
    if (s.desktopInstalled && !s.desktop) {
      try {
        connectDesktop()
        console.log('Claude Desktop: connected Klara Wisper (MCP)')
      } catch (err) {
        errors.push(`Claude Desktop: ${(err as Error).message}`)
      }
    }
    if (s.codeCli && !s.code) {
      try {
        await connectCode()
        console.log('Claude Code: connected Klara Wisper (MCP)')
      } catch (err) {
        errors.push(`Claude Code: ${(err as Error).message}`)
      }
    }
    try {
      const skills = installSkills()
      if (skills.length) console.log(`Claude Code skills installed/updated: ${skills.join(', ')}`)
    } catch (err) {
      errors.push(`skills: ${(err as Error).message}`)
    }
    s = await status()
    Object.assign(out, { desktopInstalled: s.desktopInstalled, desktop: s.desktop, codeCli: s.codeCli, code: s.code, skills: installedSkills() })
    out.desktopRunning = s.desktopInstalled ? await desktopRunning() : false
  } catch (err) {
    errors.push((err as Error).message)
  }
  if (errors.length) out.error = errors.join(' | ')
  return out
}

/**
 * Takes the connection out again (uninstall, or "disconnect" in Settings): our entry in Claude
 * Desktop's config, the Claude Code MCP server and the skills this app installed.
 */
export async function disconnect(): Promise<void> {
  for (const file of desktopConfigs()) {
    try {
      const cfg = readDesktop(file)
      if (!cfg?.mcpServers?.[SERVER_NAME]) continue
      delete cfg.mcpServers[SERVER_NAME]
      writeDesktop(file, cfg)
    } catch {
      /* a config we can't parse is left alone */
    }
  }
  const cli = claudeCli()
  if (cli) await runCli(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], { timeout: 8000 }).catch(() => undefined)
  const dest = join(homedir(), '.claude', 'skills')
  try {
    for (const name of readdirSync(dest)) {
      if (existsSync(join(dest, name, MARK))) rmSync(join(dest, name), { recursive: true, force: true })
    }
  } catch {
    /* no skills folder */
  }
}

/** Whether the Claude Code CLI is signed in (needed for the automatic summaries; Desktop's own sign-in doesn't count). */
export async function signedIn(cli = claudeCli()): Promise<boolean> {
  if (!cli) return false
  try {
    const { stdout } = await runCli(cli, ['auth', 'status', '--json'], { timeout: 10_000, cwd: homedir() })
    return JSON.parse(stdout)?.loggedIn === true
  } catch {
    return false
  }
}

/**
 * Signs the CLI in with the user's Claude subscription: a Terminal window runs `claude auth login`,
 * which opens the sign-in page in the browser (Terminal handles the "paste the code" fallback).
 */
export function openSignIn(dataDir: string): string {
  const cli = claudeCli()
  if (!cli) throw new Error('Claude Code CLI not found')
  mkdirSync(dataDir, { recursive: true })
  const script = join(dataDir, 'claude-sign-in.command')
  const quoted = `'${cli.replace(/'/g, `'\\''`)}'`
  writeFileSync(
    script,
    `#!/bin/zsh\n# Klara Wisper: sign Claude Code in for automatic meeting summaries.\n${quoted} auth login --claudeai\necho\necho "You can close this window."\n`,
    { mode: 0o700 }
  )
  return script
}

/** Where the app keeps its Claude skills (skills/ in the checkout, Resources/skills in the app). */
function skillsSource(): string {
  return app.isPackaged ? join(process.resourcesPath, 'skills') : join(projectRoot, 'skills')
}

const MARK = '.installed-by-klara-wisper'

/** How many of our skills are in ~/.claude/skills right now. */
function installedSkills(): number {
  const dest = join(homedir(), '.claude', 'skills')
  try {
    return readdirSync(dest).filter((name) => existsSync(join(dest, name, MARK))).length
  } catch {
    return 0
  }
}

/**
 * Installs the Klara Wisper skills (before / during / after a call) for Claude Code in
 * ~/.claude/skills, and keeps them up to date. A folder the user put there themselves (no marker)
 * is left alone. Claude Desktop skills are uploaded by hand (skills/README.md).
 */
export function installSkills(): string[] {
  const src = skillsSource()
  if (!existsSync(src)) return []
  const dest = join(homedir(), '.claude', 'skills')
  const changed: string[] = []
  for (const name of readdirSync(src)) {
    const skill = join(src, name, 'SKILL.md')
    if (!existsSync(skill)) continue
    const target = join(dest, name)
    const mine = existsSync(join(target, MARK))
    if (existsSync(target) && !mine) continue
    const want = readFileSync(skill, 'utf8')
    if (mine && existsSync(join(target, 'SKILL.md')) && readFileSync(join(target, 'SKILL.md'), 'utf8') === want) continue
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), want)
    writeFileSync(join(target, MARK), 'Installed and updated by the Klara Wisper app. Delete this file to keep your own edits.\n')
    changed.push(name)
  }
  return changed
}

export async function connectCode(): Promise<void> {
  const cli = claudeCli()
  if (!cli) throw new Error('Claude Code CLI not found')
  await runCli(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], { timeout: 8000 }).catch(() => undefined)
  await runCli(cli, ['mcp', 'add-json', SERVER_NAME, JSON.stringify({ type: 'stdio', ...mcpEntry() }), '--scope', 'user'], { timeout: 15000 })
}
