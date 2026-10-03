// The embeddable OnSight widget, built to Penpot "Widget v1":
//   1a sign up (split button + wallet picker) → 1b confirm in wallet → 1c wallet connected
//   2a selfie (one photo)
//   3a consent → sign "join" in the wallet → 3b you're in
//
// Multi-oracle: the event's oracles come from the chain (oracles.ts). The join is signed ONCE and the same body goes
// to every oracle; it counts once `threshold` of them accepted. With a single oracle the UI is the same as before.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Wallet } from '@wallet-standard/base'
import type { EventDetails, SubmitRequest } from './api'
import { ButtonCheck, Check, Chevron } from './icons'
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
import {
  attendance,
  discoverOracles,
  failureText,
  firstEvent,
  hostOf,
  toAll,
  type Attendance,
  type Oracle,
  type OracleSet,
} from './oracles'

type Stage =
  | { name: 'signup' }
  | { name: 'connecting' }
  | { name: 'connected' }
  | { name: 'selfie' }
  | { name: 'consent'; image: string }
  | { name: 'signing'; image: string }
  | { name: 'done' }

type Fill = 'empty' | 'half' | 'full'
const STEPPER: Record<Stage['name'], [Fill, Fill, Fill] | null> = {
  signup: null,
  connecting: ['half', 'empty', 'empty'],
  connected: ['full', 'empty', 'empty'],
  selfie: ['full', 'half', 'empty'],
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
const PHOTO_ERRORS = new Set(['photo_rejected', 'face_already_registered'])

/** Per-oracle state of the last join attempt (index-aligned with OracleSet.oracles; null = not sent). */
type Progress = { state: 'sending' } | { state: 'ok' } | { state: 'failed'; message: string } | null

export type WidgetProps = {
  eventId: string
  /** Origin of the fallback OnSight backend (used when the chain read fails). Empty string = the page's origin. */
  apiBase?: string
  /** Solana JSON-RPC endpoint for reading the event's oracles. Default: devnet. */
  rpcUrl?: string
  /** presence_pay program id. Default: DEFAULT_PROGRAM_ID in chain.ts. */
  programId?: string
}

export default function Widget({ eventId, apiBase = '', rpcUrl, programId }: WidgetProps) {
  const wallets = useSolanaWallets()
  const metamask = wallets.find(isMetaMask)

  const [oracleSet, setOracleSet] = useState<OracleSet | null>(null)
  /** The oracle whose event details and consent text are shown (the first to answer); also tests selfies. */
  const [primary, setPrimary] = useState<Oracle | null>(null)
  const [event, setEvent] = useState<EventDetails | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>({ name: 'signup' })
  const [conn, setConn] = useState<Connection | null>(null)
  const [status, setStatus] = useState<Attendance | null>(null)
  const [progress, setProgress] = useState<Progress[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    discoverOracles({ eventId, apiBase, rpcUrl, programId })
      .then(async (set) => {
        const first = await firstEvent(set.oracles)
        if (cancelled) return
        setOracleSet(set)
        setPrimary(first.oracle)
        setEvent(first.event)
      })
      .catch((err: Error) => !cancelled && setLoadError(err.message))
    return () => {
      cancelled = true
    }
  }, [eventId, apiBase, rpcUrl, programId])

  // Once on the list, keep the status fresh so a payout shows up without a reload.
  useEffect(() => {
    if (stage.name !== 'done' || !conn || !oracleSet) return
    const id = setInterval(() => attendance(oracleSet, conn.account.address).then(setStatus, () => {}), STATUS_POLL_MS)
    return () => clearInterval(id)
  }, [oracleSet, stage.name, conn])

  const onSelfieDone = useCallback((image: string) => {
    setProgress([])
    setStage({ name: 'consent', image })
  }, [])

  if (!event || !oracleSet || !primary) {
    return (
      <Card stepper={null}>
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
      const s = await attendance(oracleSet!, c.account.address)
      setStatus(s)
      setStage(s.status === 'not_joined' ? { name: 'connected' } : { name: 'done' })
    } catch (err) {
      setError(isUserRejection(err) ? 'Connection cancelled in MetaMask.' : (err as Error).message)
      setStage({ name: 'signup' })
    }
  }

  /** Sign the join once and send the same body to `targets` (default: every oracle) in parallel. */
  async function join(image: string, targets?: Oracle[]) {
    if (!conn || !event || !oracleSet || !primary) return
    const set = oracleSet
    setError(null)
    setStage({ name: 'signing', image })
    let body: SubmitRequest
    try {
      const signed = await signAction(conn, 'join', event.event_id, event.consent.version)
      body = { ...signed, consent: { version: event.consent.version, accepted: true }, image }
    } catch (err) {
      setError(isUserRejection(err) ? 'Signature cancelled in MetaMask.' : walletErrorMessage(err))
      setStage({ name: 'consent', image })
      return
    }

    const sendTo = targets ?? set.oracles
    // A retry keeps the oracles that already accepted; a full send starts over.
    const next: Progress[] = targets ? [...progress] : set.oracles.map(() => null)
    for (const o of sendTo) next[set.oracles.indexOf(o)] = { state: 'sending' }
    setProgress([...next])
    const results = await toAll(sendTo, (api) => api.submit(body))
    for (const r of results) {
      next[set.oracles.indexOf(r.oracle)] = r.ok ? { state: 'ok' } : { state: 'failed', message: r.error.message }
    }
    setProgress([...next])

    const accepted = next.filter((p) => p?.state === 'ok').length
    if (accepted >= set.need) {
      setStatus({ status: 'on_list', tx: null, onList: accepted })
      setStage({ name: 'done' })
      primary.api.event().then(setEvent, () => {})
      return
    }
    const failed = results.filter((r) => !r.ok)
    const photo = failed.find((r) => !r.ok && PHOTO_ERRORS.has(r.error.code))
    if (photo && !photo.ok) {
      setError(`${photo.error.message} Let's take the photo again.`)
      setStage({ name: 'selfie' })
    } else if (set.oracles.length === 1) {
      setError(failed[0] && !failed[0].ok ? failed[0].error.message : 'The join failed.')
      setStage({ name: 'consent', image })
    } else {
      setError(`${accepted} of ${set.need} needed oracles accepted. ${failureText(failed)}`)
      setStage({ name: 'consent', image })
    }
  }

  const multi = oracleSet.oracles.length > 1
  const failedOracles = oracleSet.oracles.filter((_, i) => progress[i]?.state === 'failed')
  const canRetry = multi && failedOracles.length > 0 && progress.some((p) => p?.state === 'ok')
  const sending = multi && progress.some((p) => p?.state === 'sending')
  // Name every oracle that will get the face signature, unless it is the one backend this widget always talked to.
  const showProcessors =
    oracleSet.fromChain && (multi || oracleSet.oracles[0].host !== hostOf(apiBase || window.location.origin))

  const errorLine = error && <p className="an-error" role="alert">{error}</p>

  function body(): ReactNode {
    if (!event || !oracleSet || !primary) return null
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
            <Selfie api={primary.api} onDone={onSelfieDone} />
            {errorLine}
          </>
        )
      case 'consent':
      case 'signing': {
        const [question, ...rest] = event.consent.text.split('\n')
        const signing = stage.name === 'signing'
        return (
          <div className="an-consent">
            <div className="an-consent-stage">
              <p className="an-question">{question}</p>
              <p className="an-consent-text">{rest.join('\n').trim()}</p>
              {showProcessors && (
                <p className="an-consent-text">
                  Your face signature will be processed by:{' '}
                  {oracleSet.oracles.map((o) => `${o.name} (${o.host})`).join(', ')}
                </p>
              )}
              {oracleSet.unreachable > 0 && (
                <p className="an-consent-text">
                  {oracleSet.unreachable} of the event&apos;s oracles could not be found and won&apos;t get your join.
                  {oracleSet.threshold > oracleSet.oracles.length &&
                    ` A payout needs ${oracleSet.threshold}, so it cannot happen.`}
                </p>
              )}
            </div>
            {multi && progress.some(Boolean) && <OracleProgress oracles={oracleSet.oracles} progress={progress} />}
            {errorLine}
            <button
              type="button"
              className="an-button"
              disabled={signing}
              onClick={() => (canRetry ? join(stage.image, failedOracles) : join(stage.image))}
            >
              {signing ? (
                sending ? (
                  'Sending to oracles…'
                ) : (
                  'Confirm in MetaMask…'
                )
              ) : canRetry ? (
                `Retry ${failedOracles.map((o) => o.name).join(', ')}`
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
            {multi && status && status.status !== 'paid' && (
              <p className="an-note">
                On the list with {status.onList} of {oracleSet.oracles.length} oracles
              </p>
            )}
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
      branded={stage.name === 'signup'}
    >
      {body()}
    </Card>
  )
}

function OracleProgress({ oracles, progress }: { oracles: Oracle[]; progress: Progress[] }) {
  return (
    <ul className="an-oracles" aria-live="polite">
      {oracles.map((o, i) => {
        const p = progress[i]
        return (
          <li key={o.key ?? i} className="an-oracle" data-state={p?.state ?? 'idle'}>
            <span className="an-oracle-name">{o.name}</span>
            <span className="an-oracle-state">
              {p?.state === 'sending'
                ? 'Sending…'
                : p?.state === 'ok'
                  ? 'On the list'
                  : p?.state === 'failed'
                    ? p.message
                    : 'Not sent'}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** Readable text for a failed MetaMask call. */
function walletErrorMessage(err: unknown): string {
  if (isLockedWallet(err)) return 'MetaMask is locked. Unlock it (click the MetaMask icon), then try again.'
  return (err as Error).message
}

function Card({
  stepper,
  branded = false,
  footerExtra,
  children,
}: {
  stepper: [Fill, Fill, Fill] | null
  /** Sign-up shows the OnSight pill; later steps keep the plain "Powered by" line. */
  branded?: boolean
  footerExtra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="an-card">
      {stepper && (
        <div className="an-stepper" aria-hidden>
          {stepper.map((fill, i) => (
            <span key={i} className="an-segment" data-fill={fill} />
          ))}
        </div>
      )}
      {children}
      <div className="an-footer" data-branded={branded}>
        {branded ? (
          <span className="an-brand-pill">
            <span className="an-brand-mark" aria-hidden>
              O
            </span>
            <span>
              Powered by <strong>OnSight</strong>
            </span>
          </span>
        ) : (
          <span>Powered by OnSight</span>
        )}
        {footerExtra}
      </div>
    </div>
  )
}

function Reward({ event }: { event: EventDetails }) {
  if (event.reward_lamports == null) return null
  const sol = event.reward_lamports / 1_000_000_000
  const max = event.max_payouts
  return (
    <div className="an-reward">
      <p className="an-reward-label">
        {max ? (
          <>
            First <strong>{max}</strong> attendees earn
          </>
        ) : (
          'Attendees earn'
        )}
      </p>
      <p className="an-reward-amount">{sol.toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL</p>
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
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function downloadIcs(event: EventDetails) {
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const escape = (s: string) => s.replace(/([,;\\])/g, '\\$1')
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OnSight//Widget//EN',
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
