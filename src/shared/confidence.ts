import type { Segment } from './types'

/**
 * Confidence marks (roadmap item 4): which parts of a transcript line the model was unsure of.
 *
 * The engine stores, per segment, `conf` (0..1, from the decode's average log-probability) and
 * `words`: only the unsure words, each with its probability and offset in the text. The same
 * thresholds are in engine/klara_engine/asr_common.py.
 */

/** A word is unsure below this probability. */
export const WORD_UNSURE = 0.5
/** With no unsure word listed (or no per-word data: Windows), a whole line is unsure below this. */
export const LINE_UNSURE = 0.65

export interface Piece {
  text: string
  /** Character offset of this piece in the segment text. */
  at: number
  unsure: boolean
  /** The lowest word probability in an unsure piece (the line's conf for a whole-line mark). */
  p?: number
}

type Line = Pick<Segment, 'text' | 'conf' | 'words'>

// Between two unsure words: only spaces / punctuation -> one marked phrase.
const JOIN = /^[\s.,;:!?'"״׳()\-–—]*$/

/** Unsure [start, end, p] ranges in `text`, in order, adjacent words merged into phrases. */
export function unsureRanges(line: Line, threshold = WORD_UNSURE): [number, number, number][] {
  const text = line.text ?? ''
  const found: [number, number, number][] = []
  let cursor = 0
  for (const w of line.words ?? []) {
    if (!w || typeof w.p !== 'number' || !(w.p < threshold)) continue
    const t = (w.t ?? w.word ?? '').trim()
    if (!t) continue
    // The stored offset is exact for files from this engine; otherwise find the word after the last one.
    let at = typeof w.i === 'number' && w.i >= cursor && text.startsWith(t, w.i) ? w.i : text.indexOf(t, cursor)
    if (at < 0) at = text.indexOf(t) // out of order (hand-edited text): any occurrence
    if (at < 0) continue
    found.push([at, at + t.length, w.p])
    cursor = Math.max(cursor, at + t.length)
  }
  found.sort((a, b) => a[0] - b[0])
  const out: [number, number, number][] = []
  for (const r of found) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1])
      last[2] = Math.min(last[2], r[2])
    } else if (last && JOIN.test(text.slice(last[1], r[0]))) {
      last[1] = r[1]
      last[2] = Math.min(last[2], r[2])
    } else out.push([...r])
  }
  return out
}

/**
 * The line cut into plain and unsure pieces that together are exactly its text.
 * Older files (no conf, no words) come back as one plain piece.
 */
export function unsurePieces(line: Line): Piece[] {
  const text = line.text ?? ''
  if (!text) return []
  const ranges = unsureRanges(line)
  if (!ranges.length) {
    const low = typeof line.conf === 'number' && line.conf < LINE_UNSURE
    return [low ? { text, at: 0, unsure: true, p: line.conf } : { text, at: 0, unsure: false }]
  }
  const out: Piece[] = []
  let i = 0
  for (const [s, e, p] of ranges) {
    if (s > i) out.push({ text: text.slice(i, s), at: i, unsure: false })
    out.push({ text: text.slice(s, e), at: s, unsure: true, p })
    i = e
  }
  if (i < text.length) out.push({ text: text.slice(i), at: i, unsure: false })
  return out
}

/**
 * Roughly when a piece of a line was said (seconds), for "play from here": there are no word
 * timestamps, so the time is placed in proportion to the characters before it.
 */
export function timeAt(seg: Pick<Segment, 'text' | 'start' | 'end'>, offset: number): number {
  const n = seg.text.length
  if (!n || offset <= 0) return seg.start
  return seg.start + Math.min(1, offset / n) * Math.max(0, seg.end - seg.start)
}
