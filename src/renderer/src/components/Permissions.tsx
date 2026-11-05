import { AppWindow, CalendarDays, Check, Keyboard, Mic, MousePointerClick, Speaker } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke, useAppState } from '../lib/api'
import { Button, cn } from './ui'

type Kind = 'microphone' | 'systemAudio' | 'accessibility' | 'inputMonitoring' | 'calendar' | 'automation'

const PANES: Partial<Record<Kind, string>> = {
  accessibility: 'Privacy_Accessibility',
  inputMonitoring: 'Privacy_ListenEvent',
  microphone: 'Privacy_Microphone',
  systemAudio: 'Privacy_AudioCapture',
  calendar: 'Privacy_Calendars'
}

/** Permission cards: what each one is for, its state, and a button that asks macOS. */
export function PermissionList({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const app = useAppState()
  const p = app?.permissions
  const [asked, setAsked] = useState<Record<string, string>>({})

  const all: { kind: Kind; icon: ReactNode; bundleID?: string }[] = [
    { kind: 'microphone', icon: <Mic size={17} /> },
    { kind: 'systemAudio', icon: <Speaker size={17} /> },
    { kind: 'accessibility', icon: <MousePointerClick size={17} /> },
    { kind: 'inputMonitoring', icon: <Keyboard size={17} /> },
    { kind: 'calendar', icon: <CalendarDays size={17} /> },
    { kind: 'automation', icon: <AppWindow size={17} />, bundleID: 'com.google.Chrome' }
  ]
  // Windows only gates the microphone (Settings > Privacy > Microphone); the rest is macOS-only.
  const rows = app?.platform === 'win32' ? all.filter((r) => r.kind === 'microphone') : all

  const status = (k: Kind): string => {
    if (k === 'systemAudio' || k === 'automation') return asked[k] === 'granted' || asked[k] === 'requested' ? 'granted' : asked[k] ?? 'unknown'
    return (p as any)?.[k] ?? 'unknown'
  }

  const ask = async (k: Kind, bundleID?: string): Promise<void> => {
    const r = await invoke<string>('permissions:request', k, bundleID)
    setAsked((a) => ({ ...a, [k]: r }))
    if (r === 'denied' && PANES[k]) void invoke('permissions:open', PANES[k])
  }

  return (
    <div className={cn('flex flex-col', compact ? 'gap-2' : 'gap-2.5')}>
      {rows.map(({ kind, icon, bundleID }) => {
        const s = status(kind)
        const ok = s === 'granted'
        return (
          <div key={kind} className="flex items-center gap-3.5 rounded-xl border border-line bg-panel px-4 py-3">
            <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl', ok ? 'bg-ok-soft text-ok' : 'bg-panel-2 text-ink-2')}>{icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold">{t(`perm.${kind}`)}</div>
              <div className="text-[12px] leading-snug text-ink-2">{t(`perm.${kind}Why`)}</div>
            </div>
            {ok ? (
              <span className="flex items-center gap-1 text-[12.5px] font-medium text-ok">
                <Check size={14} /> {t('perm.granted')}
              </span>
            ) : (
              <Button size="sm" onClick={() => void ask(kind, bundleID)}>
                {s === 'denied' ? t('perm.openSettings') : t('common.allow')}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
