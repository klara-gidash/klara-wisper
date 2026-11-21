// Google Calendar's secret iCal feed (src/shared/ical.ts): parsing, repeating events, time zones, merging.
// Run with `node --test test/ical.test.mts` (Node runs the TypeScript directly; no Electron).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanGoogleLink, decodeIcs, eventsInRange, googleCalendarId, mergeEvents, parseIcs } from '../src/shared/ical.ts'

// Shaped like a real Google export: CRLF lines, folded lines, escapes, a VTIMEZONE, a VALARM.
const FEED = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:klara@example.com',
  'X-WR-TIMEZONE:Asia/Jerusalem',
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Jerusalem',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0300',
  'TZOFFSETTO:+0200',
  'DTSTART:19701025T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  // A single meeting in UTC, with a Meet link folded across two lines and a reminder that has its own text.
  'BEGIN:VEVENT',
  'DTSTART:20261116T120000Z',
  'DTEND:20261116T123000Z',
  'ORGANIZER;CN=Dana Cohen:mailto:dana@example.com',
  'UID:single1@google.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN="Cohen, Dana";X-NUM-GUESTS=0:mailto:dana@example.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=klara@example.com;X-NUM-GUESTS=0:mailto:klara@example.com',
  'DESCRIPTION:Agenda: pricing\\, rollout\\nJoin with Google Meet: https://meet.go',
  ' ogle.com/abc-defg-hij',
  'LOCATION:',
  'SUMMARY:Pricing review\\, Q4',
  'STATUS:CONFIRMED',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder https://zoom.us/j/99999999999',
  'TRIGGER:-P0DT0H10M0S',
  'END:VALARM',
  'END:VEVENT',
  // Every Monday 10:00 Israel time, across the end of daylight saving (Oct 25, 2026).
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Jerusalem:20261005T100000',
  'DTEND;TZID=Asia/Jerusalem:20261005T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'EXDATE;TZID=Asia/Jerusalem:20261109T100000',
  'UID:weekly1@google.com',
  'SUMMARY:Weekly sync',
  'ATTENDEE;PARTSTAT=ACCEPTED;CN=Klara:mailto:klara@example.com',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Avi:mailto:avi@example.com',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/xyz-abcd-efg',
  'END:VEVENT',
  // ...one occurrence moved to Tuesday afternoon...
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Jerusalem:20261117T140000',
  'DTEND;TZID=Asia/Jerusalem:20261117T143000',
  'RECURRENCE-ID;TZID=Asia/Jerusalem:20261116T100000',
  'UID:weekly1@google.com',
  'SUMMARY:Weekly sync (moved)',
  'END:VEVENT',
  // ...and one cancelled.
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Jerusalem:20261123T100000',
  'DTEND;TZID=Asia/Jerusalem:20261123T103000',
  'RECURRENCE-ID;TZID=Asia/Jerusalem:20261123T100000',
  'UID:weekly1@google.com',
  'STATUS:CANCELLED',
  'SUMMARY:Weekly sync',
  'END:VEVENT',
  // The last Friday of the month, three times.
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Jerusalem:20261030T090000',
  'DTEND;TZID=Asia/Jerusalem:20261030T100000',
  'RRULE:FREQ=MONTHLY;COUNT=3;BYDAY=-1FR',
  'UID:monthly1@google.com',
  'SUMMARY:Monthly review',
  'END:VEVENT',
  // Daily until Wednesday.
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Jerusalem:20261116T083000',
  'DTEND;TZID=Asia/Jerusalem:20261116T084500',
  'RRULE:FREQ=DAILY;UNTIL=20261118T215959Z',
  'UID:daily1@google.com',
  'SUMMARY:Standup',
  'LOCATION:https://zoom.us/j/1234567890?pwd=abc',
  'END:VEVENT',
  // Every other week, Tuesday and Thursday 16:00.
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Jerusalem:20261103T160000',
  'DTEND;TZID=Asia/Jerusalem:20261103T170000',
  'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH',
  'UID:biweekly1@google.com',
  'SUMMARY:Office hours',
  'END:VEVENT',
  // Declined by the user: left out.
  'BEGIN:VEVENT',
  'DTSTART:20261116T150000Z',
  'DTEND:20261116T160000Z',
  'UID:declined1@google.com',
  'SUMMARY:Optional talk',
  'ATTENDEE;PARTSTAT=DECLINED;CN=Klara:mailto:klara@example.com',
  'END:VEVENT',
  // All day: left out (the Mac calendar skips them too).
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261116',
  'DTEND;VALUE=DATE:20261117',
  'UID:allday1@google.com',
  'SUMMARY:Holiday',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n')

const cal = parseIcs(FEED, { me: 'klara@example.com' })
const range = (from: string, to: string, title?: string) =>
  eventsInRange(cal, new Date(from), new Date(to)).filter((e) => !title || e.title.startsWith(title))

test('reads the calendar name and a single meeting: title, times, guests, Meet link (not the reminder’s)', () => {
  assert.equal(cal.name, 'klara@example.com')
  const [e] = range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z', 'Pricing')
  assert.equal(e.title, 'Pricing review, Q4')
  assert.equal(e.start, '2026-11-16T12:00:00Z')
  assert.equal(e.end, '2026-11-16T12:30:00Z')
  assert.equal(e.calendar, 'klara@example.com')
  assert.equal(e.organizer, 'Dana Cohen')
  assert.deepEqual(e.links, ['https://meet.google.com/abc-defg-hij'])
  assert.deepEqual(e.attendees, [
    { name: 'Cohen, Dana', email: 'dana@example.com', isMe: false },
    { name: '', email: 'klara@example.com', isMe: true }
  ])
})

test('weekly: same local time across daylight saving, skipped, moved and cancelled occurrences', () => {
  const starts = range('2026-10-01T00:00:00Z', '2026-12-10T00:00:00Z', 'Weekly sync').map((e) => `${e.start} ${e.title}`)
  assert.deepEqual(starts, [
    '2026-10-05T07:00:00Z Weekly sync', // 10:00 summer time (+3)
    '2026-10-12T07:00:00Z Weekly sync',
    '2026-10-19T07:00:00Z Weekly sync',
    '2026-10-26T08:00:00Z Weekly sync', // 10:00 winter time (+2)
    '2026-11-02T08:00:00Z Weekly sync',
    // Nov 9 is an EXDATE, Nov 16 moved to Tuesday, Nov 23 cancelled
    '2026-11-17T12:00:00Z Weekly sync (moved)',
    '2026-11-30T08:00:00Z Weekly sync',
    '2026-12-07T08:00:00Z Weekly sync'
  ])
  const one = range('2026-11-30T00:00:00Z', '2026-12-01T00:00:00Z', 'Weekly sync')[0]
  assert.equal(one.end, '2026-11-30T08:30:00Z')
  assert.deepEqual(one.links, ['https://meet.google.com/xyz-abcd-efg'])
  assert.notEqual(one.id, range('2026-12-07T00:00:00Z', '2026-12-08T00:00:00Z', 'Weekly sync')[0].id)
})

test('an occurrence already under way at the start of the range still counts', () => {
  const r = range('2026-11-30T08:15:00Z', '2026-11-30T09:00:00Z', 'Weekly sync')
  assert.equal(r.length, 1)
})

test('monthly on the last Friday, COUNT=3', () => {
  const starts = range('2026-10-01T00:00:00Z', '2027-03-01T00:00:00Z', 'Monthly').map((e) => e.start)
  assert.deepEqual(starts, ['2026-10-30T07:00:00Z', '2026-11-27T07:00:00Z', '2026-12-25T07:00:00Z'])
})

test('daily until a date, with the Zoom link from the location', () => {
  const r = range('2026-11-15T00:00:00Z', '2026-11-25T00:00:00Z', 'Standup')
  assert.deepEqual(r.map((e) => e.start), ['2026-11-16T06:30:00Z', '2026-11-17T06:30:00Z', '2026-11-18T06:30:00Z'])
  assert.deepEqual(r[0].links, ['https://zoom.us/j/1234567890?pwd=abc'])
})

test('every other week on two days, looked up far ahead', () => {
  assert.deepEqual(range('2026-11-01T00:00:00Z', '2026-11-22T00:00:00Z', 'Office').map((e) => e.start), [
    '2026-11-03T14:00:00Z', '2026-11-05T14:00:00Z', '2026-11-17T14:00:00Z', '2026-11-19T14:00:00Z'
  ])
  // June 2027 is summer time again (+3): 16:00 is 13:00 UTC; the week of June 7 is an "off" week.
  assert.deepEqual(range('2027-06-01T00:00:00Z', '2027-06-15T00:00:00Z', 'Office').map((e) => e.start), [
    '2027-06-01T13:00:00Z', '2027-06-03T13:00:00Z'
  ])
})

test('declined and all-day events are left out', () => {
  const titles = range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z').map((e) => e.title)
  assert.ok(!titles.includes('Optional talk'))
  assert.ok(!titles.includes('Holiday'))
  assert.deepEqual(titles, ['Standup', 'Pricing review, Q4'])
})

test('merging with the Mac calendar: the same meeting once, keeping the Mac copy plus the feed’s link', () => {
  const google = range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z')
  const mac = [
    { id: 'EK1@1', title: 'Pricing review, Q4', start: '2026-11-16T12:00:00Z', end: '2026-11-16T12:30:00Z', calendar: 'klara@example.com', color: '#4986E7', location: '', links: [], organizer: 'Dana Cohen', attendees: [{ name: 'Dana', email: 'dana@example.com' }] },
    { id: 'EK2@1', title: 'Dentist', start: '2026-11-16T10:00:00Z', end: '2026-11-16T11:00:00Z', calendar: 'Home', color: null, location: '', links: [], organizer: '', attendees: [] }
  ]
  const merged = mergeEvents(mac, google)
  assert.deepEqual(merged.map((e) => e.title), ['Standup', 'Dentist', 'Pricing review, Q4'])
  const pricing = merged.find((e) => e.title.startsWith('Pricing'))!
  assert.equal(pricing.id, 'EK1@1')
  assert.equal(pricing.color, '#4986E7')
  assert.deepEqual(pricing.links, ['https://meet.google.com/abc-defg-hij'])
  assert.deepEqual(mac[0].links, [], 'the Mac list itself is not changed')
})

test('only Google Calendar iCal links are accepted', () => {
  const secret = 'https://calendar.google.com/calendar/ical/klara%40example.com/private-0123456789abcdef0123456789abcdef/basic.ics'
  assert.equal(cleanGoogleLink(`  ${secret}  `), secret)
  assert.equal(cleanGoogleLink(secret.replace('https://', 'webcal://')), secret)
  assert.equal(cleanGoogleLink(`${secret}?ctz=Asia/Jerusalem`), secret)
  assert.equal(googleCalendarId(secret), 'klara@example.com')
  assert.throws(() => cleanGoogleLink(secret.replace('private-0123456789abcdef0123456789abcdef', 'public')), /gcal:publicLink/)
  assert.throws(() => cleanGoogleLink('https://calendar.google.com/calendar/u/0/r/settings'), /gcal:badLink/)
  assert.throws(() => cleanGoogleLink(secret.replace('calendar.google.com', 'calendar.google.com.evil.example')), /gcal:badLink/)
  assert.throws(() => cleanGoogleLink(secret.replace('https:', 'http:')), /gcal:badLink/)
  assert.throws(() => cleanGoogleLink('not a link'), /gcal:badLink/)
})

test('a fold that splits a Hebrew letter in the middle of its bytes is unfolded before decoding', () => {
  const title = 'פגישת צוות שבועית'
  const head = new TextEncoder().encode('BEGIN:VCALENDAR\r\nX-WR-CALNAME:k@example.com\r\nBEGIN:VEVENT\r\nUID:he1\r\nDTSTART:20261122T080000Z\r\nDTEND:20261122T090000Z\r\nSUMMARY:')
  const t = new TextEncoder().encode(title)
  const tail = new TextEncoder().encode('\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')
  // Fold after the first byte of the third letter (each Hebrew letter is 2 bytes).
  const fold = new TextEncoder().encode('\r\n ')
  const bytes = new Uint8Array([...head, ...t.subarray(0, 5), ...fold, ...t.subarray(5), ...tail])
  assert.ok(decodeIcs(bytes).includes(`SUMMARY:${title}`))
  const cal = parseIcs(bytes)
  assert.equal(cal.events.length, 1)
  assert.equal(eventsInRange(cal, new Date('2026-11-22T00:00:00Z'), new Date('2026-11-23T00:00:00Z'))[0].title, title)
})
