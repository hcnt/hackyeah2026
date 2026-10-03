// Fan-out of one phone camera to several oracles. Each oracle gets its own socket and its own send → ack → send
// loop, so a slow or dead oracle never holds the others back. Frames are never queued: a link that is ready asks the
// shared FrameSource for the newest frame, and links that become ready at about the same time share one capture.
import { parseJson, type CameraReply } from './api'
import { captureJpeg } from './frames'
import {
  backoffMs,
  cameraWsUrl,
  CLOSE_EVENT_GONE,
  CLOSE_TOKEN_INVALID,
  isMixedContent,
  type CameraTarget,
} from './payload'

const FRAME_WIDTH = 960
const JPEG_QUALITY = 0.75
/** A capture younger than this is handed to the next link instead of encoding a new one. */
const SHARE_WINDOW_MS = 80
/** If an oracle does not answer a frame within this time, drop its socket and reconnect. */
const REPLY_TIMEOUT_MS = 10_000

interface Frame {
  seq: number
  blob: Blob
  at: number
}

export class FrameSource {
  private readonly canvas = document.createElement('canvas')
  private seq = 0
  private latest: Frame | null = null
  private pending: Promise<Frame> | null = null
  private readonly getVideo: () => HTMLVideoElement | null

  constructor(getVideo: () => HTMLVideoElement | null) {
    this.getVideo = getVideo
  }

  /** A frame newer than `afterSeq` (the last one this link sent): a fresh shared one, or a new capture. */
  next(afterSeq: number): Promise<Frame> {
    const l = this.latest
    if (l && l.seq > afterSeq && performance.now() - l.at < SHARE_WINDOW_MS) return Promise.resolve(l)
    if (this.pending) return this.pending
    const video = this.getVideo()
    if (!video) return Promise.reject(new Error('No video'))
    this.pending = captureJpeg(video, FRAME_WIDTH, JPEG_QUALITY, this.canvas)
      .then((blob) => {
        const f = { seq: ++this.seq, blob, at: performance.now() }
        this.latest = f
        return f
      })
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }
}

export type LinkState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'expired' | 'ended' | 'error'

export interface LinkStatus {
  state: LinkState
  retryInSecs: number | null
  faces: number | null
  ms: number | null
  fps: number | null
  /** Server-side frame error (socket stays open) or why the link stopped. */
  message: string | null
}

export const IDLE_STATUS: LinkStatus = { state: 'idle', retryInSecs: null, faces: null, ms: null, fps: null, message: null }

export function isFinal(state: LinkState): boolean {
  return state === 'expired' || state === 'ended' || state === 'error'
}

/** Streams frames to one oracle until the returned stop function is called or the oracle rejects the token. */
export function startLink(target: CameraTarget, frames: FrameSource, onStatus: (s: LinkStatus) => void): () => void {
  let status: LinkStatus = { ...IDLE_STATUS, state: 'connecting' }
  const set = (patch: Partial<LinkStatus>) => {
    status = { ...status, ...patch }
    onStatus(status)
  }

  let disposed = false
  let ws: WebSocket | null = null
  let attempt = 0
  let lastSeq = 0
  let retryTimer: number | undefined
  let frameTimer: number | undefined
  let replyTimer: number | undefined
  let countdownTimer: number | undefined
  const ackTimes: number[] = []

  const clearTimers = () => {
    window.clearTimeout(retryTimer)
    window.clearTimeout(frameTimer)
    window.clearTimeout(replyTimer)
    window.clearInterval(countdownTimer)
  }

  const isCurrent = (sock: WebSocket) => !disposed && sock === ws && sock.readyState === WebSocket.OPEN

  const sendFrame = async () => {
    const sock = ws
    if (!sock || !isCurrent(sock)) return
    try {
      const frame = await frames.next(lastSeq)
      if (!isCurrent(sock)) return
      lastSeq = frame.seq
      sock.send(frame.blob)
      window.clearTimeout(replyTimer)
      replyTimer = window.setTimeout(() => sock.close(4000, 'reply timeout'), REPLY_TIMEOUT_MS)
    } catch {
      // Video not ready for a moment (orientation change, camera restarting): try again shortly.
      window.clearTimeout(frameTimer)
      frameTimer = window.setTimeout(() => void sendFrame(), 250)
    }
  }

  const scheduleReconnect = () => {
    const delay = backoffMs(attempt++)
    const until = Date.now() + delay
    set({ state: 'reconnecting', retryInSecs: Math.ceil(delay / 1000), fps: null })
    window.clearInterval(countdownTimer)
    countdownTimer = window.setInterval(
      () => set({ retryInSecs: Math.max(0, Math.ceil((until - Date.now()) / 1000)) }),
      1000,
    )
    retryTimer = window.setTimeout(() => {
      window.clearInterval(countdownTimer)
      connect()
    }, delay)
  }

  const connect = () => {
    if (disposed) return
    if (isMixedContent(window.location.protocol, target.url)) {
      set({ state: 'error', message: 'This oracle has an insecure (http) address, which a secure page cannot reach.' })
      return
    }
    set({ state: attempt === 0 ? 'connecting' : 'reconnecting', retryInSecs: null })
    let sock: WebSocket
    try {
      sock = new WebSocket(cameraWsUrl(target.url, target.token))
    } catch {
      set({ state: 'error', message: 'This oracle address cannot be opened from this page.' })
      return
    }
    sock.binaryType = 'arraybuffer'
    ws = sock
    sock.onopen = () => {
      if (disposed || sock !== ws) return
      set({ state: 'live', message: null })
      void sendFrame()
    }
    sock.onmessage = (ev: MessageEvent) => {
      if (disposed || sock !== ws) return
      window.clearTimeout(replyTimer)
      const msg = parseJson<CameraReply>(ev.data)
      if (msg?.type === 'ack') {
        attempt = 0
        const now = performance.now()
        ackTimes.push(now)
        while (ackTimes.length > 1 && now - ackTimes[0] > 3000) ackTimes.shift()
        set({
          faces: msg.faces,
          ms: msg.ms,
          message: null,
          fps: ackTimes.length > 1 ? ((ackTimes.length - 1) * 1000) / (now - ackTimes[0]) : null,
        })
      } else if (msg?.type === 'error') {
        set({ message: msg.message || 'The oracle could not read that frame.' })
      }
      void sendFrame()
    }
    sock.onclose = (ev: CloseEvent) => {
      if (disposed || sock !== ws) return
      ws = null
      clearTimers()
      ackTimes.length = 0
      if (ev.code === CLOSE_TOKEN_INVALID) {
        set({ state: 'expired', fps: null, message: 'This camera link is no longer valid for this oracle.' })
        return
      }
      if (ev.code === CLOSE_EVENT_GONE) {
        set({ state: 'ended', fps: null, message: 'The event has ended or this oracle does not know it.' })
        return
      }
      scheduleReconnect()
    }
  }

  connect()
  return () => {
    disposed = true
    clearTimers()
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null
      ws.close(1000, 'stopped')
    }
    ws = null
  }
}
