// Oracle calls and socket messages used at the venue: camera pairing and the WebSockets.
import { ApiError, type Signed } from '../widget/api'

export interface CameraTokenResponse {
  camera_token: string
  stage_token: string
  camera_path: string
}

export type CameraReply = { type: 'ack'; faces: number; ms: number } | { type: 'error'; message: string }

export type FaceState = 'unknown' | 'tracking' | 'paid'

export interface LiveFace {
  bbox: [number, number, number, number]
  state: FaceState
  name: string | null
  seen_secs: number
}

export type LiveMessage =
  | { type: 'frame'; jpeg: string; width: number; height: number; faces: LiveFace[] }
  | { type: 'payout'; wallet: string; name: string; tx: string; at: string }
  | { type: 'stats'; going: number; paid: number }

/** POST the organizer's signed `camera-token` body to one oracle. Same body for every oracle. */
export async function requestCameraToken(oracleUrl: string, eventId: string, signed: Signed, name: string) {
  let res: Response
  try {
    res = await fetch(`${oracleUrl}/api/v1/events/${encodeURIComponent(eventId)}/camera-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
  } catch {
    throw new ApiError(0, 'network', `Could not reach ${name}.`)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = data?.error
    throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `Request failed (${res.status})`)
  }
  if (typeof data?.camera_token !== 'string' || typeof data?.stage_token !== 'string') {
    throw new ApiError(res.status, 'invalid_response', `${name} sent an unexpected answer.`)
  }
  return data as CameraTokenResponse
}

export function parseJson<T>(data: unknown): T | null {
  if (typeof data !== 'string') return null
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}
