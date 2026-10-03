// Small presentational pieces shared by the stage screen and the camera page (dark venue theme).
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type Tone = 'ok' | 'warn' | 'bad' | 'idle'

const TONES: Record<Tone, string> = {
  ok: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200',
  warn: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  bad: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
  idle: 'border-white/15 bg-white/5 text-neutral-300',
}

const DOTS: Record<Tone, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  bad: 'bg-rose-400',
  idle: 'bg-neutral-500',
}

export function Chip({ tone, pulse, children, title }: { tone: Tone; pulse?: boolean; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium', TONES[tone])}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOTS[tone], pulse && 'animate-pulse')} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary'
          ? 'bg-sky-400 text-neutral-950 hover:bg-sky-300'
          : 'border border-white/20 bg-white/5 text-neutral-100 hover:bg-white/10',
        className,
      )}
    />
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-3 text-sm">
      <span aria-hidden className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      {label ?? <span className="sr-only">Loading</span>}
    </span>
  )
}

export function Notice({ tone = 'warn', title, children }: { tone?: Tone; title: string; children?: ReactNode }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cn('grid gap-1 rounded-xl border p-4 text-sm', TONES[tone])}>
      <p className="font-semibold">{title}</p>
      {children && <div className="opacity-90">{children}</div>}
    </div>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  useEffect(() => {
    if (copied === null) return
    const id = window.setTimeout(() => setCopied(null), 2000)
    return () => window.clearTimeout(id)
  }, [copied])
  return (
    <Button
      variant="ghost"
      className="min-h-9 px-3 text-xs"
      onClick={() => {
        if (!navigator.clipboard) {
          setCopied(false)
          return
        }
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }}
    >
      {copied === true ? 'Copied' : copied === false ? 'Copy failed — select the text' : label}
    </Button>
  )
}
