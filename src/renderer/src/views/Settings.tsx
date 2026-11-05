import { Check, Copy, FolderOpen, Mic, RefreshCw, Sparkles, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { HotkeyName, MeetingSource, Settings as SettingsT } from '@shared/types'
import { SOURCE_LABEL } from '@shared/types'
import { PermissionList } from '../components/Permissions'
import { SetupProgress } from '../components/SetupProgress'
import { Button, Card, cn, Segmented, Spinner, Toggle } from '../components/ui'
import { VoiceEnroll } from '../components/VoiceEnroll'
import { invoke, setSettings, useAppState } from '../lib/api'
import { modelName } from '../lib/format'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-9">
      <h2 className="mb-3 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">{title}</h2>
      <Card className="divide-y divide-line">{children}</Card>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

interface AsrChoices {
  hardware: { chip: string; ramGB: number; strong: boolean; model: string }
  language: 'he' | 'auto'
  current: string
  active: string | null
  models: { key: string; gb: number; downloaded: boolean; fits: boolean }[]
}

interface ClaudeStatus {
  desktop: boolean
  desktopInstalled: boolean
  code: boolean
  codeCli: boolean
  snippet: string
}

/** The Mac this runs on, drawn, with what it handles comfortably. */
function MacCard({ hw }: { hw: AsrChoices['hardware'] }) {
  const { t } = useTranslation()
  const laptop = /MacBook/.test(hw.model)
  const tier = hw.ramGB >= 32 || /Max|Ultra/.test(hw.chip) ? 3 : hw.strong ? 2 : 1
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-line bg-panel-2 p-4">
      <svg viewBox="0 0 120 80" className="h-[64px] w-[96px] shrink-0" aria-hidden="true">
        {laptop ? (
          <>
            <rect x="18" y="8" width="84" height="54" rx="5" fill="var(--color-panel)" stroke="currentColor" className="text-ink-3" strokeWidth="2" />
            <rect x="24" y="14" width="72" height="42" rx="2" fill="var(--color-accent-soft)" />
            <path d="M8 66h104l-6 7H14z" fill="currentColor" className="text-ink-3" />
          </>
        ) : (
          <>
            <rect x="14" y="30" width="92" height="30" rx="8" fill="var(--color-panel)" stroke="currentColor" className="text-ink-3" strokeWidth="2" />
            <rect x="40" y="62" width="40" height="4" rx="2" fill="currentColor" className="text-ink-3" />
          </>
        )}
        <g transform={laptop ? 'translate(45 20)' : 'translate(45 32)'}>
          <rect width="30" height="26" rx="4" fill="var(--color-accent)" />
          <text x="15" y="17" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">{(hw.chip.match(/M\d+/) || ['M'])[0]}</text>
        </g>
      </svg>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">{hw.model}</div>
        <div className="text-[12.5px] text-ink-2">{hw.chip || 'Apple silicon'} · {hw.ramGB}GB</div>
        <div className="mt-2 flex items-center gap-1.5" aria-label={t(`set.macTier${tier}`)}>
          {[1, 2, 3].map((n) => (
            <span key={n} className={cn('h-1.5 w-8 rounded-full', n <= tier ? 'bg-ok' : 'bg-line-strong')} />
          ))}
          <span className="ms-2 text-[12px] text-ink-2">{t(`set.macTier${tier}`)}</span>
        </div>
      </div>
    </div>
  )
}

interface CloudState {
  enabled: boolean
  url: string
  hasToken: boolean
  lastSync?: string
  lastError?: string
}

/** Optional copy of transcripts + summaries to the user's own Cloudflare Worker, for Claude on the phone. */
function CloudSection() {
  const { t } = useTranslation()
  const [st, setSt] = useState<CloudState | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  useEffect(() => void invoke<CloudState>('cloud:state').then((s) => { setSt(s); setUrl(s.url) }), [])
  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setWorking(true)
    setMsg(null)
    try {
      await fn()
      setSt(await invoke<CloudState>('cloud:state'))
      if (ok) setMsg(ok)
    } catch (err) {
      setMsg(String((err as Error).message ?? err).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''))
    } finally {
      setWorking(false)
    }
  }
  if (!st) return null
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="text-[12.5px] leading-relaxed text-ink-2">{t('set.cloudHint')}</div>
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
        <Button size="sm" variant="primary" disabled={working} onClick={() => void run(async () => {
          await invoke('cloud:configure', { url, token: token || undefined, enabled: true }); setToken('')
        }, t('set.cloudOn'))}>{st.enabled ? t('set.cloudSave') : t('set.cloudEnable')}</Button>
        {st.enabled && <Button size="sm" disabled={working} onClick={() => void run(async () => { await invoke('cloud:syncAll') }, t('set.cloudQueued'))}>{t('set.cloudSyncAll')}</Button>}
        {st.enabled && <Button size="sm" variant="ghost" disabled={working} onClick={() => void run(() => invoke('cloud:configure', { url, enabled: false }), t('set.cloudOff'))}>{t('set.cloudDisable')}</Button>}
        {st.hasToken && <Button size="sm" variant="ghost" disabled={working} onClick={() => void run(() => invoke('cloud:forget'))}>{t('set.cloudForget')}</Button>}
        {working && <Spinner />}
      </div>
      {(msg || st.lastError) && <div className={cn('text-[12px]', st.lastError && !msg ? 'text-rec' : 'text-ink-2')}>{msg ?? st.lastError}</div>}
      {st.lastSync && <div className="text-[11.5px] text-ink-3">{t('set.cloudLast')}: {new Date(st.lastSync).toLocaleString()}</div>}
    </div>
  )
}

export function Settings() {
  const { t } = useTranslation()
  const app = useAppState()
  const [claude, setClaude] = useState<ClaudeStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [scan, setScan] = useState<{ winner: string | null; results: any[] } | null>(null)
  const [vocab, setVocab] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => void invoke<ClaudeStatus>('claude:status').then(setClaude), [])
  const [asr, setAsr] = useState<AsrChoices | null>(null)
  useEffect(() => void invoke<AsrChoices>('asr:list').then(setAsr, () => setAsr(null)), [app?.engine.asr, app?.setup.running])
  const [auth, setAuth] = useState<{ cli: boolean; signedIn: boolean } | null>(null)
  const checkAuth = (): void => void invoke<{ cli: boolean; signedIn: boolean }>('claude:auth').then(setAuth, () => setAuth(null))
  useEffect(checkAuth, [])
  // Back from the Terminal / browser sign-in: check again.
  useEffect(() => {
    if (auth?.signedIn) return
    window.addEventListener('focus', checkAuth)
    return () => window.removeEventListener('focus', checkAuth)
  }, [auth?.signedIn])
  useEffect(() => setVocab((app?.settings.vocabulary ?? []).join(', ')), [app?.settings.vocabulary.join()])

  if (!app) return null
  const s = app.settings
  const set = (patch: Partial<SettingsT>): void => void setSettings(patch)

  const connect = async (target: 'desktop' | 'code'): Promise<void> => {
    setBusy(target)
    try {
      setClaude(await invoke<ClaudeStatus>('claude:connect', target))
    } catch (err) {
      window.alert(String(err))
    } finally {
      setBusy(null)
    }
  }

  const pickLanguage = async (lang: 'he' | 'auto'): Promise<void> => {
    if (lang === asr?.language) return
    setBusy('asr')
    try {
      setAsr(await invoke<AsrChoices>('asr:language', lang))
    } catch (err) {
      window.alert(String(err))
    } finally {
      setBusy(null)
    }
  }

  const pickAsr = async (key: string): Promise<void> => {
    if (key === asr?.current) return
    setBusy('asr')
    try {
      setAsr(await invoke<AsrChoices>('asr:select', key))
    } catch (err) {
      window.alert(String(err))
    } finally {
      setBusy(null)
    }
  }

  const runScan = async (): Promise<void> => {
    setBusy('scan')
    try {
      setScan(await invoke('mic:scan'))
    } finally {
      setBusy(null)
    }
  }

  const sources: Exclude<MeetingSource, 'inperson' | 'other'>[] = ['zoom', 'meet', 'teams', 'slack', 'facetime', 'webex', 'aircall']
  const physical = app.mic.devices.filter((d) => !d.virtual)

  return (
    <div className="mx-auto max-w-[760px] px-10 pb-20 pt-14">
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{t('nav.settings')}</h1>

      <Section title={t('set.general')}>
        <Row label={t('set.name')} hint={t('set.nameHint')}>
          <input
            defaultValue={s.userName}
            onBlur={(e) => set({ userName: e.target.value.trim() })}
            placeholder={t('set.namePlaceholder')}
            className="h-8 w-48 rounded-[9px] border border-line-strong bg-panel px-2.5 text-[13px] outline-none focus:border-accent/50"
          />
        </Row>
        <Row label={t('set.language')}>
          <Segmented value={s.uiLanguage} onChange={(v) => set({ uiLanguage: v })} options={[{ value: 'he' as const, label: 'עברית' }, { value: 'en' as const, label: 'English' }]} />
        </Row>
        <Row label={t('set.theme')}>
          <Segmented
            value={s.theme}
            onChange={(v) => set({ theme: v })}
            options={[
              { value: 'system' as const, label: t('set.themeSystem') },
              { value: 'light' as const, label: t('set.themeLight') },
              { value: 'dark' as const, label: t('set.themeDark') }
            ]}
          />
        </Row>
        <Row label={t('set.launchAtLogin')}>
          <Toggle checked={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} />
        </Row>
      </Section>

      <Section title={t('set.dictation')}>
        <Row label={t('set.hotkey')} hint={s.hotkey === 'fn' ? t('set.hotkeyFnHint') : t('set.hotkeyHint')}>
          <select
            value={s.hotkey}
            onChange={(e) => set({ hotkey: e.target.value as HotkeyName })}
            className="h-8 rounded-[9px] border border-line-strong bg-panel px-2 text-[13px] outline-none"
          >
            {app.platform === 'win32' ? (
              <>
                <option value="rightControl">Right Ctrl</option>
                <option value="rightOption">Right Alt</option>
              </>
            ) : (
              <>
                <option value="fn">fn / 🌐</option>
                <option value="rightOption">{t('set.rightOption')}</option>
                <option value="rightCommand">{t('set.rightCommand')}</option>
                <option value="rightControl">{t('set.rightControl')}</option>
              </>
            )}
          </select>
        </Row>
        <Row label={t('set.restoreClipboard')} hint={t('set.restoreClipboardHint')}>
          <Toggle checked={s.restoreClipboard} onChange={(v) => set({ restoreClipboard: v })} />
        </Row>
        <div className="px-4 py-3.5">
          <div className="text-[13.5px] font-medium">{t('set.vocabulary')}</div>
          <div className="mt-0.5 text-[12px] text-ink-2">{t('set.vocabularyHint')}</div>
          <textarea
            value={vocab}
            onChange={(e) => setVocab(e.target.value)}
            onBlur={() => set({ vocabulary: vocab.split(/[,\n]/).map((x) => x.trim()).filter(Boolean) })}
            rows={2}
            dir="auto"
            className="mt-2.5 w-full resize-none rounded-[10px] border border-line-strong bg-panel px-3 py-2 text-[13px] outline-none focus:border-accent/50"
          />
        </div>
      </Section>

      <Section title={t('set.meetings')}>
        <Row label={t('set.autoRecord')} hint={t('set.autoRecordHint')}>
          <Toggle checked={s.autoRecord} onChange={(v) => set({ autoRecord: v })} />
        </Row>
        <div className="flex flex-wrap gap-2 px-4 py-3.5">
          {sources.map((src) => (
            <button
              key={src}
              onClick={() => set({ detect: { ...s.detect, [src]: !s.detect[src] } })}
              className={`flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors ${s.detect[src] ? 'border-accent/40 bg-accent-soft text-accent-ink' : 'border-line-strong text-ink-3'}`}
            >
              {s.detect[src] ? <Check size={12} /> : <X size={12} />} {SOURCE_LABEL[src]}
            </button>
          ))}
        </div>
        <Row label={t('set.diarizeRemote')} hint={t('set.diarizeRemoteHint')}>
          <Toggle checked={s.diarizeRemote} onChange={(v) => set({ diarizeRemote: v })} />
        </Row>
        <Row label={t('set.keepAudio')} hint={t('set.keepAudioHint')}>
          <Toggle checked={s.keepAudio} onChange={(v) => set({ keepAudio: v })} />
        </Row>
        <Row label={t('set.folder')} hint={s.folder}>
          <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void invoke('app:pickFolder')}>
            {t('set.change')}
          </Button>
        </Row>
      </Section>

      <Section title={t('set.microphone')}>
        <Row label={t('set.micChoice')} hint={app.mic.auto ? t('set.micAutoHint', { name: app.mic.currentName ?? '—' }) : undefined}>
          <select
            value={s.micUid ?? ''}
            onChange={(e) => set({ micUid: e.target.value || null })}
            className="h-8 max-w-56 rounded-[9px] border border-line-strong bg-panel px-2 text-[13px] outline-none"
          >
            <option value="">{t('set.micAuto')}</option>
            {physical.map((d) => (
              <option key={d.uid} value={d.uid}>{d.name}</option>
            ))}
          </select>
        </Row>
        <div className="px-4 py-3.5">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="text-[13.5px] font-medium">{t('set.scan')}</div>
              <div className="mt-0.5 text-[12px] text-ink-2">{t('set.scanHint')}</div>
            </div>
            <Button size="sm" disabled={busy === 'scan' || !!app.live} icon={busy === 'scan' ? <Spinner className="size-3.5" /> : <Mic size={13} />} onClick={() => void runScan()}>
              {busy === 'scan' ? t('set.scanning') : t('set.scanNow')}
            </Button>
          </div>
          {scan && (
            <div className="mt-3 flex flex-col gap-1.5">
              {scan.results.map((r, i) => (
                <div key={r.uid} className="flex items-center gap-3 text-[12.5px]">
                  <span className={`w-40 truncate ${i === 0 && scan.winner ? 'font-semibold text-ok' : 'text-ink-2'}`}>{r.name}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, Math.min(100, (r.peakDb + 70) * 1.6))}%` }} />
                  </div>
                  <span className="tabular w-14 text-end text-ink-3">{Math.round(r.peakDb)} dB</span>
                </div>
              ))}
              {!scan.winner && <div className="text-[12px] text-warn">{t('set.scanNoVoice')}</div>}
            </div>
          )}
        </div>
      </Section>

      <Section title={t('set.voice')}>
        <div className="px-4 py-4">
          <VoiceEnroll />
        </div>
      </Section>

      <Section title={t('set.claude')}>
        <div className="flex items-start gap-3 px-4 py-3.5">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" />
          <div className="text-[12.5px] leading-relaxed text-ink-2">{t('set.claudeHint')}</div>
        </div>
        <Row label="Claude Desktop" hint={claude?.desktop ? t('set.connected') : claude && !claude.desktopInstalled ? t('set.notInstalled') : undefined}>
          {claude?.desktop ? (
            <span className="flex items-center gap-1 text-[12.5px] font-medium text-ok"><Check size={14} /> {t('set.connected')}</span>
          ) : (
            <Button size="sm" disabled={busy === 'desktop'} onClick={() => void connect('desktop')}>{t('set.connect')}</Button>
          )}
        </Row>
        <Row label="Claude Code" hint={claude && !claude.codeCli ? t('set.cliMissing') : undefined}>
          {claude?.code ? (
            <span className="flex items-center gap-1 text-[12.5px] font-medium text-ok"><Check size={14} /> {t('set.connected')}</span>
          ) : (
            <Button size="sm" disabled={busy === 'code' || !claude?.codeCli} onClick={() => void connect('code')}>{t('set.connect')}</Button>
          )}
        </Row>
        <Row
          label={t('set.autoSummary')}
          hint={!s.autoSummary ? undefined : !auth ? '…' : !auth.cli ? t('set.autoSummaryNoCli') : auth.signedIn ? t('set.autoSummaryReady') : t('set.autoSummaryLogin')}
        >
          <div className="flex items-center gap-2">
            {s.autoSummary && auth?.cli && !auth.signedIn && (
              <>
                <Button size="sm" variant="ghost" onClick={checkAuth}>{t('set.check')}</Button>
                <Button size="sm" onClick={() => void invoke('claude:signIn').catch((err) => window.alert(String(err)))}>{t('set.signIn')}</Button>
              </>
            )}
            <Toggle checked={s.autoSummary} onChange={(v) => set({ autoSummary: v })} />
          </div>
        </Row>
        <div className="px-4 py-3.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12.5px] font-medium text-ink-2">{t('set.manualConfig')}</span>
            <button
              onClick={() => {
                void invoke('clipboard:write', claude?.snippet ?? '')
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              }}
              className="flex items-center gap-1 text-[12px] font-medium text-accent"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />} {t('meeting.copy')}
            </button>
          </div>
          <pre dir="ltr" className="selectable max-h-40 overflow-auto rounded-[10px] bg-panel-2 p-3 text-[11px] leading-relaxed text-ink-2">{claude?.snippet}</pre>
        </div>
      </Section>

      {app.platform === 'darwin' && (
        <Section title={t('set.cloud')}>
          <CloudSection />
        </Section>
      )}

      <Section title={t('set.permissions')}>
        <div className="p-3">
          <PermissionList compact />
        </div>
      </Section>

      <Section title={t('set.engine')}>
        {(app.setup.needed || app.setup.running) && (
          <div className="p-3">
            <SetupProgress setup={app.setup} />
          </div>
        )}
        {app.platform === 'darwin' && asr && (
          <div className="px-4 py-3.5">
            <MacCard hw={asr.hardware} />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium">{t('set.asrLanguage')}</div>
                <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{t(asr.language === 'auto' ? 'set.asrLanguageAutoHint' : 'set.asrLanguageHeHint')}</div>
              </div>
              <Segmented
                value={asr.language}
                onChange={(v) => void pickLanguage(v as 'he' | 'auto')}
                options={[
                  { value: 'he', label: t('set.asrLanguageHe') },
                  { value: 'auto', label: t('set.asrLanguageAuto') }
                ]}
              />
            </div>
            <div className="mt-4 text-[13.5px] font-medium">{t('set.asrModel')}</div>
            <div className="mt-2 flex flex-col gap-2">
              {asr.models.map((m) => {
                const on = m.key === asr.current
                return (
                  <button
                    key={m.key}
                    disabled={!!busy}
                    onClick={() => void pickAsr(m.key)}
                    className={cn(
                      'flex items-start gap-3 rounded-xl border px-3.5 py-3 text-start transition-colors disabled:opacity-60',
                      on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel-2'
                    )}
                  >
                    <span className={cn('mt-1 grid size-3.5 shrink-0 place-items-center rounded-full border', on ? 'border-accent' : 'border-line-strong')}>
                      {on && <span className="size-1.5 rounded-full bg-accent" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
                        {t(`asr.${m.key}.name`)}
                        {m.key === 'whisper-ivrit-turbo' && <span className="rounded-md bg-ok-soft px-1.5 text-[10.5px] font-semibold text-ok">{t('set.asrRecommended')}</span>}
                      </span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-ink-2">{t(`asr.${m.key}.desc`)}</span>
                      <span className="mt-1 block text-[11.5px] text-ink-3">
                        {m.gb} GB · {m.downloaded ? t('set.asrInstalled') : t('set.asrDownloads')} ·{' '}
                        <span className={m.fits ? 'text-ok' : 'text-rec'}>{m.fits ? t('set.asrFitsHere') : t('set.asrSlowHere')}</span>
                        {on && asr.active && asr.active !== m.key && ` · ${t('set.asrAfterCall')}`}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
            {busy === 'asr' && <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-2"><Spinner /> {t('set.asrWorking')}</div>}
          </div>
        )}
        <Row label={`${modelName(app.engine.asr)} (${app.platform === 'darwin' ? 'MLX' : 'CTranslate2'})`} hint={t('set.engineHint')}>
          <span className="text-[12.5px] text-ink-2">{app.engine.state === 'ready' ? t('engine.ready') : app.engine.state}</span>
        </Row>
        <Row label="NVIDIA Nemotron-3-Diarization" hint={t('set.diarHint')}>
          <span className="text-[12.5px] text-ink-2">{app.engine.diarization ? t('engine.ready') : '—'}</span>
        </Row>
        <Row label={t('set.restartHelper')}>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void invoke('permissions:get')}>{t('set.refresh')}</Button>
        </Row>
      </Section>
    </div>
  )
}
