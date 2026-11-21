import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { managedEngineDir } from './paths'

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
