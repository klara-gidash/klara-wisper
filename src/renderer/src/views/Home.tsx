import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, Link2, Mail, Radio, Search, Users } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CalendarEvent, FollowUp, MeetingSummary } from '@shared/types'
import { SOURCE_LABEL } from '@shared/types'
import { speakerName } from '@shared/transcript'
import { DictateButton } from '../components/Controls'
import { SourceIcon } from '../components/SourceIcon'
import { Button, cn } from '../components/ui'
import { invoke, setSettings, useAppState, useEvent } from '../lib/api'
import { dayKey, dayLabel, groupByDay, initials, locale, timeHM } from '../lib/format'

// One day at a time: today (what's left of it), then tomorrow and on with the arrows.
const PAGE_DAYS = 1

/** "Thursday, 12 November" for pages after tomorrow. */
function dayTitle(offset: number, lang: 'he' | 'en'): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}

/** "Anna & Alon", "Basman, Melanie & Yael": the guests (or named speakers) of a meeting. */
function people(m: MeetingSummary, lang: 'he' | 'en'): string {
  const names = (m.attendees ?? m.calendarEvent?.attendees ?? [])
    .filter((a) => !a.isMe)
    .map((a) => (a.name || a.email.split('@')[0]).split(' ')[0])
  const fromSpeakers = Object.entries(m.speakers ?? {})
    .filter(([label, s]) => !s.isMe && label !== 'me' && s.name)
    .map(([label]) => speakerName(label, m.speakers, lang))
  return joinNames(names.length ? names : fromSpeakers, lang) || m.appName || SOURCE_LABEL[m.source]
}

function joinNames(names: string[], lang: 'he' | 'en'): string {
  const n = [...new Set(names)].filter(Boolean)
  if (n.length <= 1) return n[0] ?? ''
  const shown = n.slice(0, 3)
  const more = n.length - shown.length
  const last = shown[shown.length - 1]
  const and = lang === 'he' && /^[\u0590-\u05FF]/.test(last) ? ' ו' : ' & '
  return more > 0 ? `${shown.join(', ')} +${more}` : `${shown.slice(0, -1).join(', ')}${and}${shown[shown.length - 1]}`
}

function Avatars({ names }: { names: string[] }) {
  return (
    <span className="flex -space-x-1.5 rtl:space-x-reverse">
      {names.slice(0, 3).map((n, i) => (
        <span key={n + i} title={n} className="grid size-6 place-items-center rounded-full border-2 border-panel-2 bg-accent-soft text-[9.5px] font-semibold text-accent-ink">
          {initials(n)}
        </span>
      ))}
    </span>
  )
}

export function Home({ onOpen, go, onSearch }: { onOpen: (id: string) => void; go: (r: string) => void; onSearch: (q: string) => void }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'he' | 'en'
  const app = useAppState()
  const [page, setPage] = useState(0)
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [recent, setRecent] = useState<MeetingSummary[]>([])
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [starting, setStarting] = useState(false)
  const [ask, setAsk] = useState('')
  const [, tick] = useState(0)

  const [calendars, setCalendars] = useState<{ name: string; color: string | null; shown: boolean }[]>([])
  const [picking, setPicking] = useState(false)
  // The helper's permission report can lag behind; events coming back is proof enough.
  const calendarGranted = app?.permissions?.calendar === 'granted' || calendars.length > 0
  const [connecting, setConnecting] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const calendarBlocked = !calendarGranted && (blocked || app?.permissions?.calendar === 'denied')

  // macOS asks once; if it remembers a "no", the right Settings pane opens with instructions.
  const connectCalendar = async (): Promise<void> => {
    setConnecting(true)
    try {
      const r = await invoke<string>('permissions:request', 'calendar')
      if (r !== 'granted') {
        setBlocked(true)
        void invoke('permissions:open', 'Privacy_Calendars')
      }
      loadEvents()
    } finally {
      setConnecting(false)
    }
  }
  const checkCalendar = async (): Promise<void> => {
    await invoke('permissions:get')
    loadEvents()
  }
  // Coming back from System Settings: check again.
  useEffect(() => {
    if (calendarGranted) return
    const onFocus = (): void => void checkCalendar()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [calendarGranted])

  const loadMeetings = (): void => {
    void invoke<MeetingSummary[]>('meetings:list', { limit: 40 }).then(setRecent, () => undefined)
    void invoke<FollowUp[]>('followups:list').then(setFollowUps, () => setFollowUps([]))
  }
  const loadEvents = (): void => {
    void invoke<{ events: CalendarEvent[]; calendars: typeof calendars }>('calendar:days', page * PAGE_DAYS, PAGE_DAYS).then(
      (r) => {
        setEvents(r.events)
        if (r.calendars.length) setCalendars(r.calendars)
      },
      () => setEvents([])
    )
  }
  useEffect(loadMeetings, [])
  useEffect(loadEvents, [page, app?.permissions?.calendar, app?.settings.calendars])
  useEvent('meetings:changed', loadMeetings)
  // Keep "Now" and the list fresh while the window stays open.
  useEffect(() => {
    const timer = setInterval(() => {
      tick((n) => n + 1)
      loadEvents()
    }, 60_000)
    return () => clearInterval(timer)
  }, [page])

  const start = async (mode: 'inperson' | 'meeting'): Promise<void> => {
    setStarting(true)
    try {
      await invoke('live:start', mode === 'inperson' ? { mode, source: 'inperson' } : { mode, source: 'other' })
    } finally {
      setStarting(false)
    }
  }

  const now = Date.now()
  const days = groupByDay(events ?? [], (e) => e.start)
  const past = recent.filter((m) => m.status !== 'recording').slice(0, 20)
  const pastDays = groupByDay(past, (m) => m.startedAt)
  const Prev = lang === 'he' ? ChevronRight : ChevronLeft
  const Next = lang === 'he' ? ChevronLeft : ChevronRight
  const busy = !!app?.live || starting || app?.engine.state !== 'ready'
  const todayKey = dayKey(new Date().toISOString())

  return (
    <div className="relative mx-auto max-w-[880px] px-10 pb-32 pt-12">
      {/* quick actions */}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" disabled={busy} onClick={() => void start('inperson')} icon={<Users size={14} />}>
          {t('home.inperson')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void start('meeting')} icon={<Radio size={14} className="text-rec" />}>
          {t('home.recordCall')}
        </Button>
        <DictateButton compact />
      </div>

      {/* coming up */}
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="mt-6 flex items-end justify-between">
        <h1 className="text-[30px] font-semibold tracking-[-0.02em]">
          {page === 0 ? t('home.today') : page === 1 ? t('home.tomorrow') : dayTitle(page, lang)}
        </h1>
        {calendarGranted && (
          <div className="relative flex items-center gap-1 pb-1.5">
            <button onClick={() => setPicking(!picking)} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-ink-2 hover:bg-line">
              <CalendarDays size={14} /> {t('home.calendars')}
            </button>
            {picking && (
              <div onMouseLeave={() => setPicking(false)} className="absolute end-0 top-9 z-20 w-64 rounded-xl border border-line bg-panel p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
                {calendars.map((c) => (
                  <label key={c.name} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-panel-2">
                    <input
                      type="checkbox"
                      checked={c.shown}
                      onChange={() => {
                        const next = calendars.filter((x) => (x.name === c.name ? !x.shown : x.shown)).map((x) => x.name)
                        void setSettings({ calendars: next })
                      }}
                      className="accent-[var(--accent)]"
                    />
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: c.color ?? 'var(--accent)' }} />
                    <span dir="auto" className="bidi truncate">{c.name}</span>
                  </label>
                ))}
              </div>
            )}
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="grid size-7 place-items-center rounded-lg text-ink-2 hover:bg-line disabled:opacity-30" aria-label={t('home.earlier')}>
              <Prev size={17} />
            </button>
            <button onClick={() => setPage(page + 1)} className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium text-ink-2 hover:bg-line" aria-label={t('home.later')}>
              {page === 0 ? t('home.tomorrow') : t('home.nextDay')}
              <Next size={16} />
            </button>
          </div>
        )}
      </motion.div>

      <section className="mt-4 rounded-[22px] border border-line bg-panel shadow-card">
        {!calendarGranted ? (
          <div className="flex items-center gap-4 p-5">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-panel-2 text-ink-2">
              <CalendarPlus size={19} />
            </span>
            <div className="flex-1">
              <div className="text-[14px] font-semibold">{t('home.connectCalendar')}</div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">
                {calendarBlocked ? t('home.calendarBlocked') : t('home.connectCalendarBody')}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              {calendarBlocked ? (
                <>
                  <Button variant="primary" size="sm" onClick={() => void checkCalendar()}>
                    {t('home.calendarCheck')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void invoke('permissions:open', 'Privacy_Calendars')}>
                    {t('home.calendarSettings')}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="primary" size="sm" disabled={connecting} onClick={() => void connectCalendar()}>
                    {t('home.connectCalendarButton')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void invoke('calendar:openAccounts')}>
                    {t('home.addGoogle')}
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : days.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] leading-relaxed text-ink-3">
            {events === null ? '…' : (
              <>
                {t('home.noUpcoming')}
                <button onClick={() => void invoke('calendar:openAccounts')} className="mt-1 block w-full text-[12.5px] text-accent hover:underline">
                  {t('home.addGoogle')}
                </button>
              </>
            )}
          </div>
        ) : (
          days.map((d, di) => {
            const date = new Date(d.date)
            const isToday = d.key === todayKey
            return (
              <div key={d.key} className={cn('flex gap-6 px-6 py-4', di > 0 && 'border-t border-dashed border-line-strong')}>
                <div className="flex w-[150px] shrink-0 items-start gap-3 pt-0.5">
                  <span className="tabular text-[34px] font-light leading-none">{date.getDate()}</span>
                  <span className="pt-0.5 leading-tight">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium">
                      {date.toLocaleDateString(locale(lang), { month: 'long' })}
                      {isToday && <span className="size-1.5 rounded-full bg-rec" />}
                    </span>
                    <span className="block text-[12.5px] text-ink-3">{date.toLocaleDateString(locale(lang), { weekday: 'short' })}</span>
                  </span>
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  {d.items.map((e) => {
                    const isNow = new Date(e.start).getTime() <= now && now < new Date(e.end).getTime()
                    const guests = e.attendees.filter((a) => !a.isMe).map((a) => a.name || a.email)
                    return (
                      <div key={e.id} className="group flex items-center gap-3">
                        <span className="w-[3px] self-stretch rounded-full" style={{ background: e.color ?? 'var(--accent)' }} />
                        <div className="min-w-0 flex-1">
                          <div dir="auto" className="bidi truncate text-[14.5px] font-medium">{e.title || t('home.untitled')}</div>
                          <div className={cn('tabular text-[12.5px]', isNow ? 'font-medium text-ok' : 'text-ink-3')}>
                            {isNow && `${t('home.now')} · `}
                            <span dir="ltr" className="inline-block">{timeHM(e.start, lang)} – {timeHM(e.end, lang)}</span>
                          </div>
                        </div>
                        {guests.length > 0 && <Avatars names={guests} />}
                        {e.links[0] && (
                          <a href={e.links[0]} target="_blank" rel="noreferrer" title={t('home.join')} className="grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-line hover:text-ink">
                            <Link2 size={14} />
                          </a>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </section>

      {/* follow-up emails */}
      {followUps.length > 0 && (
        <section className="mt-6 rounded-[22px] bg-panel-2 px-3 py-3">
          <div className="flex items-center gap-2 px-3 pb-2 pt-1 text-[13px] font-medium text-ink-2">
            <Mail size={15} className="text-[#EA4335]" />
            {t('home.followUps')}
          </div>
          {followUps.map((f) => {
            const names = f.people.map((p) => p.name || p.email.split('@')[0])
            return (
              <button
                key={f.id}
                onClick={() => void invoke('followups:compose', f.id)}
                title={f.hasSummary ? t('home.followUpWithSummary') : t('home.followUpNoSummary')}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors hover:bg-panel"
              >
                {names.length > 0 ? <Avatars names={names} /> : <SourceIcon source={f.source} size={24} />}
                <span className="max-w-[220px] truncate text-[13.5px] font-semibold">{joinNames(names.map((n) => n.split(' ')[0]), lang) || t('home.noRecipients')}</span>
                <span dir="auto" className="bidi min-w-0 flex-1 truncate text-[13px] text-ink-2">{f.title}</span>
                <span className="shrink-0 text-[12px] text-ink-3">{dayLabel(f.startedAt, lang)}</span>
              </button>
            )
          })}
        </section>
      )}

      {/* past meetings */}
      {pastDays.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-[13px] leading-relaxed text-ink-3">{t('home.noMeetings')}</div>
      ) : (
        pastDays.map((d) => (
          <section key={d.key} className="mt-8">
            <h2 className="mb-1 px-3 text-[13px] font-medium text-ink-3">{dayLabel(d.date, lang)}</h2>
            {d.items.map((m) => (
              <button key={m.id} onClick={() => onOpen(m.id)} className="flex w-full items-center gap-3.5 rounded-xl px-3 py-2.5 text-start transition-colors hover:bg-panel-2">
                <SourceIcon source={m.source} size={36} />
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="bidi block truncate text-[14.5px] font-medium">{m.title}</span>
                  <span dir="auto" className="bidi block truncate text-[12.5px] text-ink-3">
                    {m.status === 'processing' ? t('live.processing') : m.status === 'error' ? t('home.failed') : people(m, lang)}
                  </span>
                </span>
                <span className="tabular shrink-0 text-[12.5px] text-ink-3">{timeHM(m.startedAt, lang)}</span>
              </button>
            ))}
          </section>
        ))
      )}
      {past.length > 0 && (
        <button onClick={() => go('meetings')} className="mt-4 px-3 text-[12.5px] font-medium text-accent hover:underline">
          {t('home.all')}
        </button>
      )}

      {/* search bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (ask.trim()) onSearch(ask.trim())
        }}
        className="sticky bottom-5 mt-10 flex items-center gap-3 rounded-full border border-line-strong bg-panel/95 px-5 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.08)] backdrop-blur"
      >
        <Search size={16} className="text-ink-3" />
        <input
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder={t('home.askPlaceholder')}
          dir="auto"
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3"
        />
      </form>
    </div>
  )
}
