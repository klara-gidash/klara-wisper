/**
 * One-click deploy of the Klara Wisper Cloud gateway (cloudflare/) to the user's own Cloudflare
 * account through the Cloudflare REST API (https://api.cloudflare.com/client/v4), with an API token
 * the user created from a pre-filled link. No Electron and no other module here: everything the
 * deploy needs comes in through `CfDeps` (fakes in test/cloud-deploy.test.mts), the Electron side is
 * src/main/cloudDeploy.ts.
 */

export const CF_API = 'https://api.cloudflare.com/client/v4'
export const WORKER_NAME = 'klara-wisper-gateway'
export const DATABASE_NAME = 'klara-wisper'
/** The phone recording page served by the Worker: <worker>/rec/<KLARA_REC_TOKEN>. */
export const REC_PATH = '/rec/'
/** The read-only Claude connector: <worker>/mcp/<KLARA_MCP_TOKEN>. */
export const MCP_PATH = '/mcp/'

export type DeployStep =
  | 'verify' | 'account' | 'database' | 'schema' | 'storage' | 'secrets' | 'subdomain' | 'upload' | 'route' | 'health'

export const DEPLOY_STEPS: DeployStep[] = ['verify', 'account', 'database', 'schema', 'storage', 'secrets', 'subdomain', 'upload', 'route', 'health']
export const UPDATE_STEPS: DeployStep[] = ['verify', 'account', 'database', 'schema', 'storage', 'upload', 'route', 'health']

export type StepState = 'running' | 'done' | 'skipped' | 'failed'

/** Why a deploy stopped, for a message in plain words (strings.ts: cf.err.<code>). */
export type CfErrorCode =
  | 'badToken' // the token is wrong, expired or was deleted
  | 'permission' // the token lacks a permission (`perm` names it)
  | 'limit' // an account limit (number of databases, Workers…)
  | 'verifyEmail' // Cloudflare wants the account's email address verified first
  | 'r2Disabled' // R2 storage was never turned on in the dashboard
  | 'chooseAccount' // the token reaches several accounts: the user picks one (`accounts`)
  | 'noAccount' // the token reaches no account at all
  | 'network' // no connection to Cloudflare
  | 'timeout'
  | 'rateLimited'
  | 'cloudflareDown' // Cloudflare answered 5xx
  | 'missingSecrets' // "update" without the local copies of the Worker's secrets
  | 'wrongAccount' // an update with a key that doesn't reach the account the Worker is in
  | 'workerExists' // a first setup found a Worker already there (another computer, or set up before): replacing its tokens needs a yes
  | 'api' // anything else: `detail` has Cloudflare's own message

export class CfError extends Error {
  code: CfErrorCode
  step?: DeployStep
  perm?: string
  detail?: string
  accounts?: { id: string; name: string }[]
  constructor(code: CfErrorCode, opts: { step?: DeployStep; perm?: string; detail?: string; accounts?: { id: string; name: string }[] } = {}) {
    super(`cf:${code}${opts.perm ? ` (${opts.perm})` : ''}${opts.detail ? `: ${opts.detail}` : ''}`)
    this.code = code
    this.step = opts.step
    this.perm = opts.perm
    this.detail = opts.detail
    this.accounts = opts.accounts
  }
}

/** The permission each step needs, named as on Cloudflare's token page. */
export const STEP_PERMISSION: Partial<Record<DeployStep, string>> = {
  account: 'Account Settings: Read',
  database: 'D1: Edit',
  schema: 'D1: Edit',
  storage: 'Workers R2 Storage: Edit',
  secrets: 'Workers Scripts: Edit', // listing the account's Workers
  subdomain: 'Workers Scripts: Edit',
  upload: 'Workers Scripts: Edit',
  route: 'Workers Scripts: Edit'
}

// ---------- the pre-filled token link ----------

/**
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 * A user token template: permissionGroupKeys (URL-encoded JSON of {key, type}), accountId=* (all
 * accounts), zoneId=all, and the token's name. User tokens only take the short keys, and drop
 * unknown ones silently.
 */
export function tokenTemplateUrl(opts: { r2?: boolean; name?: string } = {}): string {
  const keys = [
    { key: 'workers_scripts', type: 'edit' }, // the Worker, its workers.dev route and the account's workers.dev subdomain
    { key: 'd1', type: 'edit' }, // the database and its schema
    { key: 'account_settings', type: 'read' }, // finding the account
    ...(opts.r2 ? [{ key: 'workers_r2', type: 'edit' }] : [])
  ]
  const q = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(keys),
    accountId: '*',
    zoneId: 'all',
    name: opts.name ?? 'Klara Wisper'
  })
  return `https://dash.cloudflare.com/profile/api-tokens?${q.toString()}`
}

// ---------- wrangler.toml (the parts the deploy needs) ----------

export interface WorkerConfig {
  name: string
  compatibilityDate: string
  compatibilityFlags: string[]
  d1: { binding: string; databaseName: string }[]
  r2: { binding: string; bucketName: string }[]
  vars: Record<string, string>
  observability: boolean
}

function tomlValue(raw: string): unknown {
  const v = raw.trim()
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0]
    const end = v.indexOf(q, 1)
    return v.slice(1, end < 0 ? undefined : end)
  }
  if (v.startsWith('[')) {
    return [...v.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2])
  }
  if (v === 'true' || v === 'false') return v === 'true'
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/** Strips a # comment that isn't inside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}

/** A small reader for the flat wrangler.toml the Worker ships with (no inline tables). */
export function parseWranglerToml(text: string): WorkerConfig {
  const root: Record<string, unknown> = {}
  const tables: Record<string, Record<string, unknown>> = {}
  const arrays: Record<string, Record<string, unknown>[]> = {}
  let current = root
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue
    let m = /^\[\[\s*([\w.-]+)\s*\]\]$/.exec(line)
    if (m) {
      const entry: Record<string, unknown> = {}
      ;(arrays[m[1]] ??= []).push(entry)
      current = entry
      continue
    }
    m = /^\[\s*([\w.-]+)\s*\]$/.exec(line)
    if (m) {
      current = tables[m[1]] ??= {}
      continue
    }
    m = /^([\w.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line)
    if (m) current[m[1].replace(/^"|"$/g, '')] = tomlValue(m[2])
  }
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(tables.vars ?? {})) vars[k] = String(v)
  return {
    name: str(root.name, WORKER_NAME),
    compatibilityDate: str(root.compatibility_date, '2026-09-01'),
    compatibilityFlags: Array.isArray(root.compatibility_flags) ? (root.compatibility_flags as string[]) : [],
    d1: (arrays.d1_databases ?? []).map((d) => ({ binding: str(d.binding, 'DB'), databaseName: str(d.database_name, DATABASE_NAME) })),
    r2: (arrays.r2_buckets ?? []).map((b) => ({ binding: str(b.binding), bucketName: str(b.bucket_name) })).filter((b) => b.binding && b.bucketName),
    vars,
    observability: tables.observability?.enabled === true
  }
}

/**
 * Drops `--` comments (outside quotes) and blank lines from schema.sql before it goes to D1's query
 * endpoint, so an apostrophe or a semicolon in a comment can never confuse its statement splitting.
 */
export function stripSqlComments(sql: string): string {
  const out: string[] = []
  for (const line of sql.split(/\r?\n/)) {
    let quote: string | null = null
    let end = line.length
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === "'" || c === '"') quote = c
      else if (c === '-' && line[i + 1] === '-') {
        end = i
        break
      }
    }
    const kept = line.slice(0, end).trimEnd()
    if (kept.trim()) out.push(kept)
  }
  return out.join('\n')
}

// ---------- errors ----------

interface CfMessage {
  code?: number
  message?: string
}

/** Turns a Cloudflare answer (or a fetch failure) into a CfError with a reason the UI can explain. */
export function mapCfError(step: DeployStep, status: number | null, body: unknown, thrown?: unknown): CfError {
  if (status === null) {
    const name = (thrown as Error)?.name ?? ''
    if (name === 'TimeoutError' || name === 'AbortError') return new CfError('timeout', { step })
    return new CfError('network', { step, detail: String((thrown as Error)?.message ?? thrown ?? '') })
  }
  const errors: CfMessage[] = Array.isArray((body as { errors?: unknown })?.errors) ? ((body as { errors: CfMessage[] }).errors) : []
  const codes = errors.map((e) => Number(e.code))
  const text = errors.map((e) => String(e.message ?? '')).join('; ')
  const detail = text || `HTTP ${status}`
  const perm = STEP_PERMISSION[step]
  // 1000 "Invalid API Token", 6003/6111 a malformed Authorization header, 9109 "Invalid access token".
  if (codes.some((c) => c === 1000 || c === 6003 || c === 6111 || c === 9106 || c === 9109) || /invalid (api|access) token/i.test(text)) {
    return new CfError('badToken', { step, detail })
  }
  if (/verify (your )?email|email (address )?(is )?not verified|unverified email/i.test(text)) return new CfError('verifyEmail', { step, detail })
  if (codes.includes(10042) || /enable R2/i.test(text)) return new CfError('r2Disabled', { step, detail })
  if (status === 429 || codes.includes(971) || /rate limit|too many requests/i.test(text)) return new CfError('rateLimited', { step, detail })
  if (/limit|maximum number|exceeded|quota/i.test(text) || codes.includes(7406) || codes.includes(10037)) return new CfError('limit', { step, detail })
  // 10000 "Authentication error": the token is fine but may not do this.
  if (status === 401 || status === 403 || codes.includes(10000) || /authentication error|not authorized|unauthorized|permission/i.test(text)) {
    if (step === 'verify') return new CfError('badToken', { step, detail })
    return new CfError('permission', { step, perm, detail })
  }
  if (status >= 500) return new CfError('cloudflareDown', { step, detail })
  return new CfError('api', { step, detail })
}

// ---------- the deploy ----------

export interface CfDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
  }>
  /** A new 32-byte secret as 64 hex characters (crypto.randomBytes(32).toString('hex')). */
  secret: () => string
  /** A short random lowercase name part, for a new workers.dev subdomain. */
  randomName: () => string
  sleep: (ms: number) => Promise<void>
  now: () => number
  progress: (step: DeployStep, state: StepState, detail?: string) => void
}

export interface Secrets {
  upload: string // KLARA_TOKEN
  mcp: string // KLARA_MCP_TOKEN
  rec: string // KLARA_REC_TOKEN
}

export interface DeployOptions {
  apiToken: string
  /** Picked by the user when the token reaches several accounts (or remembered from the first deploy). */
  accountId?: string
  workerJs: string
  schemaSql: string
  config: WorkerConfig
  /** "update" and "rotate" re-send the Worker with these secrets; a first deploy makes new ones. */
  secrets?: Secrets
  /** How long to wait for the new address to answer /api/health. */
  healthTimeoutMs?: number
  /**
   * Right after the Worker took these secrets: save all three (the upload token too) before anything later
   * can fail, or the computer is left without the token the Worker now expects. A throw stops the deploy.
   */
  onUploaded?: (secrets: Secrets) => void
  /**
   * A first setup that finds the Worker already in the account stops with `workerExists` (new tokens would
   * break the computer and the connector that use the current ones), unless the user agreed to replace them.
   */
  replaceExisting?: boolean
}

export interface DeployResult {
  url: string
  accountId: string
  accountName: string
  databaseId: string
  subdomain: string
  secrets: Secrets
  /** /api/health answered in time (a brand-new workers.dev name can take a few minutes). */
  healthy: boolean
  features: string[]
  version: string | null
}

interface Envelope<T> {
  success?: boolean
  result?: T
  errors?: CfMessage[]
}

export class CloudflareClient {
  private deps: CfDeps
  private token: string
  constructor(deps: CfDeps, token: string) {
    this.deps = deps
    this.token = token.trim()
  }

  async request<T>(step: DeployStep, method: string, path: string, body?: unknown, extra: { contentType?: string; allow404?: boolean } = {}): Promise<{ status: number; data: Envelope<T> }> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    let payload: string | Uint8Array | undefined
    if (body instanceof Uint8Array) {
      payload = body
      headers['content-type'] = extra.contentType ?? 'application/octet-stream'
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    let res: Awaited<ReturnType<CfDeps['fetch']>>
    try {
      res = await this.deps.fetch(CF_API + path, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) })
    } catch (err) {
      throw mapCfError(step, null, null, err)
    }
    let data: Envelope<T> = {}
    try {
      data = (await res.json()) as Envelope<T>
    } catch {
      data = {}
    }
    if (res.status === 404 && extra.allow404) return { status: 404, data }
    if (!res.ok || data.success === false) throw mapCfError(step, res.status, data)
    return { status: res.status, data }
  }
}

/** multipart/form-data for the Workers script upload: the metadata part and the module. */
export function workerUploadBody(metadata: unknown, modules: { name: string; source: string }[], boundary: string): Uint8Array {
  const enc = new TextEncoder()
  const parts: string[] = []
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`)
  for (const m of modules) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${m.name}"; filename="${m.name}"\r\nContent-Type: application/javascript+module\r\n\r\n${m.source}\r\n`)
  }
  parts.push(`--${boundary}--\r\n`)
  return enc.encode(parts.join(''))
}

export function workerMetadata(config: WorkerConfig, ids: { d1: Record<string, string> }, secrets: Secrets): Record<string, unknown> {
  const bindings: Record<string, unknown>[] = [
    // `database_id` is the field's current name in the API reference; `id` is its older name, still accepted.
    ...config.d1.map((d) => ({ type: 'd1', name: d.binding, database_id: ids.d1[d.binding], id: ids.d1[d.binding] })),
    ...config.r2.map((b) => ({ type: 'r2_bucket', name: b.binding, bucket_name: b.bucketName })),
    ...Object.entries(config.vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    { type: 'secret_text', name: 'KLARA_TOKEN', text: secrets.upload },
    { type: 'secret_text', name: 'KLARA_MCP_TOKEN', text: secrets.mcp },
    { type: 'secret_text', name: 'KLARA_REC_TOKEN', text: secrets.rec }
  ]
  return {
    main_module: 'worker.js',
    compatibility_date: config.compatibilityDate,
    ...(config.compatibilityFlags.length ? { compatibility_flags: config.compatibilityFlags } : {}),
    bindings,
    // Request logs would hold the /mcp/<token> and /rec/<token> URLs: off, as in wrangler.toml.
    observability: { enabled: false }
  }
}

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * The whole deploy, one step after another (DEPLOY_STEPS; UPDATE_STEPS when `secrets` are given).
 * Every step can run again safely: an existing database, bucket or subdomain is reused.
 */
export async function deployGateway(deps: CfDeps, opts: DeployOptions): Promise<DeployResult> {
  const cf = new CloudflareClient(deps, opts.apiToken)
  const isUpdate = !!opts.secrets
  let current: DeployStep = 'verify'
  const step = async <T>(name: DeployStep, fn: () => Promise<T>): Promise<T> => {
    current = name
    deps.progress(name, 'running')
    const out = await fn()
    deps.progress(name, 'done')
    return out
  }
  try {
    if (!opts.apiToken.trim()) throw new CfError('badToken', { step: 'verify' })

    // 1. The token is real and active.
    await step('verify', async () => {
      let r: { status: number; data: Envelope<{ status?: string }> }
      try {
        r = await cf.request<{ status?: string }>('verify', 'GET', '/user/tokens/verify', undefined, { allow404: true })
      } catch (err) {
        // An account-owned token isn't a user token: it is good if it can list its account.
        if (!(err instanceof CfError) || err.code !== 'badToken') throw err
        const accounts = await cf.request<unknown[]>('verify', 'GET', '/accounts?per_page=50').catch(() => null)
        if (!accounts?.data.result?.length) throw err
        return
      }
      if (r.status === 404) return // checked by listing its accounts below
      if (r.data.result?.status && r.data.result.status !== 'active') throw new CfError('badToken', { step: 'verify', detail: `token ${r.data.result.status}` })
    })

    // 2. The account: the one the token reaches, or the one the user picked.
    const account = await step('account', async () => {
      const r = await cf.request<{ id: string; name: string }[]>('account', 'GET', '/accounts?per_page=50')
      const list = (r.data.result ?? []).map((a) => ({ id: a.id, name: a.name }))
      if (opts.accountId) {
        const found = list.find((a) => a.id === opts.accountId)
        if (found) return found
        if (!list.length) return { id: opts.accountId, name: '' }
        // An update with a key made in another account would quietly build a second Worker and database there
        // (new address, the meetings left behind): stop and say so instead.
        if (isUpdate) throw new CfError('wrongAccount', { step: 'account', accounts: list })
      }
      if (!list.length) throw new CfError('noAccount', { step: 'account' })
      if (list.length > 1) throw new CfError('chooseAccount', { step: 'account', accounts: list })
      return list[0]
    })
    const acct = `/accounts/${encodeURIComponent(account.id)}`

    // 3. The D1 database(s): found by name, or made.
    const d1Ids: Record<string, string> = {}
    await step('database', async () => {
      for (const d of opts.config.d1) {
        const r = await cf.request<{ uuid: string; name: string }[]>('database', 'GET', `${acct}/d1/database?name=${encodeURIComponent(d.databaseName)}&per_page=100`)
        const found = (r.data.result ?? []).find((x) => x.name === d.databaseName)
        if (found) {
          d1Ids[d.binding] = found.uuid
          continue
        }
        const made = await cf.request<{ uuid: string }>('database', 'POST', `${acct}/d1/database`, { name: d.databaseName })
        if (!made.data.result?.uuid) throw new CfError('api', { step: 'database', detail: 'no database id in the answer' })
        d1Ids[d.binding] = made.data.result.uuid
      }
    })

    // 4. schema.sql (only creates what is missing, so it runs on every update too).
    await step('schema', async () => {
      const main = opts.config.d1[0]
      if (!main) return
      const r = await cf.request<{ success?: boolean; error?: string }[]>('schema', 'POST', `${acct}/d1/database/${d1Ids[main.binding]}/query`, { sql: stripSqlComments(opts.schemaSql) })
      const failed = (r.data.result ?? []).find((x) => x && x.success === false)
      if (failed) throw new CfError('api', { step: 'schema', detail: failed.error ?? 'schema failed' })
    })

    // 5. R2 bucket(s), only when wrangler.toml declares one.
    if (opts.config.r2.length) {
      await step('storage', async () => {
        for (const b of opts.config.r2) {
          const r = await cf.request('storage', 'GET', `${acct}/r2/buckets/${encodeURIComponent(b.bucketName)}`, undefined, { allow404: true })
          if (r.status !== 404) continue
          await cf.request('storage', 'POST', `${acct}/r2/buckets`, { name: b.bucketName })
        }
      })
    } else {
      deps.progress('storage', 'skipped')
    }

    // 6. Three different secrets: upload, connector (read-only), phone link.
    const secrets: Secrets = isUpdate
      ? (opts.secrets as Secrets)
      : await step('secrets', async () => {
          if (!opts.replaceExisting) {
            const list = await cf.request<{ id?: string }[]>('secrets', 'GET', `${acct}/workers/scripts`)
            if ((list.data.result ?? []).some((x) => x?.id === opts.config.name)) throw new CfError('workerExists', { step: 'secrets' })
          }
          const s ={ upload: deps.secret(), mcp: deps.secret(), rec: deps.secret() }
          if (new Set([s.upload, s.mcp, s.rec]).size !== 3) throw new CfError('api', { step: 'secrets', detail: 'secrets are not different' })
          return s
        })
    if (isUpdate && (!secrets.upload || !secrets.mcp || !secrets.rec)) throw new CfError('missingSecrets', { step: 'upload' })

    // 7. The account's workers.dev subdomain (registered when the account has none yet).
    const subdomain = isUpdate
      ? await readSubdomain(cf, acct)
      : await step('subdomain', async () => (await readSubdomain(cf, acct)) ?? (await registerSubdomain(cf, acct, deps)))
    if (!subdomain) throw new CfError('api', { step: 'subdomain', detail: 'the account has no workers.dev subdomain' })
    // The address is built from this answer and the upload token is sent there: only a plain DNS label is accepted.
    if (!SUBDOMAIN_RE.test(subdomain) || !SUBDOMAIN_RE.test(opts.config.name)) throw new CfError('api', { step: 'subdomain', detail: 'unexpected workers.dev subdomain' })

    // 8. The Worker itself, as an ES module with its bindings.
    await step('upload', async () => {
      const boundary = `----klara${deps.secret().slice(0, 24)}`
      const body = workerUploadBody(workerMetadata(opts.config, { d1: d1Ids }, secrets), [{ name: 'worker.js', source: opts.workerJs }], boundary)
      await cf.request('upload', 'PUT', `${acct}/workers/scripts/${encodeURIComponent(opts.config.name)}`, body, {
        contentType: `multipart/form-data; boundary=${boundary}`
      })
      opts.onUploaded?.(secrets)
    })

    // 9. Its workers.dev address on (no preview URLs).
    await step('route', async () => {
      await cf.request('route', 'POST', `${acct}/workers/scripts/${encodeURIComponent(opts.config.name)}/subdomain`, { enabled: true, previews_enabled: false })
    })

    const url = `https://${opts.config.name}.${subdomain}.workers.dev`

    // 10. Wait until it answers (a new workers.dev name can take a minute or more to reach DNS).
    current = 'health'
    deps.progress('health', 'running')
    const health = await waitHealthy(deps, url, opts.healthTimeoutMs ?? 180_000)
    deps.progress('health', health ? 'done' : 'skipped', health ? undefined : 'slow')

    return {
      url,
      accountId: account.id,
      accountName: account.name,
      databaseId: d1Ids[opts.config.d1[0]?.binding ?? 'DB'] ?? '',
      subdomain,
      secrets,
      healthy: !!health,
      features: health?.features ?? [],
      version: health?.version ?? null
    }
  } catch (err) {
    const e = err instanceof CfError ? err : new CfError('api', { step: current, detail: String((err as Error)?.message ?? err) })
    e.step ??= current
    deps.progress(e.step, 'failed', e.code)
    throw e
  }
}

async function readSubdomain(cf: CloudflareClient, acct: string): Promise<string | null> {
  try {
    const r = await cf.request<{ subdomain?: string }>('subdomain', 'GET', `${acct}/workers/subdomain`, undefined, { allow404: true })
    return r.status === 404 ? null : r.data.result?.subdomain || null
  } catch (err) {
    // 10007: the account has no workers.dev subdomain yet.
    if (err instanceof CfError && err.code === 'api' && /10007|not found|no subdomain/i.test(err.detail ?? '')) return null
    throw err
  }
}

async function registerSubdomain(cf: CloudflareClient, acct: string, deps: CfDeps): Promise<string> {
  let last: unknown = null
  for (let i = 0; i < 4; i++) {
    const name = `klara-${deps.randomName()}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)
    if (!SUBDOMAIN_RE.test(name)) continue
    try {
      const r = await cf.request<{ subdomain?: string }>('subdomain', 'PUT', `${acct}/workers/subdomain`, { subdomain: name })
      return r.data.result?.subdomain || name
    } catch (err) {
      last = err
      // Taken or not allowed: try another name. Anything else (permission, network) stops here.
      if (!(err instanceof CfError) || err.code !== 'api' || !/taken|already|unavailable|not available|exists|in use|reserved|conflict/i.test(err.detail ?? '')) throw err
    }
  }
  throw last ?? new CfError('api', { step: 'subdomain', detail: 'could not register a workers.dev subdomain' })
}

export interface Health {
  version: string | null
  features: string[]
}

/** The features the Worker announces in /api/health ("recordings", …), as an array or an object of flags. */
export function healthFeatures(body: unknown): string[] {
  const f = (body as { features?: unknown })?.features
  if (Array.isArray(f)) return f.filter((x): x is string => typeof x === 'string')
  if (f && typeof f === 'object') return Object.entries(f as Record<string, unknown>).filter(([, v]) => !!v).map(([k]) => k)
  return []
}

async function waitHealthy(deps: CfDeps, url: string, timeoutMs: number): Promise<Health | null> {
  const until = deps.now() + timeoutMs
  for (;;) {
    try {
      const r = await deps.fetch(`${url}/api/health`, { method: 'GET', headers: {}, signal: AbortSignal.timeout(10_000) })
      if (r.ok) {
        const body = (await r.json()) as { ok?: boolean; version?: string }
        if (body?.ok) return { version: typeof body.version === 'string' ? body.version : null, features: healthFeatures(body) }
      }
    } catch {
      // not reachable yet (DNS for a new subdomain, TLS certificate)
    }
    if (deps.now() >= until) return null
    await deps.sleep(3000)
  }
}

export function connectorUrl(workerUrl: string, mcpToken: string): string {
  return `${workerUrl.replace(/\/+$/, '')}${MCP_PATH}${mcpToken}`
}

export function phoneUrl(workerUrl: string, recToken: string): string {
  return `${workerUrl.replace(/\/+$/, '')}${REC_PATH}${recToken}`
}
