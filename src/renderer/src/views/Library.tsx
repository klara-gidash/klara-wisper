import { AudioLines, CalendarDays, Keyboard, Search, Settings as SettingsIcon, Users, Video } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SOURCE_LABEL } from '@shared/types'
import { StatusDot, cn } from '../components/ui'
import { invoke, useAppState, useEvent } from '../lib/api'
import { modelName } from '../lib/format'
import { Dictations } from './Dictations'
import { Home } from './Home'
import { MeetingList } from './MeetingList'
import { MeetingView } from './MeetingView'
import { Onboarding } from './Onboarding'
import { SearchView } from './SearchView'
import { Settings } from './Settings'

export function useRoute(): [string, (r: string) => void] {
  const read = (): string => decodeURIComponent(window.location.hash.replace(/^#\/?/, '')) || 'library'
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = (): void => setRoute(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  useEvent<string>('navigate', (r) => (window.location.hash = `/${r}`))
  return [route, (r: string) => (window.location.hash = `/${r}`)]
}

function NavItem({ icon, label, active, onClick, trailing }: { icon: ReactNode; label: string; active: boolean; onClick: () => void; trailing?: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex h-8 w-full items-center gap-2.5 rounded-[9px] px-2.5 text-[13.5px] transition-colors',
        active ? 'font-semibold text-ink' : 'text-ink-2 hover:bg-line hover:text-ink'
      )}
    >
      {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-[9px] bg-line-strong/70" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
      <span className="relative opacity-80">{icon}</span>
      <span className="relative flex-1 text-start">{label}</span>
      {trailing && <span className="relative">{trailing}</span>}
    </button>
  )
}

export function Library() {
  const { t } = useTranslation()
  const app = useAppState()
  const [route, go] = useRoute()
  const [query, setQuery] = useState('')

  if (route === 'onboarding') return <Onboarding onDone={() => go('library')} />

  const [section, arg] = route.split('/')
  const live = app?.live
  const engine = app?.engine

  let content: ReactNode
  if (section === 'meeting' && arg) content = <MeetingView id={arg} onBack={() => history.back()} />
  else if (section === 'meetings') content = <MeetingList mode="meeting" onOpen={(id) => go(`meeting/${id}`)} />
  else if (section === 'inperson') content = <MeetingList mode="inperson" onOpen={(id) => go(`meeting/${id}`)} />
  else if (section === 'dictations') content = <Dictations />
  else if (section === 'settings') content = <Settings />
  else if (section === 'search') content = <SearchView query={query} onOpen={(id, q) => go(`meeting/${id}?q=${encodeURIComponent(q)}&t=0`)} />
  else
    content = (
      <Home
        onOpen={(id) => go(`meeting/${id}`)}
        go={go}
        onSearch={(q) => {
          setQuery(q)
          go('search')
        }}
      />
    )

  const engineTone = engine?.state === 'ready' ? 'ok' : engine?.state === 'error' || engine?.state === 'missing' ? 'rec' : 'warn'

  return (
    <div className="flex h-full">
      {/* sidebar */}
      <aside className="flex w-[232px] shrink-0 flex-col border-e border-line bg-[var(--sidebar)]">
        <div className="drag h-[52px] shrink-0" />
        <div className="px-3 pb-3">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                if (e.target.value.trim()) go('search')
              }}
              placeholder={t('nav.search')}
              className="h-8 w-full rounded-[9px] border border-line bg-panel/70 ps-8 pe-2 text-[13px] outline-none placeholder:text-ink-3 focus:border-accent/50 focus:ring-2 focus:ring-accent/15"
            />
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          <NavItem icon={<CalendarDays size={16} />} label={t('nav.today')} active={section === 'library' || section === ''} onClick={() => go('library')} />
          <NavItem icon={<Video size={16} />} label={t('nav.meetings')} active={section === 'meetings'} onClick={() => go('meetings')} />
          <NavItem icon={<Users size={16} />} label={t('nav.inperson')} active={section === 'inperson'} onClick={() => go('inperson')} />
          <NavItem icon={<Keyboard size={16} />} label={t('nav.dictations')} active={section === 'dictations'} onClick={() => go('dictations')} />
        </nav>
        <div className="flex-1" />
        {live && (
          <button
            onClick={() => void invoke('live:show')}
            className="mx-3 mb-3 flex items-center gap-2.5 rounded-xl bg-rec-soft px-3 py-2.5 text-start"
          >
            <span className="rec-dot" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-rec">{live.phase === 'recording' ? t('nav.recording') : t('live.processing')}</span>
              <span className="block truncate text-[11.5px] text-ink-2">{live.title || SOURCE_LABEL[live.source]}</span>
            </span>
          </button>
        )}
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          <NavItem icon={<SettingsIcon size={16} />} label={t('nav.settings')} active={section === 'settings'} onClick={() => go('settings')} />
          <div className="flex items-center gap-2 px-2.5 pt-2 text-[11.5px] text-ink-3" title={engine?.error ?? ''}>
            <StatusDot tone={engineTone} />
            <AudioLines size={13} />
            <span className="truncate">
              {engine?.state === 'ready' ? `${modelName(engine.asr)} · ${t('engine.ready')}` : engine?.state === 'missing' ? (app?.setup.running ? t('engine.installing', { pct: Math.round(app.setup.progress * 100) }) : t('engine.missing')) : t('engine.loading')}
            </span>
          </div>
        </div>
      </aside>

      {/* content */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-bg">
        <div className="drag absolute inset-x-0 top-0 h-[44px]" />
        <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
      </main>
    </div>
  )
}
