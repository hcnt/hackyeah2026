// The embeddable "Attend Now" widget, built to Penpot "Widget v1":
//   1a sign up (split button + wallet picker) → 1b confirm in wallet → 1c wallet connected
//   2a selfie (straight, left, right) → 2d first name
//   3a consent → sign "join" in the wallet → 3b you're in
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Wallet } from '@wallet-standard/base'
import { ApiError, createApi, type EventDetails, type Frame, type StatusResponse } from './api'
import {
  ButtonCheck,
  Check,
  Chevron,
  DashedRing,
  SmallCheck,
  UserCheck,
} from './icons'
import { WALLET_LOGOS } from './assets'
import Selfie from './Selfie'
import {
  connect,
  isMetaMask,
  isLockedWallet,
  isUserRejection,
  METAMASK_DOWNLOAD_URL,
  signAction,
  useSolanaWallets,
  type Connection,
} from './wallet'

type Stage =
  | { name: 'signup' }
  | { name: 'connecting' }
  | { name: 'connected' }
  | { name: 'selfie' }
  | { name: 'details'; frames: Frame[] }
  | { name: 'consent'; frames: Frame[]; firstName: string }
  | { name: 'signing'; frames: Frame[]; firstName: string }
  | { name: 'done' }

type Fill = 'empty' | 'half' | 'full'
const STEPPER: Record<Stage['name'], [Fill, Fill, Fill] | null> = {
  signup: null,
  connecting: ['half', 'empty', 'empty'],
  connected: ['full', 'empty', 'empty'],
  selfie: ['full', 'half', 'empty'],
  details: ['full', 'half', 'empty'],
  consent: ['full', 'full', 'half'],
  signing: ['full', 'full', 'half'],
  done: ['full', 'full', 'full'],
}

/** Wallets shown in the picker. Only MetaMask is wired up; the rest are shown greyed out. */
const PICKER = [
  { id: 'metamask', name: 'MetaMask', enabled: true },
  { id: 'phantom', name: 'Phantom', enabled: false },
  { id: 'coinbase', name: 'Coinbase Wallet', enabled: false },
  { id: 'trust', name: 'Trust Wallet', enabled: false },
  { id: 'walletconnect', name: 'WalletConnect', enabled: false },
] as const

const STATUS_POLL_MS = 10_000
const PHOTO_ERRORS = new Set(['photo_rejected', 'not_same_person', 'liveness_failed', 'face_already_registered'])

export type WidgetProps = {
  eventId: string
  /** Origin of the Attend Now backend. Empty string means the page's own origin. */
  apiBase?: string
}

export default function Widget({ eventId, apiBase = '' }: WidgetProps) {
  const api = useMemo(() => createApi(apiBase, eventId), [apiBase, eventId])
  const wallets = useSolanaWallets()
  const metamask = wallets.find(isMetaMask)

  const [event, setEvent] = useState<EventDetails | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>({ name: 'signup' })
  const [conn, setConn] = useState<Connection | null>(null)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    api.event().then(setEvent, (err: Error) => setLoadError(err.message))
  }, [api])

  // Once on the list, keep the status fresh so a payout shows up without a reload.
  useEffect(() => {
    if (stage.name !== 'done' || !conn) return
    const id = setInterval(() => api.status(conn.account.address).then(setStatus, () => {}), STATUS_POLL_MS)
    return () => clearInterval(id)
  }, [api, stage.name, conn])

  const onSelfieDone = useCallback((frames: Frame[]) => setStage({ name: 'details', frames }), [])

  if (!event) {
    return (
      <Card stepper={null} header={null}>
        {loadError ? <p className="an-error">{loadError}</p> : <p className="an-note">Loading event…</p>}
      </Card>
    )
  }

  async function signUp(wallet: Wallet | undefined) {
    setError(null)
    setPickerOpen(false)
    if (!wallet) {
      window.open(METAMASK_DOWNLOAD_URL, '_blank', 'noopener')
      setError('Install MetaMask, then reload this page.')
      return
    }
    setStage({ name: 'connecting' })
    try {
      // MetaMask asks only the first time; after that it reuses this site's stored connection silently.
      const c = await connect(wallet)
      setConn(c)
      const s = await api.status(c.account.address)
      setStatus(s)
      setStage(s.status === 'not_joined' ? { name: 'connected' } : { name: 'done' })
    } catch (err) {
      setError(isUserRejection(err) ? 'Connection cancelled in MetaMask.' : (err as Error).message)
      setStage({ name: 'signup' })
    }
  }

  async function join(frames: Frame[], firstName: string) {
    if (!conn || !event) return
    setError(null)
    setStage({ name: 'signing', frames, firstName })
    try {
      const signed = await signAction(conn, 'join', event.event_id, event.consent.version)
      await api.submit({
        ...signed,
        consent: { version: event.consent.version, accepted: true },
        first_name: firstName,
        frames,
      })
      setStatus({ status: 'on_list', tx: null })
      setStage({ name: 'done' })
      api.event().then(setEvent, () => {})
    } catch (err) {
      if (isUserRejection(err)) {
        setError('Signature cancelled in MetaMask.')
        setStage({ name: 'consent', frames, firstName })
      } else if (err instanceof ApiError && PHOTO_ERRORS.has(err.code)) {
        setError(`${err.message} Let's take the photos again.`)
        setStage({ name: 'selfie' })
      } else {
        setError(walletErrorMessage(err))
        setStage({ name: 'consent', frames, firstName })
      }
    }
  }

  async function leave() {
    if (!conn || !event) return
    setError(null)
    try {
      await api.leave(await signAction(conn, 'leave', event.event_id))
      setStatus({ status: 'not_joined', tx: null })
      setStage({ name: 'connected' })
      api.event().then(setEvent, () => {})
    } catch (err) {
      setError(isUserRejection(err) ? 'Signature cancelled in MetaMask.' : walletErrorMessage(err))
    }
  }

  const errorLine = error && <p className="an-error" role="alert">{error}</p>

  function body(): ReactNode {
    if (!event) return null
    switch (stage.name) {
      case 'signup':
        return (
          <div className="an-body">
            <Reward event={event} />
            {errorLine}
            {event.joining_open ? (
              <div className="an-split">
                <button type="button" className="an-split-main" onClick={() => signUp(metamask)}>
                  Sign up with MetaMask
                </button>
                <span className="an-split-divider" />
                <button
                  type="button"
                  className="an-split-trigger"
                  aria-haspopup="menu"
                  aria-expanded={pickerOpen}
                  aria-label="Choose wallet"
                  onClick={() => setPickerOpen(!pickerOpen)}
                >
                  <span className="an-wallet-tile">
                    <img src={WALLET_LOGOS.metamask} alt="" />
                  </span>
                  <Chevron />
                </button>
                {pickerOpen && <WalletPicker onPick={() => signUp(metamask)} onClose={() => setPickerOpen(false)} />}
              </div>
            ) : (
              <p className="an-note">This event has ended.</p>
            )}
          </div>
        )
      case 'connecting':
        return (
          <div className="an-body an-body--center an-stage">
            <div className="an-ring">
              <DashedRing />
              <img src={WALLET_LOGOS.metamask} alt="" />
            </div>
            <p className="an-heading">Confirm in MetaMask</p>
          </div>
        )
      case 'connected':
        return (
          <div className="an-body an-body--center an-stage">
            <div className="an-badge an-badge--lg">
              <Check size={44} />
            </div>
            <p className="an-heading">Wallet connected</p>
            {errorLine}
            <button type="button" className="an-button" onClick={() => setStage({ name: 'selfie' })}>
              Continue
            </button>
          </div>
        )
      case 'selfie':
        return (
          <>
            <Selfie api={api} onDone={onSelfieDone} />
            {errorLine}
          </>
        )
      case 'details':
        return <Details onSubmit={(firstName) => setStage({ name: 'consent', frames: stage.frames, firstName })} />
      case 'consent':
      case 'signing': {
        const [question, ...rest] = event.consent.text.split('\n')
        const signing = stage.name === 'signing'
        return (
          <div className="an-consent">
            <div className="an-consent-stage">
              <div className="an-badge an-badge--sm">
                <UserCheck />
              </div>
              <p className="an-question">{question}</p>
              <p className="an-consent-text">{rest.join('\n').trim()}</p>
            </div>
            {errorLine}
            <button
              type="button"
              className="an-button"
              disabled={signing}
              onClick={() => join(stage.frames, stage.firstName)}
            >
              {signing ? (
                'Confirm in MetaMask…'
              ) : (
                <>
                  <ButtonCheck />
                  Agree &amp; join
                </>
              )}
            </button>
          </div>
        )
      }
      case 'done':
        return (
          <div className="an-body an-body--center an-done">
            <div className="an-badge an-badge--md">
              <Check size={32} />
            </div>
            <p className="an-display">{status?.status === 'paid' ? 'You got paid.' : "You're in."}</p>
            {errorLine}
            {status?.status === 'paid' && status.tx ? (
              <a
                className="an-button an-button--outline"
                href={`https://explorer.solana.com/tx/${status.tx}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: 'none' }}
              >
                View payout
              </a>
            ) : (
              <button type="button" className="an-button an-button--outline" onClick={() => downloadIcs(event)}>
                Add to calendar
              </button>
            )}
          </div>
        )
    }
  }

  return (
    <Card
      stepper={STEPPER[stage.name]}
      header={<EventHeader event={event} />}
      footerExtra={
        stage.name === 'done' && status?.status === 'on_list' ? (
          <>
            <span aria-hidden>·</span>
            <button type="button" className="an-link" onClick={leave}>
              Leave event
            </button>
          </>
        ) : null
      }
    >
      {body()}
    </Card>
  )
}

/** Readable text for a failed MetaMask call. */
function walletErrorMessage(err: unknown): string {
  if (isLockedWallet(err)) return 'MetaMask is locked. Unlock it (click the MetaMask icon), then try again.'
  return (err as Error).message
}

function Card({
  header,
  stepper,
  footerExtra,
  children,
}: {
  header: ReactNode
  stepper: [Fill, Fill, Fill] | null
  footerExtra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="an-card">
      {header}
      {stepper && (
        <div className="an-stepper" aria-hidden>
          {stepper.map((fill, i) => (
            <span key={i} className="an-segment" data-fill={fill} />
          ))}
        </div>
      )}
      {children}
      <div className="an-footer">
        <span>Powered by Attend Now</span>
        {footerExtra}
      </div>
    </div>
  )
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${day} · ${time}`
}

function EventHeader({ event }: { event: EventDetails }) {
  return (
    <div className="an-header">
      <p className="an-title">{event.name ?? 'Event'}</p>
      <p className="an-subtitle">{[formatWhen(event.starts_at), event.venue].filter(Boolean).join(' · ')}</p>
    </div>
  )
}

function Reward({ event }: { event: EventDetails }) {
  if (event.reward_lamports == null) return null
  const sol = event.reward_lamports / 1_000_000_000
  const max = event.max_payouts
  const left = event.spots_left
  return (
    <div className="an-reward">
      <p className="an-reward-label">{max ? `First ${max} attendees earn` : 'Attendees earn'}</p>
      <p className="an-reward-amount">{sol.toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL</p>
      {max != null && left != null && (
        <>
          <div className="an-progress">
            <div style={{ width: `${((max - left) / max) * 100}%` }} />
          </div>
          <p className="an-reward-spots">
            {left} / {max} spots left
          </p>
        </>
      )}
    </div>
  )
}

function WalletPicker({ onPick, onClose }: { onPick: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9 }} onClick={onClose} />
      <ul className="an-picker" role="menu">
        {PICKER.map((w) => (
          <li key={w.id}>
            <button
              type="button"
              role="menuitemradio"
              className="an-picker-item"
              aria-checked={w.id === 'metamask'}
              disabled={!w.enabled}
              title={w.enabled ? undefined : 'Coming soon'}
              onClick={onPick}
            >
              <span className="an-picker-logo">
                <img src={WALLET_LOGOS[w.id]} alt="" />
              </span>
              <span className="an-picker-name">{w.name}</span>
              {w.id === 'metamask' && (
                <span className="an-picker-check">
                  <SmallCheck />
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function Details({ onSubmit }: { onSubmit: (firstName: string) => void }) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  return (
    <form
      className="an-body an-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (trimmed) onSubmit(trimmed)
      }}
    >
      <label className="an-field">
        <span className="an-label">First name</span>
        <input
          className="an-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          autoComplete="given-name"
          required
          autoFocus
        />
      </label>
      <span className="an-spacer" />
      <button type="submit" className="an-button" disabled={!trimmed}>
        Continue
      </button>
    </form>
  )
}

function downloadIcs(event: EventDetails) {
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const escape = (s: string) => s.replace(/([,;\\])/g, '\\$1')
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Attend Now//Widget//EN',
    'BEGIN:VEVENT',
    `UID:${event.event_id}@attendnow`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(event.starts_at)}`,
    `DTEND:${stamp(event.ends_at)}`,
    `SUMMARY:${escape(event.name ?? 'Event')}`,
    ...(event.venue ? [`LOCATION:${escape(event.venue)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }))
  a.download = `${(event.name ?? 'event').replace(/[^\w-]+/g, '-')}.ics`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
