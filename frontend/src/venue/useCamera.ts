import { useCallback, useEffect, useRef, useState } from 'react'

export type CameraState = 'idle' | 'starting' | 'live' | 'error'

export interface CameraError {
  title: string
  hint?: string
}

const HTTPS_HINT = 'Phone browsers only allow the camera on secure pages. Open this page over https://.'

function describe(err: unknown): CameraError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  const insecure = !window.isSecureContext
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        title: 'Camera blocked — allow camera access in your browser settings',
        hint: insecure ? HTTPS_HINT : 'Then come back and tap “Try again”.',
      }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { title: 'No camera found on this device', hint: 'Try another phone or laptop with a camera.' }
    case 'NotReadableError':
    case 'AbortError':
      return {
        title: 'The camera is busy',
        hint: 'Another app or browser tab is using it. Close it and try again.',
      }
    default:
      return { title: 'The camera could not start', hint: insecure ? HTTPS_HINT : 'Reload the page and try again.' }
  }
}

/**
 * Owns one getUserMedia stream bound to a <video> element. Always stops every track on stop() and on
 * unmount, including when a start() is still pending.
 */
export function useCamera(facingMode: 'user' | 'environment', idealWidth: number) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const generation = useRef(0)
  const [state, setState] = useState<CameraState>('idle')
  const [error, setError] = useState<CameraError | null>(null)

  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    const v = videoRef.current
    if (v) {
      v.pause()
      v.srcObject = null
    }
  }, [])

  const stop = useCallback(() => {
    generation.current += 1
    release()
    setState('idle')
  }, [release])

  const start = useCallback(async () => {
    const gen = ++generation.current
    release()
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        window.isSecureContext
          ? { title: 'This browser cannot use the camera', hint: 'Try a recent Chrome, Safari or Firefox.' }
          : { title: 'The camera needs a secure connection', hint: HTTPS_HINT },
      )
      setState('error')
      return
    }
    setState('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: idealWidth } },
      })
      if (gen !== generation.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (gen !== generation.current) return
        release()
        setError({ title: 'The camera was disconnected', hint: 'Tap “Try again” to reconnect it.' })
        setState('error')
      })
      const v = videoRef.current
      if (!v) throw new Error('Video element missing')
      v.srcObject = stream
      v.muted = true
      v.playsInline = true
      if (v.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve) => v.addEventListener('loadedmetadata', () => resolve(), { once: true }))
      }
      await v.play()
      if (gen !== generation.current) return
      setState('live')
    } catch (e) {
      if (gen !== generation.current) return
      release()
      setError(describe(e))
      setState('error')
    }
  }, [facingMode, idealWidth, release])

  useEffect(
    () => () => {
      generation.current += 1
      release()
    },
    [release],
  )

  return { videoRef, state, error, start, stop }
}
