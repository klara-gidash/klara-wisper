// Speakers by name: calendar suggestions, the automatic name in 1:1 calls, undo, "who is this?".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_REMEMBER_MIN_TALK_S,
  attendeeName,
  autoNameFor,
  nameAutomatically,
  nameByUser,
  needsWhoPrompt,
  otherAttendees,
  otherSpeakers,
  suggestionsFor,
  undoAutoName,
  unnamedSpeakers
} from '../src/shared/speakerNames.ts'
import type { Attendee, MeetingMeta, Segment, SpeakerInfo } from '../src/shared/types.ts'

const EMB = [0.1, 0.2, 0.3]
const me: Attendee = { name: 'Klara Gidash', email: 'klara@visitt.io', isMe: true }
const roi: Attendee = { name: 'Roi Cohen', email: 'roi@acme.com' }
const dana: Attendee = { name: 'דנה לוי', email: 'dana@acme.com' }

function seg(speaker: string, start: number, end: number, stream: 'mic' | 'system' = speaker === 'me' ? 'mic' : 'system'): Segment {
  return { id: `${speaker}-${start}`, stream, start, end, text: 'שלום', lang: 'he', speaker }
}

function meeting(o: Partial<MeetingMeta> = {}): MeetingMeta {
  return {
    id: 'm1', title: 'Sync', source: 'zoom', mode: 'meeting', startedAt: '2026-11-20T10:00:00.000Z', folder: '/x',
    status: 'done', attendees: [me, roi], speakers: { me: { name: null, key: 'me', isMe: true } }, ...o
  }
}

// ---------------------------------------------------------------- attendees

test('attendee names: calendar name, else the address made readable', () => {
  assert.equal(attendeeName(roi), 'Roi Cohen')
  assert.equal(attendeeName({ name: '', email: 'roi.cohen@acme.com' }), 'Roi Cohen')
  assert.equal(attendeeName({ name: 'dana_levi@acme.com', email: 'dana_levi@acme.com' }), 'Dana Levi')
  assert.equal(attendeeName({ name: '‏דנה לוי', email: 'd@x.com' }), 'דנה לוי')
})

test('other attendees: not me, not rooms, each person once', () => {
  const list = otherAttendees([me, roi, { ...roi, name: 'roi cohen' }, dana, { name: 'Room 3', email: 'c_123@resource.calendar.google.com' }])
  assert.deepEqual(list.map((a) => a.name), ['Roi Cohen', 'דנה לוי'])
})

test('other attendees: without an isMe mark, the user is recognised by her name or first name', () => {
  const unmarked = [{ name: 'Klara Gidash', email: 'klara@visitt.io' }, roi]
  assert.deepEqual(otherAttendees(unmarked, 'Klara Gidash').map((a) => a.name), ['Roi Cohen'])
  assert.deepEqual(otherAttendees(unmarked, 'klara').map((a) => a.name), ['Roi Cohen'])
  // With an isMe mark, a first name alone never hides someone else ("Roi" in settings, "Roi Cohen" a guest).
  assert.deepEqual(otherAttendees([{ ...me, name: 'Roi Levi' }, roi], 'Roi').map((a) => a.name), ['Roi Cohen'])
})

// ---------------------------------------------------------------- speakers

test('other speakers: never me; "rem" only when it is one voice (has a voiceprint) or named', () => {
  const segs = [seg('me', 0, 5), seg('rem2', 5, 9), seg('rem1', 9, 20), seg('rem2', 20, 30)]
  const m = meeting({ speakers: { me: { name: null, isMe: true }, rem1: { name: null, isMe: false }, rem2: { name: 'Roi', isMe: false } } })
  assert.deepEqual(otherSpeakers(m, segs), ['rem2', 'rem1'])
  assert.deepEqual(unnamedSpeakers(m, segs), ['rem1'])
  const undiarized = meeting({ speakers: { me: { name: null, isMe: true }, rem: { name: null, isMe: false } } })
  assert.deepEqual(otherSpeakers(undiarized, [seg('me', 0, 5), seg('rem', 5, 9)]), [])
  const oneVoice = meeting({ speakers: { me: { name: null, isMe: true }, rem: { name: null, isMe: false, embedding: EMB } } })
  assert.deepEqual(otherSpeakers(oneVoice, [seg('me', 0, 5), seg('rem', 5, 9)]), ['rem'])
})

test('a speaker matched to the user\'s own voiceprint (isMe) is never suggested or prompted', () => {
  const m = meeting({ mode: 'inperson', speakers: { spk1: { name: 'Klara', isMe: true }, spk2: { name: null, isMe: false } } })
  assert.deepEqual(unnamedSpeakers(m, [seg('spk1', 0, 5, 'mic'), seg('spk2', 5, 9, 'mic')]), ['spk2'])
})

test('suggestions: the invite minus me and minus names other speakers already have', () => {
  const m = meeting({ attendees: [me, roi, dana], speakers: { me: { name: null, isMe: true }, rem1: { name: 'roi cohen', isMe: false }, rem2: { name: null, isMe: false } } })
  assert.deepEqual(suggestionsFor(m, 'rem2').map((s) => s.name), ['דנה לוי'])
  // The speaker's own (maybe wrong) name doesn't hide it from its own chips.
  assert.deepEqual(suggestionsFor(m, 'rem1').map((s) => s.name), ['Roi Cohen', 'דנה לוי'])
  // No attendees on the meeting itself: the calendar event's list.
  const ev = meeting({ attendees: [], calendarEvent: { id: 'e', title: 't', start: '', end: '', calendar: '', color: null, location: '', links: [], organizer: '', attendees: [me, dana] } })
  assert.deepEqual(suggestionsFor(ev, 'rem1').map((s) => s.name), ['דנה לוי'])
})

test('"who is this?" shows for finished meetings with unnamed speakers, until closed', () => {
  const segs = [seg('me', 0, 5), seg('rem1', 5, 9), seg('rem2', 9, 15)]
  const sp = { me: { name: null, isMe: true }, rem1: { name: null, isMe: false }, rem2: { name: null, isMe: false } }
  assert.equal(needsWhoPrompt(meeting({ speakers: sp }), segs), true)
  assert.equal(needsWhoPrompt(meeting({ speakers: sp, status: 'processing' }), segs), false)
  assert.equal(needsWhoPrompt(meeting({ speakers: sp, speakerPromptDismissed: true }), segs), false)
  assert.equal(needsWhoPrompt(meeting({ speakers: { ...sp, rem1: { name: 'A', isMe: false }, rem2: { name: 'B', isMe: false } } }), segs), false)
  // Only the undiarized "Participants" line: nothing to name.
  assert.equal(needsWhoPrompt(meeting({ speakers: { me: sp.me, rem: { name: null, isMe: false } } }), [seg('me', 0, 5), seg('rem', 5, 9)]), false)
})

// ---------------------------------------------------------------- automatic name (1:1)

const oneVoice = (info: Partial<SpeakerInfo> = {}) => ({ me: { name: null, isMe: true }, rem: { name: null, isMe: false, embedding: EMB, ...info } })
const talk = [seg('me', 0, 10), seg('rem', 10, 40)]

test('1:1 call: the one remote voice is named after the one other attendee and remembered', () => {
  const a = autoNameFor(meeting({ speakers: oneVoice() }), talk)
  assert.deepEqual(a, { label: 'rem', name: 'Roi Cohen', email: 'roi@acme.com', remember: true })
})

test('1:1 call: too little talk is named but not remembered', () => {
  const short = [seg('me', 0, 10), seg('rem', 10, 10 + AUTO_REMEMBER_MIN_TALK_S - 1)]
  assert.equal(autoNameFor(meeting({ speakers: oneVoice() }), short)?.remember, false)
})

test('1:1 call without the speaker step (no voiceprint): "Participants" is named, nothing remembered', () => {
  const a = autoNameFor(meeting({ speakers: { me: { name: null, isMe: true }, rem: { name: null, isMe: false } } }), talk)
  assert.deepEqual(a, { label: 'rem', name: 'Roi Cohen', email: 'roi@acme.com', remember: false })
})

test('no automatic name: two guests, two voices, in person, no calendar, already named, undone', () => {
  assert.equal(autoNameFor(meeting({ attendees: [me, roi, dana], speakers: oneVoice() }), talk), null)
  const two = { me: { name: null, isMe: true }, rem1: { name: null, isMe: false, embedding: EMB }, rem2: { name: null, isMe: false, embedding: EMB } }
  assert.equal(autoNameFor(meeting({ speakers: two }), [seg('me', 0, 5), seg('rem1', 5, 30), seg('rem2', 30, 60)]), null)
  assert.equal(autoNameFor(meeting({ mode: 'inperson', speakers: oneVoice() }), talk), null)
  assert.equal(autoNameFor(meeting({ attendees: [], speakers: oneVoice() }), talk), null)
  assert.equal(autoNameFor(meeting({ attendees: [me], speakers: oneVoice() }), talk), null)
  assert.equal(autoNameFor(meeting({ speakers: oneVoice({ name: 'Dana', key: 'v_1' }) }), talk), null, "a recognised voice keeps its name")
  assert.equal(autoNameFor(meeting({ speakers: oneVoice({ name: 'Someone' }) }), talk), null, "never overrides the user's name")
  assert.equal(autoNameFor(meeting({ speakers: oneVoice({ autoRejected: true }) }), talk), null)
})

test('1:1 call: the user on the invite without isMe (iCal) still leaves exactly one guest', () => {
  const a = autoNameFor(meeting({ attendees: [{ name: 'Klara Gidash', email: 'k@v.io' }, roi], speakers: oneVoice() }), talk, 'Klara Gidash')
  assert.equal(a?.name, 'Roi Cohen')
  // Without the user's name, two unmarked people: can't tell who the guest is.
  assert.equal(autoNameFor(meeting({ attendees: [{ name: 'Klara Gidash', email: 'k@v.io' }, roi], speakers: oneVoice() }), talk), null)
})

test('nameAutomatically: marked auto, voiceprint under an auto_ key; never over a name', () => {
  const a = autoNameFor(meeting({ speakers: oneVoice() }), talk)!
  const r = nameAutomatically(oneVoice().rem, a)!
  assert.equal(r.info.name, 'Roi Cohen')
  assert.equal(r.info.auto, true)
  assert.equal(r.info.key, 'auto_roi_acme_com')
  assert.deepEqual(r.remember, { key: 'auto_roi_acme_com', name: 'Roi Cohen', embedding: EMB, isMe: false, auto: true })
  assert.equal(nameAutomatically({ name: 'X', isMe: false }, a), null)
  const noVoice = nameAutomatically({ name: null, isMe: false }, { ...a, remember: false })!
  assert.equal(noVoice.remember, undefined)
  assert.equal(noVoice.info.key, undefined)
})

test('undo: back to unnamed, the automatic voiceprint removed, never automatic again', () => {
  const r = undoAutoName({ name: 'Roi Cohen', isMe: false, auto: true, key: 'auto_roi_acme_com', embedding: EMB })
  assert.equal(r.info.name, null)
  assert.equal(r.info.auto, undefined)
  assert.equal(r.info.key, null)
  assert.equal(r.info.autoRejected, true)
  assert.equal(r.forget, 'auto_roi_acme_com')
  // A voiceprint the user saved herself is never removed by undo.
  assert.equal(undoAutoName({ name: 'Roi', isMe: false, auto: true, key: 'v_abc' }).forget, undefined)
})

// ---------------------------------------------------------------- names the user gives

test('user name with remember: new voiceprint, or the saved voice with the same name', () => {
  const r = nameByUser({ name: null, isMe: false, embedding: EMB }, 'Roi Cohen', { remember: true, now: 36 })
  assert.equal(r.info.key, 'v_10')
  assert.deepEqual(r.remember, { key: 'v_10', name: 'Roi Cohen', embedding: EMB, isMe: false })
  const known = { v_old: { name: 'roi  cohen', isMe: false }, auto_x: { name: 'Roi Cohen', isMe: false, auto: true }, me: { name: 'Klara', isMe: true } }
  assert.equal(nameByUser({ name: null, isMe: false, embedding: EMB }, 'Roi Cohen', { remember: true, known }).remember?.key, 'v_old')
})

test('user name without a voiceprint or without remember: only the name changes', () => {
  assert.deepEqual(nameByUser({ name: null, isMe: false }, 'Dana', { remember: true }), { info: { name: 'Dana', isMe: false }, forget: undefined })
  assert.equal(nameByUser({ name: null, isMe: false, embedding: EMB }, 'Dana', { remember: false }).remember, undefined)
})

test('user renames a wrong automatic name: the auto voiceprint is dropped', () => {
  const auto: SpeakerInfo = { name: 'Roi Cohen', isMe: false, auto: true, key: 'auto_roi', embedding: EMB }
  const r = nameByUser(auto, 'Dana', { remember: false })
  assert.equal(r.forget, 'auto_roi')
  assert.equal(r.info.key, null)
  assert.equal(r.info.auto, undefined)
  const kept = nameByUser(auto, 'Dana', { remember: true, now: 1 })
  assert.equal(kept.forget, 'auto_roi')
  assert.equal(kept.remember?.key, 'v_1')
})

test('user confirms an automatic name: no longer "auto"; remembering moves it to her own voiceprint', () => {
  const auto: SpeakerInfo = { name: 'Roi Cohen', isMe: false, auto: true, key: 'auto_roi', embedding: EMB }
  const plain = nameByUser(auto, 'Roi Cohen', { remember: false })
  assert.equal(plain.forget, undefined)
  assert.equal(plain.info.key, 'auto_roi')
  assert.equal(plain.info.auto, undefined)
  const saved = nameByUser(auto, 'Roi Cohen', { remember: true, now: 2 })
  assert.equal(saved.remember?.key, 'v_2')
  assert.equal(saved.forget, 'auto_roi')
})

test('user renames a speaker recognised by its saved voice: the same voiceprint is updated', () => {
  const r = nameByUser({ name: 'Roi', isMe: false, key: 'v_abc', embedding: EMB }, 'Roi Cohen', { remember: true })
  assert.equal(r.remember?.key, 'v_abc')
  assert.equal(r.forget, undefined)
})
