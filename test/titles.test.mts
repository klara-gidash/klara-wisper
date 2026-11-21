// Which call titles are placeholders the calendar event's title should replace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isGenericTitle } from '../src/main/meetings/titles.ts'

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
