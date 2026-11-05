import { Check, MicOff } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Levels, PillState } from '@shared/types'
import { Waveform } from '../components/Waveform'
import { useEvent } from '../lib/api'

/** The floating dictation capsule at the bottom of the screen (click-through, never takes focus). */
export function Pill() {
  const { t } = useTranslation()
  const [state, setState] = useState<PillState>({ phase: 'hidden' })
  const [db, setDb] = useState<number | undefined>()
  useEvent<PillState>('pill', setState)
  useEvent<Levels>('levels', (l) => setDb(l.mic))

  return (
    <div className="flex h-full items-end justify-center pb-3">
      <AnimatePresence>
        {state.phase !== 'hidden' && (
          <motion.div
            key="pill"
            initial={{ opacity: 0, y: 12, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
            className="flex h-[46px] items-center gap-3 rounded-full px-[18px] text-white"
            style={{
              background: 'rgba(18,18,21,0.9)',
              backdropFilter: 'blur(24px) saturate(1.4)',
              boxShadow: '0 10px 32px rgba(0,0,0,0.32), inset 0 0 0 0.5px rgba(255,255,255,0.14)'
            }}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {state.phase === 'listening' && (
                <motion.div key="l" className="flex items-center gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <span className="rec-dot" />
                  <Waveform db={db} bars={18} height={22} color="#fff" barWidth={2.5} gap={2.5} />
                  {state.handsFree && <span className="text-[12px] font-medium text-white/60">{t('pill.handsFree')}</span>}
                </motion.div>
              )}
              {state.phase === 'transcribing' && (
                <motion.div key="t" className="flex items-center gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <div className="relative overflow-hidden rounded-full">
                    <Waveform db={-40} bars={18} height={22} color="rgba(255,255,255,0.5)" barWidth={2.5} gap={2.5} active={false} />
                    <div className="shimmer absolute inset-0" />
                  </div>
                  <span className="text-[13px] font-medium text-white/80">{t('pill.transcribing')}</span>
                </motion.div>
              )}
              {state.phase === 'done' && (
                <motion.div key="d" className="flex max-w-[260px] items-center gap-2.5" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#45c08a]">
                    <Check size={13} strokeWidth={3} />
                  </span>
                  <span dir="auto" className="bidi truncate text-[13px] font-medium">
                    {state.pasted ? state.text : t('pill.copied')}
                  </span>
                </motion.div>
              )}
              {state.phase === 'error' && (
                <motion.div key="e" className="flex items-center gap-2" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <MicOff size={15} className="text-white/60" />
                  <span className="text-[13px] font-medium text-white/80">{state.message}</span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
