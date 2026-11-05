/**
 * Reading the transcripts folder. No Electron imports: shared by the app and the MCP server
 * (which runs under plain Node via ELECTRON_RUN_AS_NODE).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Meeting, MeetingMeta } from './types'

export function listMeetingFolders(meetingsRoot: string): string[] {
  if (!existsSync(meetingsRoot)) return []
  const out: string[] = []
  const dirs = (p: string): string[] => readdirSync(p).filter((n) => !n.startsWith('.') && statSync(join(p, n)).isDirectory())
  for (const y of dirs(meetingsRoot)) {
    if (!/^\d{4}$/.test(y)) continue
    for (const m of dirs(join(meetingsRoot, y))) {
      for (const name of dirs(join(meetingsRoot, y, m))) {
        const p = join(meetingsRoot, y, m, name)
        if (existsSync(join(p, 'meta.json'))) out.push(p)
      }
    }
  }
  return out
}

export function readMeta(folder: string): MeetingMeta | null {
  try {
    return { ...JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8')), folder }
  } catch {
    return null
  }
}

export function readMeeting(folder: string): Meeting | null {
  try {
    const meta = readMeta(folder)
    const t = existsSync(join(folder, 'transcript.json')) ? JSON.parse(readFileSync(join(folder, 'transcript.json'), 'utf8')) : { segments: [] }
    if (!meta) return null
    const summaryPath = join(folder, 'summary.md')
    return {
      meta: { ...meta, hasAudio: existsSync(join(folder, 'audio.m4a')) },
      segments: t.segments ?? [],
      summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : null
    }
  } catch {
    return null
  }
}
