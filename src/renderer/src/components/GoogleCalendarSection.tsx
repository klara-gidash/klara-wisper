import { CalendarCheck, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GoogleCalendarState } from '@shared/types'
import { Button, cn, Spinner } from './ui'
import { invoke, useAppState } from '../lib/api'

const GOOGLE_SETTINGS = 'https://calendar.google.com/calendar/r/settings'

/** The main process adds `needsRelink` when the saved link can no longer be decrypted (src/main/googleCalendar.ts). */
type State = GoogleCalendarState & { needsRelink?: boolean }

// Defaults for the "paste the link again" message; a `gcal.err.needsRelink` key in lib/strings.ts takes precedence.
const NEEDS_RELINK: Record<string, string> = {
  he: 'Klara Wisper כבר לא מצליחה לקרוא את הקישור השמור ל-Google Calendar (macOS או Windows לא אישרו לפתוח אותו, למשל אחרי עדכון). היומן של Google כבוי עד שמדביקים את הקישור שוב.',
  en: 'Klara Wisper can no longer read the saved Google Calendar link (the system refused to unlock it, e.g. after an update). Google Calendar is off until you paste the link again.'
}

/** Google Calendar through its secret iCal link: paste once, the app keeps it encrypted (src/main/googleCalendar.ts). */
export function GoogleCalendarSection({ onChange }: { onChange?: (s: GoogleCalendarState | null) => void } = {}) {
  const { t, i18n } = useTranslation()
  const win = useAppState()?.platform === 'win32'
  const [st, setSt] = useState<State | null>(null)
  const [link, setLink] = useState('')
  const [editing, setEditing] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const [working, setWorking] = useState(false)
  useEffect(() => void invoke<State>('gcal:state').then(setSt, () => setSt(null)), [])
  useEffect(() => onChange?.(st), [st])

  // Main-process errors arrive as "Error invoking remote method 'gcal:connect': Error: gcal:notFound".
  const explain = (raw: unknown): string => {
    const text = String((raw as Error)?.message ?? raw)
    const code = [...text.matchAll(/gcal:(\w+)/g)].at(-1)?.[1] // the last one: the first is the channel name
    if (code === 'needsRelink') return t('gcal.err.needsRelink', { defaultValue: NEEDS_RELINK[i18n.language] ?? NEEDS_RELINK.en })
    return code ? t(`gcal.err.${code}`, { defaultValue: text }) : text.replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '')
  }

  const connect = async (): Promise<void> => {
    setWorking(true)
    setMsg(null)
    try {
      const s = await invoke<State>('gcal:connect', link)
      setSt(s)
      setLink('')
      setEditing(false)
      setMsg({ text: t('gcal.connected', { n: s.upcoming ?? 0 }), error: false })
    } catch (err) {
      setMsg({ text: explain(err), error: true })
    } finally {
      setWorking(false)
    }
  }
  const disconnect = async (): Promise<void> => {
    setWorking(true)
    try {
      setSt(await invoke<State>('gcal:disconnect'))
      setEditing(false)
      setMsg({ text: t('gcal.disconnected'), error: false })
    } finally {
      setWorking(false)
    }
  }

  if (!st) return null
  const showInput = !st.linked || editing || !!st.lastError || !!st.needsRelink
  const status = msg ?? (st.lastError ? { text: explain(st.lastError), error: true } : null)

  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="text-[12.5px] leading-relaxed text-ink-2">{t(win ? 'gcal.hintWin' : 'gcal.hint')}</div>

      {st.linked && !st.needsRelink && (
        <div className="flex items-center gap-2 rounded-[10px] bg-panel-2 px-3 py-2">
          <CalendarCheck size={14} className="shrink-0 text-ok" />
          <span className="text-[12px] text-ink-2">{t('gcal.linkedTo')}:</span>
          <span dir="ltr" className="selectable min-w-0 flex-1 truncate text-start text-[12.5px] font-medium">{st.calendar}</span>
          {st.lastSync && (
            <span className="shrink-0 text-[11.5px] text-ink-3">
              {t('gcal.lastSync')} {new Date(st.lastSync).toLocaleTimeString(i18n.language === 'he' ? 'he-IL' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      )}

      {!st.linked && (
        <div className="text-[12.5px] leading-relaxed">
          <div className="font-medium">{t('gcal.stepsTitle')}</div>
          <ol className="mt-1 list-decimal ps-5 text-ink-2">
            <li>{t('gcal.step1')}</li>
            <li>{t('gcal.step2')}</li>
            <li>{t('gcal.step3')}</li>
            <li>{t('gcal.step4')}</li>
          </ol>
        </div>
      )}

      {showInput && (
        <input
          id="gcal-link"
          dir="ltr"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && link.trim() && !working && void connect()}
          placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics"
          className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[13px] outline-none focus:border-accent"
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {showInput && (
          <Button size="sm" variant="primary" disabled={working || !link.trim()} onClick={() => void connect()}>
            {st.linked ? t('gcal.save') : t('gcal.connect')}
          </Button>
        )}
        {!st.linked && (
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void invoke('app:openExternal', GOOGLE_SETTINGS)}>
            {t('gcal.openGoogle')}
          </Button>
        )}
        {st.linked && !showInput && (
          <Button size="sm" disabled={working} onClick={() => setEditing(true)}>
            {t('gcal.replace')}
          </Button>
        )}
        {st.linked && editing && (
          <Button size="sm" variant="ghost" disabled={working} onClick={() => { setEditing(false); setLink('') }}>
            {t('gcal.cancel')}
          </Button>
        )}
        {st.linked && (
          <Button size="sm" variant="ghost" disabled={working} onClick={() => void disconnect()}>
            {t('gcal.disconnect')}
          </Button>
        )}
        {working && <Spinner />}
      </div>

      {status && <div className={cn('text-[12px] leading-relaxed', status.error ? 'text-rec' : 'text-ink-2')}>{status.text}</div>}
      <div className="text-[11.5px] leading-relaxed text-ink-3">{t('gcal.privacy')}</div>
    </div>
  )
}
