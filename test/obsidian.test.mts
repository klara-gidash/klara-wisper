// Pure helpers behind the Obsidian export and transcript.md's front matter (src/shared/notes.ts).
// Run with `node --test test/obsidian.test.mts` (Node runs the TypeScript directly; no Electron).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  demoteHeadings,
  frontMatter,
  isInsideDir,
  meetingFrontMatter,
  meetingParticipants,
  noteFileName,
  sanitizeNoteName,
  stripFrontMatter,
  yamlString
} from '../src/shared/notes.ts'

const meta = {
  id: 'm_123',
  title: 'סטטוס "Q4": תמחור / Acme',
  source: 'zoom',
  mode: 'meeting',
  startedAt: new Date(2026, 10, 7, 9, 5).toISOString(),
  durationSec: 1830,
  folder: '/tmp/x',
  status: 'done',
  speakers: {},
  calendarEvent: { id: 'e1', title: 'סטטוס שבועי', start: '', end: '', calendar: '', color: null, location: '', links: [], organizer: '', attendees: [] },
  attendees: [
    { name: 'קלרה', email: 'me@example.com', isMe: true },
    { name: 'דנה כהן', email: 'dana@example.com' },
    { name: '', email: 'ops@example.com' }
  ],
  scope: 'תמחור ללקוח חדש',
  inferredParticipants: ['should not be used']
} as any

// js-yaml ships with electron-builder; when it's there, the front matter is checked with a real YAML parser.
let yaml: { load: (s: string) => unknown } | null = null
try {
  yaml = (await import('js-yaml')).default
} catch {
  yaml = null
}

const block = (fm: string): string => {
  assert.ok(fm.startsWith('---\n'), 'starts with ---')
  assert.ok(fm.endsWith('\n---\n'), 'ends with ---')
  return fm.slice(4, -5)
}

test('sanitizeNoteName strips path and reserved characters', () => {
  assert.equal(sanitizeNoteName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j')
  assert.equal(sanitizeNoteName('  ../../etc/passwd  '), 'etc passwd')
  assert.equal(sanitizeNoteName('תמחור #1 [טיוטה] ^x'), 'תמחור 1 טיוטה x')
  assert.equal(sanitizeNoteName('line\nbreak\ttab\u0000nul'), 'line break tab nul')
  assert.equal(sanitizeNoteName('.hidden'), 'hidden')
  assert.equal(sanitizeNoteName('trailing dots...  '), 'trailing dots')
  assert.equal(sanitizeNoteName('///'), '')
})

test('sanitizeNoteName trims to 80 characters without splitting an emoji', () => {
  assert.equal(sanitizeNoteName('א'.repeat(200)).length, 80)
  const s = sanitizeNoteName('x'.repeat(79) + '😀😀')
  assert.equal(Array.from(s).length, 80)
  assert.ok(s.endsWith('😀'))
  assert.ok(!/[\ud800-\udbff]$/.test(s), 'no half surrogate at the end')
})

test('noteFileName is "YYYY-MM-DD HH-MM title.md" in local time', () => {
  assert.equal(noteFileName(meta), '2026-11-07 09-05 סטטוס Q4 תמחור Acme.md')
  assert.equal(noteFileName({ startedAt: meta.startedAt, title: '' }), '2026-11-07 09-05.md')
  assert.equal(noteFileName({ startedAt: 'nonsense', title: '///' }), 'Klara Wisper.md')
  const long = noteFileName({ startedAt: meta.startedAt, title: 'ש'.repeat(300) })
  assert.equal(Array.from(long.replace(/\.md$/, '')).length, 80)
})

test('yamlString quotes safely (JSON-style, Hebrew kept as is)', () => {
  assert.equal(yamlString('שלום'), '"שלום"')
  assert.equal(yamlString('a "b" \\ c'), '"a \\"b\\" \\\\ c"')
  assert.equal(yamlString('line\nbreak'), '"line\\nbreak"')
  assert.equal(yamlString('x\u2028y\u0085z'), '"x\\u2028y\\u0085z"')
  assert.equal(yamlString('#not a comment: [x]'), '"#not a comment: [x]"')
})

test('meetingParticipants: calendar attendees minus the user, else Claude’s list', () => {
  assert.deepEqual(meetingParticipants(meta), ['דנה כהן', 'ops@example.com'])
  assert.deepEqual(meetingParticipants({ attendees: [{ name: 'קלרה', email: '', isMe: true }], inferredParticipants: ['יוסי', 'יוסי', ' '] }), ['יוסי'])
  assert.deepEqual(meetingParticipants({ inferredParticipants: null }), [])
})

test('meetingFrontMatter has the expected keys, in order', () => {
  const fm = meetingFrontMatter(meta, { obsidian_id: meta.id })
  const keys = block(fm)
    .split('\n')
    .filter((l) => /^[a-z_]+:/.test(l))
    .map((l) => l.split(':')[0])
  assert.deepEqual(keys, ['id', 'title', 'date', 'source', 'duration_min', 'calendar_event', 'participants', 'scope', 'tags', 'obsidian_id'])
  assert.match(fm, /^title: "סטטוס \\"Q4\\": תמחור \/ Acme"$/m)
  assert.match(fm, /^duration_min: 31$/m)
  assert.match(fm, /^tags:\n {2}- "klara-wisper"$/m)
  assert.match(fm, new RegExp(`^date: "${meta.startedAt}"$`, 'm'))
})

test('meetingFrontMatter: missing values are null or empty', () => {
  const fm = meetingFrontMatter({ ...meta, calendarEvent: null, attendees: [], inferredParticipants: null, scope: undefined, durationSec: undefined })
  assert.match(fm, /^calendar_event: null$/m)
  assert.match(fm, /^participants: \[\]$/m)
  assert.match(fm, /^scope: null$/m)
  assert.match(fm, /^duration_min: null$/m)
})

test('front matter parses as YAML to the original values', { skip: !yaml && 'js-yaml not installed' }, () => {
  const tricky = { ...meta, title: 'a: b # c\n"d" — שלום\u2028end', scope: "it's - [x] {y}" }
  const doc = yaml!.load(block(meetingFrontMatter(tricky, { obsidian_id: meta.id }))) as Record<string, unknown>
  assert.equal(doc.id, 'm_123')
  assert.equal(doc.title, tricky.title)
  assert.equal(doc.scope, tricky.scope)
  assert.equal(doc.date, meta.startedAt)
  assert.equal(doc.source, 'zoom')
  assert.equal(doc.duration_min, 31)
  assert.equal(doc.calendar_event, 'סטטוס שבועי')
  assert.deepEqual(doc.participants, ['דנה כהן', 'ops@example.com'])
  assert.deepEqual(doc.tags, ['klara-wisper'])
  assert.equal(doc.obsidian_id, 'm_123')
})

test('frontMatter skips keys that are not plain identifiers', () => {
  assert.equal(frontMatter({ ok: 1, 'bad key': 2, 'x:y': 3 }), '---\nok: 1\n---\n')
})

test('isInsideDir: only paths strictly inside the vault', () => {
  const vault = '/Users/k/Vault'
  assert.equal(isInsideDir(vault, '/Users/k/Vault/Klara Wisper/a.md', path.posix), true)
  assert.equal(isInsideDir(vault, '/Users/k/Vault/Klara Wisper/../x.md', path.posix), true)
  assert.equal(isInsideDir(vault, '/Users/k/Vault/..foo.md', path.posix), true)
  assert.equal(isInsideDir(vault, '/Users/k/Vault', path.posix), false)
  assert.equal(isInsideDir(vault, '/Users/k/Vault/../Other/a.md', path.posix), false)
  assert.equal(isInsideDir(vault, '/Users/k/Vault2/a.md', path.posix), false)
  assert.equal(isInsideDir(vault, '/etc/passwd', path.posix), false)
  assert.equal(isInsideDir(vault + '/', '/Users/k/Vault/a.md', path.posix), true)
})

test('isInsideDir on Windows paths', () => {
  const vault = 'C:\\Users\\k\\Vault'
  assert.equal(isInsideDir(vault, 'C:\\Users\\k\\Vault\\Klara Wisper\\a.md', path.win32), true)
  assert.equal(isInsideDir(vault, 'D:\\Users\\k\\Vault\\a.md', path.win32), false)
  assert.equal(isInsideDir(vault, 'C:\\Users\\k\\Vault\\..\\a.md', path.win32), false)
})

test('a joined note name stays inside the vault folder', () => {
  const dir = '/Users/k/Vault/Klara Wisper'
  for (const title of ['../../../etc/passwd', '..', '/abs/path', 'C:\\win']) {
    const target = path.posix.join(dir, noteFileName({ startedAt: meta.startedAt, title }))
    assert.equal(isInsideDir(dir, target, path.posix), true, title)
  }
})

test('stripFrontMatter and demoteHeadings prepare a saved summary for the note', () => {
  assert.equal(stripFrontMatter('---\na: 1\n---\n# Title\ntext'), '# Title\ntext')
  assert.equal(stripFrontMatter('# No front matter\n---\n'), '# No front matter\n---\n')
  assert.equal(demoteHeadings('# A\n## B\ntext #not\n###### F'), '### A\n#### B\ntext #not\n###### F')
  assert.equal(demoteHeadings('```\n# code\n```\n# real'), '```\n# code\n```\n### real')
  assert.equal(demoteHeadings('#hashtag'), '#hashtag')
})
