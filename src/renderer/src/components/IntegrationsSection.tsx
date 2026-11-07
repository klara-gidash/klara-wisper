import { FolderOpen } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Settings } from '@shared/types'
import { Button, cn, Segmented, Spinner, Toggle } from './ui'
import { invoke, setSettings, useAppState } from '../lib/api'

interface ObsidianState {
  enabled: boolean
  vault: string
  looksLikeVault: boolean
  lastError?: string
}

/** Same look as the rows in Settings. */
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

const cleanError = (err: unknown): string =>
  String((err as Error)?.message ?? err).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '')

/** Optional: open each call's summary in Claude after the call, and a note per call in an Obsidian vault. */
export function IntegrationsSection() {
  const { t } = useTranslation()
  const app = useAppState()
  const [ob, setOb] = useState<ObsidianState | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  useEffect(() => void invoke<ObsidianState>('obsidian:state').then(setOb, () => setOb(null)), [])

  const run = async (fn: () => Promise<unknown>, ok?: (r: unknown) => string | undefined): Promise<void> => {
    setWorking(true)
    setMsg(null)
    try {
      const r = await fn()
      setOb(await invoke<ObsidianState>('obsidian:state'))
      setMsg(ok?.(r) ?? null)
    } catch (err) {
      setMsg(cleanError(err))
    } finally {
      setWorking(false)
    }
  }

  if (!app) return null
  const push = app.settings.claudePush

  return (
    <>
      <Row label={t('set.claudePush')} hint={t('set.claudePushHint')}>
        <Segmented<Settings['claudePush']>
          value={push}
          onChange={(v) => void setSettings({ claudePush: v })}
          options={[
            { value: 'off', label: t('set.claudePushOff') },
            { value: 'notify', label: t('set.claudePushNotify') },
            { value: 'open', label: t('set.claudePushOpen') }
          ]}
        />
      </Row>

      {ob && (
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <div className="flex items-center gap-6">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">{t('set.obsidian')}</div>
              <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{t('set.obsidianHint')}</div>
            </div>
            <Toggle
              checked={ob.enabled}
              disabled={working}
              onChange={(v) =>
                void run(
                  () => invoke(v ? 'obsidian:enable' : 'obsidian:disable'),
                  (r) => ((r as ObsidianState | undefined)?.enabled ? t('set.obsidianOn') : v ? undefined : t('set.obsidianOff'))
                )
              }
            />
          </div>
          <div className="flex items-center gap-2 rounded-[10px] bg-panel-2 px-3 py-2">
            <FolderOpen size={14} className="shrink-0 text-ink-3" />
            <span className="text-[12px] text-ink-2">{t('set.obsidianVault')}:</span>
            {ob.vault ? (
              <span dir="ltr" className="selectable min-w-0 flex-1 truncate text-start text-[12px]" title={ob.vault}>{ob.vault}</span>
            ) : (
              <span className="min-w-0 flex-1 text-[12px] text-ink-3">{t('set.obsidianNoVault')}</span>
            )}
          </div>
          {ob.vault && !ob.looksLikeVault && <div className="text-[12px] text-ink-2">{t('set.obsidianNotVault')}</div>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={ob.vault ? 'ghost' : 'primary'}
              disabled={working}
              onClick={() => void run(() => invoke('obsidian:pickVault'), (r) => ((r as ObsidianState | undefined)?.enabled ? t('set.obsidianOn') : undefined))}
            >
              {ob.vault ? t('set.obsidianChange') : t('set.obsidianPick')}
            </Button>
            {ob.enabled && (
              <Button
                size="sm"
                disabled={working}
                onClick={() => void run(() => invoke<number>('obsidian:exportAll'), (n) => t('set.obsidianExported', { n: Number(n) || 0 }))}
              >
                {t('set.obsidianExportAll')}
              </Button>
            )}
            {working && <Spinner />}
          </div>
          {(msg || ob.lastError) && (
            <div className={cn('text-[12px]', ob.lastError && !msg ? 'text-rec' : 'text-ink-2')}>{msg ?? ob.lastError}</div>
          )}
        </div>
      )}
    </>
  )
}
