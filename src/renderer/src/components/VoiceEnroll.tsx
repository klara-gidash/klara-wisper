import { Check, Mic, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Levels } from '@shared/types'
import { invoke, useAppState, useEvent } from '../lib/api'
import { Button, Spinner } from './ui'
import { Waveform } from './Waveform'

const SECONDS = 20

/** Records ~20 s of the user's voice so in-person transcripts can label her lines automatically. */
export function VoiceEnroll({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation()
  const app = useAppState()
  const [phase, setPhase] = useState<'idle' | 'recording' | 'saving' | 'done'>('idle')
  const [left, setLeft] = useState(SECONDS)
  const [db, setDb] = useState<number>()
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEvent<Levels>('levels', (l) => setDb(l.mic))
  const enrolled = !!app?.engine.voiceprintKeys?.me

  const stop = async (): Promise<void> => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    setPhase('saving')
    await invoke('voiceprint:stop')
    setPhase('done')
    onDone?.()
  }

  const start = async (): Promise<void> => {
    await invoke('voiceprint:start')
    setPhase('recording')
    setLeft(SECONDS)
    const began = Date.now()
    timer.current = setInterval(() => {
      const l = SECONDS - Math.floor((Date.now() - began) / 1000)
      setLeft(l)
      if (l <= 0) void stop()
    }, 250)
  }

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12.5px] leading-relaxed text-ink-2">{t('voice.why')}</div>
      {phase === 'recording' && (
        <div className="selectable rounded-xl bg-panel-2 p-4 text-[14.5px] leading-[1.8]">
          <p dir="rtl">{t('voice.readHe')}</p>
          <p dir="ltr" className="mt-2">{t('voice.readEn')}</p>
        </div>
      )}
      <div className="flex items-center gap-3">
        {phase === 'idle' && (
          <Button variant={enrolled ? 'secondary' : 'primary'} icon={<Mic size={14} />} onClick={() => void start()} disabled={app?.engine.state !== 'ready' || !!app?.live}>
            {enrolled ? t('voice.again') : t('voice.start')}
          </Button>
        )}
        {phase === 'recording' && (
          <>
            <Button variant="rec" icon={<Square size={11} fill="currentColor" />} onClick={() => void stop()} disabled={SECONDS - left < 6}>
              {t('voice.finish')}
            </Button>
            <Waveform db={db} bars={16} height={22} color="var(--accent)" />
            <span className="tabular text-[12.5px] text-ink-3">{left}s</span>
          </>
        )}
        {phase === 'saving' && (
          <span className="flex items-center gap-2 text-[12.5px] text-ink-2"><Spinner /> {t('voice.saving')}</span>
        )}
        {(phase === 'done' || (phase === 'idle' && enrolled)) && (
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ok"><Check size={14} /> {t('voice.saved')}</span>
        )}
      </div>
    </div>
  )
}
