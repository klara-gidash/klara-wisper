import { Headphones, MessageSquare, Phone, Users, Video } from 'lucide-react'
import type { MeetingSource } from '@shared/types'
import { cn } from './ui'

const STYLE: Record<MeetingSource, { bg: string; fg: string; Icon: typeof Video }> = {
  zoom: { bg: '#E8F1FF', fg: '#2D6CDF', Icon: Video },
  meet: { bg: '#E6F4EE', fg: '#13845B', Icon: Video },
  teams: { bg: '#ECEBFA', fg: '#5B5FC7', Icon: MessageSquare },
  slack: { bg: '#F5E9F3', fg: '#7C2E73', Icon: Headphones },
  facetime: { bg: '#E7F6EA', fg: '#1F9D45', Icon: Video },
  webex: { bg: '#E6F3F8', fg: '#0A7EA4', Icon: Video },
  aircall: { bg: '#E3F7EF', fg: '#0B8A5A', Icon: Phone },
  whatsapp: { bg: '#E4F7E9', fg: '#128C4A', Icon: Phone },
  telegram: { bg: '#E5F3FB', fg: '#1C83C2', Icon: Phone },
  discord: { bg: '#ECEDFB', fg: '#5865D2', Icon: Headphones },
  signal: { bg: '#E8EEFB', fg: '#3463D6', Icon: Phone },
  messenger: { bg: '#EAF0FF', fg: '#2F5FE0', Icon: MessageSquare },
  goto: { bg: '#FFF1E6', fg: '#C25A00', Icon: Video },
  inperson: { bg: '#FFF2DF', fg: '#B86E00', Icon: Users },
  other: { bg: '#EFEFF1', fg: '#5B5B64', Icon: Phone }
}

export function SourceIcon({ source, size = 32, className }: { source: MeetingSource; size?: number; className?: string }) {
  const s = STYLE[source] ?? STYLE.other
  const Icon = s.Icon
  return (
    <span
      className={cn('inline-grid shrink-0 place-items-center rounded-[9px] dark:brightness-90', className)}
      style={{ width: size, height: size, background: s.bg, color: s.fg }}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={2} />
    </span>
  )
}
