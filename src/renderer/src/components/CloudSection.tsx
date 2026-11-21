import { Check, ChevronDown, CircleAlert, CircleDashed, Cloud, Copy, ExternalLink, KeyRound, Smartphone } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { qrMatrix, qrSvgPath } from '@shared/qr'
import { Button, cn, Spinner, StatusDot } from './ui'
import { invoke, useEvent } from '../lib/api'

const SIGN_UP = 'https://dash.cloudflare.com/sign-up'
const CONNECTORS = 'https://claude.ai/settings/connectors'

type Step = 'verify' | 'account' | 'database' | 'schema' | 'storage' | 'secrets' | 'subdomain' | 'upload' | 'route' | 'health'
type StepState = 'running' | 'done' | 'skipped' | 'failed'
const DEPLOY_STEPS: Step[] = ['verify', 'account', 'database', 'schema', 'storage', 'secrets', 'subdomain', 'upload', 'route', 'health']
const UPDATE_STEPS: Step[] = ['verify', 'account', 'database', 'schema', 'storage', 'upload', 'route', 'health']

/** src/main/cloudDeploy.ts: FullCloudState */
interface CloudState {
  enabled: boolean
  url: string
  hasToken: boolean
  lastSync?: string
  lastError?: string
  deployed: boolean
  accountName?: string
  deployedAt?: string
  hasApiToken: boolean
  hasConnector: boolean
  hasPhoneLink: boolean
  /** The saved upload token can no longer be decrypted (src/main/cloud.ts: cloudNeedsRelink). */
  needsRelink?: boolean
  /** All three Worker tokens are on this computer, so an existing Worker can be updated keeping them. */
  canKeepTokens?: boolean
  phone: { supported: boolean | null; busy: boolean; lastCheck?: string; lastImport?: string; imported: number; lastError?: string }
  tokenUrl: string
}

interface DeployFailure {
  code: string
  step?: Step
  perm?: string
  detail?: string
  accounts?: { id: string; name: string }[]
}
type Outcome = { ok: true; healthy: boolean; state: CloudState } | { ok: false; error: DeployFailure }
type Kind = 'deploy' | 'update' | 'rotate'

const cleanError = (err: unknown): string => String((err as Error)?.message ?? err).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '')

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      icon={copied ? <Check size={13} /> : <Copy size={13} />}
      onClick={() => {
        void invoke('clipboard:write', text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      {copied ? t('cf.copied') : t('cf.copy')}
    </Button>
  )
}

/** A QR code drawn in the page (src/shared/qr.ts): nothing leaves the computer. */
function QrCode({ text, size = 148 }: { text: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const m = qrMatrix(text, 'M')
    return { path: qrSvgPath(m, 4), n: m.length + 8 }
  }, [text])
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" className="shrink-0 rounded-[10px] border border-line" role="img" aria-label="QR">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

/** A link shown cut short (it is a credential), with Copy. */
function SecretLink({ url }: { url: string }) {
  const short = url.replace(/^(https:\/\/[^/]+\/\w+\/)(.{6}).+$/, '$1$2…')
  return (
    <div className="flex items-center gap-2">
      <span dir="ltr" className="selectable min-w-0 flex-1 truncate rounded-[10px] bg-panel-2 px-3 py-1.5 text-start text-[12px] text-ink-2" title={short}>
        {short}
      </span>
      <CopyButton text={url} />
    </div>
  )
}

function Fold({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink">
        <ChevronDown size={14} className={cn('transition-transform', !open && 'rtl:rotate-90 ltr:-rotate-90')} />
        {title}
      </button>
      {open && <div className="mt-2 flex flex-col gap-3">{children}</div>}
    </div>
  )
}

function Progress({ kind, steps }: { kind: Kind; steps: Partial<Record<Step, StepState>> }) {
  const { t } = useTranslation()
  const list = (kind === 'deploy' ? DEPLOY_STEPS : UPDATE_STEPS).filter((s) => steps[s] !== 'skipped' || s === 'health')
  return (
    <ol className="flex flex-col gap-1 rounded-[10px] bg-panel-2 px-3 py-2">
      {list.map((s) => {
        const st = steps[s]
        return (
          <li key={s} className={cn('flex items-center gap-2 text-[12.5px]', !st && 'text-ink-3')}>
            {st === 'running' ? <Spinner className="size-3.5" />
              : st === 'done' ? <Check size={14} className="text-ok" />
              : st === 'failed' ? <CircleAlert size={14} className="text-rec" />
              : st === 'skipped' ? <CircleDashed size={14} className="text-warn" />
              : <CircleDashed size={14} />}
            {t(`cf.steps.${s}`)}
          </li>
        )
      })}
    </ol>
  )
}

/** The token field + "keep for updates", used by the setup and by update/replace without a kept key. */
function TokenField({ value, onChange, keep, onKeep, onEnter }: { value: string; onChange: (v: string) => void; keep: boolean; onKeep: (v: boolean) => void; onEnter?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1.5">
      <input
        dir="ltr"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value.trim() && onEnter?.()}
        placeholder={t('cf.tokenPlaceholder')}
        className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[13px] outline-none focus:border-accent"
      />
      <label className="flex items-start gap-2 text-[12.5px]">
        <input type="checkbox" checked={keep} onChange={(e) => onKeep(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
        <span>
          {t('cf.keepToken')}
          <span className="block text-[11.5px] text-ink-3">{t('cf.keepTokenHint')}</span>
        </span>
      </label>
    </div>
  )
}

/** The fields for a Worker deployed by hand with wrangler (the original setup). */
function ManualSetup({ st, onState }: { st: CloudState; onState: (s: CloudState) => void }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState(st.url)
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const [working, setWorking] = useState(false)
  const run = async (fn: () => Promise<CloudState>, ok?: string): Promise<void> => {
    setWorking(true)
    setMsg(null)
    try {
      onState(await fn())
      if (ok) setMsg({ text: ok, error: false })
    } catch (err) {
      setMsg({ text: cleanError(err), error: true })
    } finally {
      setWorking(false)
    }
  }
  return (
    <>
      <div className="text-[12px] leading-relaxed text-ink-3">{t('cf.manualHint')}</div>
      <label className="flex flex-col gap-1 text-[12.5px] font-medium">
        {t('set.cloudUrl')}
        <input id="cloud-url" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://klara-wisper-gateway.example.workers.dev"
          className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[13px] font-normal outline-none focus:border-accent" />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] font-medium">
        {t('set.cloudToken')} {st.hasToken && <span className="font-normal text-ok">({t('set.cloudTokenSaved')})</span>}
        <input id="cloud-token" dir="ltr" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="openssl rand -hex 32"
          className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[13px] font-normal outline-none focus:border-accent" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={working} onClick={() => void run(async () => {
          const s = await invoke<CloudState>('cloud:configure', { url, token: token || undefined, enabled: true })
          setToken('')
          return s
        }, t('set.cloudOn'))}>{st.enabled ? t('set.cloudSave') : t('set.cloudEnable')}</Button>
        {working && <Spinner />}
      </div>
      {msg && <div className={cn('text-[12px]', msg.error ? 'text-rec' : 'text-ink-2')}>{msg.text}</div>}
    </>
  )
}

/**
 * Settings > "Claude on your phone" (optional, off by default): one-click deploy of the Worker to
 * the user's own Cloudflare account, then the Claude connector link, the phone recording link with
 * its QR code, and the upkeep buttons. The manual (wrangler) setup stays under "advanced".
 */
export function CloudSection() {
  const { t, i18n } = useTranslation()
  const [st, setSt] = useState<CloudState | null>(null)
  const [links, setLinks] = useState<{ connector: string | null; phone: string | null }>({ connector: null, phone: null })
  const [wizard, setWizard] = useState(false)
  const [token, setToken] = useState('')
  const [keep, setKeep] = useState(false)
  const [accounts, setAccounts] = useState<{ id: string; name: string }[] | null>(null)
  const [account, setAccount] = useState('')
  const [kind, setKind] = useState<Kind | null>(null) // a deploy/update/rotate under way or just finished
  const [steps, setSteps] = useState<Partial<Record<Step, StepState>>>({})
  const [asking, setAsking] = useState<Kind | null>(null) // update/rotate waiting for a pasted key
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const [working, setWorking] = useState(false)
  const [exists, setExists] = useState(false) // a first setup found the Worker already in the account

  const refresh = async (): Promise<void> => {
    const s = await invoke<CloudState>('cloud:state')
    setSt(s)
    setLinks(s.enabled && (s.hasConnector || s.hasPhoneLink) ? await invoke('cloud:links') : { connector: null, phone: null })
  }
  useEffect(() => void refresh(), [])
  useEvent('cloud:changed', () => void refresh())
  useEvent<{ kind: Kind; step: Step; state: StepState }>('cloud:deployProgress', (p) => setSteps((s) => ({ ...s, [p.step]: p.state })))

  const explain = (e: DeployFailure): string => {
    const base = e.code === 'api'
      ? `${t('cf.err.api')}${e.detail ? `: ${e.detail}` : ''}`
      : t(`cf.err.${e.code}`, { perm: e.perm ?? '', detail: e.detail ?? '', defaultValue: e.detail ?? e.code })
    const at = e.step && e.code !== 'chooseAccount' && e.code !== 'permission' ? ` (${t('cf.err.atStep', { step: t(`cf.steps.${e.step}`) })})` : ''
    return base + at
  }

  const go = async (k: Kind, o: { replaceExisting?: boolean } = {}): Promise<void> => {
    setWorking(true)
    setMsg(null)
    setKind(k)
    setSteps({})
    setExists(false)
    try {
      const channel = k === 'deploy' ? 'cloud:deploy' : k === 'update' ? 'cloud:updateWorker' : 'cloud:rotatePhone'
      const pasted = token.trim()
      const r = await invoke<Outcome>(channel, { apiToken: pasted || undefined, keepToken: pasted ? keep : undefined, accountId: account || undefined, replaceExisting: o.replaceExisting === true })
      if (!r.ok) {
        // The Worker is already there (another computer, or an earlier setup): new tokens would cut off whatever
        // uses the current ones, so ask first, and offer an update that keeps this computer's tokens when it has them.
        if (r.error.code === 'workerExists') {
          setExists(true)
          return
        }
        if (r.error.code === 'chooseAccount' && r.error.accounts?.length) {
          setAccounts(r.error.accounts)
          setAccount(r.error.accounts[0].id)
        }
        // A key the update needs but doesn't have: ask for one right here.
        if (k !== 'deploy' && (r.error.code === 'badToken' || r.error.code === 'permission') && !st?.hasApiToken) setAsking(k)
        setMsg({ text: explain(r.error), error: r.error.code !== 'chooseAccount' })
        return
      }
      setToken('')
      setAccounts(null)
      setAsking(null)
      setWizard(false)
      setMsg({
        text: k === 'deploy' ? `${r.healthy ? t('cf.deployed') : t('cf.deployedSlow')} ${t('cf.syncOld')}` : k === 'update' ? t('cf.updated') : t('cf.rotated'),
        error: false
      })
      await refresh()
    } catch (err) {
      setMsg({ text: cleanError(err), error: true })
    } finally {
      setWorking(false)
    }
  }

  /** Update / replace: straight away with a kept key, otherwise ask for one first. */
  const upkeep = (k: 'update' | 'rotate'): void => {
    if (k === 'rotate' && !window.confirm(t('cf.rotateConfirm'))) return
    setMsg(null)
    if (st?.hasApiToken) void go(k)
    else {
      setAsking(k)
      setKind(null)
    }
  }

  const simple = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setWorking(true)
    setMsg(null)
    try {
      await fn()
      await refresh()
      if (ok) setMsg({ text: ok, error: false })
    } catch (err) {
      setMsg({ text: cleanError(err), error: true })
    } finally {
      setWorking(false)
    }
  }

  if (!st) return null
  const relink = st.needsRelink && (
    <div className="flex items-start gap-2 text-[12px] leading-relaxed text-rec"><CircleAlert size={14} className="mt-0.5 shrink-0" /> {t('cf.needsRelink')}</div>
  )
  const time = (iso?: string): string => (iso ? new Date(iso).toLocaleString(i18n.language === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : t('cf.never'))
  const status = msg && <div className={cn('text-[12px] leading-relaxed', msg.error ? 'text-rec' : 'text-ink-2')}>{msg.text}</div>

  // ---------- the guided setup ----------
  const setup = (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-panel-2/50 p-3.5">
      <div className="text-[12px] text-ink-2">{t('cf.autoSetupHint')}</div>
      <ol className="flex flex-col gap-3">
        <li className="flex gap-2.5">
          <StepNo n={1} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{t('cf.step1')}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{t('cf.step1Hint')}</div>
            <Button size="sm" variant="ghost" className="mt-1 -ms-2" icon={<ExternalLink size={13} />} onClick={() => void invoke('app:openExternal', SIGN_UP)}>{t('cf.step1Button')}</Button>
          </div>
        </li>
        <li className="flex gap-2.5">
          <StepNo n={2} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{t('cf.step2')}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{t('cf.step2Hint')}</div>
            <Button size="sm" className="mt-1.5" icon={<KeyRound size={13} />} onClick={() => void invoke('app:openExternal', st.tokenUrl)}>{t('cf.step2Button')}</Button>
          </div>
        </li>
        <li className="flex gap-2.5">
          <StepNo n={3} />
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 text-[13px] font-medium">{t('cf.step3')}</div>
            <TokenField value={token} onChange={setToken} keep={keep} onKeep={setKeep} onEnter={() => !working && void go('deploy')} />
          </div>
        </li>
      </ol>
      {accounts && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[12.5px] font-medium">{t('cf.chooseAccount')}</div>
          {accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-[12.5px]">
              <input type="radio" name="cf-account" checked={account === a.id} onChange={() => setAccount(a.id)} className="accent-[var(--color-accent)]" />
              {a.name || a.id}
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={working || !token.trim()} onClick={() => void go('deploy')}>{accounts ? t('cf.continue') : t('cf.deploy')}</Button>
        <Button size="sm" variant="ghost" disabled={working} onClick={() => { setWizard(false); setToken(''); setAccounts(null); setKind(null); setMsg(null) }}>{t('cf.cancel')}</Button>
      </div>
      {exists && (
        <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-panel px-3 py-2.5">
          <div className="flex items-start gap-2 text-[12.5px] leading-relaxed"><CircleAlert size={14} className="mt-0.5 shrink-0 text-warn" /> {t('cf.err.workerExists')}</div>
          <div className="flex flex-wrap items-center gap-2">
            {st.canKeepTokens && (
              <Button size="sm" variant="primary" disabled={working} onClick={() => void go('update')}>{t('cf.existsKeep')}</Button>
            )}
            <Button size="sm" variant={st.canKeepTokens ? 'ghost' : 'danger'} disabled={working} onClick={() => window.confirm(t('cf.existsReplaceConfirm')) && void go('deploy', { replaceExisting: true })}>{t('cf.existsReplace')}</Button>
          </div>
        </div>
      )}
      {(kind === 'deploy' || kind === 'update') && Object.keys(steps).length > 0 && <Progress kind={kind} steps={steps} />}
      {status}
    </div>
  )

  // ---------- off ----------
  if (!st.enabled) {
    return (
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="text-[12.5px] leading-relaxed text-ink-2">{t('cf.intro')}</div>
        {relink}
        {(st.deployed || st.hasToken) && st.url && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-ink-2">{t('cf.off')}</span>
            <Button size="sm" disabled={working} onClick={() => void simple(() => invoke('cloud:configure', { url: st.url, enabled: true }), t('cf.turnedOn'))}>{t('cf.turnOn')}</Button>
          </div>
        )}
        {wizard ? setup : (
          <div>
            <Button size="sm" variant="primary" icon={<Cloud size={14} />} onClick={() => { setWizard(true); setMsg(null) }}>{t('cf.autoSetup')}</Button>
          </div>
        )}
        {!wizard && status}
        <Fold title={t('cf.manual')}>
          <ManualSetup st={st} onState={(s) => void (setSt(s), refresh())} />
          {(st.hasToken || st.deployed) && (
            <div>
              <Button size="sm" variant="danger" disabled={working} onClick={() => window.confirm(t('cf.forgetConfirm')) && void simple(() => invoke('cloud:forget'))}>{t('cf.forgetAll')}</Button>
            </div>
          )}
        </Fold>
      </div>
    )
  }

  // ---------- on ----------
  const phoneOk = st.hasPhoneLink && links.phone && st.phone.supported !== false
  return (
    <div className="flex flex-col gap-4 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
        <span className="flex items-center gap-1.5 font-medium"><StatusDot tone={st.lastError || st.needsRelink ? 'warn' : 'ok'} /> {t('cf.connected')}</span>
        {st.accountName && <span className="text-ink-2">{t('cf.account')}: {st.accountName}</span>}
        <span className="text-ink-3">{t('cf.lastSync')}: {time(st.lastSync)}</span>
      </div>
      {relink}
      {st.lastError && !st.needsRelink && <div className="text-[12px] text-rec">{st.lastError}</div>}
      {st.needsRelink && (wizard ? setup : (
        <div>
          <Button size="sm" variant="primary" icon={<Cloud size={14} />} onClick={() => { setWizard(true); setMsg(null) }}>{t('cf.autoSetup')}</Button>
        </div>
      ))}

      {links.connector && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[13px] font-medium">{t('cf.connectorTitle')}</div>
          <div className="text-[12px] leading-relaxed text-ink-2">{t('cf.connectorHint')}</div>
          <SecretLink url={links.connector} />
          <div>
            <Button size="sm" variant="ghost" className="-ms-2" icon={<ExternalLink size={13} />} onClick={() => void invoke('app:openExternal', CONNECTORS)}>{t('cf.openConnectors')}</Button>
          </div>
        </div>
      )}

      {st.hasPhoneLink && links.phone && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-[13px] font-medium"><Smartphone size={14} /> {t('cf.phoneTitle')}</div>
          {phoneOk ? (
            <div className="flex flex-wrap items-start gap-4">
              <QrCode text={links.phone} />
              <div className="flex min-w-[220px] flex-1 flex-col gap-2">
                <div className="text-[12px] leading-relaxed text-ink-2">{t('cf.phoneHint')}</div>
                <SecretLink url={links.phone} />
                <div className="text-[11.5px] text-ink-3">
                  {st.phone.busy ? t('cf.phoneBusy') : `${t('cf.phoneStatus', { n: st.phone.imported })} · ${t('cf.phoneLastCheck')}: ${time(st.phone.lastCheck)}`}
                </div>
                {st.phone.lastError && <div className="text-[11.5px] text-rec">{t('cf.phoneError', { error: st.phone.lastError })}</div>}
                <div>
                  <Button size="sm" variant="ghost" className="-ms-2" disabled={working || st.phone.busy} onClick={() => void simple(() => invoke('cloud:pullPhone'))}>{t('cf.phoneCheck')}</Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-[12px] leading-relaxed text-ink-2">{t('cf.phoneOld')}</div>
          )}
        </div>
      )}

      {(links.connector || links.phone) && <div className="text-[11.5px] leading-relaxed text-ink-3">{t('cf.secretNote')}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={working} onClick={() => void simple(() => invoke('cloud:syncAll'), t('cf.queued'))}>{t('cf.syncAll')}</Button>
        {st.deployed && <Button size="sm" disabled={working} onClick={() => upkeep('update')}>{t('cf.updateWorker')}</Button>}
        {st.deployed && st.hasPhoneLink && <Button size="sm" disabled={working} onClick={() => upkeep('rotate')}>{t('cf.rotatePhone')}</Button>}
        <Button size="sm" variant="ghost" disabled={working} onClick={() => void simple(() => invoke('cloud:configure', { url: st.url, enabled: false }), t('cf.off'))}>{t('cf.turnOff')}</Button>
        {working && <Spinner />}
      </div>

      {asking && (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-panel-2/50 p-3.5">
          <div className="text-[12.5px] leading-relaxed">{t('cf.needToken')}</div>
          <div>
            <Button size="sm" icon={<KeyRound size={13} />} onClick={() => void invoke('app:openExternal', st.tokenUrl)}>{t('cf.step2Button')}</Button>
          </div>
          <TokenField value={token} onChange={setToken} keep={keep} onKeep={setKeep} onEnter={() => !working && void go(asking)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={working || !token.trim()} onClick={() => void go(asking)}>{asking === 'update' ? t('cf.updateWorker') : t('cf.rotatePhone')}</Button>
            <Button size="sm" variant="ghost" disabled={working} onClick={() => { setAsking(null); setToken('') }}>{t('cf.cancel')}</Button>
          </div>
        </div>
      )}
      {kind && kind !== 'deploy' && !wizard && Object.keys(steps).length > 0 && <Progress kind={kind} steps={steps} />}
      {status}

      {st.hasApiToken && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
          {t('cf.apiTokenKept')}
          <button className="font-medium text-accent" disabled={working} onClick={() => void simple(() => invoke('cloud:forgetApiToken'))}>{t('cf.forgetApiToken')}</button>
        </div>
      )}

      <Fold title={t('cf.manual')}>
        <ManualSetup st={st} onState={(s) => void (setSt(s), refresh())} />
        <div>
          <Button size="sm" variant="danger" disabled={working} onClick={() => window.confirm(t('cf.forgetConfirm')) && void simple(() => invoke('cloud:forget'))}>{t('cf.forgetAll')}</Button>
        </div>
      </Fold>
    </div>
  )
}

function StepNo({ n }: { n: number }) {
  return <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{n}</span>
}
