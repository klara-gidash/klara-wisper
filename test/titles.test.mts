// Which call titles are placeholders the calendar event's title should replace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isGenericTitle, phoneCallTitle } from '../src/main/meetings/titles.ts'

test('phone call titles: "שיחת טלפון" with the contact, else the time; the time version is a placeholder', () => {
  assert.equal(phoneCallTitle('he', '10:30'), 'שיחת טלפון 10:30')
  assert.equal(phoneCallTitle('en', '10:30'), 'Phone call 10:30')
  assert.equal(phoneCallTitle('he', '10:30', 'רועי כהן'), 'שיחת טלפון עם רועי כהן')
  assert.equal(phoneCallTitle('en', '10:30', 'Roi Cohen'), 'Phone call with Roi Cohen')
  // A number or the app's own name is not a contact.
  assert.equal(phoneCallTitle('he', '10:30', '+972 54-123-4567'), 'שיחת טלפון 10:30')
  assert.equal(phoneCallTitle('en', '10:30', 'FaceTime'), 'Phone call 10:30')
  // The calendar event's title replaces the placeholder, never a named call.
  assert.equal(isGenericTitle('שיחת טלפון 10:30'), true)
  assert.equal(isGenericTitle('Phone call 9:05'), true)
  assert.equal(isGenericTitle('שיחת טלפון עם רועי כהן'), false)
})

test('generic call titles', () => {
  for (const t of ['', '  ', 'abc-defg-hij', 'Meet - abc-defg-hij', 'Zoom Meeting', 'Meet', 'Chat', 'Microsoft Teams', 'Zoom', 'Google Meet 10:30', 'Zoom 9:05', 'פגישה 14:00', '‏Meet'])
    assert.equal(isGenericTitle(t), true, t)
  assert.equal(isGenericTitle('Aircall 10:00', ['Aircall']), true)
  assert.equal(isGenericTitle(undefined), true)
})

test('real call titles are kept', () => {
  for (const t of ['Weekly sync', 'שם הפגישה', 'Sync with Dana 10:30', 'Zoom pricing review', 'Meet the team'])
    assert.equal(isGenericTitle(t), false, t)
})
