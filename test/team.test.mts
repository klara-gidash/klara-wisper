// Team cloud: invite codes, the join answer, and the rules for sharing meetings (src/shared/team.ts).
// Run with `node --test test/team.test.mts`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INVITE_PREFIX, InviteError, autoShareDecision, buildInvite, cleanRule, emailDomain, parseDomains, parseInvite,
  parseJoinResponse, parseTeamInfo, workerOrigin, type ShareRule
} from '../src/shared/team.ts'

const CODE = 'ab'.repeat(32)
const URL1 = 'https://klara-wisper-gateway.acme.workers.dev'
const hex = (c: string): string => c.repeat(64)

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof InviteError, String(err))
    return err.code
  }
  return 'no error'
}

test('an invite round-trips, and survives being pasted inside a message', () => {
  const invite = buildInvite({ url: URL1 + '/some/path?x=1', code: CODE })
  assert.ok(invite.startsWith(INVITE_PREFIX))
  assert.doesNotMatch(invite, /[+/=\s]/, 'base64url, one word')
  assert.deepEqual(parseInvite(invite), { url: URL1, code: CODE })
  // Whatever chat apps and people do to it.
  for (const pasted of [
    `  ${invite}  `,
    `"${invite}"`,
    `היי! הנה ההזמנה לענן של הצוות:\n${invite}\nתודה`,
    `${invite}.`,
    `<${invite}>`,
    invite.slice(0, 40) + '\n' + invite.slice(40), // a chat app wrapped the long word
    invite.slice(0, 40) + '\n' + invite.slice(40, 90) + ' ' + invite.slice(90) + '\nThanks, see you',
    `Here is the invite: ${invite}\nThanks!`,
    invite.replace('klara-team:', 'KLARA-TEAM: ')
  ]) {
    assert.deepEqual(parseInvite(pasted), { url: URL1, code: CODE }, JSON.stringify(pasted))
  }
})

test('broken or unsafe invites are refused with a reason', () => {
  const enc = (o: unknown): string => INVITE_PREFIX + Buffer.from(JSON.stringify(o)).toString('base64url')
  assert.equal(code(() => parseInvite('')), 'empty')
  assert.equal(code(() => parseInvite('   ')), 'empty')
  assert.equal(code(() => parseInvite('hello there')), 'format')
  assert.equal(code(() => parseInvite(CODE)), 'format', 'the bare code is not enough: the address is missing')
  assert.equal(code(() => parseInvite(INVITE_PREFIX + '!!!!!!!!!!!!!!!!!!!!!!!!')), 'format')
  assert.equal(code(() => parseInvite(enc({ v: 2, url: URL1, code: CODE }))), 'format')
  assert.equal(code(() => parseInvite(enc({ v: 1, url: 'http://evil.example', code: CODE }))), 'url', 'plain http is refused')
  assert.equal(code(() => parseInvite(enc({ v: 1, url: 'https://user:pw@evil.example', code: CODE }))), 'url')
  assert.equal(code(() => parseInvite(enc({ v: 1, url: 'javascript:alert(1)', code: CODE }))), 'url')
  assert.equal(code(() => parseInvite(enc({ v: 1, url: URL1, code: 'short' }))), 'code')
  assert.equal(code(() => parseInvite(enc({ v: 1, url: URL1, code: CODE.toUpperCase() }))), 'code')
  assert.equal(code(() => parseInvite(enc({ v: 1, url: URL1 }))), 'code')
  // Local http only when asked (the simulation), never by default.
  const local = enc({ v: 1, url: 'http://127.0.0.1:8787', code: CODE })
  assert.equal(code(() => parseInvite(local)), 'url')
  assert.deepEqual(parseInvite(local, { allowLocalHttp: true }), { url: 'http://127.0.0.1:8787', code: CODE })
  assert.equal(code(() => buildInvite({ url: 'ftp://x', code: CODE })), 'url')
  assert.equal(code(() => buildInvite({ url: URL1, code: 'nope' })), 'code')
  assert.equal(workerOrigin('http://localhost:1/x', { allowLocalHttp: true }), 'http://localhost:1')
  assert.equal(workerOrigin('http://10.0.0.1/', { allowLocalHttp: true }), null)
})

test('the join answer is checked before any token is saved', () => {
  const good = { ok: true, member: { id: 'u_0123456789abcdef', name: 'דנה' }, ownerName: 'קלרה', tokens: { upload: hex('a'), mcp: hex('b'), rec: hex('c') } }
  assert.deepEqual(parseJoinResponse(good), { member: good.member, ownerName: 'קלרה', tokens: good.tokens })
  assert.equal(parseJoinResponse({ ...good, ok: false }), null)
  assert.equal(parseJoinResponse({ ...good, member: { id: 'owner', name: 'x' } }), null)
  assert.equal(parseJoinResponse({ ...good, tokens: { ...good.tokens, rec: 'short' } }), null)
  assert.equal(parseJoinResponse({ ...good, tokens: { upload: hex('a'), mcp: hex('a'), rec: hex('c') } }), null, 'tokens must differ')
  assert.equal(parseJoinResponse(null), null)
  assert.equal(parseJoinResponse('{"ok":true}'), null)
  assert.equal(parseJoinResponse({ ...good, ownerName: 5 })?.ownerName, '')
})

test('domains are read from whatever the user types', () => {
  assert.deepEqual(parseDomains('acme.com, @Beta.co.il\n*.gamma.io  dana@delta.org;acme.com'), ['acme.com', 'beta.co.il', 'gamma.io', 'delta.org'])
  assert.deepEqual(parseDomains('not a domain, localhost, -bad-.com, .com'), [])
  assert.deepEqual(parseDomains(''), [])
  assert.equal(parseDomains(Array.from({ length: 80 }, (_, i) => `d${i}.com`).join(' ')).length, 50)
  assert.equal(emailDomain('Dana@Acme.COM'), 'acme.com')
  assert.equal(emailDomain('no-at-sign'), null)
  assert.equal(emailDomain('@acme.com'), null)
})

const since = '2026-11-20T10:00:00.000Z'
const rule = (over: Partial<ShareRule> = {}): ShareRule => ({ mode: 'never', domains: [], since, ...over })
const meeting = (over: Record<string, unknown> = {}) => ({
  startedAt: '2026-11-21T09:00:00.000Z',
  attendees: [
    { name: 'אני', email: 'me@visitt.io', isMe: true },
    { name: 'David', email: 'david@acme.com' }
  ],
  ...over
})

test('automatic sharing: never by default; all; or meetings with a guest from the listed domains', () => {
  assert.equal(autoShareDecision(meeting(), rule()), false)
  assert.equal(autoShareDecision(meeting(), cleanRule(undefined)), false, 'the default rule shares nothing')
  assert.equal(autoShareDecision(meeting(), rule({ mode: 'all' })), true)
  assert.equal(autoShareDecision(meeting(), rule({ mode: 'domains', domains: ['acme.com'] })), true)
  assert.equal(autoShareDecision(meeting(), rule({ mode: 'domains', domains: ['other.com'] })), false)
  // A subdomain counts; a look-alike doesn't.
  const sub = meeting({ attendees: [{ name: 'x', email: 'x@eu.acme.com' }] })
  assert.equal(autoShareDecision(sub, rule({ mode: 'domains', domains: ['acme.com'] })), true)
  const fake = meeting({ attendees: [{ name: 'x', email: 'x@notacme.com' }] })
  assert.equal(autoShareDecision(fake, rule({ mode: 'domains', domains: ['acme.com'] })), false)
  // My own address never decides it.
  assert.equal(autoShareDecision(meeting(), rule({ mode: 'domains', domains: ['visitt.io'] })), false)
  // Guests from the calendar event count too.
  const cal = meeting({ attendees: [], calendarEvent: { attendees: [{ name: 'S', email: 's@acme.com' }] } })
  assert.equal(autoShareDecision(cal, rule({ mode: 'domains', domains: ['acme.com'] })), true)
  // No guests (in person, phone): only "all" shares it.
  const alone = meeting({ attendees: [] })
  assert.equal(autoShareDecision(alone, rule({ mode: 'domains', domains: ['acme.com'] })), false)
  assert.equal(autoShareDecision(alone, rule({ mode: 'all' })), true)
})

test('automatic sharing never reaches back: meetings from before the rule was set stay unshared', () => {
  const before = meeting({ startedAt: '2026-11-19T09:00:00.000Z' })
  assert.equal(autoShareDecision(before, rule({ mode: 'all' })), false)
  assert.equal(autoShareDecision(meeting(), rule({ mode: 'all', since: null })), false, 'no date: nothing is shared')
  assert.equal(autoShareDecision(meeting({ startedAt: 'garbage' }), rule({ mode: 'all' })), false)
})

test('a saved rule is cleaned', () => {
  assert.deepEqual(cleanRule({ mode: 'everything' as never, domains: ['ACME.com', 'x'], since: 'nope' }), { mode: 'never', domains: ['acme.com'], since: null })
  assert.deepEqual(cleanRule({ mode: 'domains', domains: ['acme.com'], since }), { mode: 'domains', domains: ['acme.com'], since })
  assert.deepEqual(cleanRule(null), { mode: 'never', domains: [], since: null })
})

test("the owner's team list keeps only what the app shows", () => {
  const info = parseTeamInfo({
    ok: true,
    ownerName: 'קלרה',
    owner: { meetings: 4, shared: 1 },
    members: [
      { id: 'u_0123456789abcdef', name: 'דנה', status: 'joined', createdAt: 'c', joinedAt: 'j', lastSeenAt: null, inviteExpiresAt: null, meetings: 3, shared: 1, bytes: 1000, recordings: 0, token: 'secret' },
      { id: 'bad', name: 'x' },
      { id: 'u_fedcba9876543210', name: 'Yossi', status: 'weird' }
    ],
    connectors: [{ id: 't_0123456789abcdef', label: 'team', createdAt: 'c' }, { id: 'nope' }],
    limits: { members: 50, connectors: 20, memberMeetingsMb: 100, memberRecordingsMb: 150 }
  })
  assert.ok(info)
  assert.equal(info.members.length, 2)
  assert.equal(info.members[1].status, 'expired')
  assert.equal(JSON.stringify(info).includes('secret'), false)
  assert.equal(info.connectors.length, 1)
  assert.equal(info.limits.memberMeetingsMb, 100)
  assert.equal(parseTeamInfo({ ok: false }), null)
  assert.equal(parseTeamInfo({ ok: true, members: 'x', connectors: [] }), null)
})
