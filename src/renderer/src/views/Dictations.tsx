import { Check, Copy, Keyboard, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Dictation } from '@shared/types'
import { DictateButton } from '../components/Controls'
import { Empty, Kbd } from '../components/ui'
import { invoke, useEvent } from '../lib/api'
import { dayLabel, groupByDay, highlight, timeHM } from '../lib/format'

export function Dictations() {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const [q, setQ] = useState('')
  const [items, setItems] = useState<Dictation[] | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = (): void => void invoke<Dictation[]>('dictations:list', q).then(setItems)
  useEffect(load, [q])
  useEvent('dictations:changed', load)

  const words = (items ?? []).reduce((n, d) => n + d.text.split(/\s+/).filter(Boolean).length, 0)

  return (
    <div className="mx-auto max-w-[760px] px-10 pb-16 pt-14">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{t('nav.dictations')}</h1>
          <div className="mt-1 text-[13px] text-ink-3">{items ? t('dict.stats', { count: items.length, words }) : ''}</div>
        </div>
        <div className="relative w-60">
          <Search size={13} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('dict.search')} className="h-8 w-full rounded-[9px] border border-line bg-panel ps-8 pe-2 text-[12.5px] outline-none focus:border-accent/50" />
        </div>
      </div>

      <div className="mt-6">
        <DictateButton large />
      </div>

      {items && items.length === 0 ? (
        <Empty
          icon={<Keyboard size={24} />}
          title={q ? t('dict.noResults') : t('dict.empty')}
          body={q ? undefined : t('dict.emptyBody')}
          action={!q ? <div className="flex items-center gap-1.5 text-[12.5px] text-ink-2"><Kbd>fn</Kbd> {t('dict.hold')}</div> : undefined}
        />
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {groupByDay(items ?? [], (d) => d.at).map((g) => (
            <section key={g.key}>
              <h2 className="mb-2 text-[12.5px] font-semibold text-ink-3">{dayLabel(g.date, lang)}</h2>
              <div className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-panel shadow-card">
                {g.items.map((d) => (
                  <div key={d.id} className="group flex items-start gap-4 px-4 py-3">
                    <div className="w-12 shrink-0 pt-0.5">
                      <div className="tabular text-[12px] text-ink-3">{timeHM(d.at, lang)}</div>
                      {d.lang && <div className="mt-1 inline-block rounded bg-line px-1 text-[9.5px] font-semibold uppercase text-ink-2">{d.lang}</div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p dir="auto" className="bidi selectable text-[14px] leading-relaxed">
                        {highlight(d.text, q).map((h, i) => (h.hit ? <mark key={i}>{h.text}</mark> : <span key={i}>{h.text}</span>))}
                      </p>
                      {d.app && <div className="mt-1 text-[11.5px] text-ink-3">{t('dict.in', { app: d.app })}</div>}
                    </div>
                    <button
                      title={t('meeting.copy')}
                      onClick={() => {
                        void invoke('clipboard:write', d.text)
                        setCopied(d.id)
                        setTimeout(() => setCopied(null), 1200)
                      }}
                      className="grid size-7 place-items-center rounded-lg text-ink-3 opacity-0 transition-opacity hover:bg-line hover:text-ink group-hover:opacity-100"
                    >
                      {copied === d.id ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
