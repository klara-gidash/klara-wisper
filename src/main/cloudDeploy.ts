import { app, net } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  API_TOKEN_FILE, DEPLOY_FILE, MCP_TOKEN_FILE, REC_TOKEN_FILE,
  cloudState, configureCloud, readSecret, saveSecret, saveUploadToken, uploadToken, type CloudState
} from './cloud'
import {
  CfError, connectorUrl, deployGateway, parseWranglerToml, phoneUrl, tokenTemplateUrl,
  type CfErrorCode, type DeployResult, type DeployStep, type Secrets, type StepState, type WorkerConfig
} from './cloudflareApi'
import { projectRoot } from './paths'
import { phoneState, pullPhoneRecordings, type PhoneState } from './phoneRecordings'
import { settings } from './settings'
import { broadcast } from './windows'

/**
 * Settings > "Claude on your phone" > automatic setup: deploys the Worker (cloudflare/src/worker.js,
 * bundled with the app) to the user's own Cloudflare account with an API token they create from a
 * pre-filled link, then turns sync on. The API token is kept (encrypted) only when the user asks,
 * for later updates; otherwise it is forgotten as soon as the deploy ends.
 */

/** What the deploy made; no secrets (they are in the encrypted .bin files next to it). */
interface DeployInfo {
  url: string
  accountId: string
  accountName: string
  databaseId: string
  subdomain: string
  deployedAt: string
  updatedAt?: string
  workerVersion?: string | null
  features?: string[]
}

export interface DeployFailure {
  code: CfErrorCode
  step?: DeployStep
  perm?: string
  detail?: string
  accounts?: { id: string; name: string }[]
}

export type DeployOutcome = { ok: true; healthy: boolean; state: FullCloudState } | { ok: false; error: DeployFailure }

export interface FullCloudState extends CloudState {
  /** Set up by the one-click deploy (so "update" and "replace phone link" can work). */
  deployed: boolean
  accountName?: string
  deployedAt?: string
  /** The Cloudflare API token is kept for updates. */
  hasApiToken: boolean
  /** The connector and phone links can be shown (their tokens are on this computer). */
  hasConnector: boolean
  hasPhoneLink: boolean
  /** All three of the Worker's tokens are on this computer, so it can be updated keeping them. */
  canKeepTokens: boolean
  phone: PhoneState
  /** The token page link, pre-filled with the permissions the deploy needs. */
  tokenUrl: string
}

/** The Worker's files: inside the app (resources/cloudflare) or the checkout's cloudflare/ folder. */
export function bundledFile(name: 'worker.js' | 'schema.sql' | 'wrangler.toml'): string {
  if (app.isPackaged) return join(process.resourcesPath, 'cloudflare', name)
  return name === 'worker.js' ? join(projectRoot, 'cloudflare', 'src', 'worker.js') : join(projectRoot, 'cloudflare', name)
}

function workerConfig(): WorkerConfig {
  return parseWranglerToml(readFileSync(bundledFile('wrangler.toml'), 'utf8'))
}

function readInfo(): DeployInfo | null {
  try {
    return existsSync(DEPLOY_FILE) ? (JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')) as DeployInfo) : null
  } catch {
    return null
  }
}

export function tokenUrl(): string {
  try {
    return tokenTemplateUrl({ r2: workerConfig().r2.length > 0 })
  } catch {
    return tokenTemplateUrl()
  }
}

export function fullCloudState(): FullCloudState {
  const base = cloudState()
  const info = readInfo()
  return {
    ...base,
    deployed: !!info && info.url === base.url,
    accountName: info?.accountName,
    deployedAt: info?.updatedAt ?? info?.deployedAt,
    hasApiToken: !!readSecret(API_TOKEN_FILE),
    hasConnector: !!base.url && !!readSecret(MCP_TOKEN_FILE),
    hasPhoneLink: !!base.url && !!readSecret(REC_TOKEN_FILE),
    canKeepTokens: base.hasToken && !!readSecret(MCP_TOKEN_FILE) && !!readSecret(REC_TOKEN_FILE),
    phone: phoneState(),
    tokenUrl: tokenUrl()
  }
}

/** The Claude connector URL and the phone recording link (both are credentials: shown only on request). */
export function cloudLinks(): { connector: string | null; phone: string | null } {
  const url = settings.value.cloudUrl
  const mcp = readSecret(MCP_TOKEN_FILE)
  const rec = readSecret(REC_TOKEN_FILE)
  return { connector: url && mcp ? connectorUrl(url, mcp) : null, phone: url && rec ? phoneUrl(url, rec) : null }
}

/** Saves the three tokens the Worker was just given (the deploy calls it right after the upload). */
export function saveDeploySecrets(s: Secrets): void {
  saveUploadToken(s.upload)
  saveSecret(MCP_TOKEN_FILE, s.mcp)
  saveSecret(REC_TOKEN_FILE, s.rec)
}

let running = false

async function run(
  kind: 'deploy' | 'update' | 'rotate',
  opts: { apiToken?: string; keepToken?: boolean; accountId?: string; replaceExisting?: boolean }
): Promise<DeployOutcome> {
  if (running) return { ok: false, error: { code: 'api', detail: 'busy' } }
  running = true
  const pasted = opts.apiToken?.trim() || ''
  const apiToken = pasted || readSecret(API_TOKEN_FILE) || ''
  const info = readInfo()
  try {
    let secrets: Secrets | undefined
    if (kind !== 'deploy') {
      const upload = uploadToken()
      const mcp = readSecret(MCP_TOKEN_FILE)
      const rec = readSecret(REC_TOKEN_FILE)
      if (!upload || !mcp || !rec) throw new CfError('missingSecrets')
      secrets = { upload, mcp, rec: kind === 'rotate' ? randomBytes(32).toString('hex') : rec }
    }
    const result: DeployResult = await deployGateway(
      {
        fetch: async (url, init) => {
          const r = await net.fetch(url, { method: init.method, headers: init.headers, body: init.body as string | Uint8Array<ArrayBuffer> | undefined, signal: init.signal, redirect: 'error' })
          return { ok: r.ok, status: r.status, json: () => r.json(), text: () => r.text() }
        },
        secret: () => randomBytes(32).toString('hex'),
        randomName: () => randomBytes(4).toString('hex'),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        progress: (step: DeployStep, state: StepState, detail?: string) => broadcast('cloud:deployProgress', { kind, step, state, detail })
      },
      {
        apiToken,
        accountId: opts.accountId || info?.accountId,
        workerJs: readFileSync(bundledFile('worker.js'), 'utf8'),
        schemaSql: readFileSync(bundledFile('schema.sql'), 'utf8'),
        config: workerConfig(),
        secrets,
        replaceExisting: kind === 'deploy' && opts.replaceExisting === true,
        // The Worker has these secrets now: keep this computer's copies of all three in step at once, before
        // the route and health steps (up to minutes) can fail or the app quit. Otherwise a re-deploy that stops
        // there leaves the Worker expecting an upload token this computer doesn't have: every upload gets 401.
        onUploaded: saveDeploySecrets
      }
    )

    const now = new Date().toISOString()
    const next: DeployInfo = {
      url: result.url,
      accountId: result.accountId,
      accountName: result.accountName,
      databaseId: result.databaseId,
      subdomain: result.subdomain,
      deployedAt: kind === 'deploy' || !info ? now : info.deployedAt,
      ...(kind === 'deploy' ? {} : { updatedAt: now }),
      workerVersion: result.version,
      features: result.features
    }
    writeFileSync(DEPLOY_FILE, JSON.stringify(next, null, 2))
    try {
      await configureCloud({ url: result.url, token: result.secrets.upload, enabled: true })
    } catch (err) {
      // A brand-new workers.dev address can take a few minutes to answer: sync stays on and
      // starts working by itself (configureCloud saved the address and token before checking).
      if (result.healthy) throw err
    }
    if (pasted && opts.keepToken) saveSecret(API_TOKEN_FILE, pasted)
    else if (pasted && opts.keepToken === false) rmSync(API_TOKEN_FILE, { force: true })
    if (result.features.includes('recordings')) setTimeout(() => void pullPhoneRecordings(), 5_000)
    broadcast('cloud:changed', null)
    return { ok: true, healthy: result.healthy, state: fullCloudState() }
  } catch (err) {
    const e = err instanceof CfError ? err : new CfError('api', { detail: String((err as Error)?.message ?? err) })
    // A pasted token the user didn't ask to keep is never written anywhere.
    console.warn(`cloudflare ${kind}: ${e.code}${e.step ? ` at ${e.step}` : ''}${e.perm ? ` (${e.perm})` : ''}`)
    return { ok: false, error: { code: e.code, step: e.step, perm: e.perm, detail: e.detail?.slice(0, 300), accounts: e.accounts } }
  } finally {
    running = false
  }
}

export const deployCloud = (opts: { apiToken?: string; keepToken?: boolean; accountId?: string; replaceExisting?: boolean }): Promise<DeployOutcome> => run('deploy', opts)
export const updateCloudWorker = (opts: { apiToken?: string; keepToken?: boolean; accountId?: string }): Promise<DeployOutcome> => run('update', opts)
export const rotatePhoneLink = (opts: { apiToken?: string; keepToken?: boolean; accountId?: string }): Promise<DeployOutcome> => run('rotate', opts)

/** "Forget the Cloudflare key": updates will ask for a new one. */
export function forgetApiToken(): FullCloudState {
  rmSync(API_TOKEN_FILE, { force: true })
  return fullCloudState()
}
