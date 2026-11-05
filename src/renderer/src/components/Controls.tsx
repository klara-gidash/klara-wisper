import { Check, Mic, Radio, Square, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Levels } from '@shared/types'
import { invoke, useAppState, useEvent } from '../lib/api'
import { Button, Kbd, Spinner, cn } from './ui'
import { Waveform } from './Waveform'

interface DictState {
  phase: 'idle' | 'recording' | 'transcribing'
  handsFree: boolean
  source: string
  lastText: string
}

/** Click to dictate (no special key needed). The text lands on the clipboard and in the list. */
export function DictateButton({ large = false, compact = false }: { large?: boolean; compact?: boolean }) {
  const { t } = useTranslation()
  const app = useAppState()
  const [st, setSt] = useState<DictState>({ phase: 'idle', handsFree: false, source: 'button', lastText: '' })
  const [db, setDb] = useState<number>()
  useEffect(() => void invoke<DictState>('dictation:state').then(setSt), [])
  useEvent<DictState>('dictation:state', setSt)
  useEvent<Levels>('levels', (l) => setDb(l.mic))
  const ready = app?.engine.state === 'ready'

  if (compact) {
    const rec = st.phase === 'recording'
    return (
      <button
        onClick={() => void invoke('dictation:toggle')}
        disabled={!ready || st.phase === 'transcribing'}
        title={`${rec ? t('dict.stop') : t('dict.start')} · ⌃⌥Space`}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-medium shadow-sm transition-all active:scale-[0.98] disabled:opacity-40',
          rec ? 'bg-rec text-white' : 'bg-ink text-bg hover:opacity-90'
        )}
      >
        {rec ? <Square size={11} fill="currentColor" /> : st.phase === 'transcribing' ? <Spinner /> : <Mic size={13} />}
        {rec ? t('dict.listening') : st.phase === 'transcribing' ? t('dict.transcribing') : t('home.dictate')}
      </button>
    )
  }

  return (
    <div className={cn('flex items-center gap-4', large && 'rounded-2xl border border-line bg-panel p-4 shadow-card')}>
      <button
        onClick={() => void invoke('dictation:toggle')}
        disabled={!ready || st.phase === 'transcribing'}
        title={st.phase === 'recording' ? t('dict.stop') : t('dict.start')}
        className={cn(
          'grid shrink-0 place-items-center rounded-full text-white shadow-md transition-all active:scale-95 disabled:opacity-40',
          large ? 'size-14' : 'size-11',
          st.phase === 'recording' ? 'bg-rec' : 'bg-ink text-bg'
        )}
      >
        {st.phase === 'recording' ? <Square size={large ? 18 : 15} fill="currentColor" /> : st.phase === 'transcribing' ? <Spinner /> : <Mic size={large ? 22 : 18} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">
          {st.phase === 'recording' ? t('dict.listening') : st.phase === 'transcribing' ? t('dict.transcribing') : t('dict.start')}
        </div>
        {st.phase === 'recording' ? (
          <div className="mt-1.5">
            <Waveform db={db} bars={22} height={18} color="var(--rec)" barWidth={2.5} gap={2} />
          </div>
        ) : st.lastText && st.source === 'button' ? (
          <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-2">
            <Check size={13} className="shrink-0 text-ok" />
            <span dir="auto" className="bidi truncate">{t('dict.copiedText', { text: st.lastText })}</span>
          </div>
        ) : (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-2">
            {t('dict.orAnywhere')} <Kbd>⌃⌥Space</Kbd> {t('dict.or')} <Kbd>fn</Kbd>
          </div>
        )}
      </div>
    </div>
  )
}

/** Start or stop a recording by hand (calls also start and stop by themselves). */
export function RecordControls({ mode }: { mode: 'meeting' | 'inperson' }) {
  const { t } = useTranslation()
  const app = useAppState()
  const [busy, setBusy] = useState(false)
  const live = app?.live
  const ready = app?.engine.state === 'ready'

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      window.alert(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  if (live) {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void invoke('live:show')}>
          <span className="rec-dot" /> {t('rec.showLive')}
        </Button>
        <Button variant="rec" size="sm" disabled={busy || live.phase !== 'recording'} icon={<Square size={11} fill="currentColor" />} onClick={() => void run(() => invoke('live:stop'))}>
          {live.phase === 'recording' ? t('rec.stop') : t('live.processing')}
        </Button>
      </div>
    )
  }
  return (
    <Button
      variant="primary"
      size="sm"
      disabled={busy || !ready}
      icon={mode === 'inperson' ? <Users size={14} /> : <Radio size={14} />}
      onClick={() => void run(() => invoke('live:start', mode === 'inperson' ? { mode, source: 'inperson' } : { mode, source: 'other' }))}
    >
      {mode === 'inperson' ? t('rec.startInperson') : t('rec.startCall')}
    </Button>
  )
}
