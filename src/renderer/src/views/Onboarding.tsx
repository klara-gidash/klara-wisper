import { ArrowLeft, ArrowRight, AudioLines, Check, Keyboard, Mic, Sparkles, Users, Video } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PermissionList } from '../components/Permissions'
import { SetupProgress } from '../components/SetupProgress'
import { Button, Kbd, Spinner } from '../components/ui'
import { VoiceEnroll } from '../components/VoiceEnroll'
import { invoke, setSettings, useAppState } from '../lib/api'

const ALL_STEPS = ['welcome', 'setup', 'permissions', 'voice', 'claude', 'done'] as const

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const app = useAppState()
  const [step, setStep] = useState(0)
  const [name, setName] = useState(app?.settings.userName ?? '')
  const [claudeDone, setClaudeDone] = useState(false)
  // The install step only shows on a computer that still needs the engine or the models.
  const needsSetup = useRef<boolean | null>(null)
  if (needsSetup.current === null && app) needsSetup.current = app.setup.needed || app.setup.running
  const STEPS = ALL_STEPS.filter((s) => s !== 'setup' || needsSetup.current)
  const id = STEPS[step]
  const setupBlocking = id === 'setup' && !!app && app.setup.needed && !app.setup.running
  const rtl = i18n.language === 'he'
  const Next = rtl ? ArrowLeft : ArrowRight

  const next = (): void => {
    if (id === 'voice' && name.trim()) void setSettings({ userName: name.trim() })
    if (step < STEPS.length - 1) setStep(step + 1)
  }
  const finish = (): void => {
    void setSettings({ onboarded: true, ...(name.trim() ? { userName: name.trim() } : {}) })
    onDone()
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-8 pb-10">
        <div className="w-full max-w-[560px]">
          <div className="mb-8 flex justify-center gap-1.5">
            {STEPS.map((s, i) => (
              <span key={s} className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? 'w-6 bg-ink' : i < step ? 'w-1.5 bg-ink-2' : 'w-1.5 bg-line-strong'}`} />
            ))}
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
              {id === 'welcome' && (
                <div className="text-center">
                  <div className="mx-auto mb-6 grid size-20 place-items-center rounded-[22px] bg-gradient-to-br from-[#33305a] to-[#16161f] text-white shadow-xl">
                    <AudioLines size={38} />
                  </div>
                  <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{t('onb.welcome')}</h1>
                  <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-ink-2">{t('onb.welcomeBody')}</p>
                  <div className="mt-8 grid grid-cols-3 gap-3 text-start">
                    {[
                      { icon: <Keyboard size={18} />, title: t('onb.f1'), body: t('onb.f1b') },
                      { icon: <Video size={18} />, title: t('onb.f2'), body: t('onb.f2b') },
                      { icon: <Users size={18} />, title: t('onb.f3'), body: t('onb.f3b') }
                    ].map((f) => (
                      <div key={f.title} className="rounded-2xl border border-line bg-panel p-4 shadow-card">
                        <div className="mb-3 grid size-9 place-items-center rounded-xl bg-accent-soft text-accent">{f.icon}</div>
                        <div className="text-[13.5px] font-semibold">{f.title}</div>
                        <div className="mt-1 text-[12px] leading-snug text-ink-2">{f.body}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-6 text-[12px] text-ink-3">{t('onb.private')}</div>
                </div>
              )}
              {id === 'setup' && app && (
                <div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{t('onb.setupTitle')}</h1>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{t('onb.setupBody')}</p>
                  <div className="mt-6">
                    <SetupProgress setup={app.setup} />
                  </div>
                </div>
              )}
              {id === 'permissions' && (
                <div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{t('onb.permTitle')}</h1>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{t('onb.permBody')}</p>
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
              {id === 'voice' && (
                <div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{t('onb.voiceTitle')}</h1>
                  <label className="mt-6 block text-[12.5px] font-medium text-ink-2">{t('set.name')}</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('set.namePlaceholder')}
                    className="mt-1.5 h-10 w-full rounded-[10px] border border-line-strong bg-panel px-3 text-[14px] outline-none focus:border-accent/50"
                  />
                  <div className="mt-6 rounded-2xl border border-line bg-panel p-4 shadow-card">
                    {app?.engine.state === 'ready' ? (
                      <VoiceEnroll />
                    ) : (
                      <div className="flex items-center gap-2 text-[13px] text-ink-2">
                        <Spinner /> {t('onb.engineLoading')}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {id === 'claude' && (
                <div>
                  <div className="mb-5 grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">
                    <Sparkles size={22} />
                  </div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{t('onb.claudeTitle')}</h1>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{t('onb.claudeBody')}</p>
                  <div className="mt-5 rounded-xl bg-panel-2 p-4 text-[13px] leading-relaxed text-ink-2">
                    <div dir="auto">“{t('onb.claudeEx1')}”</div>
                    <div dir="auto" className="mt-1.5">“{t('onb.claudeEx2')}”</div>
                  </div>
                  <div className="mt-6 flex items-center gap-3">
                    {claudeDone ? (
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-ok"><Check size={15} /> {t('onb.claudeConnected')}</span>
                    ) : (
                      <Button
                        variant="primary"
                        onClick={() =>
                          void invoke<{ desktop: boolean }>('claude:connect', 'desktop').then((s) => setClaudeDone(s.desktop), () => undefined)
                        }
                      >
                        {t('onb.connectClaude')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {id === 'done' && (
                <div className="text-center">
                  <div className="mx-auto mb-6 grid size-16 place-items-center rounded-full bg-ok-soft text-ok">
                    <Check size={30} />
                  </div>
                  <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{t('onb.doneTitle')}</h1>
                  <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-ink-2">{t('onb.doneBody')}</p>
                  <div className="mx-auto mt-7 flex w-fit items-center gap-3 rounded-2xl border border-line bg-panel px-5 py-4 shadow-card">
                    <Kbd>fn</Kbd>
                    <span className="text-[13.5px]">{t('onb.tryIt')}</span>
                    <Mic size={16} className="text-accent" />
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          <div className="mt-10 flex items-center justify-between">
            {step > 0 && step < STEPS.length - 1 ? (
              <Button variant="ghost" onClick={() => setStep(step - 1)}>{t('onb.back')}</Button>
            ) : (
              <span />
            )}
            {id === 'done' ? (
              <Button variant="primary" size="lg" onClick={finish}>{t('onb.start')}</Button>
            ) : (
              <Button variant="primary" size="lg" onClick={next} disabled={setupBlocking}>
                {id === 'claude' && !claudeDone ? t('onb.skip') : t('onb.next')} <Next size={16} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
