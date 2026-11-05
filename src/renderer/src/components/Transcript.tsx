import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { Segment, SpeakerInfo } from '@shared/types'
import { fmtClock, paragraphs, speakerName } from '@shared/transcript'
import { highlight, speakerColor } from '../lib/format'
import { cn } from './ui'

/**
 * Transcript paragraphs: consecutive lines of one speaker grouped under their name.
 * Every line sets its own text direction, so Hebrew, English and mixed lines all read right.
 */
export function Transcript({
  segments,
  speakers,
  userName,
  query = '',
  activeId,
  onSeek,
  animate = false,
  compact = false
}: {
  segments: Segment[]
  speakers: Record<string, SpeakerInfo>
  userName: string
  query?: string
  activeId?: string | null
  onSeek?: (t: number) => void
  animate?: boolean
  compact?: boolean
}) {
  const { i18n } = useTranslation()
  const lang = i18n.language as 'he' | 'en'
  return (
    <div className={cn('flex flex-col', compact ? 'gap-3' : 'gap-5')}>
      {paragraphs(segments, compact ? 12 : 25).map((p) => {
        const color = speakerColor(p.speaker, speakers)
        return (
          <div key={p.lines[0].id} className="flex gap-3">
            <div className="mt-1 w-[3px] shrink-0 rounded-full opacity-70" style={{ background: color }} />
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[12.5px] font-semibold" style={{ color }}>
                  {speakerName(p.speaker, speakers, lang, userName)}
                </span>
                <button
                  onClick={() => onSeek?.(p.start)}
                  className={cn('tabular text-[11.5px] text-ink-3', onSeek && 'hover:text-accent')}
                  disabled={!onSeek}
                >
                  {fmtClock(p.start)}
                </button>
              </div>
              <div className={cn('selectable', compact ? 'text-[13.5px] leading-[1.65]' : 'text-[15px] leading-[1.75]')}>
                {p.lines.map((l) => {
                  const body = (
                    <span
                      key={l.id}
                      id={`seg-${l.id}`}
                      dir="auto"
                      onDoubleClick={() => onSeek?.(l.start)}
                      className={cn(
                        'bidi block rounded-md transition-colors',
                        activeId === l.id && 'bg-accent-soft',
                        onSeek && 'hover:bg-line/60'
                      )}
                    >
                      {highlight(l.text, query).map((h, i) => (h.hit ? <mark key={i}>{h.text}</mark> : <span key={i}>{h.text}</span>))}
                    </span>
                  )
                  return animate ? (
                    <motion.span key={l.id} initial={{ opacity: 0, y: 4, filter: 'blur(2px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.35 }} className="block">
                      {body}
                    </motion.span>
                  ) : (
                    body
                  )
                })}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
