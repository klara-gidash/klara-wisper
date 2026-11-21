import { ArrowLeft, ArrowRight, Briefcase, Building2, CheckSquare, ChevronLeft, ChevronRight, Search, User } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClientFile, ClientGroup } from '@shared/clients'
import { normalizeText } from '@shared/clients'
import { fmtDuration } from '@shared/transcript'
import { SourceIcon } from '../components/SourceIcon'
import { Empty, Spinner } from '../components/ui'
import { invoke, useEvent } from '../lib/api'
import { dayLabel, initials } from '../lib/format'

function ClientIcon({ client, size = 36 }: { client: ClientGroup; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-[10px] bg-panel-2 text-[12px] font-semibold text-ink-2" style={{ width: size, height: size }}>
      {client.kind === 'company' ? <Building2 size={size * 0.48} className="text-ink-3" /> : initials(client.name) || <User size={size * 0.48} />}
    </span>
  )
}

/** Names without the "<email>" part, for one short line. */
const shortPeople = (people: string[], n: number): string => {
  const names = people.map((p) => p.replace(/\s*<[^>]*>$/, '').trim() || p)
  return names.slice(0, n).join(', ') + (names.length > n ? ` +${names.length - n}` : '')
}

/** The "לקוחות" page: every client or person, newest first (src/shared/clients.ts groups them). */
export function ClientList({ onOpen }: { onOpen: (key: string) => void }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const [items, setItems] = useState<ClientGroup[] | null>(null)
  const [filter, setFilter] = useState('')

  const load = (): void => void invoke<ClientGroup[]>('clients:list').then(setItems)
  useEffect(load, [])
  useEvent('meetings:changed', load)

  const q = normalizeText(filter)
  const shown = (items ?? []).filter(
    (c) => !q || normalizeText(`${c.name} ${c.domain ?? ''} ${c.people.join(' ')} ${c.aliases.join(' ')}`).includes(q)
  )
  const Chevron = lang === 'he' ? ChevronLeft : ChevronRight

  return (
    <div className="mx-auto max-w-[860px] px-10 pb-16 pt-14">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{t('nav.clients')}</h1>
          <div className="mt-1 text-[13px] text-ink-3">{items ? t('clients.count', { count: items.length }) : ''}</div>
        </div>
        {(items?.length ?? 0) > 6 && (
          <div className="relative w-[240px]">
            <Search size={14} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('clients.filter')}
              className="no-drag h-8 w-full rounded-[9px] border border-line bg-panel/70 ps-8 pe-2 text-[13px] outline-none placeholder:text-ink-3 focus:border-accent/50 focus:ring-2 focus:ring-accent/15"
            />
          </div>
        )}
      </div>
      {!items ? (
        <div className="grid place-items-center py-20 text-ink-3">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Empty icon={<Briefcase size={24} />} title={t('clients.empty')} body={t('clients.emptyBody')} />
      ) : shown.length === 0 ? (
        <Empty icon={<Search size={24} />} title={t('clients.noMatch')} />
      ) : (
        <div className="mt-6 flex flex-col">
          {shown.map((c) => (
            <button
              key={c.key}
              onClick={() => onOpen(c.key)}
              className="group flex w-full items-center gap-3.5 rounded-xl px-3 py-3 text-start transition-colors hover:bg-panel-2"
            >
              <ClientIcon client={c} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span dir="auto" className="bidi truncate text-[14px] font-semibold">{c.name}</span>
                  <span className="truncate text-[12px] text-ink-3" dir="ltr">{c.domain ?? t('clients.person')}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-3">
                  <span>{t('clients.meetings', { count: c.count })}</span>
                  <span>·</span>
                  <span>{t('clients.last', { day: dayLabel(c.lastAt, lang) })}</span>
                  {c.kind === 'company' && c.people.length > 0 && (
                    <>
                      <span>·</span>
                      <span dir="auto" className="bidi truncate">{shortPeople(c.people, 3)}</span>
                    </>
                  )}
                </div>
              </div>
              <Chevron size={15} className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** One client's file: open tasks across its meetings, then the timeline with each meeting's summary lines. */
export function ClientView({ clientKey, onBack, onOpenMeeting }: { clientKey: string; onBack: () => void; onOpenMeeting: (id: string) => void }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'he' | 'en'
  const [file, setFile] = useState<ClientFile | null | undefined>(undefined)

  const load = (): void => void invoke<ClientFile | null>('clients:get', clientKey).then(setFile)
  useEffect(load, [clientKey])
  useEvent('meetings:changed', load)

  const tasks = useMemo(() => {
    const seen = new Set<string>()
    const out: { text: string; meetingId: string; title: string; startedAt: string }[] = []
    for (const m of file?.meetings ?? []) {
      for (const text of m.openTasks) {
        const k = normalizeText(text)
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ text, meetingId: m.id, title: m.title, startedAt: m.startedAt })
      }
    }
    return out
  }, [file])

  const Back = lang === 'he' ? ArrowRight : ArrowLeft
  const back = (
    <button onClick={onBack} className="no-drag mb-4 flex items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink">
      <Back size={14} /> {t('clients.back')}
    </button>
  )

  if (file === undefined)
    return (
      <div className="grid h-full place-items-center text-ink-3">
        <Spinner />
      </div>
    )
  if (file === null)
    return (
      <div className="mx-auto max-w-[860px] px-10 pb-16 pt-12">
        {back}
        <Empty icon={<Briefcase size={24} />} title={t('clients.notFound')} />
      </div>
    )

  const { client, meetings } = file
  return (
    <div className="mx-auto max-w-[860px] px-10 pb-24 pt-12">
      {back}
      <div className="flex items-start gap-4">
        <ClientIcon client={client} size={44} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            <span dir="auto" className="bidi">{client.name}</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-ink-3">
            <span dir="ltr">{client.domain ?? t('clients.person')}</span>
            <span>·</span>
            <span>{t('clients.meetings', { count: client.count })}</span>
            <span>·</span>
            <span>{t('clients.last', { day: dayLabel(client.lastAt, lang) })}</span>
          </div>
          {client.people.length > 0 && (
            <div dir="auto" className="bidi mt-2 text-[13px] leading-relaxed text-ink-2">
              <span className="font-medium text-ink-3">{t('clients.people')}: </span>
              {shortPeople(client.people, 8)}
            </div>
          )}
          {client.aliases.length > 0 && (
            <div dir="auto" className="bidi mt-1 text-[12px] text-ink-3">{t('clients.titleWords', { words: client.aliases.join(', ') })}</div>
          )}
        </div>
      </div>

      {/* open tasks */}
      <section className="mt-8 rounded-[22px] bg-panel-2 px-3 py-3">
        <div className="flex items-center gap-2 px-3 pb-1 pt-1 text-[13px] font-medium text-ink-2">
          <CheckSquare size={15} className="text-accent" />
          {t('clients.openTasks')}
          {tasks.length > 0 && <span className="text-ink-3">· {tasks.length}</span>}
        </div>
        <div className="px-3 pb-2 text-[11.5px] text-ink-3">{t('clients.tasksHint')}</div>
        {tasks.length === 0 ? (
          <div className="px-3 pb-2 text-[13px] text-ink-3">{t('clients.noTasks')}</div>
        ) : (
          tasks.map((task, i) => (
            <button
              key={i}
              onClick={() => onOpenMeeting(task.meetingId)}
              className="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-start transition-colors hover:bg-panel"
            >
              <span className="mt-[5px] size-3.5 shrink-0 rounded-[4px] border border-line-strong" />
              {/* a column of flex items: each line sits at the page's start edge, whatever its own direction */}
              <span className="flex min-w-0 flex-1 flex-col items-start">
                <span dir="auto" className="bidi max-w-full text-[13.5px] leading-relaxed">{task.text}</span>
                <span dir="auto" className="bidi max-w-full truncate text-[11.5px] text-ink-3">
                  {task.title} · {dayLabel(task.startedAt, lang)}
                </span>
              </span>
            </button>
          ))
        )}
      </section>

      {/* timeline */}
      <h2 className="mt-8 text-[13px] font-semibold text-ink-3">{t('clients.timeline')}</h2>
      <ol className="mt-3 flex flex-col">
        {meetings.map((m, i) => (
          <li key={m.id} className="relative flex gap-3.5">
            <div className="flex w-[34px] shrink-0 flex-col items-center">
              <SourceIcon source={m.source} size={30} className="mt-2.5" />
              {i < meetings.length - 1 && <span className="mt-1 w-px flex-1 bg-line-strong" />}
            </div>
            <button onClick={() => onOpenMeeting(m.id)} className="mb-2 min-w-0 flex-1 rounded-xl px-3 py-2.5 text-start transition-colors hover:bg-panel-2">
              <div className="flex items-baseline gap-2">
                <span dir="auto" className="bidi truncate text-[14px] font-semibold">{m.title}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-3">
                <span>{dayLabel(m.startedAt, lang)}</span>
                {!!m.durationSec && (
                  <>
                    <span>·</span>
                    <span>{fmtDuration(m.durationSec, lang)}</span>
                  </>
                )}
                {m.openTasks.length > 0 && (
                  <>
                    <span>·</span>
                    <span>{t('clients.tasksCount', { count: m.openTasks.length })}</span>
                  </>
                )}
              </div>
              {m.gist ? (
                <div dir="auto" className="bidi mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-ink-2">{m.gist}</div>
              ) : (
                <div className="mt-1.5 text-[12.5px] text-ink-3">{t('clients.noNotes')}</div>
              )}
              {m.decisions.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-0.5">
                  <span className="text-[11.5px] font-medium text-ink-3">{t('clients.decisions')}</span>
                  {m.decisions.slice(0, 3).map((d, j) => (
                    <div key={j} dir="auto" className="bidi flex gap-2 text-[12.5px] leading-relaxed text-ink-2">
                      <span className="text-ink-3">•</span>
                      <span>{d}</span>
                    </div>
                  ))}
                </div>
              )}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
