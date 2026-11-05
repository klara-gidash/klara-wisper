import { app } from 'electron'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { enginePython, projectRoot } from './paths'

const run = promisify(execFile)
const SERVER_NAME = 'klara-wisper'
const desktopConfig =
  process.platform === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')

/**
 * How Claude starts our MCP server: the engine's Python, separate from this app, so the app
 * binary never runs arbitrary scripts. The server reads the transcripts folder from settings.json.
 * In an installed app that is <data folder>/engine (set up on first launch), so the entry keeps
 * working when the app is moved or updated.
 */
export function mcpEntry(): { command: string; args: string[] } {
  return { command: enginePython(), args: ['-m', 'klara_engine.mcp_server'] }
}

/** Parsed config, `{}` if there is none yet; throws if the file exists but isn't valid JSON. */
function readDesktop(): any {
  if (!existsSync(desktopConfig)) return {}
  return JSON.parse(readFileSync(desktopConfig, 'utf8'))
}

export function claudeCli(): string | null {
  const candidates = [
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude'
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

const sameEntry = (a: any): boolean => {
  const want = mcpEntry()
  return a?.command === want.command && JSON.stringify(a?.args) === JSON.stringify(want.args) && !a?.env
}

export async function status(): Promise<{ desktop: boolean; desktopInstalled: boolean; code: boolean; codeCli: boolean; snippet: string }> {
  let desktop = false
  try {
    desktop = sameEntry(readDesktop()?.mcpServers?.[SERVER_NAME])
  } catch {
    desktop = false
  }
  const cli = claudeCli()
  let code = false
  if (cli) {
    try {
      const { stdout } = await run(cli, ['mcp', 'get', SERVER_NAME], { timeout: 8000 })
      code = stdout.includes('klara_engine.mcp_server')
    } catch {
      code = false
    }
  }
  return {
    desktop,
    desktopInstalled: existsSync(dirname(desktopConfig)),
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
  const cfg = readDesktop()
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [SERVER_NAME]: mcpEntry() }
  mkdirSync(dirname(desktopConfig), { recursive: true })
  if (existsSync(desktopConfig)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(desktopConfig, `${desktopConfig}.${stamp}.bak`)
  }
  const tmp = `${desktopConfig}.tmp-klara`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  renameSync(tmp, desktopConfig)
}

/** Whether the Claude Code CLI is signed in (needed for the automatic summaries; Desktop's own sign-in doesn't count). */
export async function signedIn(cli = claudeCli()): Promise<boolean> {
  if (!cli) return false
  try {
    const { stdout } = await run(cli, ['auth', 'status', '--json'], { timeout: 10_000, cwd: homedir() })
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
  await run(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], { timeout: 8000 }).catch(() => undefined)
  await run(cli, ['mcp', 'add-json', SERVER_NAME, JSON.stringify({ type: 'stdio', ...mcpEntry() }), '--scope', 'user'], { timeout: 15000 })
}
