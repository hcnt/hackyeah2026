import { useEffect, useRef, useState } from 'react'
import type { Api, TestResponse } from './api'
import { SILHOUETTE } from './assets'
import { FaceGuide } from './icons'

const PROMPT = 'Look straight at the camera'
const TEST_INTERVAL_MS = 500
const MAX_SIDE = 1280

/** Grabs the current video frame as a base64 JPEG (no data: prefix), at most 1280 px on the long side. */
function grab(video: HTMLVideoElement, canvas: HTMLCanvasElement): string | null {
  const { videoWidth: w, videoHeight: h } = video
  if (!w || !h) return null
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h))
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
}

/** Coaching text for a failed test: the oracle's ready-made message for the first issue. */
function hintFor(res: TestResponse): string {
  return res.issues[0]?.message ?? PROMPT
}

type Props = { api: Api; onDone: (image: string) => void }

/**
 * Penpot 2a. The camera runs in the viewfinder; about twice a second the current frame is tested against the
 * oracle so the caption can coach the user. The shutter takes the one photo the oracle needs.
 */
export default function Selfie({ api, onDone }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [looksOk, setLooksOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(0)
  const [ready, setReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(() =>
    navigator.mediaDevices ? null : 'This browser has no camera access (it needs HTTPS).',
  )

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    if (!navigator.mediaDevices) return
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream = s
        const video = videoRef.current!
        video.srcObject = s
        video.onloadedmetadata = () => setReady(true)
      })
      .catch((err: Error) =>
        setCameraError(
          err.name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow the camera for this site and try again.'
            : `Could not open the camera: ${err.message}`,
        ),
      )
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const canvas = () => (canvasRef.current ??= document.createElement('canvas'))

  // Live coaching: test the current frame without keeping it.
  useEffect(() => {
    if (!ready || busy) return
    let inFlight = false
    let stopped = false
    const id = setInterval(async () => {
      if (inFlight || stopped || !videoRef.current) return
      const image = grab(videoRef.current, canvas())
      if (!image) return
      inFlight = true
      try {
        const res = await api.test(image)
        if (stopped) return
        setLooksOk(res.ok)
        setHint(res.ok ? null : hintFor(res))
      } catch {
        // Coaching is best effort; the shutter reports real errors.
      } finally {
        inFlight = false
      }
    }, TEST_INTERVAL_MS)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [api, ready, busy])

  async function shoot() {
    if (!videoRef.current || busy) return
    const image = grab(videoRef.current, canvas())
    if (!image) return
    setBusy(true)
    setFlash((n) => n + 1)
    try {
      const res = await api.test(image)
      if (res.ok) return onDone(image)
      setLooksOk(false)
      setHint(hintFor(res))
    } catch (err) {
      setHint((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const caption = cameraError ?? (!ready ? 'Opening camera…' : (hint ?? PROMPT))

  return (
    <div className="an-body an-body--center an-selfie">
      <div className="an-viewfinder">
        {!ready && <img className="an-silhouette" src={SILHOUETTE} alt="" />}
        <video ref={videoRef} autoPlay playsInline muted hidden={!ready} />
        <FaceGuide ok={ready && looksOk} />
        <div className="an-flash" key={flash} data-on={flash > 0} />
        <p className="an-caption" aria-live="polite">{caption}</p>
      </div>
      <button
        type="button"
        className="an-shutter"
        aria-label="Take photo"
        disabled={!ready || busy || !!cameraError}
        onClick={shoot}
      >
        <span />
      </button>
    </div>
  )
}
