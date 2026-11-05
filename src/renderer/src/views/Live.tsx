import { ArrowDown, Bookmark, Check, ExternalLink, Pause, Play, Square, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Levels, LiveSession, Segment, SpeakerInfo } from '@shared/types'
import { fmtClock, speakerName } from '@shared/transcript'
import { SourceIcon } from '../components/SourceIcon'
import { Transcript } from '../components/Transcript'
import { Button, IconButton, Spinner, cn } from '../components/ui'
import { LevelMeter, Waveform } from '../components/Waveform'
import { invoke, useAppState, useEvent } from '../lib/api'
import { speakerColor } from '../lib/format'

/** Floating panel shown during a recording: live transcript, levels, pause/bookmark/stop. */
export function Live() {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'he' | 'en'
  const app = useAppState()
  const [live, setLive] = useState<LiveSession | null>(null)
  const [saved, setSaved] = useState<{ id: string; title: string } | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [speakers, setSpeakers] = useState<Record<string, SpeakerInfo>>({})
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({})
  const [levels, setLevels] = useState<Levels>({})
  const [stage, setStage] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [follow, setFollow] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const liveId = useRef<string | null>(null)

  useEffect(() => {
    void invoke<{ live: LiveSession | null; segments: Segment[]; speakers: Record<string, SpeakerInfo> }>('live:snapshot').then((s) => {
      setLive(s.live)
      liveId.current = s.live?.id ?? null
      setSegments(s.segments)
      setSpeakers(s.speakers)
    })
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])

  useEvent<LiveSession | null>('live:state', (s) => {
    if (s && s.id !== liveId.current) {
      setSegments([])
      setSpeakers({})
      setSaved(null)
      setStage(null)
    }
    if (!s && live && live.phase !== 'recording') {
      setSaved({ id: live.id, title: live.title })
      setTimeout(() => void invoke('live:hide'), 6000)
    }
    liveId.current = s?.id ?? null
    setLive(s)
  })
  useEvent<Segment>('live:segment', (seg) =>
    setSegments((prev) => [...prev.filter((p) => p.id !== seg.id), seg].sort((a, b) => a.start - b.start))
  )
  useEvent<string>('live:remove', (id) => setSegments((prev) => prev.filter((p) => p.id !== id)))
  useEvent<Record<string, SpeakerInfo>>('live:speakers', setSpeakers)
  useEvent<{ stream: string; value: boolean }>('live:speaking', ({ stream, value }) => setSpeaking((s) => ({ ...s, [stream]: value })))
  useEvent<Levels>('levels', setLevels)
  useEvent<{ stage: string; value: number }>('live:progress', (p) => setStage(p.value < 1 ? p.stage : null))

  useEffect(() => {
    if (follow) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [segments, speaking, follow])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }

  const userName = app?.settings.userName ?? ''
  const recording = live?.phase === 'recording'
  const elapsed = live ? Math.max(0, (now - new Date(live.startedAt).getTime()) / 1000) : 0
  const someoneSpeaking = Object.values(speaking).some(Boolean)
  const speakerLabels = Object.keys(speakers).filter((l) => l !== 'me' || live?.mode === 'meeting')

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-[14px] border border-line-strong bg-[var(--glass)] text-ink" dir={lang === 'he' ? 'rtl' : 'ltr'}>
      {/* header */}
      <div className="drag flex items-center gap-2.5 px-3.5 pb-2.5 pt-3">
        <SourceIcon source={live?.source ?? 'other'} size={28} />
        <div className="min-w-0 flex-1">
          {editingTitle && live ? (
            <input
              autoFocus
              defaultValue={live.title}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== live.title) void invoke('live:rename', v)
                setEditingTitle(false)
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="no-drag h-6 w-full rounded-md border border-line-strong bg-panel px-1.5 text-[13.5px] font-semibold outline-none"
            />
          ) : (
            <button
              onClick={() => live && setEditingTitle(true)}
              title={live ? t('live.renameTitle') : undefined}
              dir="auto"
              className="no-drag bidi block max-w-full truncate text-start text-[13.5px] font-semibold"
            >
              {live?.title ?? saved?.title ?? 'Klara Wisper'}
            </button>
          )}
          <div className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
            {recording && !live?.paused && <span className="rec-dot !size-1.5" />}
            <span className="tabular">{live ? fmtClock(elapsed) : ''}</span>
            {live?.paused && <span className="font-medium text-warn">· {t('live.paused')}</span>}
            {live?.mic && <span className="truncate">· {live.mic}</span>}
          </div>
        </div>
        <IconButton title={t('live.hide')} onClick={() => void invoke('live:hide')}>
          <X size={16} />
        </IconButton>
      </div>

      {/* levels / speakers */}
      {live && recording && (
        <div className="border-y border-line px-3.5 py-2.5">
          {live.mode === 'meeting' ? (
            <div className="grid grid-cols-2 gap-3 text-[11.5px] text-ink-2">
              <div className="flex flex-col gap-1.5">
                <span>{speakerName('me', speakers, lang, userName)}</span>
                <LevelMeter db={levels.mic} color="var(--accent)" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span>{t('live.others')}</span>
                <LevelMeter db={levels.system} color="#14B8A6" />
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {speakerLabels.length === 0 && <span className="text-[12px] text-ink-3">{t('live.waitingSpeakers')}</span>}
              {speakerLabels.map((label) =>
                editing === label ? (
                  <input
                    key={label}
                    autoFocus
                    defaultValue={speakers[label]?.name ?? ''}
                    placeholder={speakerName(label, speakers, lang, userName)}
                    onBlur={(e) => {
                      if (e.target.value.trim()) void invoke('live:renameSpeaker', label, e.target.value.trim())
                      setEditing(null)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    className="h-6 w-28 rounded-full border border-line-strong bg-panel px-2.5 text-[12px] outline-none"
                  />
                ) : (
                  <button
                    key={label}
                    onClick={() => setEditing(label)}
                    title={t('live.renameSpeaker')}
                    className="flex h-6 items-center gap-1.5 rounded-full bg-line px-2.5 text-[12px] font-medium hover:bg-line-strong"
                  >
                    <span className="size-2 rounded-full" style={{ background: speakerColor(label, speakers) }} />
                    {speakerName(label, speakers, lang, userName)}
                  </button>
                )
              )}
              <div className="ms-auto">
                <Waveform db={levels.mic} bars={8} height={14} color="var(--accent)" barWidth={2} gap={2} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* transcript */}
      <div ref={scroller} onScroll={onScroll} className="relative flex-1 overflow-y-auto px-3.5 py-3">
        {segments.length === 0 && recording && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-ink-3">
            <Waveform db={levels.mic ?? levels.system} bars={12} height={26} color="var(--ink-3)" />
            <span className="text-[12.5px]">{t('live.listening')}</span>
          </div>
        )}
        <Transcript segments={segments} speakers={speakers} userName={userName} animate compact />
        <AnimatePresence>
          {recording && someoneSpeaking && segments.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="typing mt-3 ps-4 text-[18px] leading-none text-ink-3">
              <span>•</span>
              <span>•</span>
              <span>•</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {!follow && segments.length > 0 && (
        <button
          onClick={() => setFollow(true)}
          className="absolute bottom-[68px] left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-ink px-3 py-1 text-[12px] font-medium text-bg shadow-lg"
        >
          <ArrowDown size={13} /> {t('live.backToLive')}
        </button>
      )}

      {/* footer */}
      <div className="border-t border-line px-3 py-2.5">
        {live?.phase === 'processing' ? (
          <div className="flex items-center justify-center gap-2 py-1 text-[12.5px] text-ink-2">
            <Spinner />
            {stage === 'diarization' ? t('live.processingSpeakers') : t('live.processing')}
          </div>
        ) : saved && !live ? (
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ok">
              <Check size={15} /> {t('live.saved')}
            </span>
            <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => void invoke('library:show', `meeting/${saved.id}`)}>
              {t('live.open')}
            </Button>
          </div>
        ) : (
          <div className={cn('flex items-center gap-1.5', !live && 'opacity-40')}>
            <IconButton title={live?.paused ? t('live.resume') : t('live.pause')} disabled={!recording} onClick={() => void invoke('live:pause', !live?.paused)}>
              {live?.paused ? <Play size={16} /> : <Pause size={16} />}
            </IconButton>
            <IconButton title={t('live.bookmark')} disabled={!recording} onClick={() => void invoke('live:bookmark')}>
              <Bookmark size={16} />
            </IconButton>
            <div className="flex-1" />
            <Button variant="rec" size="sm" disabled={!recording} icon={<Square size={11} fill="currentColor" />} onClick={() => void invoke('live:stop')}>
              {t('live.stop')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
