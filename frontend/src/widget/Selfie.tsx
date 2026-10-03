import { useEffect, useRef, useState } from 'react'
import type { Api, Frame, Step } from './api'

const STEPS: Step[] = ['straight', 'left', 'right']
const PROMPT: Record<Step, string> = {
  straight: 'Look straight at the camera',
  left: 'Turn your head slightly left',
  right: 'Turn your head slightly right',
}
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

type Props = { api: Api; onDone: (frames: Frame[]) => void }

/**
 * Opens the camera and tests a frame about twice a second against the oracle. Each frame that
 * passes for the current head angle is kept; after straight, left and right it hands them back.
 */
export default function Selfie({ api, onDone }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [hint, setHint] = useState<string | null>(null)
  const [cameraError, setCameraError] = useState<string | null>(() =>
    navigator.mediaDevices ? null : 'This browser has no camera access (it needs HTTPS).',
  )
  const [ready, setReady] = useState(false)
  const frames = useRef<Frame[]>([])

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

  useEffect(() => {
    if (!ready || stepIndex >= STEPS.length) return
    const step = STEPS[stepIndex]
    const canvas = document.createElement('canvas')
    let busy = false
    let stopped = false
    const id = setInterval(async () => {
      if (busy || stopped || !videoRef.current) return
      const image = grab(videoRef.current, canvas)
      if (!image) return
      busy = true
      try {
        const res = await api.test({ step, image })
        if (stopped) return
        if (res.ok) {
          stopped = true
          frames.current = [...frames.current, { step, image }]
          setHint(null)
          if (stepIndex + 1 === STEPS.length) onDone(frames.current)
          else setStepIndex(stepIndex + 1)
        } else {
          setHint(res.issues[0]?.message ?? null)
        }
      } catch (err) {
        setHint((err as Error).message)
      } finally {
        busy = false
      }
    }, TEST_INTERVAL_MS)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [api, ready, stepIndex, onDone])

  if (cameraError) return <p className="an-error">{cameraError}</p>

  const step = STEPS[Math.min(stepIndex, STEPS.length - 1)]
  return (
    <div className="an-selfie">
      <video ref={videoRef} autoPlay playsInline muted />
      <p className="an-strong">
        {stepIndex + 1}/{STEPS.length} · {PROMPT[step]}
      </p>
      <p className="an-muted" aria-live="polite">{ready ? (hint ?? 'Checking…') : 'Opening camera…'}</p>
    </div>
  )
}
