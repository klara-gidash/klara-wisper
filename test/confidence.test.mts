// Confidence marks: which parts of a transcript line get the "unsure" underline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LINE_UNSURE, timeAt, unsurePieces, unsureRanges } from '../src/shared/confidence.ts'

const joined = (pieces: { text: string }[]): string => pieces.map((p) => p.text).join('')
const marked = (pieces: { text: string; unsure: boolean }[]): string[] => pieces.filter((p) => p.unsure).map((p) => p.text)

test('older lines without confidence fields are one plain piece', () => {
  assert.deepEqual(unsurePieces({ text: 'שלום לכולם' }), [{ text: 'שלום לכולם', at: 0, unsure: false }])
  assert.deepEqual(unsurePieces({ text: '' }), [])
  assert.deepEqual(unsurePieces({ text: 'שלום', conf: 0.97 }), [{ text: 'שלום', at: 0, unsure: false }])
})

test('unsure words are marked at their stored offset, even when the word repeats', () => {
  const text = 'את הפגישה את זה'
  const pieces = unsurePieces({ text, conf: 0.9, words: [{ t: 'את', p: 0.3, i: 10 }] })
  assert.equal(joined(pieces), text)
  assert.deepEqual(pieces, [
    { text: 'את הפגישה ', at: 0, unsure: false },
    { text: 'את', at: 10, unsure: true, p: 0.3 },
    { text: ' זה', at: 12, unsure: false }
  ])
})

test('adjacent unsure words become one phrase with the lowest probability', () => {
  const text = 'נדבר עם ליגל, ונבוא לכל מיוחד. טוב'
  const words = [
    { t: 'ליגל', p: 0.4, i: 8 },
    { t: 'ונבוא', p: 0.2, i: 14 },
    { t: 'טוב', p: 0.45, i: 31 }
  ]
  const r = unsureRanges({ text, words })
  assert.deepEqual(r, [
    [8, 19, 0.2],
    [31, 34, 0.45]
  ])
  const pieces = unsurePieces({ text, conf: 0.7, words })
  assert.equal(joined(pieces), text)
  assert.deepEqual(marked(pieces), ['ליגל, ונבוא', 'טוב'])
})

test('a wrong or missing offset falls back to finding the word in order', () => {
  const text = 'זה זה וזה'
  const pieces = unsurePieces({ text, words: [{ t: 'זה', p: 0.1, i: 99 }, { t: 'וזה', p: 0.2 }] })
  assert.equal(joined(pieces), text)
  assert.deepEqual(marked(pieces), ['זה', 'וזה'])
  assert.equal(pieces[0].at, 0)
  // a word that is no longer in the text (edited) is skipped
  assert.deepEqual(marked(unsurePieces({ text: 'אחר', words: [{ t: 'זה', p: 0.1, i: 0 }] })), [])
})

test('words at or above the threshold and legacy all-word entries', () => {
  const text = 'טוב רע'
  // very early files kept every word as {word, p}: only low ones count
  const legacy = [
    { t: undefined as unknown as string, word: ' טוב', p: 0.9 },
    { t: undefined as unknown as string, word: ' רע', p: 0.1 }
  ]
  assert.deepEqual(marked(unsurePieces({ text, words: legacy })), ['רע'])
  assert.deepEqual(marked(unsurePieces({ text, words: [{ t: 'טוב', p: 0.5, i: 0 }] })), [])
})

test('a low line with no per-word data is marked whole (Windows engine)', () => {
  const text = 'משפט שלא נשמע טוב'
  assert.deepEqual(unsurePieces({ text, conf: LINE_UNSURE - 0.1 }), [{ text, at: 0, unsure: true, p: LINE_UNSURE - 0.1 }])
  assert.deepEqual(marked(unsurePieces({ text, conf: LINE_UNSURE })), [])
  // word marks win over the whole-line mark
  assert.deepEqual(marked(unsurePieces({ text, conf: 0.3, words: [{ t: 'נשמע', p: 0.2, i: 9 }] })), ['נשמע'])
})

test('time of a piece is proportional to its offset', () => {
  const seg = { text: 'abcdefghij', start: 10, end: 20 }
  assert.equal(timeAt(seg, 0), 10)
  assert.equal(timeAt(seg, 5), 15)
  assert.equal(timeAt(seg, 50), 20)
  assert.equal(timeAt({ text: '', start: 3, end: 4 }, 2), 3)
})
