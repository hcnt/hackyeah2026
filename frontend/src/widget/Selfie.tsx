import { useEffect, useRef, useState } from 'react'
import type { Api, Frame, Step, TestResponse } from './api'
import { SILHOUETTE } from './assets'
import { FaceGuide } from './icons'

// The oracle names turns from the camera's point of view (`left` = nose toward the image's left edge), while
// the preview is mirrored and the prompts speak to the user. Turning to your own left is the oracle's `right`.
const STEPS: { step: Step; prompt: string; side?: 'left' | 'right' }[] = [
  { step: 'straight', prompt: 'Look straight at the camera' },
  { step: 'right', prompt: 'Turn your head slightly to your left', side: 'left' },
  { step: 'left', prompt: 'Turn your head slightly to your right', side: 'right' },
]
const TOO_FAR_YAW = 0.35 // the oracle accepts a turn of |yaw| 0.10–0.35

/** Coaching text for a failed test. Our own wording per issue code (the oracle's `wrong_pose` text says
 * "as shown", which only makes sense next to a picture). */
function hintFor(res: TestResponse, current: (typeof STEPS)[number]): string {
  const issue = res.issues[0]
  if (!issue) return current.prompt
  if (issue.code !== 'wrong_pose') return issue.message
  if (!current.side) return 'Look straight at the camera'
  const yaw = res.face?.yaw ?? 0
  const towardSide = current.step === 'left' ? yaw < 0 : yaw > 0
  if (towardSide && Math.abs(yaw) > TOO_FAR_YAW) return 'Not that far — turn back a little'
  return `Turn your head a bit more to your ${current.side}`
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
 * Penpot 2a. The camera runs in the viewfinder; about twice a second the current frame is tested against the
 * oracle so the caption can coach the user. The shutter takes the photo for the current head angle; after
 * straight, left and right the frames go back to the widget.
 */
export default function Selfie({ api, onDone }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frames = useRef<Frame[]>([])
  const [stepIndex, setStepIndex] = useState(0)
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
  const current = STEPS[Math.min(stepIndex, STEPS.length - 1)]
  const step = current.step

  // Live coaching: test the current frame without keeping it.
  useEffect(() => {
    if (!ready || busy || stepIndex >= STEPS.length) return
    let inFlight = false
    let stopped = false
    const id = setInterval(async () => {
      if (inFlight || stopped || !videoRef.current) return
      const image = grab(videoRef.current, canvas())
      if (!image) return
      inFlight = true
      try {
        const res = await api.test({ step, image })
        if (stopped) return
        setLooksOk(res.ok)
        setHint(res.ok ? null : hintFor(res, current))
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
  }, [api, ready, busy, step, stepIndex, current])

  async function shoot() {
    if (!videoRef.current || busy) return
    const image = grab(videoRef.current, canvas())
    if (!image) return
    setBusy(true)
    setFlash((n) => n + 1)
    try {
      const res = await api.test({ step, image })
      if (!res.ok) {
        setLooksOk(false)
        setHint(hintFor(res, current))
        return
      }
      frames.current = [...frames.current, { step, image }]
      setHint(null)
      setLooksOk(false)
      if (stepIndex + 1 === STEPS.length) onDone(frames.current)
      else setStepIndex(stepIndex + 1)
    } catch (err) {
      setHint((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const caption = cameraError ?? (!ready ? 'Opening camera…' : (hint ?? `${stepIndex + 1}/3 · ${current.prompt}`))

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
        aria-label={`Take photo: ${current.prompt}`}
        disabled={!ready || busy || !!cameraError}
        onClick={shoot}
      >
        <span />
      </button>
    </div>
  )
}
