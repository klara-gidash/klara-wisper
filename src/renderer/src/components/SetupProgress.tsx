import { AlertTriangle, Check, Download, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SetupState } from '@shared/types'
import { invoke } from '../lib/api'
import { Button, Spinner } from './ui'

const gb = (bytes: number): string => (bytes / 1e9).toFixed(bytes >= 1e9 ? 1 : 2)

function Bar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-strong" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  )
}

/** Installs the engine and the models on first launch, with a progress bar for each part. */
export function SetupProgress({ setup }: { setup: SetupState }) {
  const { t } = useTranslation()
  const engineDone = !setup.engineMissing || setup.phase === 'models' || setup.phase === 'done'
  const enginePhase = setup.phase === 'python' || setup.phase === 'packages'
  const finished = !setup.needed && !setup.running
  const start = (): void => void invoke('setup:run')

  return (
    <div className="space-y-4">
      {/* the engine (Python + packages) */}
      <div className="rounded-2xl border border-line bg-panel p-4 shadow-card">
        <div className="mb-2 flex items-center justify-between text-[13px]">
          <span className="font-medium">{t('onb.setupEngine')}</span>
          <span className="text-[12px] text-ink-3">
            {engineDone ? <Check size={15} className="text-ok" /> : enginePhase ? `${Math.round(setup.progress * 100)}%` : '≈ 0.3 GB'}
          </span>
        </div>
        {enginePhase && <Bar value={setup.progress} />}
        {enginePhase && (
          <div className="mt-1.5 text-[11.5px] text-ink-3">{setup.phase === 'python' ? t('onb.setupPython') : t('onb.setupPackages', { detail: setup.detail ?? '' })}</div>
        )}
      </div>

      {/* the models */}
      <div className="rounded-2xl border border-line bg-panel p-4 shadow-card">
        <div className="mb-2 flex items-center justify-between text-[13px]">
          <span className="font-medium">{t('onb.setupModels')}</span>
          <span className="text-[12px] text-ink-3">
            {finished || (setup.modelsMissing?.length === 0 && !setup.running) ? <Check size={15} className="text-ok" /> : setup.phase === 'models' ? `${Math.round(setup.progress * 100)}%` : '≈ 2.1 GB'}
          </span>
        </div>
        {setup.phase === 'models' && <Bar value={setup.progress} />}
        {setup.phase === 'models' && setup.models && (
          <ul className="mt-3 space-y-1.5 text-[12px] text-ink-2">
            {setup.models.map((m) => (
              <li key={m.key} className="flex items-center justify-between gap-3">
                <span dir="ltr" className="truncate">{m.title}</span>
                <span dir="ltr" className="shrink-0 tabular-nums text-ink-3">
                  {m.state === 'done' ? (
                    <Check size={13} className="text-ok" />
                  ) : m.state === 'verifying' ? (
                    t('onb.setupVerifying')
                  ) : (
                    `${gb(m.done)} / ${gb(m.bytes)} GB`
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {setup.phase === 'error' && (
        <div className="flex items-start gap-2.5 rounded-xl bg-rec-soft p-3.5 text-[12.5px] leading-relaxed text-ink">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rec" />
          <div className="min-w-0">
            <div className="font-medium">{t('onb.setupFailed')}</div>
            <div dir="ltr" className="selectable mt-1 break-words text-[11.5px] text-ink-3">{setup.error}</div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        {finished ? (
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ok"><Check size={15} /> {t('onb.setupDone')}</span>
        ) : setup.running ? (
          <span className="flex items-center gap-2 text-[12.5px] text-ink-2"><Spinner /> {t('onb.setupBackground')}</span>
        ) : setup.phase === 'error' ? (
          <Button variant="primary" icon={<RefreshCw size={14} />} onClick={start}>{t('onb.setupRetry')}</Button>
        ) : (
          <Button variant="primary" icon={<Download size={14} />} onClick={start}>{t('onb.setupStart')}</Button>
        )}
      </div>
    </div>
  )
}
