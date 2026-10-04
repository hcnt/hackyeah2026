// Cameras on the dashboard. Live: the organizer pairs once (one free signature, posted to every oracle of the event,
// tokens kept in this browser until the event ends, same as the stage screen), then one stage socket per oracle brings
// annotated frames and payouts. The phone streams the same frames to every oracle, so the dashboard shows one camera
// feed: online while any oracle relays frames, drawn from the first such oracle, with each oracle's state in the note.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readEventOracles, type OracleEntry } from '../widget/chain'
import type { Connection } from '../widget/wallet'
import { parseJson, type CameraTokenResponse, type LiveFace, type LiveMessage } from '../venue/api'
import { base64ToBlob, drawFrame } from '../venue/draw'
import { clearPairing, loadPairing, pairWithOracles, savePairing } from '../venue/pairing'
import { backoffMs, CLOSE_EVENT_GONE, CLOSE_TOKEN_INVALID, encodeCameraPayload, isMixedContent, stageWsUrl } from '../venue/payload'
import type { Backend } from './backend'
import { walletErrorText } from './account'
import type { EventRow, Payout } from './model'

export interface Camera {
  id: string
  name: string
  online: boolean
  /** Why it is offline, when known. */
  note?: string
}

export type PairState =
  | { kind: 'loading' }
  | { kind: 'unpaired' }
  | { kind: 'busy'; step: string }
  | { kind: 'error'; message: string }
  | { kind: 'paired' }

export interface CameraFeed {
  cameras: Camera[]
  /** Link that turns a phone into an event camera; null until paired. */
  cameraUrl: string | null
  pair: PairState
  pairNow(): void
  /** Draws camera `id` into `canvas` as frames arrive; returns a stop function. */
  watch(id: string, canvas: HTMLCanvasElement): () => void
  /** Payouts announced over the stage sockets (instant, before the RPC history catches up). */
  livePayouts: Payout[]
}

type Frame = { jpeg: string; width: number; height: number; faces: LiveFace[] }
const STALE_MS = 4000
/** Id of the single camera feed (frames and online state keyed by oracle key otherwise). */
const FEED = 'feed'

export function useCameraFeed(backend: Backend, event: EventRow | null, conn: Connection | null): CameraFeed {
  const demo = useDemoFeed(backend.mode === 'demo')
  const live = useLiveFeed(backend.mode === 'live' ? backend : null, event, conn)
  return backend.mode === 'demo' ? demo : live
}

function useDemoFeed(enabled: boolean): CameraFeed {
  return useMemo(
    () => ({
      cameras: enabled
        ? [
            { id: 'cam-1', name: 'Entrance camera 1', online: true },
            { id: 'cam-2', name: 'Entrance camera 2', online: false, note: 'Phone stopped streaming 6 min ago' },
          ]
        : [],
      cameraUrl: `${window.location.origin}${import.meta.env.BASE_URL}camera.html#demo-event-camera-link`,
      pair: { kind: 'paired' },
      pairNow: () => {},
      watch: () => () => {},
      livePayouts: [],
    }),
    [enabled],
  )
}

function useLiveFeed(backend: Backend | null, event: EventRow | null, conn: Connection | null): CameraFeed {
  const [oracles, setOracles] = useState<OracleEntry[] | null>(null)
  const [tokens, setTokens] = useState<{ oracle: OracleEntry; tokens: CameraTokenResponse }[] | null>(null)
  const [pair, setPair] = useState<PairState>({ kind: 'loading' })
  const [online, setOnline] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [livePayouts, setLivePayouts] = useState<Payout[]>([])
  const lastFrame = useRef(new Map<string, { frame: Frame; at: number }>())
  const watchers = useRef(new Map<string, Set<(f: Frame) => void>>())
  const eventId = event?.id ?? null
  const end = event?.end ?? 0
  const reward = event?.rewardLamports ?? 0n
  const rpcUrl = backend?.rpcUrl
  const programId = backend?.programId

  // The event's registered oracles, then any tokens saved by an earlier pairing in this browser.
  useEffect(() => {
    if (!eventId || !rpcUrl || !programId) return
    let cancelled = false
    readEventOracles(rpcUrl, programId, eventId).then(
      (ev) => {
        if (cancelled) return
        setOracles(ev.oracles)
        const saved = loadPairing(eventId, ev.oracles)
        if (saved) {
          setTokens(saved.flatMap((r) => (r.ok ? [{ oracle: r.oracle, tokens: r.tokens }] : [])))
          setPair({ kind: 'paired' })
        } else setPair({ kind: 'unpaired' })
      },
      () => !cancelled && setPair({ kind: 'error', message: 'Couldn’t read the event’s oracles from Solana.' }),
    )
    return () => {
      cancelled = true
    }
  }, [eventId, rpcUrl, programId])

  const pairNow = useCallback(async () => {
    if (!eventId || !oracles) return
    if (!conn) return setPair({ kind: 'error', message: 'Sign in with the organiser’s wallet to pair cameras.' })
    if (oracles.length === 0) return setPair({ kind: 'error', message: 'None of this event’s oracles is in the on-chain registry.' })
    setPair({ kind: 'busy', step: 'Approve the signature in your wallet…' })
    try {
      const results = await pairWithOracles(conn, eventId, oracles)
      const ok = results.flatMap((r) => (r.ok ? [{ oracle: r.oracle, tokens: r.tokens }] : []))
      if (ok.length === 0) {
        const first = results.find((r) => !r.ok)
        return setPair({ kind: 'error', message: `No oracle accepted the pairing${first && !first.ok ? `: ${first.message}` : ''}.` })
      }
      savePairing(eventId, end, results)
      setTokens(ok)
      setPair({ kind: 'paired' })
    } catch (err) {
      setPair({ kind: 'error', message: walletErrorText(err) })
    }
  }, [conn, eventId, oracles, end])

  // One stage socket per paired oracle.
  useEffect(() => {
    if (!eventId || !tokens?.length) return
    let disposed = false
    const stops = tokens.map(({ oracle, tokens: t }) => {
      let ws: WebSocket | null = null
      let attempt = 0
      let timer: number | undefined
      const note = (text: string) => setNotes((n) => ({ ...n, [oracle.key]: text }))
      const open = () => {
        if (disposed) return
        if (isMixedContent(window.location.protocol, oracle.url)) return note('Oracle address is not secure; the browser blocks it')
        let sock: WebSocket
        try {
          sock = new WebSocket(stageWsUrl(oracle.url, eventId, t.stage_token))
        } catch {
          return note('Couldn’t open the connection')
        }
        ws = sock
        sock.onopen = () => {
          attempt = 0
          note('Waiting for a phone to stream')
        }
        sock.onmessage = (ev: MessageEvent) => {
          const msg = parseJson<LiveMessage>(ev.data)
          if (!msg || disposed) return
          if (msg.type === 'frame') {
            const frame = { jpeg: msg.jpeg, width: msg.width, height: msg.height, faces: msg.faces ?? [] }
            const now = performance.now()
            lastFrame.current.set(oracle.key, { frame, at: now })
            // The feed shows the first oracle (in the event's order) that is relaying, so the picture doesn't flicker
            // between two oracles' boxes.
            const shown = tokens.find(({ oracle: o }) => {
              const last = lastFrame.current.get(o.key)
              return last && now - last.at < STALE_MS
            })
            if (shown?.oracle.key === oracle.key) {
              lastFrame.current.set(FEED, { frame, at: now })
              watchers.current.get(FEED)?.forEach((w) => w(frame))
            }
          } else if (msg.type === 'payout' && msg.tx) {
            const at = msg.at ? new Date(msg.at).getTime() : Date.now()
            const p: Payout = { tx: msg.tx, wallet: msg.wallet, lamports: reward, at: Number.isFinite(at) ? at : Date.now() }
            setLivePayouts((prev) => (prev.some((x) => x.tx === p.tx) ? prev : [p, ...prev].slice(0, 100)))
          }
        }
        sock.onclose = (ev: CloseEvent) => {
          if (disposed || sock !== ws) return
          ws = null
          if (ev.code === CLOSE_TOKEN_INVALID) {
            clearPairing(eventId)
            setTokens(null)
            setPair({ kind: 'unpaired' })
            return
          }
          if (ev.code === CLOSE_EVENT_GONE) return note('The oracle no longer serves this event')
          note('Oracle unreachable, retrying…')
          timer = window.setTimeout(open, backoffMs(attempt++))
        }
      }
      open()
      return () => {
        window.clearTimeout(timer)
        if (ws) {
          ws.onopen = ws.onmessage = ws.onclose = null
          ws.close(1000, 'dashboard closed')
        }
      }
    })
    return () => {
      disposed = true
      stops.forEach((s) => s())
    }
  }, [eventId, tokens, reward])

  // Online = a frame within the last few seconds; sampled once a second, off the frame path.
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = performance.now()
      const next: Record<string, boolean> = {}
      lastFrame.current.forEach((v, k) => (next[k] = now - v.at < STALE_MS))
      setOnline((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  const watch = useCallback((id: string, canvas: HTMLCanvasElement) => {
    let decoding = false
    let pending: Frame | null = null
    let stopped = false
    const render = async () => {
      if (decoding || !pending) return
      decoding = true
      const f = pending
      pending = null
      try {
        const bmp = await createImageBitmap(base64ToBlob(f.jpeg))
        const ctx = canvas.getContext('2d')
        if (!stopped && ctx) drawFrame(ctx, bmp, f.width || bmp.width, f.height || bmp.height, f.faces)
        bmp.close()
      } catch {
        // a corrupt frame is skipped
      } finally {
        decoding = false
        if (!stopped && pending) void render()
      }
    }
    const onFrame = (f: Frame) => {
      pending = f
      void render()
    }
    const set = watchers.current.get(id) ?? new Set()
    set.add(onFrame)
    watchers.current.set(id, set)
    const last = lastFrame.current.get(id)
    if (last) onFrame(last.frame)
    return () => {
      stopped = true
      set.delete(onFrame)
    }
  }, [])

  const cameraUrl = useMemo(
    () =>
      eventId && tokens?.length
        ? `${window.location.origin}${import.meta.env.BASE_URL}camera.html#${encodeCameraPayload({
            eventId,
            oracles: tokens.map((p) => ({ url: p.oracle.url, token: p.tokens.camera_token })),
          })}`
        : null,
    [eventId, tokens],
  )

  const cameras: Camera[] = tokens?.length ? [feedCamera(tokens.map((t) => t.oracle), online, notes)] : []

  return { cameras, cameraUrl, pair, pairNow: () => void pairNow(), watch, livePayouts }
}

/** The one camera feed: online while any oracle relays frames; the note says which oracles get it and why others don't. */
function feedCamera(oracles: OracleEntry[], online: Record<string, boolean>, notes: Record<string, string>): Camera {
  const label = (o: OracleEntry) => o.name || 'oracle'
  const live = oracles.filter((o) => online[o.key])
  const others = oracles.filter((o) => !online[o.key])
  const reason = (o: OracleEntry) => notes[o.key] ?? 'Connecting…'
  if (live.length === 0) {
    const reasons = new Set(oracles.map(reason))
    const note = reasons.size === 1 ? [...reasons][0] : oracles.map((o) => `${label(o)}: ${reason(o)}`).join(' · ')
    return { id: FEED, name: 'Camera feed', online: false, note }
  }
  const note = [`Streaming to ${live.map(label).join(', ')}`, ...others.map((o) => `${label(o)}: ${reason(o)}`)].join(' · ')
  return { id: FEED, name: 'Camera feed', online: true, note }
}
