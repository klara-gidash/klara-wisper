import { ArrowLeft, ArrowRight, Bookmark, Copy, FolderOpen, Pause, Play, Search, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Meeting } from '@shared/types'
import { SOURCE_LABEL } from '@shared/types'
import { fmtClock, fmtDuration, speakerName } from '@shared/transcript'
import { SourceIcon } from '../components/SourceIcon'
import { Transcript } from '../components/Transcript'
import { Button, IconButton, Segmented, Spinner, Toggle, cn } from '../components/ui'
import { invoke, useAppState, useEvent } from '../lib/api'
import { dayLabel, speakerColor, timeHM } from '../lib/format'

function Markdown({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>))
  return (
    <div className="selectable flex flex-col gap-2 text-[14.5px] leading-[1.75]">
      {text.split('\n').map((line, i) => {
        const l = line.trimEnd()
        if (!l.trim()) return <div key={i} className="h-1" />
        const h = /^(#{1,3})\s+(.*)$/.exec(l)
        if (h) return <div key={i} dir="auto" className={cn('bidi font-semibold', h[1].length === 1 ? 'mt-2 text-[18px]' : 'mt-2 text-[15.5px]')}>{inline(h[2])}</div>
        const b = /^\s*[-*•]\s+(.*)$/.exec(l) ?? /^\s*\d+[.)]\s+(.*)$/.exec(l)
        if (b) return <div key={i} dir="auto" className="bidi flex gap-2 ps-1"><span className="text-ink-3">•</span><span>{inline(b[1])}</span></div>
        return <p key={i} dir="auto" className="bidi">{inline(l)}</p>
      })}
    </div>
  )
}

export function MeetingView({ id: rawId, onBack }: { id: string; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'he' | 'en'
  const app = useAppState()
  const [id, qs] = rawId.split('?')
  const params = new URLSearchParams(qs ?? '')
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [tab, setTab] = useState<'transcript' | 'notes' | 'speakers'>('transcript')
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [editingTitle, setEditingTitle] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [rate, setRate] = useState(1)

  const load = (): void => void invoke<Meeting>('meetings:get', id).then(setMeeting)
  useEffect(load, [id])
  useEvent<string | null>('meetings:changed', (changed) => (!changed || changed === id) && load())

  const flash = (msg: string): void => {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }

  const segments = meeting?.segments ?? []
  const meta = meeting?.meta
  const userName = app?.settings.userName ?? ''
  const duration = meta?.durationSec ?? 0
  const activeId = useMemo(() => (playing || time > 0 ? segments.find((s) => s.start <= time && time < s.end + 0.3)?.id ?? null : null), [segments, time, playing])
  const matches = useMemo(() => (query.trim() ? segments.filter((s) => s.text.toLowerCase().includes(query.trim().toLowerCase())) : []), [segments, query])

  useEffect(() => {
    if (!activeId || !playing) return
    document.getElementById(`seg-${activeId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeId, playing])

  /** Two-channel recordings (me | them) are mixed to mono for listening. */
  const ensureMix = (): void => {
    if (ctxRef.current || !audioRef.current) return
    const ctx = new AudioContext()
    const src = ctx.createMediaElementSource(audioRef.current)
    const mix = ctx.createGain()
    mix.channelCount = 1
    mix.channelCountMode = 'explicit'
    mix.channelInterpretation = 'speakers'
    mix.gain.value = 1.4
    src.connect(mix).connect(ctx.destination)
    ctxRef.current = ctx
  }

  const seek = (t0: number): void => {
    const a = audioRef.current
    if (!a || !meta?.hasAudio) return
    ensureMix()
    a.currentTime = Math.max(0, t0 - 0.3)
    void a.play()
  }

  const toggle = (): void => {
    const a = audioRef.current
    if (!a) return
    ensureMix()
    if (a.paused) void a.play()
    else a.pause()
  }

  if (!meeting || !meta) {
    return (
      <div className="grid h-full place-items-center text-ink-3">
        <Spinner />
      </div>
    )
  }

  const Back = lang === 'he' ? ArrowRight : ArrowLeft
  const askClaude = async (): Promise<void> => {
    const prompt =
      lang === 'he'
        ? `לסכם את הפגישה ${meta.id} מ-Klara Wisper: נקודות עיקריות, החלטות ומשימות לפי אחראי. אחר כך לשמור את הסיכום עם save_meeting_notes.`
        : `Summarize Klara Wisper meeting ${meta.id}: key points, decisions and action items by owner. Then save it with save_meeting_notes.`
    await invoke('clipboard:write', prompt)
    void invoke('app:openExternal', 'claude://')
    flash(t('meeting.claudeCopied'))
  }

  const speakerLabels = Object.keys(meta.speakers ?? {}).length ? Object.keys(meta.speakers) : [...new Set(segments.map((s) => s.speaker ?? ''))].filter(Boolean)

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto w-full max-w-[860px] flex-1 px-10 pb-32 pt-12">
        {/* header */}
        <button onClick={onBack} className="no-drag mb-4 flex items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink">
          <Back size={14} /> {t('meeting.back')}
        </button>
        <div className="flex items-start gap-4">
          <SourceIcon source={meta.source} size={44} className="mt-1" />
          <div className="min-w-0 flex-1">
            {editingTitle ? (
              <input
                autoFocus
                defaultValue={meta.title}
                onBlur={(e) => {
                  setEditingTitle(false)
                  const v = e.target.value.trim()
                  if (v && v !== meta.title) void invoke('meetings:rename', id, v).then(load)
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                className="w-full rounded-lg border border-line-strong bg-panel px-2 py-1 text-[24px] font-semibold tracking-[-0.02em] outline-none"
              />
            ) : (
              <h1 dir="auto" onClick={() => setEditingTitle(true)} className="bidi cursor-text text-[24px] font-semibold leading-tight tracking-[-0.02em]" title={t('meeting.rename')}>
                {meta.title}
              </h1>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-2">
              <span>{dayLabel(meta.startedAt, lang)}</span>
              <span className="text-ink-3">·</span>
              <span className="tabular">{timeHM(meta.startedAt, lang)}</span>
              <span className="text-ink-3">·</span>
              <span>{fmtDuration(meta.durationSec, lang)}</span>
              <span className="text-ink-3">·</span>
              <span>{meta.source === 'inperson' ? t('nav.inperson') : SOURCE_LABEL[meta.source]}</span>
              {meta.languages?.length ? (
                <>
                  <span className="text-ink-3">·</span>
                  {meta.languages.map((l) => (
                    <span key={l} className="rounded-md bg-line px-1.5 text-[10.5px] font-semibold uppercase tracking-wide">{l}</span>
                  ))}
                </>
              ) : null}
            </div>
            {(meta.attendees?.length ?? 0) > 0 ? (
              <div className="mt-2 text-[12.5px] text-ink-3">{meta.attendees!.map((a) => a.name || a.email).join(' · ')}</div>
            ) : meta.inferredParticipants ? (
              <div className="mt-2 text-[12.5px] text-ink-3">
                {meta.inferredParticipants.length ? meta.inferredParticipants.join(' · ') : t('meeting.participantsUnknown')}
              </div>
            ) : null}
            {meta.scope && <div className="mt-1.5 max-w-[60ch] text-[13px] leading-relaxed text-ink-2">{meta.scope}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" icon={<Sparkles size={13} />} onClick={() => void askClaude()}>{t('meeting.askClaude')}</Button>
            <IconButton title={t('meeting.copy')} onClick={() => void invoke('meetings:copy', id).then(() => flash(t('meeting.copied')))}>
              <Copy size={15} />
            </IconButton>
            <IconButton title={t('meeting.reveal')} onClick={() => void invoke('meetings:reveal', id)}>
              <FolderOpen size={15} />
            </IconButton>
            <IconButton
              title={t('meeting.delete')}
              className="hover:text-rec"
              onClick={() => {
                if (window.confirm(t('meeting.deleteConfirm'))) void invoke('meetings:delete', id).then(onBack)
              }}
            >
              <Trash2 size={15} />
            </IconButton>
          </div>
        </div>

        {/* tabs + search */}
        <div className="mt-7 flex items-center justify-between gap-3 border-b border-line pb-3">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'transcript' as const, label: t('meeting.transcript') },
              { value: 'notes' as const, label: t('meeting.notes') },
              { value: 'speakers' as const, label: t('meeting.speakers') }
            ]}
          />
          {tab === 'transcript' && (
            <div className="relative w-56">
              <Search size={13} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matches.length) {
                    const cur = matches.findIndex((m) => m.start > time + 0.5)
                    const next = matches[cur < 0 ? 0 : cur]
                    setTime(next.start)
                    document.getElementById(`seg-${next.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  }
                }}
                placeholder={t('meeting.find')}
                className="h-8 w-full rounded-[9px] border border-line bg-panel ps-8 pe-12 text-[12.5px] outline-none focus:border-accent/50"
              />
              {query && <span className="tabular absolute end-2.5 top-1/2 -translate-y-1/2 text-[11px] text-ink-3">{matches.length}</span>}
            </div>
          )}
        </div>

        <div className="mt-6">
          {tab === 'transcript' &&
            (segments.length === 0 ? (
              <div className="py-16 text-center text-[13px] text-ink-3">{meta.status === 'error' ? meta.error : t('meeting.emptyTranscript')}</div>
            ) : (
              <Transcript segments={segments} speakers={meta.speakers} userName={userName} query={query} activeId={activeId} onSeek={meta.hasAudio ? seek : undefined} />
            ))}
          {tab === 'notes' &&
            (meeting.summary ? (
              <Markdown text={meeting.summary} />
            ) : (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <Sparkles size={22} className="text-ink-3" />
                <div className="max-w-sm text-[13px] leading-relaxed text-ink-2">{t('meeting.noNotes')}</div>
                <Button size="sm" onClick={() => void askClaude()}>{t('meeting.askClaude')}</Button>
              </div>
            ))}
          {tab === 'speakers' && (
            <div className="flex flex-col gap-2">
              {speakerLabels.map((label) => {
                const info = meta.speakers?.[label]
                const lines = segments.filter((s) => s.speaker === label)
                const talk = lines.reduce((a, s) => a + (s.end - s.start), 0)
                return (
                  <div key={label} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
                    <span className="size-3 rounded-full" style={{ background: speakerColor(label, meta.speakers) }} />
                    <input
                      defaultValue={info?.name ?? ''}
                      placeholder={speakerName(label, meta.speakers, lang, userName)}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        if (v && v !== info?.name) void invoke('meetings:renameSpeaker', id, label, v, false).then(load)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      className="min-w-0 flex-1 bg-transparent text-[14px] font-medium outline-none placeholder:text-ink"
                    />
                    <span className="tabular text-[12px] text-ink-3">
                      {t('meeting.talkTime', { time: fmtClock(talk), count: lines.length })}
                    </span>
                    {info?.embedding?.length ? (
                      <label className="flex items-center gap-2 text-[12px] text-ink-2">
                        {t('meeting.rememberVoice')}
                        <Toggle
                          checked={!!info.key}
                          onChange={(v) => v && void invoke('meetings:renameSpeaker', id, label, info.name || speakerName(label, meta.speakers, lang, userName), true).then(load)}
                        />
                      </label>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* player */}
      {meta.hasAudio && (
        <div className="sticky bottom-0 z-20 border-t border-line bg-bg/85 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[860px] items-center gap-4 px-10 py-3">
            <button onClick={toggle} className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-bg transition-transform active:scale-95">
              {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ms-0.5 rtl:-scale-x-100" />}
            </button>
            <span className="tabular w-12 text-[12px] text-ink-2">{fmtClock(time)}</span>
            <div
              dir="ltr"
              className="relative h-8 flex-1 cursor-pointer"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
                seek(((e.clientX - r.left) / r.width) * duration)
              }}
            >
              <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line-strong" />
              <div className="absolute start-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
              {segments.map((s) => (
                <span key={s.id} className="absolute top-1/2 h-1 -translate-y-1/2 opacity-50" style={{ left: `${(s.start / Math.max(duration, 1)) * 100}%`, width: `${Math.max(0.15, ((s.end - s.start) / Math.max(duration, 1)) * 100)}%`, background: speakerColor(s.speaker, meta.speakers) }} />
              ))}
              {(meta.bookmarks ?? []).map((b) => (
                <Bookmark key={b} size={11} className="absolute top-0 -translate-x-1/2 fill-warn text-warn" style={{ left: `${(b / Math.max(duration, 1)) * 100}%` }} />
              ))}
            </div>
            <span className="tabular w-12 text-end text-[12px] text-ink-3">{fmtClock(duration)}</span>
            <button
              onClick={() => {
                const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1
                setRate(next)
                if (audioRef.current) audioRef.current.playbackRate = next
              }}
              className="tabular h-7 w-11 rounded-md bg-line text-[12px] font-semibold"
            >
              {rate}×
            </button>
          </div>
          <audio
            ref={audioRef}
            src={`klara-media://${id}/audio.m4a`}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setTime((e.target as HTMLAudioElement).currentTime)}
          />
        </div>
      )}

      {toast && (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[12.5px] font-medium text-bg shadow-lg">{toast}</div>
      )}
    </div>
  )
}
