import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { timeAt, unsurePieces } from '@shared/confidence'
import type { Segment, SpeakerInfo } from '@shared/types'
import { fmtClock, paragraphs, speakerName } from '@shared/transcript'
import { highlight, speakerColor } from '../lib/format'
import { cn } from './ui'

/**
 * Transcript paragraphs: consecutive lines of one speaker grouped under their name.
 * Every line sets its own text direction, so Hebrew, English and mixed lines all read right.
 * With showUnsure, words the model was unsure of get a dotted underline; clicking one plays the
 * recording from about there (when there is audio).
 */
export function Transcript({
  segments,
  speakers,
  userName,
  query = '',
  activeId,
  onSeek,
  animate = false,
  compact = false,
  showUnsure = false
}: {
  segments: Segment[]
  speakers: Record<string, SpeakerInfo>
  userName: string
  query?: string
  activeId?: string | null
  onSeek?: (t: number) => void
  animate?: boolean
  compact?: boolean
  showUnsure?: boolean
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'he' | 'en'
  const marks = (text: string, key: string): ReactNode[] =>
    highlight(text, query).map((h, i) => (h.hit ? <mark key={`${key}.${i}`}>{h.text}</mark> : <span key={`${key}.${i}`}>{h.text}</span>))
  const body = (l: Segment): ReactNode[] => {
    if (!showUnsure) return marks(l.text, 'p')
    return unsurePieces(l).flatMap((piece) =>
      !piece.unsure ? (
        marks(piece.text, `p${piece.at}`)
      ) : (
        <span
          key={`u${piece.at}`}
          className={cn('unsure', onSeek && 'playable')}
          title={t(onSeek ? 'meeting.unsurePlay' : 'meeting.unsure')}
          onClick={
            onSeek
              ? (e) => {
                  e.stopPropagation()
                  onSeek(Math.max(l.start, timeAt(l, piece.at) - 1)) // a second of lead-in
                }
              : undefined
          }
        >
          {marks(piece.text, `u${piece.at}`)}
        </span>
      )
    )
  }
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
                  const line = (
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
                      {body(l)}
                    </span>
                  )
                  return animate ? (
                    <motion.span key={l.id} initial={{ opacity: 0, y: 4, filter: 'blur(2px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.35 }} className="block">
                      {line}
                    </motion.span>
                  ) : (
                    line
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
