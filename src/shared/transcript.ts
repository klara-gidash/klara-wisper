import type { MeetingMeta, Segment, SpeakerInfo } from './types'
import { SOURCE_LABEL } from './types'

export function speakerName(
  label: string | null | undefined,
  speakers: Record<string, SpeakerInfo> | undefined,
  ui: 'he' | 'en' = 'he',
  userName = ''
): string {
  if (!label) return ui === 'he' ? 'לא ידוע' : 'Unknown'
  const info = speakers?.[label]
  if (info?.name) return info.name
  if (info?.isMe || label === 'me') return userName || (ui === 'he' ? 'אני' : 'Me')
  if (label === 'rem') return ui === 'he' ? 'משתתפים' : 'Participants'
  const m = /^(spk|rem)(\d+)$/.exec(label)
  if (m) {
    const n = m[2]
    if (m[1] === 'spk') return ui === 'he' ? `דובר ${n}` : `Speaker ${n}`
    return ui === 'he' ? `משתתף ${n}` : `Participant ${n}`
  }
  return label
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function fmtDuration(sec: number | undefined, ui: 'he' | 'en' = 'he'): string {
  if (!sec || sec < 1) return ui === 'he' ? 'פחות מדקה' : '< 1 min'
  const min = Math.round(sec / 60)
  if (min < 60) return ui === 'he' ? `${Math.max(min, 1)} דק׳` : `${Math.max(min, 1)} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return ui === 'he' ? `${h} ש׳ ${m ? `${m} דק׳` : ''}`.trim() : `${h} h ${m ? `${m} min` : ''}`.trim()
}

export function sanitizeName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** Paragraphs: consecutive lines of the same speaker with short gaps are joined. */
export function paragraphs(segments: Segment[], maxGap = 20): { speaker: string | null; start: number; end: number; lines: Segment[] }[] {
  const out: { speaker: string | null; start: number; end: number; lines: Segment[] }[] = []
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && last.speaker === s.speaker && s.start - last.end <= maxGap) {
      last.lines.push(s)
      last.end = Math.max(last.end, s.end)
    } else {
      out.push({ speaker: s.speaker, start: s.start, end: s.end, lines: [s] })
    }
  }
  return out
}

export function toMarkdown(meta: MeetingMeta, segments: Segment[], userName = ''): string {
  const ui = 'he'
  const date = new Date(meta.startedAt)
  const when = date.toLocaleString('he-IL', { dateStyle: 'full', timeStyle: 'short' })
  const lines = [`# ${meta.title}`, '', `${when} · ${SOURCE_LABEL[meta.source]} · ${fmtDuration(meta.durationSec, ui)}`]
  const attendees = (meta.attendees ?? []).map((a) => a.name || a.email).filter(Boolean)
  if (attendees.length) lines.push(`משתתפים: ${attendees.join(', ')}`)
  lines.push('')
  for (const p of paragraphs(segments)) {
    lines.push(`**${speakerName(p.speaker, meta.speakers, ui, userName)}** [${fmtClock(p.start)}]`)
    lines.push(p.lines.map((l) => l.text).join(' '))
    lines.push('')
  }
  return lines.join('\n')
}

/** Strip Hebrew niqqud and normalise case/whitespace, for search. */
export function normalizeForSearch(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
}
