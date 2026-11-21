// One-click Cloudflare deploy (src/main/cloudflareApi.ts) with a fake fetch: step order, request shapes, errors.
// Run with `node --test test/cloud-deploy.test.mts`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CfError, deployGateway, mapCfError, parseWranglerToml, tokenTemplateUrl, type CfDeps } from '../src/main/cloudflareApi.ts'

const ACC = 'a'.repeat(32)
const toml = readFileSync(new URL('../cloudflare/wrangler.toml', import.meta.url), 'utf8')

type Call = { method: string; url: string; headers: Record<string, string>; body?: string | Uint8Array }
const ok = (result: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ success: status < 400, result, errors: [] }), text: async () => '' })
const fail = (status: number, code: number, message: string) => ({ ok: false, status, json: async () => ({ success: false, errors: [{ code, message }] }), text: async () => '' })

function fake(routes: (c: Call) => ReturnType<typeof ok> | undefined, over: Partial<CfDeps> = {}) {
  const calls: Call[] = []
  const progress: string[] = []
  let n = 0
  const deps: CfDeps = {
    fetch: async (url, init) => {
      const c = { method: init.method, url, headers: init.headers, body: init.body }
      calls.push(c)
      const r = routes(c)
      if (!r) throw new Error(`unexpected ${init.method} ${url}`)
      return r
    },
    secret: () => String(++n).padStart(64, '0'),
    randomName: () => 'abcd1234',
    sleep: async () => undefined,
    now: () => 0,
    progress: (s, st) => progress.push(`${s}:${st}`),
    ...over
  }
  return { deps, calls, progress }
}

function happy(c: Call, opts: { subdomain?: string | null; db?: boolean } = {}) {
  const p = c.url.replace('https://api.cloudflare.com/client/v4', '')
  if (p === '/user/tokens/verify') return ok({ status: 'active' })
  if (p.startsWith('/accounts?')) return ok([{ id: ACC, name: 'Klara' }])
  if (p.startsWith(`/accounts/${ACC}/d1/database?`)) return ok(opts.db ? [{ uuid: 'db-1', name: 'klara-wisper' }] : [])
  if (p === `/accounts/${ACC}/d1/database` && c.method === 'POST') return ok({ uuid: 'db-new' })
  if (p.endsWith('/query')) return ok([{ success: true }])
  if (p === `/accounts/${ACC}/workers/subdomain` && c.method === 'GET') return opts.subdomain === null ? fail(404, 10007, 'not found') : ok({ subdomain: opts.subdomain ?? 'klara' })
  if (p === `/accounts/${ACC}/workers/subdomain` && c.method === 'PUT') return ok({ subdomain: JSON.parse(String(c.body)).subdomain })
  if (p === `/accounts/${ACC}/workers/scripts/klara-wisper-gateway` && c.method === 'PUT') return ok({})
  if (p.endsWith('/klara-wisper-gateway/subdomain')) return ok({ enabled: true })
  if (c.url.endsWith('/api/health')) return { ok: true, status: 200, json: async () => ({ ok: true, version: '2.0.0', features: ['meetings', 'recordings'] }), text: async () => '' }
}

const base = (deps: CfDeps, extra = {}) => deployGateway(deps, { apiToken: 'tok', workerJs: 'export default {}', schemaSql: 'CREATE TABLE x (a);', config: parseWranglerToml(toml), ...extra })

test('wrangler.toml: name, date, D1 binding, observability off', () => {
  const c = parseWranglerToml(toml)
  assert.equal(c.name, 'klara-wisper-gateway')
  assert.match(c.compatibilityDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(c.d1, [{ binding: 'DB', databaseName: 'klara-wisper' }])
  assert.equal(c.observability, false)
})

test('token link: user token template with the needed permissions', () => {
  const u = new URL(tokenTemplateUrl())
  assert.equal(u.origin + u.pathname, 'https://dash.cloudflare.com/profile/api-tokens')
  assert.deepEqual(JSON.parse(u.searchParams.get('permissionGroupKeys')!), [
    { key: 'workers_scripts', type: 'edit' }, { key: 'd1', type: 'edit' }, { key: 'account_settings', type: 'read' }
  ])
  assert.equal(u.searchParams.get('accountId'), '*')
  assert.equal(u.searchParams.get('zoneId'), 'all')
})

test('deploy: steps in order, request shapes, three different secrets', async () => {
  const { deps, calls, progress } = fake((c) => happy(c, { subdomain: null }))
  const r = await base(deps)
  assert.deepEqual(progress.filter((p) => p.endsWith(':done')).map((p) => p.split(':')[0]),
    ['verify', 'account', 'database', 'schema', 'secrets', 'subdomain', 'upload', 'route', 'health'])
  assert.ok(progress.includes('storage:skipped'))
  assert.equal(r.url, 'https://klara-wisper-gateway.klara-abcd1234.workers.dev')
  assert.equal(r.databaseId, 'db-new')
  assert.equal(new Set(Object.values(r.secrets)).size, 3)
  assert.deepEqual(r.features, ['meetings', 'recordings'])
  for (const c of calls.filter((c) => c.url.startsWith('https://api.cloudflare.com'))) assert.equal(c.headers.authorization, 'Bearer tok')
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/d1/database'))!
  assert.deepEqual(JSON.parse(String(create.body)), { name: 'klara-wisper' })
  assert.deepEqual(JSON.parse(String(calls.find((c) => c.url.endsWith('/query'))!.body)), { sql: 'CREATE TABLE x (a);' })
  const up = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/scripts/klara-wisper-gateway'))!
  assert.match(up.headers['content-type'], /^multipart\/form-data; boundary=/)
  const body = new TextDecoder().decode(up.body as Uint8Array)
  const meta = JSON.parse(/name="metadata"[^\n]*\r\nContent-Type: application\/json\r\n\r\n(.*)\r\n/.exec(body)![1])
  assert.equal(meta.main_module, 'worker.js')
  assert.deepEqual(meta.observability, { enabled: false })
  assert.deepEqual(meta.bindings.find((b: any) => b.type === 'd1'), { type: 'd1', name: 'DB', id: 'db-new' })
  assert.deepEqual(meta.bindings.filter((b: any) => b.type === 'secret_text').map((b: any) => b.name), ['KLARA_TOKEN', 'KLARA_MCP_TOKEN', 'KLARA_REC_TOKEN'])
  assert.match(body, /Content-Type: application\/javascript\+module\r\n\r\nexport default \{\}/)
  assert.deepEqual(JSON.parse(String(calls.find((c) => c.url.endsWith('/klara-wisper-gateway/subdomain'))!.body)), { enabled: true, previews_enabled: false })
})

test('update: same secrets re-sent, existing database and subdomain reused', async () => {
  const { deps, calls } = fake((c) => happy(c, { db: true }))
  const secrets = { upload: 'u'.repeat(64), mcp: 'm'.repeat(64), rec: 'r'.repeat(64) }
  const r = await base(deps, { secrets })
  assert.deepEqual(r.secrets, secrets)
  assert.equal(r.url, 'https://klara-wisper-gateway.klara.workers.dev')
  assert.ok(!calls.some((c) => c.method === 'POST' && c.url.endsWith('/d1/database')))
  assert.ok(!calls.some((c) => c.method === 'PUT' && c.url.endsWith('/workers/subdomain')))
  assert.match(new TextDecoder().decode(calls.find((c) => c.method === 'PUT' && c.url.includes('/scripts/'))!.body as Uint8Array), /"text":"rrrr/)
})

test('several accounts: asks which one, then uses the picked one', async () => {
  const B = 'b'.repeat(32)
  const multi = (c: Call) => (c.url.includes('/accounts?') ? ok([{ id: ACC, name: 'A' }, { id: B, name: 'B' }]) : happy(c))
  await assert.rejects(base(fake(multi).deps), (e: CfError) => e.code === 'chooseAccount' && e.accounts?.length === 2)
  const r = await base(fake(multi).deps, { accountId: ACC })
  assert.equal(r.accountId, ACC)
})

test('missing permission is named; failure stops the deploy', async () => {
  const { deps, calls, progress } = fake((c) => (c.url.includes('/d1/database?') ? fail(403, 10000, 'Authentication error') : happy(c)))
  await assert.rejects(base(deps), (e: CfError) => e.code === 'permission' && e.perm === 'D1: Edit' && e.step === 'database')
  assert.ok(progress.includes('database:failed'))
  assert.ok(!calls.some((c) => c.url.includes('/scripts/')))
})

test('health that never answers: deployed, marked not healthy', async () => {
  let t = 0
  const { deps } = fake((c) => (c.url.endsWith('/api/health') ? fail(404, 0, '') : happy(c)), { now: () => (t += 60_000) })
  const r = await base(deps)
  assert.equal(r.healthy, false)
})

test('error mapping', () => {
  assert.equal(mapCfError('verify', 401, { errors: [{ code: 1000, message: 'Invalid API Token' }] }).code, 'badToken')
  assert.equal(mapCfError('upload', 403, { errors: [{ code: 10000, message: 'Authentication error' }] }).perm, 'Workers Scripts: Edit')
  assert.equal(mapCfError('database', 400, { errors: [{ code: 7406, message: 'You have reached the maximum number of databases' }] }).code, 'limit')
  assert.equal(mapCfError('upload', 400, { errors: [{ message: 'Please verify your email address' }] }).code, 'verifyEmail')
  assert.equal(mapCfError('upload', 429, {}).code, 'rateLimited')
  assert.equal(mapCfError('upload', 502, {}).code, 'cloudflareDown')
  assert.equal(mapCfError('upload', null, null, new TypeError('fetch failed')).code, 'network')
  assert.equal(mapCfError('upload', null, null, Object.assign(new Error('x'), { name: 'TimeoutError' })).code, 'timeout')
  assert.equal(mapCfError('upload', 400, { errors: [{ code: 1, message: 'weird' }] }).code, 'api')
})
