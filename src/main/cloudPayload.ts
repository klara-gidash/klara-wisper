/**
 * The meeting body sent to the Worker's POST /api/meetings, cut to what one D1 row can hold.
 * D1 stores at most 2,000,000 bytes per row and the Worker refuses (413) a body whose fields together are
 * over 1,990,000 bytes of UTF-8. Hebrew letters are 2 bytes each, so a length in characters is not enough.
 * No Electron here (tests: test/cloud-payload.test.mts); cloud.ts sends the result.
 */

/** Bytes for the whole row, under the Worker's 1,990,000 with room to spare. */
export const ROW_BUDGET = 1_900_000
/** The Worker refuses a summary over 200,000 bytes. */
export const SUMMARY_MAX = 190_000

export const CUT_NOTE_HE = '\n\n[התמלול קוצר: הוא ארוך מדי לענן. התמלול המלא נמצא ב-Klara Wisper במחשב.]\n'
export const CUT_NOTE_EN = '\n\n[Transcript cut: too long for the cloud. The full transcript is in Klara Wisper on the computer.]\n'

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** The longest start of `s` that is at most `maxBytes` of UTF-8, never splitting a character; at a line end when one is near. */
export function clipUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8Bytes(s) <= maxBytes) return s
  const buf = Buffer.from(s, 'utf8')
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end-- // back to the start of a UTF-8 sequence
  let out = buf.subarray(0, end).toString('utf8')
  const nl = out.lastIndexOf('\n')
  if (nl > out.length * 0.9) out = out.slice(0, nl + 1)
  return out
}

export interface MeetingPayload {
  id: string
  title: string
  startedAt: string
  durationSec: number
  source: string
  participants: string[]
  scope: string | null
  calendarTitle: string | null
  transcript: string
  summary: string | null
}

/** The same meeting, with the summary and then the transcript cut so the row fits; a note says the transcript was cut. */
export function fitMeetingPayload(input: MeetingPayload, lang: 'he' | 'en' = 'he'): MeetingPayload {
  // The Worker's own field limits (cloudflare/README.md), so a long calendar title can't make every upload fail.
  const p: MeetingPayload = {
    ...input,
    title: (input.title ?? '').slice(0, 1000),
    source: (input.source ?? '').slice(0, 40),
    participants: (input.participants ?? []).slice(0, 500).map((x) => String(x).slice(0, 300)),
    scope: input.scope == null ? null : input.scope.slice(0, 4000),
    calendarTitle: input.calendarTitle == null ? null : input.calendarTitle.slice(0, 1000),
    durationSec: Math.min(7 * 86400, Math.max(0, Number(input.durationSec) || 0))
  }
  const summary = p.summary == null ? null : clipUtf8(p.summary, SUMMARY_MAX)
  const rest =
    utf8Bytes(p.title) + utf8Bytes(p.scope ?? '') + utf8Bytes(p.calendarTitle ?? '') + utf8Bytes(JSON.stringify(p.participants)) +
    utf8Bytes(p.source) + utf8Bytes(p.id) + utf8Bytes(summary ?? '')
  const room = ROW_BUDGET - rest
  let transcript = p.transcript
  if (utf8Bytes(transcript) > room) {
    const note = lang === 'en' ? CUT_NOTE_EN : CUT_NOTE_HE
    transcript = clipUtf8(transcript, room - utf8Bytes(note)) + note
  }
  return { ...p, summary, transcript }
}
