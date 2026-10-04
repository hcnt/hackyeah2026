// Event camera (phone): streams the back camera to every oracle in the link from the event dashboard's QR code.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { decodeCameraPayload, type CameraPayload } from './payload'
import { FrameSource, IDLE_STATUS, isFinal, startLink, type LinkStatus } from './streamer'
import { Button, Chip, Spinner, type Tone } from './ui'
import { useCamera } from './useCamera'
import { useWakeLock } from './useWakeLock'

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export function CameraPage() {
  const hash = useHash()
  const payload = useMemo(() => decodeCameraPayload(hash), [hash])
  if (!payload) {
    return (
      <Shell>
        <CenterCard>
          <p className="text-xl font-bold">Scan the QR code on the event dashboard</p>
          <p className="text-sm opacity-80">
            This page needs the camera link from the event’s dashboard. On the organizer’s laptop, open the event in
            the OnSight events app, click Add a camera and scan its QR code with this phone.
          </p>
        </CenterCard>
      </Shell>
    )
  }
  // A new link (another event or new tokens) starts from scratch.
  return <Streamer key={hash} payload={payload} />
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** UI updates for acks are batched to this interval; connection changes show at once. */
const FLUSH_MS = 400

function Streamer({ payload }: { payload: CameraPayload }) {
  const { videoRef, state: camState, error: camError, start, stop } = useCamera('environment', 1280)
  const [running, setRunning] = useState(true)
  const n = payload.oracles.length
  const [statuses, setStatuses] = useState<LinkStatus[]>(() => payload.oracles.map(() => IDLE_STATUS))
  const latest = useRef<LinkStatus[]>(statuses)

  const camLive = camState === 'live'
  // Every oracle rejected the link or ended the event: nothing left to stream to, so the camera goes off.
  const exhausted = statuses.every((s) => isFinal(s.state))
  const active = running && !exhausted
  useWakeLock(active && camLive)

  // Camera follows the Start/Stop toggle.
  useEffect(() => {
    if (!active) stop()
    else if (camState === 'idle') void start()
  }, [active, camState, start, stop])

  const retryAll = () => {
    latest.current = payload.oracles.map(() => IDLE_STATUS)
    setStatuses(latest.current)
    setRunning(true)
  }

  // One link per oracle while the camera is live. Links share one frame source.
  useEffect(() => {
    if (!active || !camLive) return
    const frames = new FrameSource(() => videoRef.current)
    let dirty = false
    const stops = payload.oracles.map((target, i) =>
      startLink(target, frames, (s) => {
        const prev = latest.current[i]
        latest.current = latest.current.map((x, j) => (j === i ? s : x))
        if (prev.state !== s.state || prev.retryInSecs !== s.retryInSecs || prev.message !== s.message) {
          setStatuses(latest.current)
        } else {
          dirty = true
        }
      }),
    )
    const flush = window.setInterval(() => {
      if (!dirty) return
      dirty = false
      setStatuses(latest.current)
    }, FLUSH_MS)
    return () => {
      window.clearInterval(flush)
      stops.forEach((s) => s())
      latest.current = latest.current.map((s) => (isFinal(s.state) ? s : IDLE_STATUS))
      setStatuses(latest.current)
    }
  }, [active, camLive, payload, videoRef])

  const live = statuses.filter((s) => s.state === 'live').length

  return (
    <Shell>
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label="Event camera preview"
        className={cn('absolute inset-0 size-full object-cover transition-opacity', camLive ? 'opacity-100' : 'opacity-0')}
      />

      <div className="absolute inset-x-0 top-0 grid gap-3 bg-linear-to-b from-black/80 to-transparent px-4 pt-[max(env(safe-area-inset-top),12px)] pb-10">
        <div className="flex items-center justify-between gap-3" aria-live="polite">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span
              aria-hidden
              className={cn(
                'size-2.5 rounded-full',
                live > 0 ? 'animate-pulse bg-rose-500' : running && camLive ? 'bg-amber-400' : 'bg-neutral-500',
              )}
            />
            {!active
              ? 'Stopped'
              : !camLive
                ? camState === 'error'
                  ? 'Camera off'
                  : 'Starting camera…'
                : `Streaming to ${live} of ${n} ${n === 1 ? 'oracle' : 'oracles'}`}
          </p>
          <span className="text-xs opacity-70">Event camera</span>
        </div>
        <ul className="grid gap-2" aria-label="Oracles">
          {payload.oracles.map((o, i) => (
            <OracleRow key={o.url} host={hostOf(o.url)} status={statuses[i]} running={active && camLive} />
          ))}
        </ul>
      </div>

      {exhausted ? (
        <CenterCard>
          {statuses.every((s) => s.state === 'ended') ? (
            <>
              <p className="text-xl font-bold">This event has ended</p>
              <p className="text-sm opacity-80">The camera is off and nothing is being sent. You can close this page.</p>
            </>
          ) : (
            <>
              <p className="text-xl font-bold">This camera link no longer works — scan the QR code again</p>
              <p className="text-sm opacity-80">The camera is off and nothing is being sent.</p>
              <Button variant="ghost" onClick={retryAll}>
                Try again
              </Button>
            </>
          )}
        </CenterCard>
      ) : camState === 'error' && camError ? (
        <CenterCard>
          <p className="text-xl font-bold">{camError.title}</p>
          {camError.hint && <p className="text-sm opacity-80">{camError.hint}</p>}
          <Button variant="ghost" onClick={() => void start()}>
            Try again
          </Button>
        </CenterCard>
      ) : active && camState === 'starting' ? (
        <CenterCard>
          <Spinner label="Starting camera…" />
        </CenterCard>
      ) : !running ? (
        <CenterCard>
          <p className="text-xl font-bold">Streaming stopped</p>
          <p className="text-sm opacity-80">The camera is off and nothing is being sent.</p>
        </CenterCard>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 grid gap-3 bg-linear-to-t from-black/85 to-transparent px-4 pt-10 pb-[max(env(safe-area-inset-bottom),16px)] text-center">
        {active && camLive && <p className="text-sm opacity-85">Point at the entrance or the room. Keep the phone still.</p>}
        {!exhausted && (
          <Button
            variant={running ? 'ghost' : 'primary'}
            onClick={() => setRunning((r) => !r)}
            className="mx-auto w-full max-w-xs"
          >
            {running ? 'Stop streaming' : 'Start streaming'}
          </Button>
        )}
      </div>
    </Shell>
  )
}

function OracleRow({ host, status, running }: { host: string; status: LinkStatus; running: boolean }) {
  let tone: Tone = 'idle'
  let text = running ? 'Waiting…' : 'Not streaming'
  switch (status.state) {
    case 'connecting':
      tone = 'warn'
      text = 'Connecting…'
      break
    case 'live':
      tone = 'ok'
      text = 'Connected'
      break
    case 'reconnecting':
      tone = 'warn'
      text = status.retryInSecs ? `Reconnecting in ${status.retryInSecs} s` : 'Reconnecting…'
      break
    case 'expired':
      tone = 'bad'
      text = 'Link expired'
      break
    case 'ended':
      tone = 'bad'
      text = 'Event ended'
      break
    case 'error':
      tone = 'bad'
      text = 'Error'
      break
  }
  const isLive = status.state === 'live'
  return (
    <li className="grid gap-1 rounded-xl bg-black/45 px-3 py-2 backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs opacity-85">{host}</span>
        <Chip tone={tone} pulse={isLive}>
          {text}
        </Chip>
      </div>
      {isLive && (
        <p className="font-mono text-xs tabular-nums opacity-80">
          {status.faces ?? '–'} faces · {status.ms === null ? '–' : Math.round(status.ms)} ms ·{' '}
          {status.fps === null ? '–' : status.fps.toFixed(1)} fps
        </p>
      )}
      {status.message && (status.state === 'live' || isFinal(status.state)) && (
        <p className={cn('text-xs', isLive ? 'text-amber-200' : 'text-rose-200')}>{status.message}</p>
      )}
    </li>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="fixed inset-0 overflow-hidden bg-neutral-950 text-neutral-50">{children}</div>
}

function CenterCard({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="grid max-w-sm gap-3 rounded-2xl bg-black/70 p-5 text-center backdrop-blur">{children}</div>
    </div>
  )
}
