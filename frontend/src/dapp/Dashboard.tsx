// Screen 3: one event's dashboard. Status and countdown, oracles, entrants and prize pool (from the Event account),
// payouts (from its transaction history, plus the stage sockets once paired) and the cameras.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Calendar,
  Camera as CameraIcon,
  ExternalLink,
  Link2,
  MapPin,
  MonitorPlay,
  Play,
  QrCode,
  Server,
  Settings,
  Users,
  Wallet,
} from 'lucide-react'
import { SILHOUETTE } from '../widget/assets'
import { shortAddress } from '../widget/wallet'
import { useAccount, useBackend, walletErrorText } from './account'
import { useCameraFeed, type Camera, type CameraFeed } from './cameras'
import { EventSettings, eventLinks } from './EventSettings'
import {
  fmtCountdown,
  fmtDate,
  fmtDuration,
  fmtTime,
  prizePool,
  prizesPaid,
  remaining,
  sol,
  statusOf,
  type EventRow,
  type OracleStatus,
  type Payout,
} from './model'
import { Avatar, Modal, Notice, QrImage, Spinner, useCopy, useNow } from './ui'

/** Poll intervals: the demo changes every few seconds, the public devnet RPC is rate limited. */
const poll = (demo: boolean) => ({ event: demo ? 3000 : 15_000, oracles: demo ? 3000 : 20_000, payouts: demo ? 3000 : 20_000 })

interface Polled<T> {
  data: T | null
  error: string | null
  /** True after the first answer (even an empty one). */
  loaded: boolean
}

function usePolled<T>(load: (() => Promise<T>) | null, ms: number, deps: unknown[]): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, loaded: false })
  useEffect(() => {
    if (!load) return
    let cancelled = false
    let timer: number | undefined
    const run = () =>
      load()
        .then(
          (data) => !cancelled && setState({ data, error: null, loaded: true }),
          (err) => !cancelled && setState((s) => ({ ...s, error: walletErrorText(err) })),
        )
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(run, ms)
        })
    void run()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, deps)
  return state
}

export function Dashboard({ id }: { id: string }) {
  const backend = useBackend()
  const account = useAccount()
  const now = useNow(backend.now)
  const intervals = poll(backend.mode === 'demo')
  const [refresh, setRefresh] = useState(0)
  const [settings, setSettings] = useState(false)

  const ev = usePolled(() => backend.getEvent(id, account.address), intervals.event, [backend, id, account.address, refresh])
  const event = ev.data
  const eventKey = event ? `${event.id}:${event.withdrawn}` : null
  const oracles = usePolled(event ? () => backend.oracles(event) : null, intervals.oracles, [backend, eventKey])
  const history = usePolled(event ? () => backend.payouts(event) : null, intervals.payouts, [backend, eventKey, event?.paidCount])
  const feed = useCameraFeed(backend, event, account.address === event?.organizer ? account.conn : null)

  const payouts = useMemo(() => {
    const all = new Map<string, Payout>()
    for (const p of [...feed.livePayouts, ...(history.data ?? [])]) if (!all.has(p.tx)) all.set(p.tx, p)
    return [...all.values()].sort((a, b) => b.at - a.at)
  }, [feed.livePayouts, history.data])

  if (!event) {
    return (
      <main className="os-page">
        <a className="os-back" href="#/">
          <ArrowLeft size={16} /> Events
        </a>
        {ev.loaded ? (
          <div className="os-empty">
            <h2>No such event</h2>
            <p>
              There’s no Event account <span className="mono">{shortAddress(id)}</span> on {backend.network}. It may have been
              withdrawn (which closes it) or belong to another deployment.
            </p>
            <a className="os-btn" href="#/">
              Back to events
            </a>
          </div>
        ) : ev.error ? (
          <div style={{ marginTop: 24 }}>
            <Notice tone="bad" title="Couldn’t read this event">
              {ev.error}
            </Notice>
          </div>
        ) : (
          <Loading />
        )}
      </main>
    )
  }

  const status = statusOf(event, now)
  const links = eventLinks(event.id)
  const pct = event.maxPaid ? (event.paidCount / event.maxPaid) * 100 : 0

  return (
    <main className="os-page">
      <a className="os-back" href="#/">
        <ArrowLeft size={16} /> Events
      </a>
      <div className="os-dashhead">
        <div>
          <h1 className="os-title">{event.name}</h1>
          <div className="os-dashmeta">
            {event.venue && (
              <span>
                <MapPin size={15} /> {event.venue}
              </span>
            )}
            <span>
              <Calendar size={15} /> {fmtDate(event.start)}, {fmtTime(event.start)} – {fmtTime(event.end)}
              {fmtDate(event.start) !== fmtDate(event.end) ? ` (${fmtDate(event.end)})` : ''} · {fmtDuration(event.end - event.start)}
            </span>
            <span>
              <Wallet size={15} /> Organiser <span className="mono">{shortAddress(event.organizer)}</span>
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a className="os-btn os-btn--secondary" href={links.stage} target="_blank" rel="noreferrer">
            <MonitorPlay size={16} /> Stage screen
          </a>
          <a className="os-btn os-btn--secondary" href={links.attendee} target="_blank" rel="noreferrer">
            <Users size={16} /> Attendee page
          </a>
          <button type="button" className="os-iconbtn os-iconbtn--filled" style={{ width: 40, height: 40 }} onClick={() => setSettings(true)} aria-label="Event settings">
            <Settings size={17} />
          </button>
        </div>
      </div>

      <div className="os-dashgrid">
        <StatusBar event={event} now={now} onWithdraw={() => setSettings(true)} />

        <section className="os-card os-card-pad" aria-label="Oracle status">
          <div className="os-cardhead">
            <h2 className="os-cardtitle">
              <Server size={17} /> Oracle status
            </h2>
            <span className="os-eyebrow">
              {event.threshold} of {event.oracles.length} must agree
            </span>
          </div>
          <OracleList oracles={oracles.data} error={oracles.error} />
        </section>

        <section className="os-card os-card-pad" aria-label="Entrants">
          <div className="os-cardhead">
            <h2 className="os-cardtitle">
              <Users size={17} /> Entrants
            </h2>
            <span className="os-eyebrow num">out of {event.maxPaid}</span>
          </div>
          <div className="os-bignums">
            <div className="os-bignum" data-tone="paid">
              <b className="num">{event.paidCount}</b>
              <span>paid out</span>
            </div>
            <div className="os-bignum">
              <b className="num">{Math.max(0, event.maxPaid - event.paidCount)}</b>
              <span>{event.withdrawn ? 'unclaimed' : 'remaining'}</span>
            </div>
          </div>
          <div className="os-progress" style={{ marginTop: 18 }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="os-progress-legend">
            <span>{Math.round(pct)}% checked in</span>
            <span>
              {event.paidCount} / {event.maxPaid}
            </span>
          </div>
        </section>

        <section className="os-card os-card-pad" aria-label="Prize pool">
          <div className="os-cardhead">
            <h2 className="os-cardtitle">
              <Wallet size={17} /> Prize pool
            </h2>
            <span className="os-eyebrow num">of {sol(prizePool(event))} SOL</span>
          </div>
          <div className="os-bignums">
            <div className="os-bignum" data-tone="paid">
              <b className="num">
                {sol(prizesPaid(event))}
                <small>SOL</small>
              </b>
              <span>paid out</span>
            </div>
            <div className="os-bignum">
              <b className="num">
                {sol(event.withdrawn ? (event.returnedLamports ?? 0n) : remaining(event))}
                <small>SOL</small>
              </b>
              <span>{event.withdrawn ? 'returned to you' : 'remaining'}</span>
            </div>
          </div>
          <div className="os-progress" style={{ marginTop: 18 }}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="os-progress-legend">
            <span>{sol(event.rewardLamports)} SOL per attendee</span>
            <span>{sol(event.feeLamports)} SOL oracle fee each</span>
          </div>
        </section>

        <section className="os-card os-card-pad os-span2" aria-label="Payouts">
          <div className="os-cardhead">
            <h2 className="os-cardtitle">
              <Wallet size={17} /> Payouts
            </h2>
            <span className="os-eyebrow">
              {!history.loaded && !history.error ? 'Reading the chain…' : `${payouts.length} latest · ${backend.mode === 'demo' ? 'simulated' : 'live from Solana'}`}
            </span>
          </div>
          <PayoutTable payouts={payouts} loading={!history.loaded && !history.error} error={history.error} />
        </section>

        <section className="os-card os-card-pad" aria-label="Cameras">
          <div className="os-cardhead">
            <h2 className="os-cardtitle">
              <CameraIcon size={17} /> Cameras
            </h2>
            <span className="os-eyebrow">
              {feed.cameras.filter((c) => c.online).length} of {feed.cameras.length} online
            </span>
          </div>
          <Cameras feed={feed} status={status} isOrganizer={account.address === event.organizer} />
        </section>
      </div>

      {settings && (
        <EventSettings
          event={event}
          onClose={() => setSettings(false)}
          onChanged={() => {
            setRefresh((n) => n + 1)
          }}
        />
      )}
    </main>
  )
}

function Loading() {
  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 24 }}>
      <div className="os-skeleton" style={{ height: 48, width: 420 }} />
      <div className="os-skeleton" style={{ height: 100 }} />
      <div className="os-dashgrid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="os-skeleton" style={{ height: 180 }} />
        ))}
      </div>
    </div>
  )
}

function StatusBar({ event, now, onWithdraw }: { event: EventRow; now: number; onWithdraw: () => void }) {
  const status = statusOf(event, now)
  const label = status === 'ongoing' ? 'LIVE' : status === 'planned' ? 'UPCOMING' : 'ENDED'
  return (
    <section className="os-card os-statusbar os-span3" data-s={status} aria-label="Event status">
      <span className="os-bigbadge" data-s={status}>
        {label}
      </span>
      <div className="os-countdown">
        {status === 'ongoing' ? (
          <>
            <span>Ends in</span>
            <b>{fmtCountdown(event.end * 1000 - now)}</b>
          </>
        ) : status === 'planned' ? (
          <>
            <span>Starts in</span>
            <b>{fmtCountdown(event.start * 1000 - now)}</b>
          </>
        ) : (
          <>
            <span>Ended</span>
            <b style={{ fontSize: 24 }}>
              {fmtDate(event.end)}, {fmtTime(event.end)}
            </b>
          </>
        )}
      </div>
      <div className="os-statusfacts">
        <div>
          <span>Reward per attendee</span>
          <b>{sol(event.rewardLamports)} SOL</b>
        </div>
        <div>
          <span>Paid so far</span>
          <b>{sol(prizesPaid(event))} SOL</b>
        </div>
        {status === 'past' && !event.withdrawn && remaining(event) > 0n ? (
          <button type="button" className="os-btn" onClick={onWithdraw}>
            Withdraw {sol(remaining(event))} SOL
          </button>
        ) : (
          <div>
            <span>{event.withdrawn ? 'Returned' : 'Locked in contract'}</span>
            <b>{sol(event.withdrawn ? (event.returnedLamports ?? 0n) : remaining(event))} SOL</b>
          </div>
        )}
      </div>
    </section>
  )
}

function OracleList({ oracles, error }: { oracles: OracleStatus[] | null; error: string | null }) {
  if (!oracles) {
    return error ? <p className="os-error">{error}</p> : <div className="os-skeleton" style={{ height: 96 }} />
  }
  return (
    <ul className="os-list">
      {oracles.map((o) => (
        <li key={o.key}>
          <span className="os-list-icon">
            <Server size={16} />
          </span>
          <div className="os-list-body">
            <strong title={o.url ?? o.key}>{o.name}</strong>
            <span className="num">{o.signatures === null ? 'Signatures unknown' : `${o.signatures} signatures received`}</span>
          </div>
          <span className="os-online" data-on={o.online}>
            <span className="os-dot" data-on={o.online} /> {o.online ? 'Online' : 'Offline'}
          </span>
        </li>
      ))}
    </ul>
  )
}

function PayoutTable({ payouts, loading, error }: { payouts: Payout[]; loading: boolean; error: string | null }) {
  const backend = useBackend()
  const copy = useCopy()
  // Rows from the last few seconds flash green as they arrive.
  const now = useNow(backend.now)
  if (loading) return <div className="os-skeleton" style={{ height: 200 }} />
  if (payouts.length === 0) {
    return (
      <div className="os-empty" style={{ padding: '40px 16px' }}>
        <p>{error ? `Couldn’t read payouts: ${error}` : 'No payouts yet. They appear here the moment the oracles agree on an attendee.'}</p>
      </div>
    )
  }
  return (
    <div className="os-scroll">
      <table className="os-ptable">
        <thead>
          <tr>
            <th>Time</th>
            <th>Wallet</th>
            <th>Amount</th>
            <th>
              <span className="sr-only">Transaction</span>
            </th>
          </tr>
        </thead>
        <tbody aria-live="polite">
          {payouts.map((p) => (
            <tr key={p.tx} className={now - p.at < 6000 ? 'fresh' : undefined}>
              <td className="num">{new Date(p.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
              <td>
                <button type="button" className="os-wallettag" style={{ border: 0, background: 'none', padding: 0 }} title="Copy wallet" onClick={() => copy(p.wallet, 'Wallet')}>
                  <Avatar address={p.wallet} />
                  <span className="mono">{shortAddress(p.wallet)}</span>
                </button>
              </td>
              <td className="amt num">{sol(p.lamports)} SOL</td>
              <td>
                <a className="os-iconbtn" href={backend.txUrl(p.tx)} target="_blank" rel="noreferrer" aria-label="View transaction" title="View transaction">
                  <ExternalLink size={15} />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Cameras({ feed, status, isOrganizer }: { feed: CameraFeed; status: string; isOrganizer: boolean }) {
  const copy = useCopy()
  const [qr, setQr] = useState(false)
  const [watching, setWatching] = useState<Camera | null>(null)
  const { pair } = feed

  if (pair.kind !== 'paired') {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        {pair.kind === 'loading' ? (
          <div className="os-skeleton" style={{ height: 80 }} />
        ) : status === 'past' ? (
          <p className="muted">The event has ended; cameras can no longer be paired.</p>
        ) : (
          <>
            <p className="muted">
              Pair this dashboard with the event’s oracles to add cameras and watch them. One free signature, no transaction.
            </p>
            <button type="button" className="os-btn os-btn--block" disabled={pair.kind === 'busy' || !isOrganizer} onClick={feed.pairNow}>
              {pair.kind === 'busy' ? (
                <>
                  <Spinner /> {pair.step}
                </>
              ) : (
                'Pair cameras'
              )}
            </button>
            {!isOrganizer && <p className="os-actions-hint">Sign in with the organiser’s wallet to pair cameras.</p>}
          </>
        )}
        {pair.kind === 'error' && <Notice tone="bad" title={pair.message} />}
      </div>
    )
  }

  return (
    <>
      {feed.cameras.length === 0 ? (
        <p className="muted">No camera yet. Add one below with a phone or tablet.</p>
      ) : (
        <ul className="os-list">
          {feed.cameras.map((c) => (
            <li key={c.id}>
              <span className="os-list-icon">
                <CameraIcon size={16} />
              </span>
              <div className="os-list-body">
                <strong>{c.name}</strong>
                <span className="os-online" data-on={c.online}>
                  <span className="os-dot" data-on={c.online} /> {c.online ? 'Online' : c.note ? `Offline · ${c.note}` : 'Offline'}
                </span>
              </div>
              <button
                type="button"
                className="os-iconbtn os-iconbtn--dark"
                disabled={!c.online}
                aria-label={`Watch ${c.name}`}
                title={c.online ? 'Watch' : 'Offline'}
                onClick={() => setWatching(c)}
              >
                <Play size={14} fill="currentColor" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="os-addcam">
        <span>Add a camera</span>
        <div>
          <button type="button" className="os-iconbtn os-iconbtn--filled" aria-label="Show QR code" title="QR code for a phone or tablet" disabled={!feed.cameraUrl} onClick={() => setQr(true)}>
            <QrCode size={16} />
          </button>
          <button
            type="button"
            className="os-iconbtn os-iconbtn--filled"
            aria-label="Copy camera link"
            title="Copy camera link"
            disabled={!feed.cameraUrl}
            onClick={() => feed.cameraUrl && copy(feed.cameraUrl, 'Camera link')}
          >
            <Link2 size={16} />
          </button>
        </div>
      </div>

      {qr && feed.cameraUrl && (
        <Modal title="Add a camera" subtitle="Scan with a phone or tablet and point it at the entrance." onClose={() => setQr(false)}>
          <QrImage text={feed.cameraUrl} />
          <div className="os-linkbox">
            <code className="mono">{feed.cameraUrl}</code>
            <button type="button" className="os-btn os-btn--secondary os-btn--sm" onClick={() => copy(feed.cameraUrl!, 'Camera link')}>
              <Link2 size={13} /> Copy
            </button>
          </div>
          <p className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>
            Anyone with this link can stream to your event. Faces of people not on the guest list are discarded.
          </p>
        </Modal>
      )}
      {watching && <Player camera={watching} feed={feed} onClose={() => setWatching(null)} />}
    </>
  )
}

function Player({ camera, feed, onClose }: { camera: Camera; feed: CameraFeed; onClose: () => void }) {
  const backend = useBackend()
  const canvas = useRef<HTMLCanvasElement>(null)
  const { watch } = feed
  useEffect(() => (canvas.current ? watch(camera.id, canvas.current) : undefined), [watch, camera.id])
  return (
    <Modal title={camera.name} subtitle="Live view with recognised attendees marked" wide onClose={onClose}>
      <div className="os-video">
        {backend.mode === 'demo' ? (
          <DemoFrame />
        ) : (
          <canvas ref={canvas} role="img" aria-label="Live camera view with recognised attendees marked" />
        )}
        <span className="os-video-tag">
          <span className="os-dot" data-on /> Live
        </span>
      </div>
    </Modal>
  )
}

/** Stand-in for the camera picture in the demo: the Widget v1 silhouette with a paid and a tracking box. */
function DemoFrame() {
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: 'radial-gradient(ellipse at 50% 30%, #3a3a3a, #141414)' }}>
      {[
        { left: '22%', label: 'Kasia · paid ✓', color: '#45C9B4' },
        { left: '58%', label: 'Guest · 2.4 s', color: '#E8AA52' },
      ].map((p) => (
        <div key={p.left} style={{ position: 'absolute', left: p.left, bottom: 0, width: '22%' }}>
          <div style={{ position: 'absolute', left: '22%', right: '22%', top: '-2%', height: '52%', border: `3px solid ${p.color}`, borderRadius: 6 }}>
            <span style={{ position: 'absolute', left: -3, top: -26, padding: '2px 8px', background: p.color, color: '#0E1514', fontSize: 12, fontWeight: 700, borderRadius: 4, whiteSpace: 'nowrap' }}>
              {p.label}
            </span>
          </div>
          <img src={SILHOUETTE} alt="" style={{ width: '100%', display: 'block', opacity: 0.85 }} />
        </div>
      ))}
    </div>
  )
}
