// Organizer's stage screen: reads the event from Solana, pairs cameras with every oracle the event lists (one signed
// camera-token message, posted to each), shows the camera QR code, the live annotated video and the payout feed.
import QRCode from 'qrcode'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Wallet } from '@wallet-standard/base'
import { cn } from '@/lib/utils'
import { ChainError, DEFAULT_PROGRAM_ID, DEFAULT_RPC_URL, readEventOracles, type EventOracles, type OracleEntry } from '../widget/chain'
import {
  connect,
  disconnect,
  isLockedWallet,
  isUserRejection,
  METAMASK_DOWNLOAD_URL,
  shortAddress,
  useSolanaWallets,
  type Connection,
} from '../widget/wallet'
import { parseJson, type CameraTokenResponse, type LiveFace, type LiveMessage } from './api'
import { clearPairing, loadPairing, pairWithOracles, savePairing, type PairResult } from './pairing'
import { base64ToBlob, drawFrame } from './draw'
import {
  backoffMs,
  CLOSE_EVENT_GONE,
  CLOSE_TOKEN_INVALID,
  encodeCameraPayload,
  explorerTxUrl,
  isMixedContent,
  stageWsUrl,
} from './payload'
import { Button, Chip, CopyButton, Notice, Spinner, type Tone } from './ui'
import { eventLamports, eventRent, formatSol, withdrawRemaining } from '../organizer/program'

/** Wall clock for status labels, refreshed every 30 s (kept out of render for purity). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

function readLocation() {
  const q = new URLSearchParams(window.location.search)
  return {
    eventId: decodeURIComponent(window.location.hash.replace(/^#/, '')).trim(),
    rpcUrl: q.get('rpc') || DEFAULT_RPC_URL,
    programId: q.get('program') || DEFAULT_PROGRAM_ID,
  }
}

export function StagePage() {
  const [loc, setLoc] = useState(readLocation)
  useEffect(() => {
    const onChange = () => setLoc(readLocation())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return (
    <div className="min-h-svh bg-neutral-950 text-neutral-100">
      <div className="mx-auto grid w-full max-w-[1600px] gap-5 px-4 py-5 sm:px-6">
        {loc.eventId ? (
          <Stage key={`${loc.eventId}|${loc.rpcUrl}|${loc.programId}`} {...loc} />
        ) : (
          <Centered>
            <h1 className="text-2xl font-bold">Stage screen</h1>
            <p className="text-neutral-300">
              Add your event id to the address, like <code className="font-mono">stage.html#YourEventId</code>.
            </p>
          </Centered>
        )}
      </div>
    </div>
  )
}

type ChainState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; event: EventOracles }


type Pairing = { kind: 'idle' } | { kind: 'busy'; step: string } | { kind: 'error'; message: string }

function walletErrorText(err: unknown): string {
  if (isUserRejection(err)) return 'You closed the wallet prompt. Try again when you’re ready.'
  if (isLockedWallet(err)) return 'Your wallet is locked. Unlock it and try again.'
  return (err as Error | null)?.message || 'The wallet request failed.'
}

function Stage({ eventId, rpcUrl, programId }: { eventId: string; rpcUrl: string; programId: string }) {
  const [chain, setChain] = useState<ChainState>({ kind: 'loading' })
  const [chainTry, setChainTry] = useState(0)
  const wallets = useSolanaWallets()
  const [conn, setConn] = useState<Connection | null>(null)
  const [pairing, setPairing] = useState<Pairing>({ kind: 'idle' })
  /** Latest per-oracle pairing results; kept while re-pairing so the live view stays up. */
  const [results, setResults] = useState<PairResult[] | null>(null)
  const busy = useRef(false)
  const now = useNow()
  const paired = useMemo(
    () => (results ?? []).filter((r): r is Extract<PairResult, { ok: true }> => r.ok),
    [results],
  )

  useEffect(() => {
    let cancelled = false
    readEventOracles(rpcUrl, programId, eventId).then(
      (event) => {
        if (cancelled) return
        setChain({ kind: 'ready', event })
        // Tokens saved by an earlier pairing in this browser (a refresh, or the organizer page): no wallet needed.
        const saved = loadPairing(eventId, event.oracles)
        if (saved) setResults((current) => current ?? saved)
      },
      (err: unknown) =>
        !cancelled &&
        setChain({
          kind: 'error',
          message: err instanceof ChainError ? err.message : (err as Error | null)?.message || 'Unknown error',
        }),
    )
    return () => {
      cancelled = true
    }
  }, [eventId, rpcUrl, programId, chainTry])

  const event = chain.kind === 'ready' ? chain.event : null
  const organizer = event?.meta?.organizer ?? null
  const isOrganizer = !!conn && (!organizer || conn.account.address === organizer)

  /** One signature, posted to every oracle. Tokens are fixed per event, so pairing again is harmless. */
  const pair = useCallback(
    async (c: Connection) => {
      if (!event || busy.current) return
      busy.current = true
      try {
        setPairing({ kind: 'busy', step: 'Approve the signature in your wallet…' })
        const results = await pairWithOracles(c, eventId, event.oracles)
        setResults(results)
        if (event.meta) savePairing(eventId, event.meta.end, results)
        setPairing({ kind: 'idle' })
      } catch (err) {
        setPairing({ kind: 'error', message: walletErrorText(err) })
      } finally {
        busy.current = false
      }
    },
    [event, eventId],
  )

  const onConnect = async (wallet: Wallet) => {
    if (busy.current) return
    busy.current = true
    let c: Connection
    try {
      setPairing({ kind: 'busy', step: `Connecting ${wallet.name}…` })
      c = await connect(wallet)
    } catch (err) {
      setPairing({ kind: 'error', message: walletErrorText(err) })
      return
    } finally {
      busy.current = false
    }
    setConn(c)
    setPairing({ kind: 'idle' })
    // Already paired from saved tokens: connecting is only for withdrawing, so don't ask for another signature.
    if ((!organizer || c.account.address === organizer) && paired.length === 0) void pair(c)
  }

  /** A token an oracle no longer accepts: sign again with the wallet, connecting it first if needed. */
  const repair = () => {
    if (conn) return void pair(conn)
    clearPairing(eventId)
    setResults(null)
  }

  const walletButtons =
    !conn && wallets.length > 0 ? (
      <div className="flex flex-wrap gap-2">
        {wallets.map((w) => (
          <Button key={w.name} variant="ghost" disabled={pairing.kind === 'busy'} onClick={() => void onConnect(w)}>
            {w.icon && <img src={w.icon} alt="" className="size-5" />}
            Connect {w.name}
          </Button>
        ))}
      </div>
    ) : null

  const onDisconnect = async () => {
    if (conn) await disconnect(conn)
    setConn(null)
    setPairing({ kind: 'idle' })
  }

  if (chain.kind === 'loading') {
    return (
      <Centered>
        <Spinner label="Reading the event from Solana…" />
      </Centered>
    )
  }
  if (chain.kind === 'error') {
    return (
      <Centered>
        <h1 className="text-2xl font-bold">We couldn’t read this event from Solana</h1>
        <Notice tone="bad" title={chain.message}>
          <p>
            Event <code className="font-mono break-all">{eventId}</code>, RPC <code className="font-mono break-all">{rpcUrl}</code>,
            program <code className="font-mono break-all">{programId}</code>.
          </p>
        </Notice>
        <Button onClick={() => (setChain({ kind: 'loading' }), setChainTry((n) => n + 1))}>Try again</Button>
      </Centered>
    )
  }

  const ev = chain.event
  const depositPanel = (refreshKey = 0) =>
    ev.meta && (
      <DepositPanel
        eventId={eventId}
        rpcUrl={rpcUrl}
        programId={programId}
        conn={isOrganizer ? conn : null}
        walletButtons={walletButtons}
        end={ev.meta.end}
        now={now}
        refreshKey={refreshKey}
      />
    )

  return (
    <>
      <Header eventId={eventId} event={ev} now={now} conn={conn} onDisconnect={() => void onDisconnect()} />

      {ev.oracles.length === 0 && (
        <Notice tone="bad" title="None of this event’s oracles is in the on-chain registry">
          There is nowhere to send the camera. Each oracle must register its address before cameras can pair.
        </Notice>
      )}
      {ev.unregistered.length > 0 && ev.oracles.length > 0 && (
        <Notice title={`${ev.unregistered.length} of the event’s oracles ${ev.unregistered.length === 1 ? 'has' : 'have'} no registry entry`}>
          Cameras can’t reach {ev.unregistered.length === 1 ? 'it' : 'them'}. Payouts still need {ev.threshold} oracles to
          agree.
        </Notice>
      )}
      {ev.meta && ev.meta.end * 1000 < now && (
        <Notice tone="bad" title="This event has ended">Cameras can no longer be paired. Payouts already sent are final.</Notice>
      )}

      {results && paired.length > 0 ? (
        <>
          {pairing.kind === 'busy' && <Spinner label={pairing.step} />}
          {pairing.kind === 'error' && <Notice tone="bad" title={pairing.message} />}
          <Live
            key={paired.map((p) => p.oracle.key).join()}
            eventId={eventId}
            paired={paired}
            failed={results.filter((r) => !r.ok)}
            threshold={ev.threshold}
            busy={pairing.kind === 'busy'}
            onRepair={repair}
            deposit={(refreshKey) => depositPanel(refreshKey)}
          />
        </>
      ) : (
        <Centered>
          {!conn ? (
            <>
              <h2 className="text-2xl font-bold">Connect the organizer wallet</h2>
              <p className="text-neutral-300">
                Sign once to pair cameras with this event’s {ev.oracles.length === 1 ? 'oracle' : `${ev.oracles.length} oracles`}.
                Signing costs nothing.
              </p>
              {wallets.length === 0 ? (
                <Notice title="No Solana wallet found in this browser">
                  Install MetaMask and turn on Solana, then reload.{' '}
                  <a className="underline" href={METAMASK_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                    Get MetaMask
                  </a>
                </Notice>
              ) : (
                <div className="grid gap-2">
                  {wallets.map((w) => (
                    <Button key={w.name} disabled={pairing.kind === 'busy' || ev.oracles.length === 0} onClick={() => void onConnect(w)}>
                      {w.icon && <img src={w.icon} alt="" className="size-5" />}
                      Connect {w.name}
                    </Button>
                  ))}
                </div>
              )}
            </>
          ) : !isOrganizer ? (
            <>
              <h2 className="text-2xl font-bold">This wallet isn’t the event’s organizer</h2>
              <p className="text-neutral-300">
                You connected <code className="font-mono">{shortAddress(conn.account.address)}</code>. Only the organizer{' '}
                <code className="font-mono">{organizer && shortAddress(organizer)}</code> can pair cameras. Switch to that
                account in your wallet and connect again.
              </p>
              <Button variant="ghost" onClick={() => void onDisconnect()}>
                Disconnect
              </Button>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-bold">Pair cameras</h2>
              <p className="text-neutral-300">Sign once and we send the same signature to every oracle of this event.</p>
              <Button disabled={pairing.kind === 'busy'} onClick={() => void pair(conn)}>
                {results ? 'Try again' : 'Sign and pair cameras'}
              </Button>
            </>
          )}
          {pairing.kind === 'busy' && <Spinner label={pairing.step} />}
          {pairing.kind === 'error' && <Notice tone="bad" title={pairing.message} />}
          {results && isOrganizer && (
            <>
              <Notice tone="bad" title="No oracle accepted the pairing">
                Check that the oracles are online and that this wallet is the event’s organizer.
              </Notice>
              <PairList results={results} />
            </>
          )}
          {conn && isOrganizer && <div className="text-left">{depositPanel()}</div>}
        </Centered>
      )}
    </>
  )
}

function eventStatus(meta: NonNullable<EventOracles['meta']>, nowMs: number): string {
  const now = nowMs / 1000
  if (now < meta.start) return 'upcoming'
  if (now > meta.end) return 'ended'
  return 'live'
}

function fmtTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function Header({
  eventId,
  event,
  now,
  conn,
  onDisconnect,
}: {
  eventId: string
  event: EventOracles
  now: number
  conn: Connection | null
  onDisconnect: () => void
}) {
  const meta = event.meta
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-4">
      <div className="grid gap-1">
        <p className="text-xs font-semibold tracking-widest text-sky-300 uppercase">Stage screen</p>
        <h1 className="text-2xl font-bold break-words sm:text-3xl">
          {meta ? (
            meta.name
          ) : (
            <>
              Event <span className="font-mono text-xl sm:text-2xl">{shortAddress(eventId)}</span>
            </>
          )}
        </h1>
        <p className="text-sm text-neutral-400">
          {meta?.venue ? `${meta.venue} · ` : ''}
          {meta ? `${fmtTime(meta.start)} – ${fmtTime(meta.end)} · ${eventStatus(meta, now)} · ` : ''}
          pays when {event.threshold} of {event.oracles.length + event.unregistered.length} oracles agree
          {meta ? ` · organizer ${shortAddress(meta.organizer)}` : ''}
        </p>
      </div>
      {conn && (
        <div className="flex items-center gap-2 text-sm text-neutral-300">
          <span className="font-mono">{shortAddress(conn.account.address)}</span>
          <Button variant="ghost" className="min-h-9 px-3 text-xs" onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      )}
    </header>
  )
}

function PairList({ results }: { results: PairResult[] }) {
  return (
    <ul className="grid gap-2 text-left text-sm">
      {results.map((r) => (
        <li key={r.oracle.key} className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-xs text-neutral-300">{r.oracle.name || hostOf(r.oracle.url)}</span>
          {r.ok ? <Chip tone="ok">paired</Chip> : <Chip tone="bad" title={r.message}>{r.message}</Chip>}
        </li>
      ))}
    </ul>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ---------- Live view ----------

type Conn = 'connecting' | 'live' | 'reconnecting' | 'expired' | 'ended' | 'blocked'

interface OracleLive {
  conn: Conn
  retryInSecs: number | null
  stats: { going: number; paid: number } | null
}

interface Payout {
  wallet: string
  name: string
  tx: string
  at: Date
}

const MAX_FEED = 100
/** Frames are taken from the first oracle (event order) that sent one within this window. */
const SOURCE_WINDOW_MS = 2000
const STALE_MS = 4000

function toDate(at: string | undefined): Date {
  const d = at ? new Date(at) : new Date(NaN)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

function Live({
  eventId,
  paired,
  failed,
  threshold,
  busy,
  onRepair,
  deposit,
}: {
  eventId: string
  paired: { oracle: OracleEntry; tokens: CameraTokenResponse }[]
  failed: PairResult[]
  threshold: number
  busy: boolean
  onRepair: () => void
  /** The deposit panel; `refreshKey` changes with every payout so the balance is re-read. */
  deposit: (refreshKey: number) => ReactNode
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [oracles, setOracles] = useState<OracleLive[]>(() =>
    paired.map(() => ({ conn: 'connecting', retryInSecs: null, stats: null })),
  )
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [hasFrame, setHasFrame] = useState(false)
  const [source, setSource] = useState<number | null>(null)
  const [cameraFps, setCameraFps] = useState<number | null>(null)
  const [stale, setStale] = useState(true)
  const [showQr, setShowQr] = useState(true)
  const frameTimes = useRef<number[]>([])

  const cameraUrl = `${window.location.origin}/camera.html#${encodeCameraPayload({
    eventId,
    oracles: paired.map((p) => ({ url: p.oracle.url, token: p.tokens.camera_token })),
  })}`

  // One socket per oracle: payouts and stats from all, frames drawn from the first that is sending them.
  useEffect(() => {
    let disposed = false
    const lastFrameAt = paired.map(() => 0)
    let currentSource: number | null = null
    let decoding = false
    let pending: { jpeg: string; width: number; height: number; faces: LiveFace[] } | null = null

    const patch = (i: number, p: Partial<OracleLive>) =>
      setOracles((prev) => prev.map((o, j) => (j === i ? { ...o, ...p } : o)))

    const render = async () => {
      if (decoding || !pending) return
      decoding = true
      const f = pending
      pending = null
      try {
        const bmp = await createImageBitmap(base64ToBlob(f.jpeg))
        const ctx = canvasRef.current?.getContext('2d')
        if (!disposed && ctx) {
          drawFrame(ctx, bmp, f.width || bmp.width, f.height || bmp.height, f.faces ?? [])
          setHasFrame(true)
        }
        bmp.close()
      } catch {
        // A corrupt frame is skipped; the next one replaces it.
      } finally {
        decoding = false
        if (!disposed && pending) void render()
      }
    }

    const onFrame = (i: number, msg: Extract<LiveMessage, { type: 'frame' }>) => {
      const now = performance.now()
      lastFrameAt[i] = now
      for (let j = 0; j < i; j++) if (now - lastFrameAt[j] < SOURCE_WINDOW_MS) return
      if (currentSource !== i) {
        currentSource = i
        setSource(i)
      }
      frameTimes.current.push(now)
      pending = msg
      void render()
    }

    const stops = paired.map(({ oracle, tokens }, i) => {
      let ws: WebSocket | null = null
      let attempt = 0
      let retryTimer: number | undefined
      let countdownTimer: number | undefined

      const scheduleReconnect = () => {
        const delay = backoffMs(attempt++)
        const until = Date.now() + delay
        patch(i, { conn: 'reconnecting', retryInSecs: Math.ceil(delay / 1000) })
        window.clearInterval(countdownTimer)
        countdownTimer = window.setInterval(
          () => patch(i, { retryInSecs: Math.max(0, Math.ceil((until - Date.now()) / 1000)) }),
          1000,
        )
        retryTimer = window.setTimeout(() => {
          window.clearInterval(countdownTimer)
          open()
        }, delay)
      }

      const open = () => {
        if (disposed) return
        if (isMixedContent(window.location.protocol, oracle.url)) {
          patch(i, { conn: 'blocked', retryInSecs: null })
          return
        }
        patch(i, { conn: attempt === 0 ? 'connecting' : 'reconnecting', retryInSecs: null })
        let sock: WebSocket
        try {
          sock = new WebSocket(stageWsUrl(oracle.url, eventId, tokens.stage_token))
        } catch {
          patch(i, { conn: 'blocked', retryInSecs: null })
          return
        }
        ws = sock
        sock.onopen = () => {
          if (disposed || sock !== ws) return
          attempt = 0
          patch(i, { conn: 'live' })
        }
        sock.onmessage = (ev: MessageEvent) => {
          if (disposed || sock !== ws) return
          const msg = parseJson<LiveMessage>(ev.data)
          if (!msg) return
          if (msg.type === 'frame') onFrame(i, msg)
          else if (msg.type === 'stats') patch(i, { stats: { going: msg.going, paid: msg.paid } })
          else if (msg.type === 'payout' && msg.tx) {
            const p: Payout = { wallet: msg.wallet, name: msg.name ?? '', tx: msg.tx, at: toDate(msg.at) }
            setPayouts((prev) =>
              prev.some((x) => x.tx === p.tx)
                ? prev
                : [p, ...prev].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, MAX_FEED),
            )
          }
        }
        sock.onclose = (ev: CloseEvent) => {
          if (disposed || sock !== ws) return
          ws = null
          lastFrameAt[i] = 0
          if (ev.code === CLOSE_TOKEN_INVALID) patch(i, { conn: 'expired', retryInSecs: null })
          else if (ev.code === CLOSE_EVENT_GONE) patch(i, { conn: 'ended', retryInSecs: null })
          else scheduleReconnect()
        }
      }

      open()
      return () => {
        window.clearTimeout(retryTimer)
        window.clearInterval(countdownTimer)
        if (ws) {
          ws.onopen = ws.onmessage = ws.onclose = null
          ws.close(1000, 'stage closed')
        }
        ws = null
      }
    })

    return () => {
      disposed = true
      stops.forEach((s) => s())
    }
  }, [eventId, paired])

  // Camera health from frame arrival times, sampled once a second (keeps re-renders off the frame path).
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = performance.now()
      const t = frameTimes.current
      while (t.length && now - t[0] > 3000) t.shift()
      setCameraFps(t.length > 1 ? ((t.length - 1) * 1000) / (t[t.length - 1] - t[0] || 1) : null)
      setStale(t.length === 0 || now - t[t.length - 1] > STALE_MS)
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  const going = maxOf(oracles.map((o) => o.stats?.going))
  const paid = maxOf(oracles.map((o) => o.stats?.paid))
  const needsRepair = oracles.some((o) => o.conn === 'expired' || o.conn === 'ended')
  const liveCount = oracles.filter((o) => o.conn === 'live').length

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
      <section aria-label="Live camera" className="grid content-start gap-3">
        {needsRepair && (
          <Notice tone="bad" title="An oracle closed the stage connection">
            <div className="mt-1 grid justify-items-start gap-2">
              <span>
                Its access expired or it no longer knows this event. Sign again to reconnect — phones that are streaming keep
                working.
              </span>
              <Button className="min-h-9 px-3 text-xs" disabled={busy} onClick={onRepair}>
                Reconnect
              </Button>
            </div>
          </Notice>
        )}
        <div className="relative overflow-hidden rounded-2xl bg-black">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="Live camera view with recognised attendees marked"
            className={cn('block h-auto w-full', !hasFrame && 'hidden')}
          />
          {!hasFrame && (
            <div className="flex aspect-video flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-xl font-semibold">Waiting for the event camera</p>
              <p className="max-w-sm text-sm text-neutral-400">
                Scan the QR code with a phone and point it at the room. The video appears here.
              </p>
            </div>
          )}
          {hasFrame && (
            <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-black/65 px-3 py-1 font-mono text-xs">
              {stale
                ? 'camera paused'
                : `camera · ${cameraFps ? Math.round(cameraFps) : '–'} fps${source !== null ? ` · via ${paired[source].oracle.name || hostOf(paired[source].oracle.url)}` : ''}`}
            </span>
          )}
          {hasFrame && stale && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <p className="rounded-xl bg-black/75 px-4 py-2 text-center text-sm">
                No new frames from the camera. Check that the phone is still streaming.
              </p>
            </div>
          )}
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-neutral-400" aria-label="Legend">
          <Legend swatch="border-[#E8AA52]">Amber: on the list, being recognised</Legend>
          <Legend swatch="border-[#45C9B4]">Green: paid</Legend>
          <Legend swatch="border-[#7A8886] border-dashed">Grey: not on the list, face discarded</Legend>
        </ul>
      </section>

      <aside className="grid content-start gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Counter label="going" value={going} />
          <Counter label="paid" value={paid} money />
        </div>

        {deposit(payouts.length)}

        <Panel title={`Oracles · ${liveCount} of ${paired.length} connected · ${threshold} needed to pay`}>
          <ul className="grid gap-2">
            {paired.map((p, i) => (
              <li key={p.oracle.key} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-xs text-neutral-300" title={p.oracle.url}>
                  {p.oracle.name || hostOf(p.oracle.url)}
                </span>
                <ConnChip o={oracles[i]} />
              </li>
            ))}
            {failed.map((r) => (
              <li key={r.oracle.key} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-xs text-neutral-300" title={r.oracle.url}>
                  {r.oracle.name || hostOf(r.oracle.url)}
                </span>
                <Chip tone="bad" title={r.ok ? '' : r.message}>
                  not paired: {r.ok ? '' : r.message}
                </Chip>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Payouts">
          {payouts.length === 0 ? (
            <p className="text-sm text-neutral-400">No payouts yet. They appear here once the oracles agree on someone.</p>
          ) : (
            <ol className="grid max-h-[40svh] gap-2 overflow-y-auto pr-1" aria-live="polite">
              {payouts.map((p) => (
                <li key={p.tx} className="grid gap-0.5 border-b border-dashed border-white/10 pb-2 text-sm last:border-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono font-semibold">{p.name.trim() || shortAddress(p.wallet)}</span>
                    <time className="font-mono text-xs text-neutral-400" dateTime={p.at.toISOString()}>
                      {p.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </time>
                  </div>
                  <a
                    href={explorerTxUrl(p.tx)}
                    target="_blank"
                    rel="noreferrer"
                    className="justify-self-start font-mono text-xs text-emerald-300 underline-offset-2 hover:underline"
                    title={p.tx}
                  >
                    tx {shortAddress(p.tx)} ↗
                  </a>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel
          title="Add a camera"
          action={
            <Button variant="ghost" className="min-h-8 px-3 text-xs" onClick={() => setShowQr((s) => !s)}>
              {showQr ? 'Hide' : 'Show'}
            </Button>
          }
        >
          {showQr ? (
            <>
              <p className="text-sm text-neutral-400">
                Scan with a phone to turn it into the event camera. It streams to {paired.length === 1 ? 'the paired oracle' : `all ${paired.length} paired oracles`}.
              </p>
              <QrCode text={cameraUrl} />
              <code className="max-h-24 overflow-y-auto rounded-lg bg-black/50 p-2 font-mono text-xs break-all select-all">
                {cameraUrl}
              </code>
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton text={cameraUrl} label="Copy camera link" />
                <span className="text-xs text-neutral-500">Anyone with this link can stream to your event.</span>
              </div>
            </>
          ) : (
            <p className="text-sm text-neutral-400">Hidden. Phones that are already streaming keep working.</p>
          )}
        </Panel>
      </aside>
    </div>
  )
}

function maxOf(values: (number | undefined)[]): number | undefined {
  const nums = values.filter((v): v is number => typeof v === 'number')
  return nums.length ? Math.max(...nums) : undefined
}

function ConnChip({ o }: { o: OracleLive }) {
  const map: Record<Conn, [Tone, string]> = {
    connecting: ['warn', 'connecting…'],
    live: ['ok', 'live'],
    reconnecting: ['warn', o.retryInSecs ? `unreachable · retry in ${o.retryInSecs} s` : 'reconnecting…'],
    expired: ['bad', 'access expired'],
    ended: ['bad', 'event ended'],
    blocked: ['bad', 'insecure address, blocked'],
  }
  const [tone, text] = map[o.conn]
  return (
    <Chip tone={tone} pulse={o.conn === 'live'}>
      {text}
    </Chip>
  )
}

/** How often the deposit balance is re-read besides after each payout (the public RPC is rate limited). */
const DEPOSIT_POLL_MS = 20_000

type Withdraw = { kind: 'idle' } | { kind: 'busy'; step: string } | { kind: 'error'; message: string } | { kind: 'done'; tx: string; lamports: bigint | null }

/**
 * What is left of the event's deposit (the Event account's lamports minus its rent) and the organizer's
 * withdraw_remaining button, which unlocks once the event has ended. Withdrawing closes the account.
 */
function DepositPanel({
  eventId,
  rpcUrl,
  programId,
  conn,
  walletButtons,
  end,
  now,
  refreshKey,
}: {
  eventId: string
  rpcUrl: string
  programId: string
  /** The organizer's connection, or null when no organizer wallet is connected. */
  conn: Connection | null
  /** Connect buttons, shown when withdrawing needs a wallet that isn't connected (null when one is). */
  walletButtons: ReactNode
  /** Unix seconds. */
  end: number
  now: number
  refreshKey: number
}) {
  const [balance, setBalance] = useState<{ lamports: bigint | null; rent: bigint } | null>(null)
  const [readTry, setReadTry] = useState(0)
  const [withdraw, setWithdraw] = useState<Withdraw>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    const read = () =>
      Promise.all([eventLamports(rpcUrl, eventId), eventRent(rpcUrl)]).then(
        ([lamports, rent]) => !cancelled && setBalance({ lamports, rent }),
        () => {},
      )
    void read()
    const id = window.setInterval(read, DEPOSIT_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [eventId, rpcUrl, refreshKey, readTry])

  const closed = balance !== null && balance.lamports === null
  const left = balance?.lamports != null ? (balance.lamports > balance.rent ? balance.lamports - balance.rent : 0n) : null
  const ended = now > end * 1000

  async function onWithdraw() {
    if (!conn || withdraw.kind === 'busy') return
    const returned = balance?.lamports ?? null
    setWithdraw({ kind: 'busy', step: 'Preparing the transaction…' })
    try {
      const tx = await withdrawRemaining(conn, rpcUrl, programId, eventId, (step) => setWithdraw({ kind: 'busy', step }))
      setWithdraw({ kind: 'done', tx, lamports: returned })
      setReadTry((n) => n + 1)
    } catch (err) {
      setWithdraw({ kind: 'error', message: walletErrorText(err) })
    }
  }

  return (
    <Panel title="Deposit">
      <div className="grid gap-0.5">
        <span className="text-4xl font-bold text-emerald-300 tabular-nums">
          {closed ? '0' : left === null ? '–' : formatSol(left)} <span className="text-xl font-semibold">SOL</span>
        </span>
        <span className="text-sm text-neutral-400">
          {closed ? 'withdrawn, the event account is closed' : 'left for rewards and oracle fees'}
        </span>
      </div>
      {withdraw.kind === 'done' ? (
        <Notice tone="ok" title="Deposit withdrawn">
          {withdraw.lamports !== null && <>{formatSol(withdraw.lamports)} SOL (with the account rent) went back to your wallet. </>}
          <a className="underline" href={explorerTxUrl(withdraw.tx)} target="_blank" rel="noreferrer">
            View transaction ↗
          </a>
        </Notice>
      ) : (
        !closed && (
          <>
            <Button
              variant={ended ? 'primary' : 'ghost'}
              disabled={!ended || !conn || withdraw.kind === 'busy' || balance === null}
              onClick={() => void onWithdraw()}
            >
              {withdraw.kind === 'busy' ? <Spinner label={withdraw.step} /> : 'Withdraw remaining deposit'}
            </Button>
            <p className="text-xs text-neutral-400">
              {!ended
                ? `Unlocks when the event ends (${fmtTime(end)}).`
                : !conn
                  ? 'Connect the organizer wallet to withdraw.'
                  : 'Returns what wasn’t paid out, plus the account rent, to your wallet.'}
            </p>
            {ended && !conn && walletButtons}
          </>
        )
      )}
      {withdraw.kind === 'error' && <Notice tone="bad" title="Withdraw failed">{withdraw.message}</Notice>}
    </Panel>
  )
}

function Counter({ label, value, money }: { label: string; value: number | undefined; money?: boolean }) {
  return (
    <div className="grid gap-0.5 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <span className={cn('text-4xl font-bold tabular-nums', money && 'text-emerald-300')}>{value ?? '–'}</span>
      <span className="text-sm text-neutral-400">{label}</span>
    </div>
  )
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Legend({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden className={cn('size-3.5 rounded-sm border-2', swatch)} />
      {children}
    </li>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="mx-auto grid w-full max-w-lg content-center gap-4 py-12 text-center">{children}</div>
}

function QrCode({ text }: { text: string }) {
  const [result, setResult] = useState<{ text: string; src: string | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'L' }).then(
      (src) => !cancelled && setResult({ text, src }),
      () => !cancelled && setResult({ text, src: null }),
    )
    return () => {
      cancelled = true
    }
  }, [text])
  const current = result?.text === text ? result : null
  if (current && !current.src) return <p className="text-sm text-rose-300">Could not draw the QR code. Use the link below instead.</p>
  return (
    <div className="justify-self-center rounded-xl bg-white p-2">
      {current?.src ? (
        <img src={current.src} alt="QR code that opens the event camera page" className="size-72" />
      ) : (
        <div className="flex size-72 items-center justify-center text-neutral-500">
          <Spinner />
        </div>
      )}
    </div>
  )
}
