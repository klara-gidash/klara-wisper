import { useEffect, useRef, useState } from 'react'

/**
 * Live audio bars. `db` is the current level in dBFS (about -60 silent … -10 loud).
 * Bars are shaped like a voice envelope (taller in the middle) and wobble a little so the
 * animation reads as "listening" rather than a meter.
 */
export function Waveform({
  db,
  bars = 14,
  height = 22,
  color = 'currentColor',
  active = true,
  barWidth = 3,
  gap = 2.5
}: {
  db: number | undefined
  bars?: number
  height?: number
  color?: string
  active?: boolean
  barWidth?: number
  gap?: number
}) {
  const [heights, setHeights] = useState<number[]>(() => Array(bars).fill(0.12))
  const level = useRef(0)
  const target = db === undefined || !active ? 0 : Math.min(1, Math.max(0, (db + 58) / 42))
  level.current = target

  useEffect(() => {
    let raf = 0
    let smooth = 0
    const tick = (time: number): void => {
      smooth += (level.current - smooth) * 0.25
      setHeights((prev) =>
        prev.map((h, i) => {
          const center = 1 - Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2 + 0.5)
          const wobble = 0.55 + 0.45 * Math.sin(time / 140 + i * 1.7) * Math.sin(time / 330 + i * 0.6)
          const want = 0.12 + smooth * (0.35 + 0.65 * center) * wobble
          return h + (want - h) * 0.35
        })
      )
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [bars])

  return (
    <div className="flex items-center" style={{ height, gap }} aria-hidden>
      {heights.map((h, i) => (
        <span
          key={i}
          className="rounded-full"
          style={{ width: barWidth, height: Math.max(barWidth, h * height), background: color, opacity: active ? 0.95 : 0.35 }}
        />
      ))}
    </div>
  )
}

/** A small horizontal level meter. */
export function LevelMeter({ db, color = 'var(--accent)' }: { db: number | undefined; color?: string }) {
  const v = db === undefined ? 0 : Math.min(1, Math.max(0, (db + 60) / 45))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
      <div className="h-full rounded-full transition-[width] duration-75" style={{ width: `${v * 100}%`, background: color }} />
    </div>
  )
}
