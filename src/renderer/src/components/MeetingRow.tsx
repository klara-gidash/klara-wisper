import { AlertTriangle, FileText, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MeetingSummary } from '@shared/types'
import { fmtDuration, speakerName } from '@shared/transcript'
import { dayLabel, speakerColor, timeHM } from '../lib/format'
import { SourceIcon } from './SourceIcon'

export function MeetingRow({ meeting: m, onOpen, showDate = false }: { meeting: MeetingSummary; onOpen: (id: string) => void; showDate?: boolean }) {
  const { i18n } = useTranslation()
  const lang = i18n.language as 'he' | 'en'
  const labels = Object.keys(m.speakers ?? {}).slice(0, 5)
  return (
    <button
      onClick={() => onOpen(m.id)}
      className="group flex w-full items-start gap-3.5 rounded-xl px-3 py-3 text-start transition-colors hover:bg-panel-2"
    >
      <SourceIcon source={m.source} size={34} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span dir="auto" className="bidi truncate text-[14px] font-semibold">{m.title}</span>
          {m.status === 'processing' && <Loader2 size={13} className="animate-spin text-ink-3" />}
          {m.status === 'error' && <AlertTriangle size={13} className="text-warn" />}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-3">
          <span className="tabular">{showDate ? `${dayLabel(m.startedAt, lang)} · ` : ''}{timeHM(m.startedAt, lang)}</span>
          <span>·</span>
          <span>{fmtDuration(m.durationSec, lang)}</span>
          {labels.length > 0 && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1">
                {labels.map((l) => (
                  <span key={l} title={speakerName(l, m.speakers, lang)} className="size-1.5 rounded-full" style={{ background: speakerColor(l, m.speakers) }} />
                ))}
              </span>
            </>
          )}
        </div>
        {m.preview && (
          <div dir="auto" className="bidi mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink-2">
            {m.preview}
          </div>
        )}
      </div>
      <FileText size={15} className="mt-1 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}
