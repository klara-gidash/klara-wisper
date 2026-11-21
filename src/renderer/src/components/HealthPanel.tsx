import { AlertTriangle, Check, CircleSlash, ClipboardCopy, RefreshCw, Wrench, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppState, HealthItem, HealthReport } from '@shared/types'
import { healthFix } from '@shared/plan'
import { invoke, useAppState, useEvent } from '../lib/api'
import { SetupProgress } from './SetupProgress'
import { Button, Card, cn, Spinner } from './ui'

const VC_REDIST = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

/** A failure the app can fix by itself: rebuilding the engine, or re-running the install (models). */
export function repairable(report: HealthReport | null | undefined): boolean {
  return healthFix(report?.items) !== null
}

/** The fix for the report: a broken engine is rebuilt; only a model or slow transcription is retried (the engine stays). */
export function fixAction(report: HealthReport | null | undefined): 'setup:repair' | 'setup:retry' | null {
  const fix = healthFix(report?.items)
  return fix === 'repair' ? 'setup:repair' : fix === 'retry' ? 'setup:retry' : null
}

function Icon({ status }: { status: HealthItem['status'] }) {
  if (status === 'running') return <Spinner className="size-3.5 text-ink-3" />
  if (status === 'ok') return <Check size={15} className="text-ok" />
  if (status === 'warn') return <AlertTriangle size={14} className="text-warn" />
  if (status === 'fail') return <X size={15} className="text-rec" />
  return <CircleSlash size={13} className="text-ink-3" />
}

/**
 * The health check, live: each line turns green, orange or red as it is checked. `auto` starts it
 * by itself (once the install is finished). Failed lines say what to do; "repair" rebuilds the engine.
 */
export function HealthPanel({
  auto = false,
  onPermissions,
  onVoice,
  onReport
}: {
  auto?: boolean
  onPermissions?: () => void
  onVoice?: () => void
  /** The latest result (null while a check or a repair runs). */
  onReport?: (r: HealthReport | null) => void
}) {
  const { t } = useTranslation()
  const app = useAppState()
  // Windows words where they differ (Windows Settings, the Recycle Bin): an `…Win` key wins when there is one.
  const win = app?.platform === 'win32'
  const tw = (key: string, opts?: Record<string, unknown>): string => t(win ? [`${key}Win`, key] : key, opts)
  const [items, setItems] = useState<HealthItem[] | null>(null)
  const [report, setReport] = useState<HealthReport | null>(null)
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  /** Run the check as soon as nothing is installing (at the start with `auto`, and after a repair). */
  const want = useRef(auto)
  useEvent<HealthItem[]>('health', (list) => setItems(list))

  const installing = !!app?.setup.running
  const phase = app?.setup.phase
  useEffect(() => onReport?.(running || installing ? null : report), [report, running, installing])
  const run = async (): Promise<void> => {
    setRunning(true)
    setCopied(false)
    try {
      const r = await invoke<HealthReport>('health:run')
      setReport(r)
      setItems(r.items)
    } finally {
      setRunning(false)
    }
  }
  const runIfWanted = (): void => {
    if (!want.current) return
    want.current = false
    void run()
  }
  // Start by itself when the install is done, and in the wizard again after every (re)install.
  const wasInstalling = useRef(installing)
  useEffect(() => {
    if (auto && wasInstalling.current && !installing) want.current = true
    wasInstalling.current = installing
    if (!installing) runIfWanted()
  }, [installing, phase])

  const repair = async (): Promise<void> => {
    const action = fixAction(report) ?? 'setup:retry'
    want.current = true // check again once the repair has installed everything
    setReport(null)
    setItems(null)
    await invoke(action).catch(() => undefined)
    // A repair that stopped at once (e.g. a file it could not delete) never shows as installing.
    setTimeout(() => void invoke<AppState>('state').then((s) => !s.setup.running && runIfWanted()), 1000)
  }
  const copy = async (): Promise<void> => {
    await invoke('health:copy')
    setCopied(true)
  }

  if (installing && !items && app) {
    // Still installing: show the downloads (with their retries), the check starts when they're done.
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <Spinner /> {t('wiz.healthWaiting')}
        </div>
        <SetupProgress setup={app.setup} bare />
      </div>
    )
  }

  const failed = report && !report.ok
  const warned = report?.ok && report.items.some((i) => i.status === 'warn')
  const needsRepair = repairable(report)

  return (
    <div className="space-y-4">
      {report && (
        <div className={cn('flex items-center gap-2 text-[15px] font-semibold', failed ? 'text-rec' : warned ? 'text-warn' : 'text-ok')}>
          {failed ? <X size={18} /> : warned ? <AlertTriangle size={17} /> : <Check size={18} />}
          {failed ? t('wiz.healthFail') : warned ? t('wiz.healthWarn') : t('wiz.healthAllOk')}
        </div>
      )}
      {items && (
        <Card className="divide-y divide-line">
          {items.map((i) => (
            <div key={i.id} className="flex items-start gap-3 px-4 py-2.5">
              <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
                <Icon status={i.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="font-medium">{t(`health.${i.id}`)}</span>
                  {i.status === 'ok' && i.detail && <span dir="ltr" className="truncate text-[12px] text-ink-3">{i.detail}</span>}
                </div>
                {i.code && i.status !== 'ok' && (
                  <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{tw(`health.${i.id}_${i.code}`, { defaultValue: t('health.error') })}</div>
                )}
                {i.detail && i.status !== 'ok' && i.status !== 'running' && (
                  <div dir="ltr" className="selectable mt-0.5 break-words text-start text-[11px] text-ink-3">{i.detail}</div>
                )}
                {i.status === 'fail' && i.id === 'engine' && i.code === 'vcRuntime' && (
                  <Button className="mt-2" size="sm" onClick={() => void invoke('app:openExternal', VC_REDIST)}>{t('health.fixVc')}</Button>
                )}
                {i.status === 'fail' && i.id === 'app' && i.code === 'misplaced' && (
                  <Button className="mt-2" size="sm" onClick={() => void invoke('app:moveToApplications')}>{t('health.fixMove')}</Button>
                )}
                {onVoice && i.id === 'speakers' && i.code === 'notEnrolled' && (
                  <Button className="mt-2" size="sm" onClick={onVoice}>{t('health.fixVoice')}</Button>
                )}
                {onPermissions && (i.status === 'fail' || i.status === 'warn') && (i.id === 'microphone' || i.id === 'permissions') && (
                  <Button className="mt-2" size="sm" onClick={onPermissions}>{t('health.fixPermissions')}</Button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
      {failed && <div className="text-[12.5px] leading-relaxed text-ink-2">{t('wiz.healthFailBody')}</div>}
      {phase === 'error' && app?.setup.error && (
        <div className="rounded-xl bg-rec-soft p-3 text-[12px] leading-relaxed">
          <div className="font-medium">{t(`setupx.errorTitle_${app.setup.errorKind ?? 'unknown'}`)}</div>
          <div className="mt-0.5 text-ink-2">{tw(`setupx.errorBody_${app.setup.errorKind ?? 'unknown'}`)}</div>
          <div dir="ltr" className="selectable mt-1 break-words text-start text-[11px] text-ink-3">{app.setup.error}</div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {needsRepair && (
          <Button variant="primary" icon={fixAction(report) === 'setup:retry' ? <RefreshCw size={14} /> : <Wrench size={14} />} disabled={running || installing} onClick={() => void repair()}>
            {fixAction(report) === 'setup:retry' ? t('onb.setupRetry') : t('wiz.healthRepair')}
          </Button>
        )}
        <Button icon={running ? <Spinner /> : <RefreshCw size={14} />} disabled={running || installing} onClick={() => void run()}>
          {t('wiz.healthRun')}
        </Button>
        {report && (
          <Button variant="ghost" icon={<ClipboardCopy size={14} />} onClick={() => void copy()}>
            {t('wiz.healthCopy')}
          </Button>
        )}
      </div>
      {copied && <div className="text-[12px] text-ok">{t('wiz.healthCopied')}</div>}
    </div>
  )
}
