import { Users, Video } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MeetingSource, MeetingSummary } from '@shared/types'
import { SOURCE_LABEL } from '@shared/types'
import { RecordControls } from '../components/Controls'
import { MeetingRow } from '../components/MeetingRow'
import { Empty, Segmented } from '../components/ui'
import { invoke, useEvent } from '../lib/api'
import { dayLabel, groupByDay } from '../lib/format'

export function MeetingList({ mode, onOpen }: { mode: 'meeting' | 'inperson'; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const [items, setItems] = useState<MeetingSummary[] | null>(null)
  const [source, setSource] = useState<'all' | MeetingSource>('all')

  const load = (): void => void invoke<MeetingSummary[]>('meetings:list', { mode }).then(setItems)
  useEffect(load, [mode])
  useEvent('meetings:changed', load)

  const sources = useMemo(() => [...new Set((items ?? []).map((m) => m.source))], [items])
  const shown = (items ?? []).filter((m) => source === 'all' || m.source === source)

  return (
    <div className="mx-auto max-w-[860px] px-10 pb-16 pt-14">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{mode === 'inperson' ? t('nav.inperson') : t('nav.meetings')}</h1>
          <div className="mt-1 text-[13px] text-ink-3">{items ? t('list.count', { count: items.length }) : ''}</div>
        </div>
        <RecordControls mode={mode} />
      </div>
      <div className="mt-4 flex justify-end">
        {mode === 'meeting' && sources.length > 1 && (
          <Segmented
            value={source}
            onChange={setSource}
            options={[{ value: 'all' as const, label: t('list.all') }, ...sources.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))]}
          />
        )}
      </div>
      {items && shown.length === 0 ? (
        <Empty
          icon={mode === 'inperson' ? <Users size={24} /> : <Video size={24} />}
          title={mode === 'inperson' ? t('list.emptyInperson') : t('list.emptyMeetings')}
          body={mode === 'inperson' ? t('list.emptyInpersonBody') : t('list.emptyMeetingsBody')}
        />
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {groupByDay(shown, (m) => m.startedAt).map((g) => (
            <section key={g.key}>
              <h2 className="sticky top-0 z-10 bg-bg/90 py-2 text-[12.5px] font-semibold text-ink-3 backdrop-blur">{dayLabel(g.date, lang)}</h2>
              <div className="flex flex-col">
                {g.items.map((m) => (
                  <MeetingRow key={m.id} meeting={m} onOpen={onOpen} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
