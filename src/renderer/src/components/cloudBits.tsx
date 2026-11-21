import { Check, ChevronDown, Copy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, cn } from './ui'
import { invoke } from '../lib/api'

/** Small pieces shared by Settings > Cloud (CloudSection.tsx) and its team part (TeamSection.tsx). */

export const cleanError = (err: unknown): string => String((err as Error)?.message ?? err).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '')

export function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      icon={copied ? <Check size={13} /> : <Copy size={13} />}
      onClick={() => {
        void invoke('clipboard:write', text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      {copied ? t('cf.copied') : t('cf.copy')}
    </Button>
  )
}

/** A link or code shown cut short (it is a credential), with Copy. */
export function SecretLink({ url }: { url: string }) {
  const short = url.startsWith('klara-team:') ? `${url.slice(0, 22)}…` : url.replace(/^(https:\/\/[^/]+\/\w+\/)(.{6}).+$/, '$1$2…')
  return (
    <div className="flex items-center gap-2">
      <span dir="ltr" className="selectable min-w-0 flex-1 truncate rounded-[10px] bg-panel-2 px-3 py-1.5 text-start text-[12px] text-ink-2" title={short}>
        {short}
      </span>
      <CopyButton text={url} />
    </div>
  )
}

export function Fold({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink">
        <ChevronDown size={14} className={cn('transition-transform', !open && 'rtl:rotate-90 ltr:-rotate-90')} />
        {title}
      </button>
      {open && <div className="mt-2 flex flex-col gap-3">{children}</div>}
    </div>
  )
}
