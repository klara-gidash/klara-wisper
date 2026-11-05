import type { SpeakerInfo } from '@shared/types'

export const locale = (lang: string): string => (lang === 'he' ? 'he-IL' : 'en-US')

export function timeHM(iso: string | Date, lang: string): string {
  return new Date(iso).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' })
}

export function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function dayLabel(iso: string, lang: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400_000)
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  if (same(d, today)) return lang === 'he' ? 'היום' : 'Today'
  if (same(d, yesterday)) return lang === 'he' ? 'אתמול' : 'Yesterday'
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString(locale(lang), opts)
}

export function groupByDay<T>(items: T[], date: (t: T) => string): { key: string; date: string; items: T[] }[] {
  const out: { key: string; date: string; items: T[] }[] = []
  for (const it of items) {
    const k = dayKey(date(it))
    const last = out[out.length - 1]
    if (last && last.key === k) last.items.push(it)
    else out.push({ key: k, date: date(it), items: [it] })
  }
  return out
}

const PALETTE = ['#6366F1', '#14B8A6', '#F59E0B', '#F43F5E', '#0EA5E9', '#84CC16', '#A855F7', '#F97316']

export function speakerColor(label: string | null | undefined, speakers?: Record<string, SpeakerInfo>): string {
  if (!label) return 'var(--ink-3)'
  if (label === 'me' || speakers?.[label]?.isMe) return 'var(--accent)'
  const n = Number(/\d+$/.exec(label)?.[0] ?? 0)
  return PALETTE[(n - 1 + PALETTE.length) % PALETTE.length]
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '·'
}

/** Wraps matches of `query` in <mark> (returns React-safe segments). */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim()
  if (!q) return [{ text, hit: false }]
  const out: { text: string; hit: boolean }[] = []
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  let i = 0
  for (;;) {
    const j = lower.indexOf(ql, i)
    if (j < 0) break
    if (j > i) out.push({ text: text.slice(i, j), hit: false })
    out.push({ text: text.slice(j, j + q.length), hit: true })
    i = j + q.length
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false })
  return out
}

/** Display name of the transcription model the engine reports. */
export function modelName(key: string | null | undefined): string {
  if (!key) return 'Whisper'
  if (key.includes('ivrit')) return 'Whisper turbo · ivrit.ai'
  if (key.includes('turbo')) return 'Whisper large-v3 turbo'
  return 'Whisper large-v3'
}
