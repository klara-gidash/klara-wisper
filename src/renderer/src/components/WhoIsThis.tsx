import { Play, Sparkles, UserRound, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Meeting } from '@shared/types'
import { needsWhoPrompt, suggestionsFor, talkTime, unnamedSpeakers } from '@shared/speakerNames'
import { fmtClock, speakerName } from '@shared/transcript'
import { invoke } from '../lib/api'
import { speakerColor } from '../lib/format'
import { cn } from './ui'

/** One-tap names from the calendar for one speaker; a chip names it and remembers the voice. */
export function NameChips({ meeting, label, userName, onDone, className }: { meeting: Meeting; label: string; userName: string; onDone: () => void; className?: string }) {
  const { t } = useTranslation()
  const chips = suggestionsFor(meeting.meta, label, userName)
  if (!chips.length) return null
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {chips.map((c) => (
        <button
          key={c.email || c.name}
          title={t('meeting.nameChip')}
          onClick={() => void invoke('meetings:renameSpeaker', meeting.meta.id, label, c.name, true).then(onDone)}
          className="bidi rounded-full border border-line-strong bg-panel px-2.5 py-0.5 text-[12px] font-medium text-ink hover:border-accent/60 hover:bg-panel-2"
          dir="auto"
        >
          {c.name}
        </button>
      ))}
    </div>
  )
}

/** "Named X from the calendar · Not X": the automatic name of a 1:1 call, easy to undo. */
export function AutoNamedNote({ meeting, onDone }: { meeting: Meeting; onDone: () => void }) {
  const { t } = useTranslation()
  const auto = Object.entries(meeting.meta.speakers ?? {}).filter(([, s]) => s.auto && s.name)
  if (!auto.length) return null
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      {auto.map(([label, s]) => (
        <div key={label} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-panel-2 px-3.5 py-2 text-[12.5px] text-ink-2">
          <Sparkles size={13} className="shrink-0 text-ink-3" />
          <span dir="auto" className="bidi">{t('meeting.autoNamed', { name: s.name })}</span>
          <button onClick={() => void invoke('meetings:undoAutoSpeaker', meeting.meta.id, label).then(onDone)} className="font-medium text-ink underline-offset-2 hover:underline">
            {t('meeting.autoUndo', { name: s.name })}
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * A gentle "who is this?" card above the transcript, after a call with unnamed speakers: per speaker a
 * play button (their longest line), the calendar's names as chips, or any other name.
 */
export function WhoIsThis({ meeting, userName, onSeek, onDone }: { meeting: Meeting; userName: string; onSeek?: (t: number) => void; onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'he' | 'en'
  const { meta, segments } = meeting
  if (!needsWhoPrompt(meta, segments)) return null
  const labels = unnamedSpeakers(meta, segments)
  return (
    <div className="mb-6 rounded-2xl border border-line bg-panel px-5 py-4">
      <div className="flex items-start gap-3">
        <UserRound size={18} className="mt-0.5 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{t('meeting.whoTitle')}</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">{t('meeting.whoBody')}</div>
        </div>
        <button onClick={() => void invoke('meetings:dismissSpeakerPrompt', meta.id).then(onDone)} className="flex shrink-0 items-center gap-1 text-[12px] text-ink-3 hover:text-ink" title={t('meeting.whoLater')}>
          {t('meeting.whoLater')} <X size={12} />
        </button>
      </div>
      <div className="mt-3 flex flex-col divide-y divide-line">
        {labels.map((label) => {
          const mine = segments.filter((s) => s.speaker === label)
          const longest = mine.reduce<(typeof mine)[number] | null>((a, s) => (!a || s.end - s.start > a.end - a.start ? s : a), null)
          return (
            <div key={label} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: speakerColor(label, meta.speakers) }} />
              <span className="text-[13px] font-medium">{speakerName(label, meta.speakers, lang, userName)}</span>
              <span className="tabular text-[11.5px] text-ink-3">{fmtClock(talkTime(segments, label))}</span>
              {onSeek && longest && (
                <button onClick={() => onSeek(longest.start)} className="flex items-center gap-1 text-[11.5px] text-ink-2 hover:text-ink" title={longest.text}>
                  <Play size={10} fill="currentColor" className="rtl:-scale-x-100" /> {t('meeting.whoListen')}
                </button>
              )}
              <div className="flex flex-1 flex-wrap items-center justify-end gap-1.5">
                <NameChips meeting={meeting} label={label} userName={userName} onDone={onDone} />
                <input
                  placeholder={t('meeting.whoOther')}
                  onKeyDown={(e) => {
                    const v = (e.target as HTMLInputElement).value.trim()
                    if (e.key === 'Enter' && v) void invoke('meetings:renameSpeaker', meta.id, label, v, true).then(onDone)
                  }}
                  dir="auto"
                  className="h-7 w-32 rounded-full border border-line bg-transparent px-2.5 text-[12px] outline-none focus:border-accent/50"
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
