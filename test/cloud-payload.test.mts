// The meeting body sent to the Worker fits one D1 row (src/main/cloudPayload.ts).
// Run with `node --test test/cloud-payload.test.mts`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CUT_NOTE_HE, ROW_BUDGET, SUMMARY_MAX, clipUtf8, fitMeetingPayload, utf8Bytes, type MeetingPayload } from '../src/main/cloudPayload.ts'

const base = (over: Partial<MeetingPayload> = {}): MeetingPayload => ({
  id: 'm_1', title: 'שיחה', startedAt: '2026-11-21T08:00:00.000Z', durationSec: 60, source: 'zoom',
  participants: ['דוד'], scope: null, calendarTitle: null, transcript: 'שלום\n', summary: null, ...over
})

test('a normal meeting goes through unchanged', () => {
  const p = base({ summary: '## תקציר\nהכול טוב' })
  assert.deepEqual(fitMeetingPayload(p), p)
})

test('a long Hebrew transcript is cut by bytes, not characters (the old 1,900,000-character cut sent 3.8 MB)', () => {
  // 1,900,000 Hebrew characters: what the old .slice(0, 1_900_000) let through, 3.8 MB and a 413 every time.
  const line = 'דובר 1 [00:01]\nזה משפט בעברית על התקציב.\n'
  const transcript = line.repeat(Math.ceil(1_900_000 / line.length))
  const out = fitMeetingPayload(base({ transcript, summary: 'ס'.repeat(50_000) }))
  const total = utf8Bytes(out.transcript) + utf8Bytes(out.summary ?? '') + utf8Bytes(out.title) + utf8Bytes(JSON.stringify(out.participants))
  assert.ok(total <= ROW_BUDGET, `row ${total} bytes`)
  assert.ok(total > ROW_BUDGET - 10_000, 'uses the room it has')
  assert.ok(out.transcript.endsWith(CUT_NOTE_HE), 'says it was cut')
  assert.ok(transcript.startsWith(out.transcript.slice(0, -CUT_NOTE_HE.length)), 'a prefix of the original')
  assert.equal(out.summary?.length, 50_000, 'the summary is kept')
})

test('the summary is capped below the Worker limit, the transcript gets the rest', () => {
  const out = fitMeetingPayload(base({ summary: 'ב'.repeat(150_000), transcript: 'x'.repeat(1_800_000) }))
  assert.ok(utf8Bytes(out.summary ?? '') <= SUMMARY_MAX)
  assert.ok(utf8Bytes(out.summary ?? '') + utf8Bytes(out.transcript) <= ROW_BUDGET)
})

test('field limits of the Worker are respected', () => {
  const out = fitMeetingPayload(base({ title: 'ת'.repeat(2000), participants: Array(600).fill('n'.repeat(400)), scope: 's'.repeat(5000), durationSec: 1e9 }))
  assert.equal(out.title.length, 1000)
  assert.equal(out.participants.length, 500)
  assert.equal(out.participants[0].length, 300)
  assert.equal(out.scope?.length, 4000)
  assert.equal(out.durationSec, 7 * 86400)
})

test('clipUtf8 never splits a character (Hebrew, emoji)', () => {
  const s = 'א🚀ב'.repeat(1000)
  for (let max = 0; max < 60; max++) {
    const c = clipUtf8(s, max)
    assert.ok(utf8Bytes(c) <= max)
    assert.ok(!c.includes('�'), 'no replacement character')
    assert.ok(s.startsWith(c))
  }
})
