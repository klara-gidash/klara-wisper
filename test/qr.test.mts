// The in-repo QR encoder (src/shared/qr.ts) used for the phone link in Settings.
// Codes made by it were also checked by decoding them with macOS CoreImage (CIDetector) during development.
// Run with `node --test test/qr.test.mts`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qrMatrix, qrSvgPath } from '../src/shared/qr.ts'

const finderAt = (m: boolean[][], x: number, y: number): boolean => {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
      if (m[y + dy][x + dx] !== (ring !== 2)) return false
    }
  }
  return true
}

test('a phone link (124 characters) makes a version 8 code (49 modules) at level M', () => {
  const url = 'https://klara-wisper-gateway.klara-1a2b3c4d.workers.dev/rec/' + 'ab12'.repeat(16)
  assert.equal(url.length, 124)
  const m = qrMatrix(url, 'M')
  assert.equal(m.length, 49)
  assert.ok(m.every((row) => row.length === 49))
  assert.ok(finderAt(m, 0, 0) && finderAt(m, 42, 0) && finderAt(m, 0, 42), 'three finder patterns')
  assert.equal(m[49 - 8][8], true, 'the dark module')
  for (let i = 8; i < 41; i++) assert.equal(m[6][i], i % 2 === 0, 'timing pattern')
})

test('small and long texts pick the smallest version; the same text gives the same code', () => {
  assert.equal(qrMatrix('hello', 'M').length, 21)
  assert.equal(qrMatrix('x'.repeat(320), 'M').length > 57, true)
  assert.deepEqual(qrMatrix('same'), qrMatrix('same'))
  assert.throws(() => qrMatrix('x'.repeat(3000), 'M'))
})

test('the SVG path draws one square per dark module, inside the quiet zone', () => {
  const m = qrMatrix('hello')
  const path = qrSvgPath(m, 4)
  const dark = m.flat().filter(Boolean).length
  assert.equal((path.match(/M/g) ?? []).length, dark)
  assert.ok(path.startsWith('M4,4h1v1h-1z'))
})
