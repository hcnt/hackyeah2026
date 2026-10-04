// Organizer's page: registers an event on the on_sight program. The organizer sets the reward deposit and the end
// date (plus name, start and the payout rules); one wallet transaction moves the deposit into the new Event account.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { nowIso } from '../widget/api'
import { ChainError, DEFAULT_PROGRAM_ID, DEFAULT_RPC_URL, readEventOracles } from '../widget/chain'
import {
  connect,
  disconnect,
  isLockedWallet,
  isUserRejection,
  METAMASK_DOWNLOAD_URL,
  shortAddress,
  signText,
  useSolanaWallets,
  type Connection,
} from '../widget/wallet'
import { explorerTxUrl } from '../venue/payload'
import { pairWithOracles, savePairing } from '../venue/pairing'
import { Button, Chip, CopyButton, Notice, Spinner } from '../venue/ui'
import {
  createEvent,
  DEFAULT_ORACLE,
  eventBudget,
  eventRent,
  eventTextError,
  FEE_LAMPORTS,
  formatSol,
  getBalance,
  isPublicKey,
  MAX_EVENT_NAME,
  MAX_EVENT_VENUE,
  MAX_ORACLES,
  parseSol,
  unregisteredOracles,
  type CreatedEvent,
  type EventParams,
} from './program'

/** Room for the transaction fee on top of deposit and rent. */
const TX_FEE_ROOM = 10_000n

function readLocation() {
  const q = new URLSearchParams(window.location.search)
  return { rpcUrl: q.get('rpc') || DEFAULT_RPC_URL, programId: q.get('program') || DEFAULT_PROGRAM_ID }
}

/** Value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(value: string): number | null {
  const ms = new Date(value).getTime()
  return value && Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function walletErrorText(err: unknown): string {
  if (isUserRejection(err)) return 'You closed the wallet prompt. Nothing was sent.'
  if (isLockedWallet(err)) return 'Your wallet is locked. Unlock it and try again.'
  if (err instanceof ChainError) return err.message
  return (err as Error | null)?.message || 'The wallet request failed.'
}

interface Form {
  name: string
  venue: string
  start: string
  end: string
  deposit: string
  reward: string
  minSeen: string
  oracles: string
  threshold: string
}

type Checked = { ok: true; params: EventParams; budget: bigint } | { ok: false; errors: Partial<Record<keyof Form, string>> }

function check(f: Form): Checked {
  const errors: Partial<Record<keyof Form, string>> = {}
  const nameErr = eventTextError('Name', f.name.trim(), 1, MAX_EVENT_NAME)
  if (nameErr) errors.name = nameErr
  const venueErr = eventTextError('Venue', f.venue.trim(), 0, MAX_EVENT_VENUE)
  if (venueErr) errors.venue = venueErr

  const start = fromLocalInput(f.start)
  const end = fromLocalInput(f.end)
  if (start === null) errors.start = 'Pick when the event starts.'
  if (end === null) errors.end = 'Pick when the event ends.'
  else if (end * 1000 <= Date.now()) errors.end = 'The end must be in the future.'
  else if (start !== null && end <= start) errors.end = 'The end must be after the start.'

  const deposit = parseSol(f.deposit)
  const reward = parseSol(f.reward)
  if (!reward) errors.reward = 'Enter the reward per attendee in SOL, e.g. 0.01.'
  if (!deposit) errors.deposit = 'Enter the reward deposit in SOL, e.g. 0.5.'
  const maxPaid = deposit && reward ? deposit / reward : 0n
  if (deposit && reward && maxPaid < 1n) errors.deposit = 'The deposit must cover at least one reward.'
  if (maxPaid > 0xffff_ffffn) errors.deposit = 'That deposit pays too many attendees; raise the reward.'

  const minSeen = Number(f.minSeen)
  if (!/^\d+$/.test(f.minSeen.trim()) || minSeen > 0xffff_ffff) errors.minSeen = 'Whole seconds, 0 or more.'

  const oracles = f.oracles.split(/[\s,]+/).filter(Boolean)
  if (oracles.length < 1 || oracles.length > MAX_ORACLES) errors.oracles = `List 1 to ${MAX_ORACLES} oracle keys.`
  else if (!oracles.every(isPublicKey)) errors.oracles = 'Every oracle must be a Solana public key.'
  else if (new Set(oracles).size !== oracles.length) errors.oracles = 'Each oracle can be listed once.'
  const threshold = Number(f.threshold)
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > Math.max(1, oracles.length)) {
    errors.threshold = `Between 1 and ${Math.max(1, oracles.length)}.`
  }

  if (Object.keys(errors).length) return { ok: false, errors }
  const params: EventParams = {
    oracles,
    threshold,
    start: start!,
    end: end!,
    rewardLamports: reward!,
    maxPaid: Number(maxPaid),
    minSeenSecs: minSeen,
    name: f.name.trim(),
    venue: f.venue.trim(),
  }
  return { ok: true, params, budget: eventBudget(reward!, Number(maxPaid)) }
}

type Submit = { kind: 'idle' } | { kind: 'busy'; step: string } | { kind: 'error'; message: string } | { kind: 'done'; created: CreatedEvent }

export function OrganizerPage() {
  const [{ rpcUrl, programId }] = useState(readLocation)
  const wallets = useSolanaWallets()
  const [conn, setConn] = useState<Connection | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  /** Oracle keys from the form that the program's registry doesn't know; null while unknown. */
  const [unregistered, setUnregistered] = useState<{ key: string; missing: string[] } | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [rent, setRent] = useState<bigint | null>(null)
  const [submit, setSubmit] = useState<Submit>({ kind: 'idle' })
  const [touched, setTouched] = useState(false)
  const [form, setForm] = useState<Form>(() => ({
    name: '',
    venue: '',
    start: toLocalInput(Date.now()),
    end: '',
    deposit: '',
    reward: '0.01',
    minSeen: '30',
    oracles: DEFAULT_ORACLE,
    threshold: '1',
  }))
  const checked = useMemo(() => check(form), [form])
  const set = (key: keyof Form) => (value: string) => setForm((f) => ({ ...f, [key]: value }))

  useEffect(() => {
    eventRent(rpcUrl).then(setRent, () => setRent(null))
  }, [rpcUrl])

  useEffect(() => {
    if (!conn) return
    let cancelled = false
    getBalance(rpcUrl, conn.account.address).then(
      (b) => !cancelled && setBalance(b),
      () => !cancelled && setBalance(null),
    )
    return () => {
      cancelled = true
    }
  }, [conn, rpcUrl, submit.kind])

  const oracleKey = checked.ok ? checked.params.oracles.join(',') : ''
  useEffect(() => {
    if (!oracleKey) return
    let cancelled = false
    const id = window.setTimeout(() => {
      unregisteredOracles(rpcUrl, programId, oracleKey.split(',')).then(
        (missing) => !cancelled && setUnregistered({ key: oracleKey, missing }),
        () => !cancelled && setUnregistered(null),
      )
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [oracleKey, rpcUrl, programId])
  const missingOracles = unregistered?.key === oracleKey ? unregistered.missing : []
  const oracleCount = checked.ok ? checked.params.oracles.length : 0

  const total = checked.ok ? checked.budget + (rent ?? 0n) : null
  const shortOfFunds = total !== null && balance !== null && balance < total + TX_FEE_ROOM

  /** Connect, then sign a sign-in message so the wallet opens (and unlocks) now rather than at the deposit. */
  async function onConnect(w: (typeof wallets)[number]) {
    setConnectError(null)
    setConnecting(w.name)
    let c: Connection | null = null
    try {
      c = await connect(w)
      await signText(
        c,
        `Sign in to OnSight as an event organizer.\n\nWallet: ${c.account.address}\nTime: ${nowIso()}\n\nThis costs nothing and sends no transaction.`,
      )
      setConn(c)
    } catch (err) {
      if (c) await disconnect(c)
      setConnectError(walletErrorText(err))
    } finally {
      setConnecting(null)
    }
  }

  async function onDisconnect() {
    if (conn) await disconnect(conn)
    setConn(null)
    setBalance(null)
  }

  /**
   * Pairs the stage with the event's oracles using the wallet that is already connected here and saves the tokens in
   * this browser, so the stage screen opens without connecting a wallet. On any failure the stage simply asks itself.
   */
  async function openStage(stageUrl: string, eventId: string) {
    if (conn) {
      try {
        const event = await readEventOracles(rpcUrl, programId, eventId)
        const results = await pairWithOracles(conn, eventId, event.oracles)
        if (event.meta) savePairing(eventId, event.meta.end, results)
      } catch {
        // rejected signature, oracle or RPC down: the stage screen offers pairing itself
      }
    }
    window.location.href = stageUrl
  }

  async function onSubmit() {
    setTouched(true)
    if (!conn || !checked.ok || submit.kind === 'busy') return
    setSubmit({ kind: 'busy', step: 'Preparing the transaction…' })
    try {
      const created = await createEvent(conn, rpcUrl, programId, checked.params, (step) => setSubmit({ kind: 'busy', step }))
      setSubmit({ kind: 'done', created })
    } catch (err) {
      setSubmit({ kind: 'error', message: walletErrorText(err) })
    }
  }

  const errors = !checked.ok && touched ? checked.errors : {}
  const busy = submit.kind === 'busy'

  return (
    <div className="min-h-svh bg-neutral-950 text-neutral-100">
      <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-xs font-semibold tracking-widest text-sky-300 uppercase">OnSight · organizer</p>
            <h1 className="text-3xl font-bold">Register an event</h1>
          </div>
          <Chip tone={/devnet/.test(rpcUrl) ? 'idle' : 'warn'} title={`Program ${programId}`}>
            {/devnet/.test(rpcUrl) ? 'devnet' : rpcUrl}
          </Chip>
        </header>

        {submit.kind === 'done' ? (
          <Created
            created={submit.created}
            params={checked.ok ? checked.params : null}
            onAnother={() => setSubmit({ kind: 'idle' })}
            onOpenStage={openStage}
          />
        ) : (
          <>
            <Section title="1. Organizer wallet" hint="The deposit is paid from this wallet. After the event ends, whatever wasn’t paid out comes back to it.">
              {conn ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="grid gap-1 text-sm">
                    <span className="font-mono">{shortAddress(conn.account.address)}</span>
                    <span className="text-neutral-400">
                      {balance === null ? 'Reading balance…' : `Balance: ${formatSol(balance)} SOL`}
                    </span>
                  </div>
                  <Button variant="ghost" disabled={busy} onClick={() => void onDisconnect()}>
                    Disconnect
                  </Button>
                </div>
              ) : wallets.length === 0 ? (
                <Notice title="No Solana wallet found in this browser">
                  Install MetaMask and turn on Solana, then reload.{' '}
                  <a className="underline" href={METAMASK_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                    Get MetaMask
                  </a>
                </Notice>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {wallets.map((w) => (
                    <Button key={w.name} disabled={!!connecting} onClick={() => void onConnect(w)}>
                      {connecting === w.name ? (
                        <Spinner label={`Sign in with ${w.name}…`} />
                      ) : (
                        <>
                          {w.icon && <img src={w.icon} alt="" className="size-5" />}
                          Sign in with {w.name}
                        </>
                      )}
                    </Button>
                  ))}
                </div>
              )}
              {connectError && <Notice tone="bad" title={connectError} />}
            </Section>

            <Section title="2. Event">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" error={errors.name} className="sm:col-span-2">
                  <input className={inputCls} value={form.name} maxLength={MAX_EVENT_NAME} placeholder="HackYeah 2026" onChange={(e) => set('name')(e.target.value)} />
                </Field>
                <Field label="Venue" optional error={errors.venue} className="sm:col-span-2">
                  <input className={inputCls} value={form.venue} maxLength={MAX_EVENT_VENUE} placeholder="Tauron Arena, Kraków" onChange={(e) => set('venue')(e.target.value)} />
                </Field>
                <Field label="Starts" error={errors.start}>
                  <input type="datetime-local" className={inputCls} value={form.start} onChange={(e) => set('start')(e.target.value)} />
                </Field>
                <Field label="Ends" error={errors.end} hint="Rewards are paid only until then. After it, you can withdraw what’s left.">
                  <input type="datetime-local" className={inputCls} value={form.end} min={form.start} onChange={(e) => set('end')(e.target.value)} />
                </Field>
              </div>
            </Section>

            <Section title="3. Reward deposit" hint="Held by the program, not by us. Each attendee seen at the event gets the reward, until the deposit runs out.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Deposit for rewards (SOL)" error={errors.deposit}>
                  <input inputMode="decimal" className={inputCls} value={form.deposit} placeholder="0.5" onChange={(e) => set('deposit')(e.target.value)} />
                </Field>
                <Field label="Reward per attendee (SOL)" error={errors.reward}>
                  <input inputMode="decimal" className={inputCls} value={form.reward} placeholder="0.01" onChange={(e) => set('reward')(e.target.value)} />
                </Field>
              </div>
              {checked.ok && (
                <dl className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm">
                  <Row label={`Rewards: ${checked.params.maxPaid} × ${formatSol(checked.params.rewardLamports)} SOL`} value={checked.params.rewardLamports * BigInt(checked.params.maxPaid)} />
                  <Row label={`Oracle fees: ${checked.params.maxPaid} × ${formatSol(FEE_LAMPORTS)} SOL`} value={FEE_LAMPORTS * BigInt(checked.params.maxPaid)} />
                  <Row label="Event account rent (returned on withdraw)" value={rent} />
                  <div className="my-1 border-t border-white/10" />
                  <Row label="You pay now" value={total} strong />
                  <p className="text-neutral-400">
                    Pays up to {checked.params.maxPaid} {checked.params.maxPaid === 1 ? 'attendee' : 'attendees'}. The oracle fee is
                    charged only for attendees who actually get paid.
                  </p>
                </dl>
              )}
            </Section>

            <details className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <summary className="cursor-pointer text-sm font-semibold text-neutral-200 select-none">Payout rules (advanced)</summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Time on camera before payout (s)" error={errors.minSeen} hint="Measured by the program on the chain clock.">
                  <input inputMode="numeric" className={inputCls} value={form.minSeen} onChange={(e) => set('minSeen')(e.target.value)} />
                </Field>
                <Field label="Oracles that must agree" error={errors.threshold}>
                  <input inputMode="numeric" className={inputCls} value={form.threshold} onChange={(e) => set('threshold')(e.target.value)} />
                </Field>
                <Field label={`Oracles (1–${MAX_ORACLES} public keys, one per line)`} error={errors.oracles} className="sm:col-span-2" hint="Only these keys can report attendees. Default: the OnSight oracle.">
                  <textarea rows={3} className={cn(inputCls, 'font-mono text-xs')} value={form.oracles} onChange={(e) => set('oracles')(e.target.value)} />
                </Field>
              </div>
              <p className="mt-4 text-xs text-neutral-500">These rules are frozen once the event exists. To change them, withdraw before the start and create a new event.</p>
            </details>

            <div className="grid gap-3">
              {missingOracles.length > 0 && (
                <Notice tone={missingOracles.length === oracleCount ? 'bad' : 'warn'} title={
                  missingOracles.length === oracleCount
                    ? 'None of the chosen oracles is in the on-chain registry'
                    : `${missingOracles.length} of the chosen oracles ${missingOracles.length === 1 ? 'is' : 'are'} not in the on-chain registry`
                }>
                  The stage screen can’t pair cameras with an unregistered oracle, so no QR code and no payouts through it.
                  The oracle registers once per program with <code className="font-mono">scripts/register_oracle.py</code>;
                  you can create the event now and it starts working as soon as the oracle registers.
                  <ul className="mt-1 font-mono text-xs break-all">
                    {missingOracles.map((k) => (
                      <li key={k}>{k}</li>
                    ))}
                  </ul>
                </Notice>
              )}
              {shortOfFunds && (
                <Notice title="Not enough SOL in this wallet">
                  You need about {formatSol(total! + TX_FEE_ROOM)} SOL and have {formatSol(balance!)} SOL.
                  {/devnet/.test(rpcUrl) && (
                    <>
                      {' '}
                      Get devnet SOL at{' '}
                      <a className="underline" href="https://faucet.solana.com" target="_blank" rel="noreferrer">
                        faucet.solana.com
                      </a>
                      .
                    </>
                  )}
                </Notice>
              )}
              {submit.kind === 'error' && <Notice tone="bad" title="The event wasn’t created">{submit.message}</Notice>}
              {!checked.ok && touched && <Notice title="Fix the highlighted fields first." />}
              <Button className="min-h-12 text-base" disabled={!conn || busy || shortOfFunds} onClick={() => void onSubmit()}>
                {busy ? <Spinner label={submit.step} /> : total !== null ? `Deposit ${formatSol(total)} SOL and create event` : 'Create event'}
              </Button>
              {!conn && <p className="text-center text-sm text-neutral-400">Connect your wallet first.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-xl border border-white/15 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30 aria-invalid:border-rose-400 [color-scheme:dark]'

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {hint && <p className="text-sm text-neutral-400">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({
  label,
  optional,
  hint,
  error,
  className,
  children,
}: {
  label: string
  optional?: boolean
  hint?: string
  error?: string
  className?: string
  children: ReactNode
}) {
  return (
    <label className={cn('grid content-start gap-1.5 text-sm', className)}>
      <span className="font-medium text-neutral-200">
        {label}
        {optional && <span className="font-normal text-neutral-500"> (optional)</span>}
      </span>
      <span className="contents [&>*]:aria-[invalid]:border-rose-400" aria-invalid={!!error || undefined}>
        {children}
      </span>
      {error ? <span className="text-rose-300">{error}</span> : hint && <span className="text-neutral-500">{hint}</span>}
    </label>
  )
}

function Row({ label, value, strong }: { label: string; value: bigint | null; strong?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4', strong && 'text-base font-semibold')}>
      <dt className={strong ? 'text-neutral-100' : 'text-neutral-300'}>{label}</dt>
      <dd className="shrink-0 font-mono tabular-nums">{value === null ? '…' : `${formatSol(value)} SOL`}</dd>
    </div>
  )
}

function Created({
  created,
  params,
  onAnother,
  onOpenStage,
}: {
  created: CreatedEvent
  params: EventParams | null
  onAnother: () => void
  onOpenStage: (stageUrl: string, eventId: string) => Promise<void>
}) {
  const [opening, setOpening] = useState(false)
  // Keep ?program= and ?rpc= so the stage screen and the attendee page read the same deployment.
  const base = `${window.location.origin}${import.meta.env.BASE_URL}`
  const query = new URLSearchParams(window.location.search)
  const stageUrl = `${base}stage.html${query.size ? `?${query}` : ''}#${created.event}`
  query.set('event', created.event)
  const attendeeUrl = `${base}?${query}`
  return (
    <section className="grid gap-5 rounded-2xl border border-emerald-400/30 bg-emerald-400/[0.06] p-6">
      <div className="grid gap-1">
        <Chip tone="ok">Registered on chain</Chip>
        <h2 className="mt-2 text-2xl font-bold">{params?.name ?? 'Your event'} is live</h2>
        {params && (
          <p className="text-neutral-300">
            Up to {params.maxPaid} attendees get {formatSol(params.rewardLamports)} SOL each until{' '}
            {new Date(params.end * 1000).toLocaleString()}.
          </p>
        )}
      </div>
      <div className="grid gap-2">
        <p className="text-sm font-medium text-neutral-200">Event id</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 rounded-lg border border-white/10 bg-neutral-900 px-3 py-2 font-mono text-xs break-all">{created.event}</code>
          <CopyButton text={created.event} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={opening}
          className="inline-flex min-h-11 items-center rounded-xl bg-sky-400 px-5 text-sm font-semibold text-neutral-950 hover:bg-sky-300 disabled:opacity-60"
          onClick={() => {
            setOpening(true)
            void onOpenStage(stageUrl, created.event).finally(() => setOpening(false))
          }}
        >
          {opening ? 'Approve the signature to pair cameras…' : 'Open the stage screen'}
        </button>
        <a className="inline-flex min-h-11 items-center rounded-xl border border-white/20 bg-white/5 px-5 text-sm font-semibold hover:bg-white/10" href={attendeeUrl} target="_blank" rel="noreferrer">
          Attendee page
        </a>
        <a className="inline-flex min-h-11 items-center rounded-xl border border-white/20 bg-white/5 px-5 text-sm font-semibold hover:bg-white/10" href={explorerTxUrl(created.signature)} target="_blank" rel="noreferrer">
          Deposit transaction
        </a>
      </div>
      <p className="text-sm text-neutral-400">
        After the event ends, withdraw what wasn’t paid out (with the account rent) back to your wallet.
      </p>
      <div>
        <Button variant="ghost" onClick={onAnother}>
          Register another event
        </Button>
      </div>
    </section>
  )
}
