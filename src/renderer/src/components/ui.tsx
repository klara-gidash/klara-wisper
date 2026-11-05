import { clsx } from 'clsx'
import { motion } from 'motion/react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { twMerge } from 'tailwind-merge'

export const cn = (...a: Parameters<typeof clsx>): string => twMerge(clsx(...a))

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'rec'

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  icon,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[10px] font-medium transition-all duration-150 select-none',
        'disabled:opacity-40 disabled:pointer-events-none active:scale-[0.98] whitespace-nowrap',
        size === 'sm' && 'h-7 px-2.5 text-[12.5px]',
        size === 'md' && 'h-8.5 px-3.5 text-[13px]',
        size === 'lg' && 'h-11 px-5 text-[14.5px]',
        variant === 'primary' && 'bg-ink text-bg hover:opacity-90 shadow-sm',
        variant === 'secondary' && 'bg-panel text-ink border border-line-strong hover:bg-panel-2 shadow-[0_1px_1px_rgba(0,0,0,0.03)]',
        variant === 'ghost' && 'text-ink-2 hover:text-ink hover:bg-line',
        variant === 'danger' && 'text-rec hover:bg-rec-soft',
        variant === 'rec' && 'bg-rec text-white hover:brightness-105 shadow-sm',
        className
      )}
    >
      {icon}
      {children}
    </button>
  )
}

export function IconButton({ className, children, title, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      title={title}
      aria-label={title}
      className={cn(
        'inline-grid place-items-center size-8 rounded-[9px] text-ink-2 hover:text-ink hover:bg-line transition-colors',
        'disabled:opacity-40 disabled:pointer-events-none',
        className
      )}
    >
      {children}
    </button>
  )
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line-strong'
      )}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 600, damping: 35 }}
        className="absolute top-[3px] size-4 rounded-full bg-white shadow"
        style={{ insetInlineStart: checked ? 19 : 3 }}
      />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-[10px] bg-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative h-7 rounded-[8px] px-3 text-[12.5px] font-medium transition-colors',
            value === o.value ? 'text-ink' : 'text-ink-2 hover:text-ink'
          )}
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${options.map((x) => x.value).join()}`} className="absolute inset-0 rounded-[8px] bg-panel shadow-sm" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-2xl border border-line bg-panel shadow-card', className)}>{children}</div>
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-line-strong bg-panel px-1.5 font-sans text-[12px] font-semibold text-ink shadow-[0_1px_0_var(--line-strong)]">
      {children}
    </kbd>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('size-4 animate-spin', className)} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="grid size-14 place-items-center rounded-2xl bg-panel-2 text-ink-3">{icon}</div>
      <div className="text-[15px] font-semibold">{title}</div>
      {body && <div className="max-w-sm text-[13px] leading-relaxed text-ink-2">{body}</div>}
      {action}
    </div>
  )
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'rec' | 'idle' }) {
  return (
    <span
      className={cn(
        'inline-block size-2 rounded-full',
        tone === 'ok' && 'bg-ok',
        tone === 'warn' && 'bg-warn',
        tone === 'rec' && 'bg-rec',
        tone === 'idle' && 'bg-ink-3'
      )}
    />
  )
}
