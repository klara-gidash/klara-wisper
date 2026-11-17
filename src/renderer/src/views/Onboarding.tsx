import {
  AlertTriangle, ArrowLeft, ArrowRight, AudioLines, CalendarDays, Check, Cpu, Download, FolderInput, HardDrive, Keyboard, Languages, MemoryStick,
  Mic, RefreshCw, Sparkles, Users, Video, Wifi, WifiOff
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClaudeAuto, PreflightReport } from '@shared/types'
import { blocked, DEFAULT_WISHES, recommend, tierOf, type Plan, type Problem, type Use, type Wishes } from '@shared/plan'
import { GoogleCalendarSection } from '../components/GoogleCalendarSection'
import { HealthPanel } from '../components/HealthPanel'
import { PermissionList } from '../components/Permissions'
import { SetupProgress } from '../components/SetupProgress'
import { Button, Card, cn, Kbd, Segmented, Spinner, Toggle } from '../components/ui'
import { VoiceEnroll } from '../components/VoiceEnroll'
import { invoke, setSettings, useAppState } from '../lib/api'
import { modelName } from '../lib/format'

/**
 * The install wizard (first launch): checks the computer, asks two questions, picks the version
 * that fits (src/shared/plan.ts), installs it, connects Claude and runs the health check.
 * Every step can be passed with the big button: the defaults are the recommended choices.
 */
type Step = 'welcome' | 'check' | 'ask' | 'install' | 'permissions' | 'calendar' | 'voice' | 'claude' | 'health' | 'done'
const USES: { use: Use; icon: ReactNode }[] = [
  { use: 'dictation', icon: <Keyboard size={18} /> },
  { use: 'calls', icon: <Video size={18} /> },
  { use: 'inperson', icon: <Users size={18} /> }
]

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const app = useAppState()
  const rtl = i18n.language === 'he'
  const Next = rtl ? ArrowLeft : ArrowRight
  const mac = app?.platform !== 'win32'

  const [report, setReport] = useState<PreflightReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [wishes, setWishes] = useState<Wishes>(app?.settings.wishes ?? DEFAULT_WISHES)
  const [planned, setPlanned] = useState<Plan | null>(null)
  const [name, setName] = useState(app?.settings.userName ?? '')
  const [step, setStep] = useState<Step>('welcome')

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      const r = await invoke<PreflightReport>('preflight:run', null)
      setReport(r)
      // Python and the packages are the same whatever the answers: start them right away.
      if (!blocked(r.problems) && !r.installed.engine) void invoke('setup:engine')
    } catch (err) {
      console.error('preflight failed', err) // the check step offers "check again"
    } finally {
      setChecking(false)
    }
  }
  // The computer is checked while the welcome screen is read.
  useEffect(() => void check(), [])

  const plan = useMemo(() => (report ? recommend(report.machine, wishes) : null), [report, wishes])
  const speakers = (planned ?? plan)?.speakers ?? true
  // The calendar names the calls; with dictation only there are no calls to name.
  const meetings = wishes.uses.includes('calls') || wishes.uses.includes('inperson')
  const steps: Step[] = [
    'welcome', 'check', 'ask', 'install', 'permissions',
    ...(meetings ? (['calendar'] as Step[]) : []),
    ...(speakers ? (['voice'] as Step[]) : []),
    'claude', 'health', 'done'
  ]
  const index = steps.indexOf(step)
  const go = (s: Step): void => setStep(s)
  const next = (): void => {
    if (step === 'voice' && name.trim()) void setSettings({ userName: name.trim() })
    if (index < steps.length - 1) setStep(steps[index + 1])
  }
  const back = (): void => {
    if (index > 0) setStep(steps[index - 1])
  }
  const finish = (): void => {
    void setSettings({ onboarded: true, ...(name.trim() ? { userName: name.trim() } : {}) })
    onDone()
  }
  const startInstall = async (): Promise<void> => {
    setPlanned(await invoke<Plan>('setup:plan', wishes))
    go('install')
  }

  const isBlocked = !!report && blocked(report.problems)
  let primary: { label: string; onClick: () => void; disabled?: boolean; quiet?: boolean } = { label: t('wiz.next'), onClick: next }
  if (step === 'welcome') primary = { label: t('wiz.begin'), onClick: next }
  if (step === 'check') primary = { label: t('wiz.next'), onClick: next, disabled: !report || checking || isBlocked }
  if (step === 'ask') primary = { label: t('wiz.install'), onClick: () => void startInstall(), disabled: !plan || isBlocked }
  if (step === 'done') primary = { label: t('wiz.start'), onClick: finish }
  // The move button is the way forward; going on from the download folder stays possible, quietly.
  if (step === 'check' && report?.misplaced && !isBlocked) primary = { label: t('wiz.continueAnyway'), onClick: next, quiet: true }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-8 pb-10">
        <div className="w-full max-w-[600px]">
          <div className="mb-8 flex justify-center gap-1.5">
            {steps.map((s, i) => (
              <span key={s} className={cn('h-1.5 rounded-full transition-all duration-300', i === index ? 'w-6 bg-ink' : i < index ? 'w-1.5 bg-ink-2' : 'w-1.5 bg-line-strong')} />
            ))}
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={step} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
              {step === 'welcome' && <Welcome />}
              {step === 'check' && <CheckStep report={report} checking={checking} onCheck={() => void check()} />}
              {step === 'ask' && report && plan && <AskStep report={report} wishes={wishes} setWishes={setWishes} plan={plan} />}
              {step === 'install' && app && (
                <div>
                  <Title>{t('wiz.installTitle')}</Title>
                  <Body>{t('wiz.installBody')}</Body>
                  <div className="mt-6">
                    <SetupProgress setup={app.setup} />
                  </div>
                </div>
              )}
              {step === 'permissions' && (
                <div>
                  <Title>{t('wiz.permTitle')}</Title>
                  <Body>{mac ? t('wiz.permBodyMac') : t('wiz.permBodyWin')}</Body>
                  <div className="mt-6">
                    <PermissionList />
                  </div>
                  {app?.settings.hotkey === 'fn' && (
                    <div className="mt-4 flex items-start gap-3 rounded-xl bg-accent-soft p-3.5 text-[12.5px] leading-relaxed text-ink">
                      <Kbd>🌐</Kbd>
                      <span>{t('onb.fnTip')}</span>
                    </div>
                  )}
                </div>
              )}
              {step === 'calendar' && <CalendarStep mac={mac} />}
              {step === 'voice' && (
                <div>
                  <Title>{t('wiz.voiceTitle')}</Title>
                  <label className="mt-6 block text-[12.5px] font-medium text-ink-2">{t('set.name')}</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('set.namePlaceholder')}
                    className="mt-1.5 h-10 w-full rounded-[10px] border border-line-strong bg-panel px-3 text-[14px] outline-none focus:border-accent/50"
                  />
                  <div className="mt-1.5 text-[12px] text-ink-3">{t('wiz.nameHint')}</div>
                  <div className="mt-6 rounded-2xl border border-line bg-panel p-4 shadow-card">
                    {app?.engine.state === 'ready' ? (
                      <VoiceEnroll />
                    ) : (
                      <div className="flex items-center gap-2 text-[13px] text-ink-2">
                        <Spinner /> {app?.setup.running ? t('wiz.healthWaiting') : t('onb.engineLoading')}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {step === 'claude' && <ClaudeStep mac={mac} />}
              {step === 'health' && app && (
                <div>
                  <Title>{t('wiz.healthTitle')}</Title>
                  <Body>{t('wiz.healthBody')}</Body>
                  <div className="mt-6">
                    <HealthPanel auto onPermissions={() => go('permissions')} />
                  </div>
                </div>
              )}
              {step === 'done' && (
                <div className="text-center">
                  <div className="mx-auto mb-6 grid size-16 place-items-center rounded-full bg-ok-soft text-ok">
                    <Check size={30} />
                  </div>
                  <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{t('wiz.doneTitle')}</h1>
                  <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-ink-2">
                    {!wishes.uses.includes('calls') && !wishes.uses.includes('inperson') ? t('wiz.doneBodyDictation') : mac ? t('wiz.doneBodyMac') : t('wiz.doneBodyWin')}
                  </p>
                  {wishes.uses.includes('dictation') && (
                    <div className="mx-auto mt-7 flex w-fit items-center gap-3 rounded-2xl border border-line bg-panel px-5 py-4 shadow-card">
                      <Kbd>{t(`wiz.key_${app?.settings.hotkey ?? 'fn'}`)}</Kbd>
                      <span className="text-[13.5px]">{t('wiz.tryIt')}</span>
                      <Mic size={16} className="text-accent" />
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          <div className="mt-10 flex items-center justify-between">
            {index > 0 && step !== 'done' ? (
              <Button variant="ghost" onClick={back}>{t('wiz.back')}</Button>
            ) : (
              <span />
            )}
            <Button variant={primary.quiet ? 'ghost' : 'primary'} size="lg" onClick={primary.onClick} disabled={primary.disabled}>
              {primary.label} {step !== 'done' && <Next size={16} />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Title({ children }: { children: ReactNode }) {
  return <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{children}</h1>
}

function Body({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{children}</p>
}

function Welcome() {
  const { t } = useTranslation()
  return (
    <div className="text-center">
      <div className="mx-auto mb-6 grid size-20 place-items-center rounded-[22px] bg-gradient-to-br from-[#33305a] to-[#16161f] text-white shadow-xl">
        <AudioLines size={38} />
      </div>
      <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{t('wiz.welcomeTitle')}</h1>
      <p className="mx-auto mt-3 max-w-lg text-[14px] leading-relaxed text-ink-2">{t('wiz.welcomeBody')}</p>
      <div className="mt-8 grid grid-cols-3 gap-3 text-start">
        {USES.map(({ use, icon }) => (
          <div key={use} className="rounded-2xl border border-line bg-panel p-4 shadow-card">
            <div className="mb-3 grid size-9 place-items-center rounded-xl bg-accent-soft text-accent">{icon}</div>
            <div className="text-[13.5px] font-semibold">{t(`wiz.use_${use}`)}</div>
            <div className="mt-1 text-[12px] leading-snug text-ink-2">{t(`wiz.use_${use}Body`)}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 text-[12px] text-ink-3">{t('onb.private')} · {t('wiz.welcomeTime')}</div>
    </div>
  )
}

function ProblemLine({ p }: { p: Problem }) {
  const { t } = useTranslation()
  const block = p.severity === 'block'
  return (
    <div className={cn('flex items-start gap-2.5 rounded-xl p-3.5 text-[12.5px] leading-relaxed text-ink', block ? 'bg-rec-soft' : 'bg-warn/10')}>
      <AlertTriangle size={16} className={cn('mt-0.5 shrink-0', block ? 'text-rec' : 'text-warn')} />
      <span>{t(`wiz.problem_${p.id}`, p.values ?? {})}</span>
    </div>
  )
}

function CheckStep({ report, checking, onCheck }: { report: PreflightReport | null; checking: boolean; onCheck: () => void }) {
  const { t } = useTranslation()
  const [moveFailed, setMoveFailed] = useState(false)
  if (!report) {
    return (
      <div>
        <Title>{t('wiz.checkTitle')}</Title>
        {checking ? (
          <div className="mt-6 flex items-center gap-2.5 text-[13.5px] text-ink-2">
            <Spinner /> {t('wiz.checking')}
          </div>
        ) : (
          <Button className="mt-6" icon={<RefreshCw size={14} />} onClick={onCheck}>{t('wiz.checkAgain')}</Button>
        )}
      </div>
    )
  }
  const m = report.machine
  const isBlocked = blocked(report.problems)
  const tier = tierOf(m)
  const move = async (): Promise<void> => {
    const ok = await invoke<boolean>('app:moveToApplications').catch(() => false)
    if (!ok) setMoveFailed(true) // on success the app quits and reopens from Applications
  }
  return (
    <div>
      <Title>{t('wiz.checkTitle')}</Title>
      <Card className="mt-6 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">{m.model || (m.platform === 'win32' ? 'Windows PC' : 'Mac')}</div>
            <div dir="ltr" className="mt-0.5 truncate text-start text-[12px] text-ink-3">
              {m.chip} · {m.platform === 'darwin' ? 'macOS' : 'Windows'} {m.osVersion}
            </div>
          </div>
          {!isBlocked && (
            <span className={cn('shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-semibold', tier === 'light' ? 'bg-warn/15 text-warn' : 'bg-ok-soft text-ok')}>
              {t(`wiz.tier_${tier}`)}
            </span>
          )}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-[12.5px] text-ink-2">
          <Fact icon={<Cpu size={14} />}>{t('wiz.cores', { n: m.cores })}</Fact>
          <Fact icon={<MemoryStick size={14} />}>{t('wiz.memory', { gb: m.ramGB })}</Fact>
          <Fact icon={<HardDrive size={14} />}>{m.freeGB >= 0 ? t('wiz.free', { gb: Math.round(m.freeGB) }) : '—'}</Fact>
        </div>
        {!isBlocked && <div className="mt-3 text-[12.5px] leading-relaxed text-ink-2">{t(`wiz.tierBody_${tier}`)}</div>}
      </Card>

      <div className="mt-4 space-y-2.5">
        {isBlocked && <div className="text-[14px] font-semibold text-rec">{t('wiz.blockedTitle')}</div>}
        {report.problems.map((p) => (
          <ProblemLine key={p.id} p={p} />
        ))}
        {report.misplaced && (
          <div className="rounded-xl border border-accent/30 bg-accent-soft p-4">
            <div className="flex items-center gap-2 text-[13.5px] font-semibold">
              <FolderInput size={16} className="text-accent" /> {t('wiz.moveTitle')}
            </div>
            <div className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{moveFailed ? t('wiz.moveFailed') : t('wiz.moveBody')}</div>
            <Button className="mt-3" variant="primary" onClick={() => void move()}>{t('wiz.moveButton')}</Button>
          </div>
        )}
        {!isBlocked && (
          <div className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-2">
            {report.internet.ok ? <Wifi size={15} className="mt-0.5 shrink-0 text-ok" /> : <WifiOff size={15} className="mt-0.5 shrink-0 text-warn" />}
            <span>{report.internet.ok ? t('wiz.internetOk') : t('wiz.internetBad', { servers: report.internet.unreachable.join(', ') })}</span>
          </div>
        )}
        {!isBlocked && (report.installed.engine || report.installed.models.length > 0) && (
          <div className="flex items-start gap-2.5 text-[12.5px] text-ink-2">
            <Check size={15} className="mt-0.5 shrink-0 text-ok" /> {t('wiz.alreadyInstalled')}
          </div>
        )}
        {!isBlocked && report.problems.length === 0 && !report.misplaced && (
          <div className="flex items-center gap-2 text-[13px] font-medium text-ok">
            <Check size={15} /> {t('wiz.allGood')}
          </div>
        )}
      </div>
      {(isBlocked || !report.internet.ok) && (
        <Button className="mt-4" icon={checking ? <Spinner /> : <RefreshCw size={14} />} disabled={checking} onClick={onCheck}>
          {t('wiz.checkAgain')}
        </Button>
      )}
    </div>
  )
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-panel-2 px-2.5 py-2">
      <span className="text-ink-3">{icon}</span>
      <span className="truncate">{children}</span>
    </div>
  )
}

function AskStep({ report, wishes, setWishes, plan }: { report: PreflightReport; wishes: Wishes; setWishes: (w: Wishes) => void; plan: Plan }) {
  const { t } = useTranslation()
  const mac = report.machine.platform === 'darwin'
  const toggleUse = (u: Use): void => {
    const uses = wishes.uses.includes(u) ? wishes.uses.filter((x) => x !== u) : [...wishes.uses, u]
    if (uses.length) setWishes({ ...wishes, uses })
  }
  return (
    <div>
      <Title>{t('wiz.askTitle')}</Title>
      <Body>{t('wiz.askBody')}</Body>

      <div className="mt-6 text-[13.5px] font-semibold">{t('wiz.usesQ')}</div>
      <div className="mt-2 grid grid-cols-3 gap-2.5">
        {USES.map(({ use, icon }) => {
          const on = wishes.uses.includes(use)
          return (
            <button
              key={use}
              onClick={() => toggleUse(use)}
              aria-pressed={on}
              className={cn('relative rounded-2xl border p-3.5 text-start transition-colors', on ? 'border-accent bg-accent-soft' : 'border-line bg-panel hover:bg-panel-2')}
            >
              <span className={cn('absolute end-3 top-3 grid size-4 place-items-center rounded-[5px] border', on ? 'border-accent bg-accent text-white' : 'border-line-strong')}>
                {on && <Check size={11} strokeWidth={3} />}
              </span>
              <span className={cn('mb-2 grid size-8 place-items-center rounded-xl', on ? 'bg-panel text-accent' : 'bg-panel-2 text-ink-2')}>{icon}</span>
              <span className="block text-[13px] font-semibold">{t(`wiz.use_${use}`)}</span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-2">{t(`wiz.use_${use}Body`)}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold">
          <Languages size={16} className="text-ink-3" /> {t('wiz.langQ')}
        </div>
        {mac && (
          <Segmented
            value={wishes.language}
            onChange={(v) => setWishes({ ...wishes, language: v as Wishes['language'] })}
            options={[
              { value: 'he', label: t('wiz.lang_he') },
              { value: 'auto', label: t('wiz.lang_auto') }
            ]}
          />
        )}
      </div>
      <div className="mt-1.5 text-[12px] leading-snug text-ink-2">{mac ? t(`wiz.lang_${wishes.language}Body`) : t('wiz.langWindows')}</div>
      {mac && wishes.language === 'auto' && plan.tier === 'strong' && (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-line bg-panel px-3.5 py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{t('wiz.accurate')}</div>
            <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{t('wiz.accurateBody')}</div>
          </div>
          <Toggle checked={!!wishes.accurate} onChange={(v) => setWishes({ ...wishes, accurate: v })} />
        </div>
      )}

      <Card className="mt-6 divide-y divide-line">
        <div className="px-4 py-3 text-[12.5px] font-semibold text-ink-2">{t('wiz.planTitle')} · {t(`wiz.tier_${plan.tier}`)}</div>
        <PlanRow label={t('wiz.planModel')}>
          <span dir="ltr">{modelName(plan.asr)}</span>
        </PlanRow>
        <PlanRow label={t('wiz.planSpeakers')}>
          {plan.speakers ? t('wiz.planSpeakersOn') : wishes.uses.includes('calls') ? t('wiz.planSpeakersOff') : t('wiz.planSpeakersUnused')}
        </PlanRow>
        <PlanRow label={t('wiz.planSize')}>
          <span className="flex items-center gap-1.5">
            <Download size={13} className="text-ink-3" /> {t('wiz.planSizeValue', { gb: plan.downloadGB })}
          </span>
        </PlanRow>
      </Card>
    </div>
  )
}

function PlanRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13px]">
      <span className="text-ink-2">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  )
}

/**
 * The calendar gives every recording its meeting's name and people. On a Mac: the Mac's own Calendar
 * app (which shows Google, Outlook and iCloud accounts added in System Settings), or Google Calendar
 * directly through its secret iCal link. On Windows only the Google link exists.
 */
function CalendarStep({ mac }: { mac: boolean }) {
  const { t } = useTranslation()
  const app = useAppState()
  const macCalendar = app?.permissions?.calendar === 'granted'
  const allow = async (): Promise<void> => {
    const r = await invoke<string>('permissions:request', 'calendar').catch(() => 'denied')
    if (r === 'denied') void invoke('permissions:open', 'Privacy_Calendars')
  }
  return (
    <div>
      <div className="mb-5 grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">
        <CalendarDays size={22} />
      </div>
      <Title>{t('wiz.calTitle')}</Title>
      <Body>{t('wiz.calBody')}</Body>
      {mac && (
        <Card className="mt-6 px-4 py-3.5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold">{t('wiz.calMac')}</div>
              <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{t('wiz.calMacBody')}</div>
            </div>
            {macCalendar ? (
              <Ok>{t('wiz.claudeConnected')}</Ok>
            ) : (
              <Button size="sm" variant="primary" onClick={() => void allow()}>{t('common.allow')}</Button>
            )}
          </div>
          {macCalendar && (
            <Button className="mt-3" size="sm" variant="ghost" onClick={() => void invoke('calendar:openAccounts')}>{t('wiz.calAccounts')}</Button>
          )}
        </Card>
      )}
      <div className="mt-5 text-[13.5px] font-semibold">{mac ? t('wiz.calGoogleOr') : t('wiz.calGoogle')}</div>
      <Card className="mt-2">
        <GoogleCalendarSection />
      </Card>
      <div className="mt-3 text-[12px] text-ink-3">{t('wiz.calLater')}</div>
    </div>
  )
}

/** Connects Claude by itself as soon as the step shows; the user only sees the result. */
function ClaudeStep({ mac }: { mac: boolean }) {
  const { t } = useTranslation()
  const app = useAppState()
  const [state, setState] = useState<ClaudeAuto | null>(null)
  const [working, setWorking] = useState(false)
  const [restarted, setRestarted] = useState<boolean | null>(null)
  const optedOut = app?.settings.claudeConnected === false
  const started = useRef(false)

  const connect = async (): Promise<void> => {
    setWorking(true)
    try {
      setState(await invoke<ClaudeAuto>('claude:auto'))
    } finally {
      setWorking(false)
    }
  }
  useEffect(() => {
    if (started.current || optedOut) return
    started.current = true
    void connect()
  }, [])

  const optOut = async (): Promise<void> => {
    await invoke('claude:disconnect')
    setState(null)
  }
  const restart = async (): Promise<void> => {
    setWorking(true)
    try {
      setRestarted(await invoke<boolean>('claude:restart'))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div>
      <div className="mb-5 grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">
        <Sparkles size={22} />
      </div>
      <Title>{t('wiz.claudeTitle')}</Title>
      <Body>{t('wiz.claudeBody')}</Body>
      <div className="mt-4 rounded-xl bg-panel-2 p-4 text-[13px] leading-relaxed text-ink-2">
        <div dir="auto">“{t('wiz.claudeEx1')}”</div>
        <div dir="auto" className="mt-1.5">“{t('wiz.claudeEx2')}”</div>
      </div>

      {optedOut ? (
        <div className="mt-6 flex items-center gap-3 text-[13px] text-ink-2">
          {t('wiz.claudeOptedOut')}
          <Button size="sm" onClick={() => void connect()}>{t('wiz.claudeOptIn')}</Button>
        </div>
      ) : !state ? (
        <div className="mt-6 flex items-center gap-2 text-[13px] text-ink-2">
          <Spinner /> {t('wiz.claudeWorking')}
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          <Card className="divide-y divide-line">
            <PlanRow label={t('wiz.claudeDesktop')}>
              {state.desktop && state.desktopInstalled ? (
                <Ok>{t('wiz.claudeConnected')}</Ok>
              ) : !state.desktopInstalled ? (
                <Button size="sm" icon={<Download size={13} />} onClick={() => void invoke('app:openExternal', 'https://claude.ai/download')}>
                  {t('wiz.claudeDownload')}
                </Button>
              ) : (
                <span className="text-rec">✕</span>
              )}
            </PlanRow>
            <PlanRow label={t('wiz.claudeCode')}>{state.code ? <Ok>{t('wiz.claudeConnected')}</Ok> : <span className="text-ink-3">{t('wiz.claudeCodeMissing')}</span>}</PlanRow>
            {state.skills > 0 && (
              <PlanRow label={t('wiz.claudeSkills')}>
                <Ok>{state.skills}</Ok>
              </PlanRow>
            )}
          </Card>
          {!state.desktopInstalled && <div className="text-[12px] leading-relaxed text-ink-2">{t('wiz.claudeDownloadHint')}</div>}
          {state.desktop && state.desktopRunning && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-accent-soft p-3.5 text-[12.5px] leading-relaxed text-ink">
              {restarted ? (
                <Ok>{t('wiz.claudeRestarted')}</Ok>
              ) : restarted === false ? (
                <span>{mac ? t('wiz.claudeRestartMacManual') : t('wiz.claudeRestartWin')}</span>
              ) : (
                <>
                  <span className="flex-1">{t('wiz.claudeRestartMac')}</span>
                  <Button size="sm" variant="primary" disabled={working} onClick={() => void restart()}>{t('wiz.claudeRestartButton')}</Button>
                </>
              )}
            </div>
          )}
          {state.error && (
            <div className="flex items-start gap-2.5 rounded-xl bg-rec-soft p-3.5 text-[12.5px] leading-relaxed">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rec" />
              <div className="min-w-0 flex-1">
                <div dir="ltr" className="selectable break-words text-start text-[11.5px] text-ink-3">{t('wiz.claudeFailed', { error: state.error })}</div>
                <Button className="mt-2" size="sm" disabled={working} icon={<RefreshCw size={13} />} onClick={() => void connect()}>{t('wiz.claudeTry')}</Button>
              </div>
            </div>
          )}
          <button className="text-[12px] text-ink-3 underline-offset-2 hover:underline" onClick={() => void optOut()}>
            {t('wiz.claudeOptOut')}
          </button>
        </div>
      )}
    </div>
  )
}

function Ok({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 font-medium text-ok">
      <Check size={14} /> {children}
    </span>
  )
}
