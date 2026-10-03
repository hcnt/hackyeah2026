// The embeddable "Attend Now" widget. Flow (Penpot "Widget v1", without the visual design):
//   1 sign up with MetaMask → confirm in wallet → wallet connected
//   2 selfie check-in (straight, left, right) → first name
//   3 consent → sign "join" in the wallet → you're in
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Wallet } from '@wallet-standard/base'
import { ApiError, createApi, type EventDetails, type Frame, type StatusResponse } from './api'
import Selfie from './Selfie'
import {
  connect,
  disconnect,
  isMetaMask,
  isUserRejection,
  METAMASK_DOWNLOAD_URL,
  shortAddress,
  signAction,
  useSolanaWallets,
  type Connection,
} from './wallet'

type Stage =
  | { name: 'signup' }
  | { name: 'connecting'; wallet: Wallet }
  | { name: 'connected' }
  | { name: 'selfie' }
  | { name: 'details'; frames: Frame[] }
  | { name: 'consent'; frames: Frame[]; firstName: string }
  | { name: 'signing'; frames: Frame[]; firstName: string }
  | { name: 'done' }

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

  const [event, setEvent] = useState<EventDetails | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>({ name: 'signup' })
  const [conn, setConn] = useState<Connection | null>(null)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)

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

  if (loadError) return <Shell><p className="an-error">{loadError}</p></Shell>
  if (!event) return <Shell><p className="an-muted">Loading event…</p></Shell>

  async function signUp(wallet: Wallet) {
    setError(null)
    setShowPicker(false)
    setStage({ name: 'connecting', wallet })
    try {
      const c = await connect(wallet)
      setConn(c)
      const s = await api.status(c.account.address)
      setStatus(s)
      setStage(s.status === 'not_joined' ? { name: 'connected' } : { name: 'done' })
    } catch (err) {
      setError(isUserRejection(err) ? 'Connection cancelled in the wallet.' : (err as Error).message)
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
        setError('Signature cancelled in the wallet.')
        setStage({ name: 'consent', frames, firstName })
      } else if (err instanceof ApiError && PHOTO_ERRORS.has(err.code)) {
        setError(`${err.message} Let's take the photos again.`)
        setStage({ name: 'selfie' })
      } else {
        setError((err as Error).message)
        setStage({ name: 'consent', frames, firstName })
      }
    }
  }

  async function leave() {
    if (!conn || !event) return
    setError(null)
    try {
      const signed = await signAction(conn, 'leave', event.event_id)
      await api.leave(signed)
      setStatus({ status: 'not_joined', tx: null })
      setStage({ name: 'connected' })
      api.event().then(setEvent, () => {})
    } catch (err) {
      setError(isUserRejection(err) ? 'Signature cancelled in the wallet.' : (err as Error).message)
    }
  }

  async function switchWallet() {
    if (conn) await disconnect(conn)
    setConn(null)
    setStatus(null)
    setError(null)
    setStage({ name: 'signup' })
  }

  return (
    <Shell>
      <EventHeader event={event} />
      {conn && stage.name !== 'connecting' && (
        <p className="an-muted an-small">
          {conn.wallet.name} · {shortAddress(conn.account.address)}{' '}
          {stage.name !== 'signing' && (
            <button type="button" className="an-link" onClick={switchWallet}>
              Switch
            </button>
          )}
        </p>
      )}
      {error && <p className="an-error" role="alert">{error}</p>}
      {body()}
    </Shell>
  )

  function body() {
    if (!event) return null
    switch (stage.name) {
      case 'signup': {
        if (!event.joining_open) return <p className="an-muted">This event has ended.</p>
        const metamask = wallets.find(isMetaMask)
        return (
          <>
            <RewardLine event={event} />
            {metamask ? (
              <button type="button" className="an-primary" onClick={() => signUp(metamask)}>
                Sign up with MetaMask
              </button>
            ) : (
              <a className="an-primary" href={METAMASK_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                Install MetaMask to sign up
              </a>
            )}
            {wallets.some((w) => !isMetaMask(w)) && (
              <button type="button" className="an-link" onClick={() => setShowPicker(!showPicker)}>
                Use another wallet
              </button>
            )}
            {showPicker && (
              <ul className="an-picker">
                {wallets.filter((w) => !isMetaMask(w)).map((w) => (
                  <li key={w.name}>
                    <button type="button" onClick={() => signUp(w)}>
                      <img src={w.icon} alt="" width={20} height={20} /> {w.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      }
      case 'connecting':
        return <p className="an-strong">Confirm in {stage.wallet.name}…</p>
      case 'connected':
        return (
          <>
            <p className="an-strong">Wallet connected</p>
            <p className="an-muted">Next, take a quick selfie so the event camera can recognise you.</p>
            <button type="button" className="an-primary" onClick={() => setStage({ name: 'selfie' })}>
              Continue
            </button>
          </>
        )
      case 'selfie':
        return <Selfie api={api} onDone={onSelfieDone} />
      case 'details':
        return <Details onSubmit={(firstName) => setStage({ name: 'consent', frames: stage.frames, firstName })} />
      case 'consent':
      case 'signing': {
        const [heading, ...rest] = event.consent.text.split('\n')
        const signing = stage.name === 'signing'
        return (
          <>
            <p className="an-strong">{heading}</p>
            <p className="an-consent">{rest.join('\n').trim()}</p>
            <button
              type="button"
              className="an-primary"
              disabled={signing}
              onClick={() => join(stage.frames, stage.firstName)}
            >
              {signing ? `Confirm in ${conn?.wallet.name ?? 'wallet'}…` : 'Agree & join'}
            </button>
          </>
        )
      }
      case 'done':
        return (
          <>
            <p className="an-strong">{status?.status === 'paid' ? "You've been paid." : "You're in."}</p>
            {status?.status === 'paid' ? (
              status.tx && (
                <a
                  className="an-link"
                  href={`https://explorer.solana.com/tx/${status.tx}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View payout transaction
                </a>
              )
            ) : (
              <p className="an-muted">
                Walk past the event camera for {event.min_seen_secs}s and your reward is sent to this wallet.
              </p>
            )}
            <button type="button" className="an-link" onClick={leave}>
              Leave event and delete my face data
            </button>
          </>
        )
    }
  }
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="an-widget">
      {children}
      <p className="an-muted an-small an-footer">Powered by Attend Now</p>
    </div>
  )
}

function EventHeader({ event }: { event: EventDetails }) {
  const when = new Date(event.starts_at).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
  return (
    <div>
      <p className="an-title">{event.name ?? 'Event'}</p>
      <p className="an-muted">{[when, event.venue].filter(Boolean).join(' · ')}</p>
    </div>
  )
}

function RewardLine({ event }: { event: EventDetails }) {
  if (event.reward_lamports == null) return null
  const sol = event.reward_lamports / 1_000_000_000
  return (
    <p>
      {event.max_payouts ? `First ${event.max_payouts} attendees earn ` : 'Attendees earn '}
      <span className="an-strong">{sol} SOL</span>
      {event.spots_left != null && event.max_payouts != null && (
        <span className="an-muted"> · {event.spots_left} / {event.max_payouts} spots left</span>
      )}
    </p>
  )
}

function Details({ onSubmit }: { onSubmit: (firstName: string) => void }) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (trimmed) onSubmit(trimmed)
      }}
    >
      <label className="an-field">
        First name <span className="an-muted an-small">(shown on the stage screen when you're recognised)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
      </label>
      <button type="submit" className="an-primary" disabled={!trimmed}>
        Continue
      </button>
    </form>
  )
}
