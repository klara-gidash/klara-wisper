import { CircleAlert, Link2, ShieldCheck, UserPlus, Users } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, cn, Spinner } from './ui'
import { CopyButton, Fold, SecretLink, cleanError } from './cloudBits'
import { invoke, useEvent } from '../lib/api'

/** src/shared/team.ts */
type AutoShare = 'never' | 'domains' | 'all'
interface ShareRule {
  mode: AutoShare
  domains: string[]
  since: string | null
}
interface TeamMember {
  id: string
  name: string
  status: 'joined' | 'invited' | 'expired'
  lastSeenAt: string | null
  inviteExpiresAt: string | null
  meetings: number
  shared: number
}
interface TeamConnector {
  id: string
  label: string
  createdAt: string
}
/** src/main/cloudTeam.ts: TeamState */
interface TeamState {
  role: 'owner' | 'member' | null
  active: boolean
  supported: boolean | null
  name?: string
  ownerName?: string
  team?: { ownerName: string; owner: { meetings: number; shared: number }; members: TeamMember[]; connectors: TeamConnector[]; limits: { members: number } }
  limits?: { meetingsMb: number; recordingsMb: number }
  rule: ShareRule
  error?: string
}

type Msg = { text: string; error: boolean } | null

/** "team:<code>" errors from the main process, in words. */
function useExplain(): (err: unknown) => string {
  const { t } = useTranslation()
  return (err) => {
    const msg = cleanError(err)
    const code = /^team:(\w+)/.exec(msg)?.[1]
    return code ? t(`team.err.${code}`, { defaultValue: t('team.err.worker') }) : msg
  }
}

const input = 'rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[13px] outline-none focus:border-accent'

function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <div className={cn('flex items-start gap-2 text-[12px] leading-relaxed', tone === 'warn' ? 'text-rec' : 'text-ink-2')}>
      {tone === 'warn' && <CircleAlert size={14} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </div>
  )
}

/** Settings > Cloud: "Join a team cloud" with an invite code from the team's owner. */
export function JoinTeam({ hasCloud, onJoined }: { hasCloud: boolean; onJoined: () => void }) {
  const { t } = useTranslation()
  const explain = useExplain()
  const [code, setCode] = useState('')
  const [working, setWorking] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const join = async (): Promise<void> => {
    if (hasCloud && !window.confirm(t('team.joinReplace'))) return
    setWorking(true)
    setMsg(null)
    try {
      await invoke('team:join', code)
      setCode('')
      setMsg({ text: t('team.joined'), error: false })
      onJoined()
    } catch (err) {
      setMsg({ text: explain(err), error: true })
    } finally {
      setWorking(false)
    }
  }
  return (
    <Fold title={t('team.join')}>
      <div className="text-[12px] leading-relaxed text-ink-2">{t('team.joinHint')}</div>
      <textarea
        dir="ltr"
        rows={2}
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={t('team.joinPlaceholder')}
        className={cn(input, 'resize-none font-mono text-[12px]')}
      />
      <div className="text-[11.5px] leading-relaxed text-ink-3">{t('team.joinPrivacy')}</div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" icon={<Users size={13} />} disabled={working || !code.trim()} onClick={() => void join()}>{t('team.joinButton')}</Button>
        {working && <Spinner />}
      </div>
      {msg && <div className={cn('text-[12px] leading-relaxed', msg.error ? 'text-rec' : 'text-ink-2')}>{msg.text}</div>}
    </Fold>
  )
}

/** What a teammate can and cannot see: the same plain list for the owner and for members. */
function WhoSeesWhat({ owner }: { owner: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] bg-panel-2 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[12.5px] font-medium"><ShieldCheck size={14} className="text-ok" /> {t('team.canSee')}</div>
      <ul className="flex list-disc flex-col gap-1 ps-5 text-[12px] leading-relaxed text-ink-2">
        <li>{t('team.seeDefault')}</li>
        <li>{t('team.seeOwn')}</li>
        <li>{t('team.seeTeam')}</li>
        <li>{t('team.seePhone')}</li>
        <li>{t('team.seeOwner', { owner })}</li>
      </ul>
    </div>
  )
}

/** "Share with the team automatically": never (default), meetings with guests from some domains, or all. */
function AutoShareSetting({ rule, onSaved }: { rule: ShareRule; onSaved: (r: ShareRule) => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<AutoShare>(rule.mode)
  const [domains, setDomains] = useState(rule.domains.join(', '))
  const [msg, setMsg] = useState<Msg>(null)
  const dirty = mode !== rule.mode || (mode === 'domains' && domains.replace(/\s/g, '') !== rule.domains.join(','))
  const save = async (): Promise<void> => {
    try {
      const next = await invoke<ShareRule>('team:autoShare', { mode, domains })
      setDomains(next.domains.join(', '))
      setMode(next.mode)
      onSaved(next)
      setMsg({ text: next.mode === 'domains' && !next.domains.length ? t('team.autoNoDomains') : t('team.autoSaved'), error: next.mode === 'domains' && !next.domains.length })
    } catch (err) {
      setMsg({ text: cleanError(err), error: true })
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[13px] font-medium">{t('team.auto')}</div>
      <div className="text-[12px] leading-relaxed text-ink-2">{t('team.autoHint')}</div>
      {(['never', 'domains', 'all'] as const).map((m) => (
        <label key={m} className="flex items-center gap-2 text-[12.5px]">
          <input type="radio" name="team-auto" checked={mode === m} onChange={() => setMode(m)} className="accent-[var(--color-accent)]" />
          {t(`team.auto_${m}`)}
        </label>
      ))}
      {mode === 'domains' && (
        <div className="flex flex-col gap-1 ps-6">
          <input dir="ltr" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="acme.com, example.co.il" className={input} />
          <div className="text-[11.5px] text-ink-3">{t('team.autoDomainsHint')}</div>
        </div>
      )}
      <div>
        <Button size="sm" disabled={!dirty} onClick={() => void save()}>{t('team.save')}</Button>
      </div>
      {msg && <div className={cn('text-[12px]', msg.error ? 'text-rec' : 'text-ink-2')}>{msg.text}</div>}
    </div>
  )
}

/**
 * Settings > Cloud > Team (optional). The owner of the Worker invites teammates, sees who joined, removes
 * them and makes team connectors; a teammate sees whose team they are in. Both pick the automatic sharing rule.
 */
export function TeamSection({ deployed, onChanged }: { deployed: boolean; onChanged: () => void }) {
  const { t, i18n } = useTranslation()
  const explain = useExplain()
  const [st, setSt] = useState<TeamState | null>(null)
  const [working, setWorking] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const [ownerName, setOwnerName] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [invite, setInvite] = useState<{ text: string; name: string } | null>(null)
  const [label, setLabel] = useState('')
  const [connector, setConnector] = useState<string | null>(null)
  const [removing, setRemoving] = useState<TeamMember | null>(null)
  const [deleteShared, setDeleteShared] = useState(false)

  const refresh = async (): Promise<void> => {
    const s = await invoke<TeamState>('team:state')
    setSt(s)
    setOwnerName(s.team?.ownerName ?? '')
  }
  useEffect(() => void refresh(), [])
  useEvent('cloud:changed', () => void refresh())

  const run = async (fn: () => Promise<void>, ok?: string): Promise<void> => {
    setWorking(true)
    setMsg(null)
    try {
      await fn()
      await refresh()
      if (ok) setMsg({ text: ok, error: false })
    } catch (err) {
      setMsg({ text: explain(err), error: true })
    } finally {
      setWorking(false)
    }
  }

  if (!st) return null
  const time = (iso: string | null): string => (iso ? new Date(iso).toLocaleString(i18n.language === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : t('cf.never'))
  const status = msg && <div className={cn('text-[12px] leading-relaxed', msg.error ? 'text-rec' : 'text-ink-2')}>{msg.text}</div>
  const header = (
    <div className="flex items-center gap-1.5 text-[13px] font-medium"><Users size={14} /> {t('team.title')}</div>
  )

  // ---------- a teammate ----------
  if (st.role === 'member') {
    const owner = st.ownerName || t('team.theOwner')
    return (
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        {header}
        <div className="text-[12.5px] leading-relaxed">{st.ownerName ? t('team.memberOf', { owner: st.ownerName, name: st.name }) : t('team.memberOfNoOwner', { name: st.name })}</div>
        {st.error === 'rejected' && <Note tone="warn">{t('team.err.removed')}</Note>}
        {st.error && st.error !== 'rejected' && <Note tone="warn">{t(`team.err.${st.error}`, { defaultValue: t('team.err.worker') })}</Note>}
        <WhoSeesWhat owner={owner} />
        {st.limits && <div className="text-[11.5px] text-ink-3">{t('team.memberLimits', { meetings: st.limits.meetingsMb, recordings: st.limits.recordingsMb })}</div>}
        <AutoShareSetting rule={st.rule} onSaved={(rule) => setSt({ ...st, rule })} />
        <div>
          <Button size="sm" variant="ghost" className="-ms-2" disabled={working} onClick={() => window.confirm(t('team.leaveConfirm')) && void run(async () => {
            await invoke('cloud:forget')
            onChanged()
          })}>{t('team.leave')}</Button>
        </div>
        {status}
      </div>
    )
  }

  // ---------- the owner (or someone who could be) ----------
  if (st.supported === false) {
    return (
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        {header}
        <div className="text-[12px] leading-relaxed text-ink-2">{t('team.intro')}</div>
        <Note>{deployed ? t('team.oldWorker') : t('team.oldWorkerManual')}</Note>
        <JoinTeam hasCloud onJoined={onChanged} />
      </div>
    )
  }
  if (st.supported !== true) {
    return st.error ? (
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        {header}
        <Note tone="warn">{t(`team.err.${st.error}`, { defaultValue: t('team.err.worker') })}</Note>
      </div>
    ) : null
  }
  const team = st.team!
  const owner = team.ownerName || t('team.theOwner')
  const doInvite = (): Promise<void> =>
    run(async () => {
      const r = await invoke<{ invite: string; name: string }>('team:invite', inviteName)
      setInvite({ text: r.invite, name: r.name })
      setInviteName('')
      onChanged()
    })
  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4">
      <div className="flex flex-col gap-1.5">
        {header}
        <div className="text-[12px] leading-relaxed text-ink-2">{t('team.intro')}</div>
      </div>
      <WhoSeesWhat owner={owner} />

      {/* the owner's name on shared meetings */}
      <div className="flex flex-col gap-1">
        <label className="text-[12.5px] font-medium" htmlFor="team-owner-name">{t('team.yourName')}</label>
        <div className="flex flex-wrap items-center gap-2">
          <input id="team-owner-name" value={ownerName} maxLength={80} onChange={(e) => setOwnerName(e.target.value)} className={cn(input, 'min-w-[200px] flex-1')} />
          <Button size="sm" disabled={working || ownerName.trim() === team.ownerName} onClick={() => void run(() => invoke('team:ownerName', ownerName), t('team.saved'))}>{t('team.save')}</Button>
        </div>
        <div className="text-[11.5px] text-ink-3">{t('team.yourNameHint')}</div>
      </div>

      {/* invite */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[13px] font-medium">{t('team.invite')}</div>
        <div className="flex flex-wrap items-center gap-2">
          <input value={inviteName} maxLength={80} onChange={(e) => setInviteName(e.target.value)} placeholder={t('team.inviteName')} className={cn(input, 'min-w-[200px] flex-1')}
            onKeyDown={(e) => e.key === 'Enter' && inviteName.trim() && !working && void doInvite()} />
          <Button size="sm" variant="primary" icon={<UserPlus size={13} />} disabled={working || !inviteName.trim()} onClick={() => void doInvite()}>{t('team.inviteButton')}</Button>
        </div>
        {invite && (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-panel px-3 py-2.5">
            <div className="text-[12.5px] leading-relaxed">{t('team.inviteReady', { name: invite.name })}</div>
            <SecretLink url={invite.text} />
            <div className="text-[11.5px] leading-relaxed text-ink-3">{t('team.inviteHow')}</div>
          </div>
        )}
      </div>

      {/* members */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[13px] font-medium">{t('team.members')}</div>
        {team.members.length === 0 && <div className="text-[12px] text-ink-3">{t('team.noMembers')}</div>}
        {team.members.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] bg-panel-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium" dir="auto">{m.name}</div>
              <div className="text-[11.5px] text-ink-3">
                {t(`team.status_${m.status}`)}
                {m.status === 'joined' && ` · ${t('team.memberStats', { meetings: m.meetings, shared: m.shared })} · ${t('team.lastSeen')}: ${time(m.lastSeenAt)}`}
              </div>
            </div>
            <Button size="sm" variant="ghost" disabled={working} onClick={() => (m.status !== 'joined' || window.confirm(t('team.newInviteConfirm', { name: m.name }))) && void run(async () => {
              const r = await invoke<{ invite: string }>('team:reinvite', m.id)
              setInvite({ text: r.invite, name: m.name })
            })}>{t('team.newInvite')}</Button>
            <Button size="sm" variant="ghost" className="hover:text-rec" disabled={working} onClick={() => { setRemoving(m); setDeleteShared(false) }}>{t('team.remove')}</Button>
          </div>
        ))}
        {removing && (
          <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-panel px-3 py-2.5">
            <div className="text-[12.5px] font-medium">{t('team.removeTitle', { name: removing.name })}</div>
            <div className="text-[12px] leading-relaxed text-ink-2">{t('team.removeWhat')}</div>
            <label className="flex items-start gap-2 text-[12.5px]">
              <input type="checkbox" checked={deleteShared} onChange={(e) => setDeleteShared(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
              <span>
                {t('team.removeShared', { name: removing.name })}
                <span className="block text-[11.5px] text-ink-3">{t('team.removeKeep')}</span>
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="danger" disabled={working} onClick={() => void run(async () => {
                await invoke('team:remove', removing.id, deleteShared)
                setRemoving(null)
                onChanged()
              }, t('team.removed', { name: removing.name }))}>{t('team.removeConfirm')}</Button>
              <Button size="sm" variant="ghost" disabled={working} onClick={() => setRemoving(null)}>{t('cf.cancel')}</Button>
            </div>
          </div>
        )}
      </div>

      {/* team connectors */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[13px] font-medium"><Link2 size={14} /> {t('team.connectorTitle')}</div>
        <div className="text-[12px] leading-relaxed text-ink-2">{t('team.connectorHint')}</div>
        {team.connectors.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-[10px] bg-panel-2 px-3 py-1.5">
            <div className="min-w-0 flex-1 text-[12.5px]" dir="auto">{c.label || t('team.connectorUnnamed')} <span className="text-[11.5px] text-ink-3">· {time(c.createdAt)}</span></div>
            <Button size="sm" variant="ghost" className="hover:text-rec" disabled={working} onClick={() => window.confirm(t('team.connectorDeleteConfirm')) && void run(async () => {
              await invoke('team:deleteConnector', c.id)
              setConnector(null)
            })}>{t('team.connectorDelete')}</Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder={t('team.connectorLabel')} className={cn(input, 'min-w-[200px] flex-1')} />
          <Button size="sm" disabled={working} onClick={() => void run(async () => {
            const r = await invoke<{ url: string }>('team:createConnector', label)
            setConnector(r.url)
            setLabel('')
            onChanged()
          })}>{t('team.connectorCreate')}</Button>
        </div>
        {connector && (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-panel px-3 py-2.5">
            <div className="text-[12.5px] leading-relaxed">{t('team.connectorReady')}</div>
            <div className="flex items-center gap-2">
              <span dir="ltr" className="selectable min-w-0 flex-1 truncate rounded-[10px] bg-panel-2 px-3 py-1.5 text-[12px] text-ink-2">{connector.replace(/(\/mcp\/.{6}).+$/, '$1…')}</span>
              <CopyButton text={connector} />
            </div>
          </div>
        )}
      </div>

      {st.active && <AutoShareSetting rule={st.rule} onSaved={(rule) => setSt({ ...st, rule })} />}
      <div className="flex items-center gap-2">
        {working && <Spinner />}
        {status}
      </div>
      {/* Not running a team: this computer could join someone else's instead. */}
      {!team.members.length && !team.connectors.length && <JoinTeam hasCloud onJoined={onChanged} />}
    </div>
  )
}
