// Screen 1: the organiser's events in three groups (planned, ongoing, past), one row each.
import { useCallback, useEffect, useState } from 'react'
import { ChartColumn, Plus, RefreshCw, Settings, Sparkles } from 'lucide-react'
import { useAccount, useBackend, walletErrorText } from './account'
import { navigate } from './App'
import {
  fmtCountdown,
  fmtDate,
  fmtDuration,
  fmtTime,
  prizePool,
  prizesPaid,
  remaining,
  withdrawable,
  sol,
  statusOf,
  type EventRow,
  type Status,
} from './model'
import { EventSettings } from './EventSettings'
import { Notice, StatusPill, useNow } from './ui'

const GROUPS: { status: Status; title: string }[] = [
  { status: 'planned', title: 'Planned' },
  { status: 'ongoing', title: 'Ongoing' },
  { status: 'past', title: 'Past' },
]

/** Re-read the list this often (the public RPC is rate limited, so not more). */
const REFRESH_MS = 30_000

export function Overview() {
  const backend = useBackend()
  const { address } = useAccount()
  const now = useNow(backend.now)
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [settings, setSettings] = useState<EventRow | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!address) return
    let cancelled = false
    setLoading(true)
    backend
      .listEvents(address)
      .then(
        (rows) => !cancelled && (setEvents(rows), setError(null)),
        (err) => !cancelled && setError(walletErrorText(err)),
      )
      .finally(() => !cancelled && setLoading(false))
    const id = window.setTimeout(reload, REFRESH_MS)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [backend, address, tick, reload])

  const grouped = GROUPS.map((g) => ({
    ...g,
    rows: (events ?? [])
      .filter((e) => statusOf(e, now) === g.status)
      // planned: soonest first; ongoing: ending first; past: most recent first
      .sort((a, b) => (g.status === 'past' ? b.end - a.end : g.status === 'ongoing' ? a.end - b.end : a.start - b.start)),
  })).filter((g) => g.rows.length > 0)

  return (
    <main className="os-page">
      <div className="os-pagehead">
        <div>
          <h1 className="os-title">Events</h1>
          <p className="os-subtitle">Attendance rewards you’ve locked on Solana, paid out automatically at check-in.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="os-iconbtn os-iconbtn--filled" style={{ width: 40, height: 40 }} onClick={reload} aria-label="Refresh" disabled={loading}>
            <RefreshCw size={16} style={loading ? { animation: 'os-spin 0.8s linear infinite' } : undefined} />
          </button>
          <button type="button" className="os-btn" onClick={() => navigate('/new')}>
            <Plus size={16} /> Create event
          </button>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="bad" title="Couldn’t read your events from Solana">
            {error}{' '}
            <button type="button" className="os-btn os-btn--sm os-btn--secondary" style={{ marginLeft: 8 }} onClick={reload}>
              Try again
            </button>
          </Notice>
        </div>
      )}

      {events === null ? (
        <div style={{ display: 'grid', gap: 10 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="os-skeleton" style={{ height: i === 1 ? 120 : 68 }} />
          ))}
        </div>
      ) : grouped.length === 0 ? (
        <div className="os-empty">
          <div className="os-empty-art">
            <Sparkles size={30} />
          </div>
          <h2>No events yet</h2>
          <p>Lock a reward pool for your next meetup. Attendees get paid to their wallets the moment the cameras see them.</p>
          <button type="button" className="os-btn" style={{ marginTop: 8 }} onClick={() => navigate('/new')}>
            <Plus size={16} /> Create event
          </button>
        </div>
      ) : (
        <div className="os-tablewrap">
          <div className="os-table">
            <div className="os-cols os-colhead" style={{ paddingLeft: 48 }}>
              <span>Status</span>
              <span>Event</span>
              <span>Start</span>
              <span>End</span>
              <span>Duration</span>
              <span>Prize pool</span>
              <span>Prizes paid</span>
              <span>Per attendee</span>
              <span>Remaining</span>
              <span>Participants</span>
              <span />
            </div>
            {grouped.map((g) => (
              <section key={g.status} className="os-group" data-s={g.status} aria-label={g.title}>
                <div className="os-group-head">
                  <h2 className="os-group-title">{g.title}</h2>
                  <span className="os-group-count">{g.rows.length}</span>
                </div>
                <div className="os-group-body">
                  {g.rows.map((e) => (
                    <Row key={e.id} event={e} status={g.status} now={now} onSettings={() => setSettings(e)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      {settings && (
        <EventSettings
          event={settings}
          onClose={() => setSettings(null)}
          onChanged={(row) => {
            setSettings(row)
            reload()
          }}
        />
      )}
    </main>
  )
}

function Row({ event: e, status, now, onSettings }: { event: EventRow; status: Status; now: number; onSettings: () => void }) {
  const open = () => navigate(`/events/${e.id}`)
  const pct = e.maxPaid ? Math.min(100, (e.paidCount / e.maxPaid) * 100) : 0
  return (
    <div
      className="os-cols os-row"
      data-s={status}
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(ev) => ev.key === 'Enter' && ev.target === ev.currentTarget && open()}
    >
      <span>
        <StatusPill status={status} label={status === 'ongoing' ? 'Live' : undefined} />
      </span>
      <span className="os-cell-name">
        <strong title={e.name}>{e.name}</strong>
        {e.venue && <span>{e.venue}</span>}
      </span>
      <span className="os-cell-date">
        {fmtDate(e.start)}
        <span>{fmtTime(e.start)}</span>
      </span>
      <span className="os-cell-date">
        {fmtDate(e.end)}
        <span>{fmtTime(e.end)}</span>
      </span>
      <span className="os-cell-num">{fmtDuration(e.end - e.start)}</span>
      <span className="os-cell-num">{sol(prizePool(e))} SOL</span>
      <span className="os-cell-num">{sol(prizesPaid(e))} SOL</span>
      <span className="os-cell-num">{sol(e.rewardLamports)} SOL</span>
      <span className="os-cell-num">
        {sol(remaining(e))} SOL
        {e.withdrawn && e.returnedLamports !== null && e.returnedLamports > 0n && <small>{sol(e.returnedLamports)} SOL returned</small>}
        {status === 'past' && withdrawable(e) > 0n && <small>ready to withdraw</small>}
      </span>
      <span className="os-cell-num">
        {e.paidCount} / {e.maxPaid}
        {status !== 'ongoing' && (
          <span className="os-minibar" aria-hidden>
            <i style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      <span className="os-cell-actions" onClick={(ev) => ev.stopPropagation()}>
        <button type="button" className="os-iconbtn" aria-label={`Settings for ${e.name}`} title="Settings" onClick={onSettings}>
          <Settings size={17} />
        </button>
        <button type="button" className="os-iconbtn" aria-label={`Dashboard for ${e.name}`} title="Dashboard" onClick={open}>
          <ChartColumn size={17} />
        </button>
      </span>
      {status === 'ongoing' && (
        <div className="os-row-live">
          <span>
            Ends in <b>{fmtCountdown(e.end * 1000 - now)}</b>
          </span>
          <span className="os-progress" aria-hidden>
            <i style={{ width: `${pct}%` }} />
          </span>
          <span>
            <b>{Math.round(pct)}%</b> of rewards paid
          </span>
        </div>
      )}
    </div>
  )
}
