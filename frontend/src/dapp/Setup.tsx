// Screen 2: a new attendance reward. "Save terms" checks them (including a simulation against the program, so the
// launch can't be refused) and freezes the form; "Launch event" then sends the one create_event transaction that moves
// the deposit into the new Event account.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronUp, Coins, ExternalLink, Info, Lock, MapPin, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { shortAddress } from '../widget/wallet'
import {
  DEFAULT_ORACLE,
  eventTextError,
  isPublicKey,
  MAX_EVENT_NAME,
  MAX_EVENT_VENUE,
  MAX_ORACLES,
  parseSol,
  type EventParams,
} from '../organizer/program'
import { useAccount, useBackend, walletErrorText } from './account'
import { WalletButtons, navigate } from './App'
import { eventLinks } from './EventSettings'
import { fmtDurationLong, sol } from './model'
import { Avatar, Notice, Spinner, useCopy } from './ui'

/** Room for the transaction fee on top of deposit and rent. */
const TX_FEE_ROOM = 10_000n

interface Form {
  name: string
  venue: string
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  reward: string
  entrants: string
  minSeen: string
  oracles: string
  threshold: string
}

type Errors = Partial<Record<keyof Form, string>>

const pad = (n: number) => String(n).padStart(2, '0')
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function initialForm(demo: boolean, nowMs: number): Form {
  // Demo: the placeholder terms. Live: tomorrow evening.
  const day = demo ? new Date(2026, 10, 12) : new Date(nowMs + 86_400_000)
  return {
    name: '',
    venue: '',
    startDate: dateValue(day),
    startTime: '18:00',
    endDate: dateValue(day),
    endTime: '22:00',
    reward: '0.5',
    entrants: '100',
    minSeen: '30',
    oracles: DEFAULT_ORACLE,
    threshold: '1',
  }
}

function toUnix(date: string, time: string): number | null {
  const ms = new Date(`${date}T${time || '00:00'}`).getTime()
  return date && Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function check(f: Form, nowMs: number): { params: EventParams | null; errors: Errors } {
  const errors: Errors = {}
  const name = f.name.trim()
  const venue = f.venue.trim()
  const nameErr = eventTextError('Event name', name, 1, MAX_EVENT_NAME)
  if (nameErr) errors.name = name ? nameErr : 'Give the event a name.'
  const venueErr = eventTextError('Venue', venue, 0, MAX_EVENT_VENUE)
  if (venueErr) errors.venue = venueErr

  const start = toUnix(f.startDate, f.startTime)
  const end = toUnix(f.endDate, f.endTime)
  if (start === null) errors.startDate = 'Pick when the event starts.'
  if (end === null) errors.endDate = 'Pick when the event ends.'
  else if (end * 1000 <= nowMs) errors.endDate = 'The end must be in the future.'
  else if (start !== null && end <= start) errors.endDate = 'The end must be after the start.'

  const reward = parseSol(f.reward)
  if (!reward) errors.reward = 'Enter the reward in SOL, e.g. 0.5.'
  const entrants = Number(f.entrants)
  if (!/^\d+$/.test(f.entrants.trim()) || entrants < 1 || entrants > 100_000) errors.entrants = 'Between 1 and 100 000 entrants.'

  const minSeen = Number(f.minSeen)
  if (!/^\d+$/.test(f.minSeen.trim()) || minSeen > 86_400) errors.minSeen = 'Whole seconds, 0 to 86 400.'
  const oracles = f.oracles.split(/[\s,]+/).filter(Boolean)
  if (oracles.length < 1 || oracles.length > MAX_ORACLES) errors.oracles = `List 1 to ${MAX_ORACLES} oracle keys.`
  else if (!oracles.every(isPublicKey)) errors.oracles = 'Every oracle must be a Solana public key.'
  else if (new Set(oracles).size !== oracles.length) errors.oracles = 'Each oracle can be listed once.'
  const threshold = Number(f.threshold)
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > Math.max(1, oracles.length)) {
    errors.threshold = `Between 1 and ${Math.max(1, oracles.length)}.`
  }

  if (Object.keys(errors).length) return { params: null, errors }
  return {
    params: { oracles, threshold, start: start!, end: end!, rewardLamports: reward!, maxPaid: entrants, minSeenSecs: minSeen, name, venue },
    errors,
  }
}

type Phase =
  | { kind: 'editing' }
  | { kind: 'checking' }
  | { kind: 'saved'; params: EventParams }
  | { kind: 'launching'; params: EventParams; step: string }
  | { kind: 'launched'; params: EventParams; event: string; signature: string }

export function Setup() {
  const backend = useBackend()
  const account = useAccount()
  const [form, setForm] = useState<Form>(() => initialForm(backend.mode === 'demo', backend.now()))
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' })
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rent, setRent] = useState<bigint | null>(null)
  const { params, errors } = useMemo(() => check(form, backend.now()), [form, backend])
  const shown: Errors = touched ? errors : {}
  const locked = phase.kind !== 'editing'
  const set = (key: keyof Form) => (value: string) => setForm((f) => ({ ...f, [key]: value }))

  useEffect(() => {
    backend.rent().then(setRent, () => setRent(null))
  }, [backend])

  // Live numbers from whatever is typed, even before the form is complete.
  const reward = parseSol(form.reward) ?? 0n
  const entrants = /^\d+$/.test(form.entrants.trim()) ? BigInt(form.entrants.trim()) : 0n
  const pool = reward * entrants
  const fees = backend.feePerAttendee * entrants
  const total = pool + fees + (rent ?? 0n)
  const left = account.balance === null ? null : account.balance - total
  const short = left !== null && left < TX_FEE_ROOM && entrants > 0n && reward > 0n
  const start = toUnix(form.startDate, form.startTime)
  const end = toUnix(form.endDate, form.endTime)

  async function save() {
    setTouched(true)
    setError(null)
    if (!params) return setError('Fix the highlighted fields first.')
    if (!account.address) return setError('Connect the sponsor wallet first.')
    if (short) return setError('This wallet can’t cover the deposit.')
    setPhase({ kind: 'checking' })
    try {
      await backend.checkTerms(account.address, params)
      setPhase({ kind: 'saved', params })
    } catch (err) {
      setPhase({ kind: 'editing' })
      setError(walletErrorText(err))
    }
  }

  async function launch() {
    if (phase.kind !== 'saved' || !account.address) return
    const saved = phase.params
    setError(null)
    setPhase({ kind: 'launching', params: saved, step: 'Preparing the transaction…' })
    try {
      const created = await backend.launch(account.conn, account.address, saved, (step) => setPhase({ kind: 'launching', params: saved, step }))
      account.refreshBalance()
      setPhase({ kind: 'launched', params: saved, ...created })
    } catch (err) {
      setPhase({ kind: 'saved', params: saved })
      setError(walletErrorText(err))
    }
  }

  if (phase.kind === 'launched') return <Launched params={phase.params} event={phase.event} signature={phase.signature} />

  const saveButton = (cls: string) => (
    <button type="button" className={cls} disabled={locked} onClick={() => void save()}>
      {phase.kind === 'checking' ? (
        <>
          <Spinner /> Checking terms…
        </>
      ) : (
        'Save terms'
      )}
    </button>
  )

  return (
    <main className="os-page os-page--narrow">
      <div className="os-topbar">
        <a className="os-back" href="#/">
          <ArrowLeft size={16} /> Back to overview
        </a>
        {saveButton('os-btn os-btn--secondary')}
      </div>
      <h1 className="os-title" style={{ marginBottom: 24 }}>
        New attendance reward
      </h1>

      <section className="os-card os-section" aria-labelledby="sec-a">
        <div className="os-section-head">
          <span className="os-section-icon">
            <MapPin size={18} />
          </span>
          <div>
            <h2 id="sec-a">Event details</h2>
            <p>What attendees see in their wallet and on the check-in page.</p>
          </div>
        </div>
        <div className="os-fields">
          <Field label="Event name" error={shown.name} counter={`${new TextEncoder().encode(form.name).length}/${MAX_EVENT_NAME}`}>
            <input
              className="os-input os-input--title"
              value={form.name}
              disabled={locked}
              placeholder="Solana Builders Night Kraków"
              aria-invalid={!!shown.name}
              onChange={(e) => set('name')(e.target.value)}
            />
          </Field>
          <Field label="Venue" error={shown.venue}>
            <input
              className="os-input"
              value={form.venue}
              disabled={locked}
              placeholder="Kraków Technology Park"
              aria-invalid={!!shown.venue}
              onChange={(e) => set('venue')(e.target.value)}
            />
          </Field>
          <div className="os-field">
            <span className="os-label">
              When <em>{Intl.DateTimeFormat().resolvedOptions().timeZone}</em>
            </span>
            <div className="os-dates">
              <DateRow label="Start" date={form.startDate} time={form.startTime} locked={locked} invalid={!!shown.startDate} onDate={set('startDate')} onTime={set('startTime')} />
              <DateRow
                label="End"
                date={form.endDate}
                time={form.endTime}
                min={form.startDate}
                locked={locked}
                invalid={!!shown.endDate}
                onDate={set('endDate')}
                onTime={set('endTime')}
              />
            </div>
            {(shown.startDate || shown.endDate) && <span className="os-error">{shown.startDate ?? shown.endDate}</span>}
            <div className="os-duration">
              <span>
                Total duration: <b>{start !== null && end !== null && end > start ? fmtDurationLong(end - start) : '—'}</b>
              </span>
              <span>Rewards are paid only between these times.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="os-card os-section" aria-labelledby="sec-b">
        <div className="os-section-head">
          <span className="os-section-icon">
            <Coins size={18} />
          </span>
          <div>
            <h2 id="sec-b">Rewards</h2>
            <p>Locked in the on_sight program, not by us. Unpaid rewards come back to you after the event.</p>
          </div>
        </div>
        <div className="os-fields">
          <div className="os-field">
            <span className="os-label">Sponsor wallet</span>
            {account.address ? (
              <div className="os-wallet">
                <Avatar address={account.address} size={36} />
                <div className="os-wallet-body">
                  <span className="os-wallet-addr mono">{shortAddress(account.address)}</span>
                  <span className="os-wallet-bal">
                    Balance <b className="num">{account.balance === null ? '…' : `${sol(account.balance)} SOL`}</b>
                  </span>
                </div>
                <button type="button" className="os-btn os-btn--secondary os-btn--sm" disabled={phase.kind === 'launching'} onClick={() => (setPhase({ kind: 'editing' }), void account.signOut())}>
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="os-wallet" style={{ display: 'block' }}>
                <p style={{ fontWeight: 500 }}>Connect the wallet that funds the rewards</p>
                <WalletButtons />
              </div>
            )}
          </div>

          <div className="os-fields os-fields--2">
            <Field label="Reward per attendee" error={shown.reward}>
              <div className="os-affix">
                <input
                  className="os-input num"
                  inputMode="decimal"
                  value={form.reward}
                  disabled={locked}
                  placeholder="0.5"
                  aria-invalid={!!shown.reward}
                  onChange={(e) => set('reward')(e.target.value)}
                />
                <span className="os-affix-tag">SOL</span>
              </div>
            </Field>
            <Field label="Entrants" hint="participants" error={shown.entrants}>
              <div className="os-affix">
                <input
                  className="os-input num"
                  inputMode="numeric"
                  value={form.entrants}
                  disabled={locked}
                  placeholder="100"
                  aria-invalid={!!shown.entrants}
                  onChange={(e) => set('entrants')(e.target.value.replace(/[^\d]/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault()
                      set('entrants')(String(Math.max(1, Number(form.entrants || 0) + (e.key === 'ArrowUp' ? 1 : -1))))
                    }
                  }}
                />
                <span className="os-stepper">
                  <button type="button" aria-label="More entrants" disabled={locked} onClick={() => set('entrants')(String(Number(form.entrants || 0) + 1))}>
                    <ChevronUp size={13} strokeWidth={2.5} />
                  </button>
                  <button
                    type="button"
                    aria-label="Fewer entrants"
                    disabled={locked || Number(form.entrants) <= 1}
                    onClick={() => set('entrants')(String(Math.max(1, Number(form.entrants || 0) - 1)))}
                  >
                    <ChevronDown size={13} strokeWidth={2.5} />
                  </button>
                </span>
              </div>
            </Field>
          </div>

          <div className="os-calc" aria-live="polite">
            <div className="os-calc-row">
              <span>
                {entrants.toString()} entrants × {sol(reward)} SOL
              </span>
              <span>{sol(pool)} SOL total prize pool</span>
            </div>
            <div className="os-calc-row">
              <span>
                Oracle fees <em>({sol(backend.feePerAttendee)} SOL per paid attendee)</em>
              </span>
              <span>{sol(fees)} SOL</span>
            </div>
            <div className="os-calc-row">
              <span>
                Event account rent <em>(returned on withdraw)</em>
              </span>
              <span>{rent === null ? '…' : `${sol(rent, 6)} SOL`}</span>
            </div>
            <div className="os-calc-sep" />
            <div className="os-calc-total">
              <span>Deducted from your balance</span>
              <span>{sol(total, 6)} SOL</span>
            </div>
            <div className="os-calc-left">
              <span>Remaining balance</span>
              <span style={{ color: short ? 'var(--danger)' : undefined }}>{left === null ? '—' : `${left < 0n ? '−' : ''}${sol(left < 0n ? -left : left, 6)} SOL`}</span>
            </div>
          </div>
          {short && (
            <Notice tone="bad" title="Not enough SOL in this wallet">
              Lower the reward or the number of entrants
              {backend.mode === 'live' && /devnet/i.test(backend.network) ? (
                <>
                  , or get devnet SOL at{' '}
                  <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
                    faucet.solana.com
                  </a>
                </>
              ) : null}
              .
            </Notice>
          )}

          <details className="os-details">
            <summary>
              <SlidersHorizontal size={16} /> Payout rules <span className="muted" style={{ fontWeight: 400 }}>· advanced</span>
              <ChevronDown size={16} />
            </summary>
            <div className="os-details-body">
              <div className="os-fields os-fields--2">
                <Field label="Time on camera before payout" hint="seconds, on the chain clock" error={shown.minSeen}>
                  <input className="os-input num" inputMode="numeric" value={form.minSeen} disabled={locked} onChange={(e) => set('minSeen')(e.target.value)} />
                </Field>
                <Field label="Oracles that must agree" error={shown.threshold}>
                  <input className="os-input num" inputMode="numeric" value={form.threshold} disabled={locked} onChange={(e) => set('threshold')(e.target.value)} />
                </Field>
              </div>
              <Field label={`Oracles (1–${MAX_ORACLES} public keys)`} hint="Only these keys can report attendees. Default: the OnSight oracle." error={shown.oracles}>
                <textarea className="os-input mono" rows={2} value={form.oracles} disabled={locked} onChange={(e) => set('oracles')(e.target.value)} />
              </Field>
            </div>
          </details>
        </div>
      </section>

      <div className="os-actions">
        {error && <Notice tone="bad" title={error} />}
        {phase.kind === 'saved' || phase.kind === 'launching' ? (
          <div className="os-saved">
            <ShieldCheck size={18} /> Terms saved{backend.mode === 'live' ? ' and checked against the program' : ''}. Ready to launch.
            <button type="button" className="os-btn os-btn--ghost os-btn--sm" disabled={phase.kind === 'launching'} onClick={() => setPhase({ kind: 'editing' })}>
              Edit terms
            </button>
          </div>
        ) : (
          saveButton('os-btn os-btn--lg os-btn--block')
        )}
        <button
          type="button"
          className={`os-btn os-btn--lg os-btn--block${phase.kind === 'saved' || phase.kind === 'launching' ? '' : ' os-btn--secondary'}`}
          disabled={phase.kind !== 'saved'}
          onClick={() => void launch()}
        >
          {phase.kind === 'launching' ? (
            <>
              <Spinner /> {phase.step}
            </>
          ) : (
            <>
              {phase.kind === 'saved' ? <Lock size={16} /> : null} Launch event{phase.kind === 'saved' ? ` · lock ${sol(total, 6)} SOL` : ''}
            </>
          )}
        </button>
        <p className="os-actions-hint">
          <Info size={13} />
          {phase.kind === 'saved' || phase.kind === 'launching'
            ? 'Your wallet asks you to approve one transaction. Terms can’t be changed after launch.'
            : 'Available after terms are saved'}
        </p>
      </div>
    </main>
  )
}

function Field({
  label,
  hint,
  counter,
  error,
  children,
}: {
  label: string
  hint?: string
  counter?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="os-field">
      <span className="os-label">
        <span>
          {label} {hint && <em>({hint})</em>}
        </span>
        {counter && <em className="num">{counter}</em>}
      </span>
      {children}
      {error && <span className="os-error">{error}</span>}
    </label>
  )
}

function DateRow({
  label,
  date,
  time,
  min,
  locked,
  invalid,
  onDate,
  onTime,
}: {
  label: string
  date: string
  time: string
  min?: string
  locked: boolean
  invalid: boolean
  onDate: (v: string) => void
  onTime: (v: string) => void
}) {
  return (
    <div className="os-daterow">
      <span className="os-daterow-label">{label}</span>
      <span className="os-datepair">
        <input type="date" className="os-pill-input" aria-label={`${label} date`} value={date} min={min} disabled={locked} aria-invalid={invalid} onChange={(e) => onDate(e.target.value)} />
        <input type="time" className="os-pill-input" aria-label={`${label} time`} value={time} disabled={locked} aria-invalid={invalid} onChange={(e) => onTime(e.target.value)} />
      </span>
    </div>
  )
}

function Launched({ params, event, signature }: { params: EventParams; event: string; signature: string }) {
  const backend = useBackend()
  const copy = useCopy()
  const links = eventLinks(event)
  return (
    <main className="os-page os-page--narrow">
      <div className="os-card os-success">
        <div className="os-success-badge">
          <Check size={36} strokeWidth={3} />
        </div>
        <h1>{params.name} is on chain</h1>
        <p>
          Up to {params.maxPaid} attendees get {sol(params.rewardLamports)} SOL each, paid automatically when they check in
          between the start and the end. Unpaid rewards come back to you after the event.
        </p>
        <div className="os-linkbox" style={{ width: '100%', maxWidth: 480 }}>
          <code className="mono">{event}</code>
          <button type="button" className="os-btn os-btn--secondary os-btn--sm" onClick={() => copy(event, 'Event id')}>
            Copy id
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 14 }}>
          <button type="button" className="os-btn" onClick={() => navigate(`/events/${event}`)}>
            Open dashboard
          </button>
          <a className="os-btn os-btn--secondary" href={links.attendee} target="_blank" rel="noreferrer">
            Attendee page
          </a>
          <a className="os-btn os-btn--ghost" href={backend.txUrl(signature)} target="_blank" rel="noreferrer">
            Deposit transaction <ExternalLink size={14} />
          </a>
        </div>
        <a className="os-back" href="#/" style={{ marginTop: 10 }}>
          <ArrowLeft size={16} /> Back to overview
        </a>
      </div>
    </main>
  )
}
