// Small building blocks of the events app, in the Widget v1 style (see dapp.css).
import QRCode from 'qrcode'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { WALLET_LOGOS } from '../widget/assets'
import type { Status } from './model'

export const STATUS_LABEL: Record<Status, string> = { planned: 'Planned', ongoing: 'Ongoing', past: 'Past' }

export function StatusPill({ status, label }: { status: Status; label?: string }) {
  return (
    <span className="os-status" data-s={status}>
      {label ?? STATUS_LABEL[status]}
    </span>
  )
}

export function Spinner() {
  return <span className="os-spin" role="status" aria-label="Loading" />
}

/** A soft two-tone gradient derived from the address, like Luma's default avatars. */
export function Avatar({ address, size }: { address: string; size?: number }) {
  let h = 0
  for (const c of address) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const a = h % 360
  const b = (a + 40 + (h >> 9) % 80) % 360
  return (
    <span
      className="os-avatar"
      aria-hidden
      style={{
        background: `linear-gradient(135deg, hsl(${a} 70% 72%), hsl(${b} 70% 60%))`,
        ...(size ? { width: size, height: size } : null),
      }}
    />
  )
}

export function WalletLogo({ name, icon }: { name: string; icon: string | null }) {
  const known = (Object.keys(WALLET_LOGOS) as (keyof typeof WALLET_LOGOS)[]).find((k) => name.toLowerCase().includes(k))
  const src = icon ?? (known ? WALLET_LOGOS[known] : null)
  return src ? <img src={src} alt="" /> : <span className="os-walletlogo" aria-hidden />
}

/** Wall clock that ticks every `ms` (from the backend's clock, so the demo runs on its own evening). */
export function useNow(now: () => number, ms = 1000): number {
  const [t, setT] = useState(now)
  useEffect(() => {
    const id = window.setInterval(() => setT(now()), ms)
    return () => window.clearInterval(id)
  }, [now, ms])
  return t
}

export function Modal({
  title,
  subtitle,
  wide,
  onClose,
  children,
}: {
  title: string
  subtitle?: ReactNode
  wide?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="os-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal aria-label={title} className={`os-modal${wide ? ' os-modal--wide' : ''}`}>
        <div className="os-modalhead">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="os-iconbtn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function QrImage({ text }: { text: string }) {
  const [src, setSrc] = useState<{ text: string; url: string | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(text, { margin: 1, width: 520, errorCorrectionLevel: 'L' }).then(
      (url) => !cancelled && setSrc({ text, url }),
      () => !cancelled && setSrc({ text, url: null }),
    )
    return () => {
      cancelled = true
    }
  }, [text])
  const current = src?.text === text ? src : null
  return (
    <div className="os-qr">
      {current?.url ? (
        <img src={current.url} alt="QR code that opens the camera page" />
      ) : current ? (
        <p className="os-error">Could not draw the QR code. Copy the link instead.</p>
      ) : (
        <div className="os-skeleton" style={{ width: 260, height: 260 }} />
      )}
    </div>
  )
}

// ---------- Toast ----------

const ToastContext = createContext<(text: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 2200)
    return () => window.clearTimeout(id)
  }, [toast])
  const show = useCallback((text: string) => setToast({ text, id: Date.now() }), [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div key={toast.id} className="os-toast" role="status">
          {toast.text}
        </div>
      )}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

export function useCopy() {
  const toast = useToast()
  return useCallback(
    (text: string, what = 'Link') => {
      if (!navigator.clipboard) return toast('Copying is blocked here. Select the text instead.')
      navigator.clipboard.writeText(text).then(
        () => toast(`${what} copied`),
        () => toast('Copying failed. Select the text instead.'),
      )
    },
    [toast],
  )
}

export function Notice({ tone, title, children }: { tone?: 'bad' | 'ok' | 'info'; title: string; children?: ReactNode }) {
  return (
    <div className="os-notice" data-tone={tone} role={tone === 'bad' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  )
}
