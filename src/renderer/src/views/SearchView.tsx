import { SearchX } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchHit } from '@shared/types'
import { fmtClock } from '@shared/transcript'
import { SourceIcon } from '../components/SourceIcon'
import { Empty } from '../components/ui'
import { invoke } from '../lib/api'
import { dayLabel, highlight } from '../lib/format'

export function SearchView({ query, onOpen }: { query: string; onOpen: (id: string, q: string) => void }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const [hits, setHits] = useState<SearchHit[] | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) return setHits([])
    const timer = setTimeout(() => void invoke<SearchHit[]>('search', q).then(setHits), 140)
    return () => clearTimeout(timer)
  }, [query])

  return (
    <div className="mx-auto max-w-[860px] px-10 pb-16 pt-14">
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
        {t('search.title')} <span dir="auto" className="bidi text-ink-3">“{query}”</span>
      </h1>
      {hits && hits.length === 0 ? (
        <Empty icon={<SearchX size={24} />} title={t('search.none')} body={t('search.noneBody')} />
      ) : (
        <div className="mt-6 flex flex-col gap-4">
          {(hits ?? []).map((h) => (
            <button key={h.meetingId} onClick={() => onOpen(h.meetingId, query)} className="rounded-2xl border border-line bg-panel p-4 text-start shadow-card transition-colors hover:border-line-strong">
              <div className="flex items-center gap-3">
                <SourceIcon source={h.source} size={28} />
                <div className="min-w-0 flex-1">
                  <div dir="auto" className="bidi truncate text-[14px] font-semibold">{h.title}</div>
                  <div className="text-[12px] text-ink-3">{dayLabel(h.startedAt, lang)}</div>
                </div>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-semibold text-accent-ink">{h.segments.length}</span>
              </div>
              <div className="mt-3 flex flex-col gap-1.5 border-s-2 border-line ps-3">
                {h.segments.slice(0, 4).map((s) => (
                  <div key={s.id} className="flex gap-2 text-[13px] leading-relaxed">
                    <span className="tabular shrink-0 pt-px text-[11.5px] text-ink-3">{fmtClock(s.start)}</span>
                    <span dir="auto" className="bidi line-clamp-2 text-ink-2">
                      {highlight(s.text, query).map((x, i) => (x.hit ? <mark key={i}>{x.text}</mark> : <span key={i}>{x.text}</span>))}
                    </span>
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
