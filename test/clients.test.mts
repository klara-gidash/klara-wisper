// Client file: grouping meetings by company / person / title words, and reading tasks out of summaries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { companyName, digestSummary, groupClients, ownDomains, registrableDomain, titleWords, type ClientMeetingInput } from '../src/shared/clients.ts'

const me = { name: 'Klara', email: 'klara@visitt.io', isMe: true }
const colleague = { name: 'Noa', email: 'noa@visitt.io' }

function m(id: string, day: number, title: string, attendees: ClientMeetingInput['attendees'] = [], extra: Partial<ClientMeetingInput> = {}): ClientMeetingInput {
  return { id, title, startedAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z`, attendees, ...extra }
}

test('registrable domain and company name', () => {
  assert.equal(registrableDomain('Dana@EU.Acme.com'), 'acme.com')
  assert.equal(registrableDomain('x@mail.shikun.co.il'), 'shikun.co.il')
  assert.equal(registrableDomain('x@tau.ac.il'), 'tau.ac.il')
  assert.equal(registrableDomain('no-domain'), '')
  assert.equal(registrableDomain(''), '')
  assert.equal(companyName('shikun-binui.co.il'), 'Shikun Binui')
  assert.equal(companyName('acme.com'), 'Acme')
})

test('title words drop stopwords, short words and numbers', () => {
  assert.deepEqual(titleWords('Weekly sync with Acme 2026'), ['acme'])
  assert.deepEqual(titleWords('שיחה עם דוד מ-שיכון על החוזה'), ['דוד', 'שיכון', 'החוזה'])
  assert.deepEqual(titleWords('פְּגִישָׁה'), [])
})

test('own domain comes from the attendee marked as me, and from a calendar named by an email', () => {
  assert.deepEqual([...ownDomains([m('a', 1, 'x', [me])])], ['visitt.io'])
  assert.deepEqual([...ownDomains([m('a', 1, 'x', [], { calendarEvent: { calendar: 'klara@visitt.io' } })])], ['visitt.io'])
  // personal mail is never "own"
  assert.deepEqual([...ownDomains([m('a', 1, 'x', [{ name: 'K', email: 'k@gmail.com', isMe: true }])])], [])
})

test('groups by company domain, ignoring my own domain and personal mail', () => {
  const clients = groupClients([
    m('m1', 1, 'Acme kickoff', [me, colleague, { name: 'Dana Levi', email: 'dana@acme.com' }]),
    m('m2', 5, 'Pricing', [me, { name: '', email: 'ops@eu.acme.com' }]),
    m('m3', 3, 'Coffee', [me, { name: 'Yossi Cohen', email: 'yossi.cohen@gmail.com' }]),
    m('m4', 4, 'Internal planning', [me, colleague]),
    m('m5', 6, 'Room booking', [me, { name: 'Room 3', email: 'c_123@resource.calendar.google.com' }])
  ])
  assert.deepEqual(clients.map((c) => c.key), ['acme.com', 'person:yossi cohen'])
  const acme = clients[0]
  assert.equal(acme.kind, 'company')
  assert.equal(acme.name, 'Acme')
  assert.equal(acme.domain, 'acme.com')
  assert.deepEqual(acme.meetingIds, ['m2', 'm1'])
  assert.equal(acme.count, 2)
  assert.equal(acme.lastAt, '2026-11-05T10:00:00.000Z')
  assert.deepEqual(acme.people, ['Dana Levi <dana@acme.com>', 'ops@eu.acme.com'])
  const yossi = clients[1]
  assert.equal(yossi.kind, 'person')
  assert.equal(yossi.name, 'Yossi Cohen')
  assert.deepEqual(yossi.people, ['Yossi Cohen <yossi.cohen@gmail.com>'])
})

test('a meeting whose title names the client joins it (domain name or a recurring title word)', () => {
  const shikun = { name: 'Avi', email: 'avi@shikun.co.il' }
  const clients = groupClients([
    m('m1', 1, 'פרויקט מגדלי הים - שיכון', [me, shikun]),
    m('m2', 2, 'מגדלי הים: סטטוס', [me, shikun]),
    m('m3', 3, 'הכנה למגדלי הים', [me, colleague]), // internal prep: "הים" recurs in Shikun's titles
    m('m4', 4, 'Call with Shikun about the contract'), // ad hoc, domain name in the title
    m('m5', 5, 'Zoom 11:00'),
    m('m6', 6, 'Acme demo', [me, { name: 'Dana', email: 'dana@acme.com' }])
  ])
  const s = clients.find((c) => c.key === 'shikun.co.il')!
  assert.deepEqual(s.meetingIds, ['m4', 'm3', 'm2', 'm1'])
  assert.ok(s.aliases.includes('מגדלי') && s.aliases.includes('הים'))
  assert.ok(!s.aliases.includes('shikun'), 'the domain name is not repeated as an alias')
  // whole words only: "למגדלי" (with a prefix) is not "מגדלי"
  assert.ok(groupClients([
    m('m1', 1, 'מגדלי הים', [me, shikun]), m('m2', 2, 'מגדלי הים', [me, shikun]), m('m3', 3, 'הכנה למגדלי', [me, colleague])
  ]).find((c) => c.key === 'shikun.co.il')!.meetingIds.includes('m3') === false)
  assert.ok(!clients.find((c) => c.key === 'acme.com')!.meetingIds.includes('m5'))
})

test('a title word shared by two clients is nobody\'s alias', () => {
  const clients = groupClients([
    m('a1', 1, 'Renewal Q4', [me, { name: 'A', email: 'a@acme.com' }]),
    m('a2', 2, 'Renewal Q4 follow', [me, { name: 'A', email: 'a@acme.com' }]),
    m('b1', 3, 'Renewal', [me, { name: 'B', email: 'b@beta.com' }]),
    m('x', 4, 'Renewal prep')
  ])
  assert.ok(!clients.find((c) => c.key === 'acme.com')!.aliases.includes('renewal'))
  assert.ok(clients.every((c) => !c.meetingIds.includes('x')))
})

test('in-person calls use the participants Claude identified, without me or placeholders', () => {
  const clients = groupClients(
    [
      m('p1', 1, 'פגישה במשרד', [], { inferredParticipants: ['רועי לוי', 'קלרה', 'דובר 2', 'משתתף 1'] }),
      m('p2', 2, 'קפה עם רועי לוי'),
      m('p3', 3, 'Acme', [me, { name: 'Dana', email: 'dana@acme.com' }], { inferredParticipants: ['Someone Else'] })
    ],
    { userName: 'קלרה' }
  )
  assert.deepEqual(clients.map((c) => c.key).sort(), ['acme.com', 'person:רועי לוי'])
  assert.deepEqual(clients.find((c) => c.kind === 'person')!.meetingIds, ['p2', 'p1'])
})

test('calendar attendees on the event count when the meeting has none of its own', () => {
  const clients = groupClients([
    m('c1', 1, 'Intro', undefined, { calendarEvent: { title: 'Intro', attendees: [me, { name: 'Z', email: 'z@zeta.io' }] } })
  ])
  assert.deepEqual(clients.map((c) => c.key), ['zeta.io'])
})

test('extra own domains and an empty library', () => {
  assert.deepEqual(groupClients([]), [])
  const clients = groupClients([m('a', 1, 'x', [{ name: 'N', email: 'n@visitt.io' }])], { ownDomains: ['visitt.io'] })
  assert.deepEqual(clients, [])
})

const SUMMARY = `# חידוש החוזה עם Acme — 20/11/2026
**משתתפים:** קלרה, דנה

## תקציר
דיברנו על **חידוש החוזה** לשנה הבאה.
הלקוח מבקש הנחה של 10%.

## נקודות עיקריות
- מחיר

## החלטות
- ממשיכים עם החבילה המורחבת
- לא התקבלו החלטות

## משימות
- [ ] לשלוח הצעת מחיר — **קלרה** — 24/11/2026
- [x] לתאם פגישה — **דנה**
- לבדוק את ה-SLA — **(לא ברור)**

## שאלות פתוחות
- [ ] זה לא משימה
`

test('digest of a saved summary: gist, open tasks, decisions', () => {
  const d = digestSummary(SUMMARY)
  assert.equal(d.gist, 'דיברנו על חידוש החוזה לשנה הבאה. הלקוח מבקש הנחה של 10%.')
  assert.deepEqual(d.openTasks, ['לשלוח הצעת מחיר — קלרה — 24/11/2026', 'לבדוק את ה-SLA — (לא ברור)'])
  assert.deepEqual(d.decisions, ['ממשיכים עם החבילה המורחבת'])
})

test('digest: English headings, a title starting with "סיכום", no gist section, long gist', () => {
  const en = digestSummary('# Summary: Acme call\n\nShort intro line.\n\n## Action items\n- [ ] Send deck — **Klara**\n\n## Decisions\n- None\n')
  assert.equal(en.gist, 'Short intro line.')
  assert.deepEqual(en.openTasks, ['Send deck — Klara'])
  assert.deepEqual(en.decisions, [])
  const long = digestSummary(`## תקציר\n${'א'.repeat(500)}`, 50)
  assert.equal([...long.gist].length, 50)
  assert.ok(long.gist.endsWith('…'))
  assert.deepEqual(digestSummary(null), { gist: '', openTasks: [], decisions: [] })
  assert.deepEqual(digestSummary('## משימות\n```\n- [ ] in code\n```\n- [ ] real'), { gist: '', openTasks: ['real'], decisions: [] })
})
