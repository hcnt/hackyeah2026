// Client for the oracle API v1. Types mirror backend/app/oracle/routes.py.

export type IssueCode =
  | 'no_face' | 'multiple_faces' | 'low_confidence' | 'too_small' | 'out_of_frame'
  | 'blurry' | 'too_dark' | 'too_bright' | 'wrong_pose'
export interface Issue { code: IssueCode; message: string }

export interface TestResponse {
  ok: boolean
  issues: Issue[]
  face: { bbox: [number, number, number, number]; confidence: number; yaw: number } | null
}

export interface Signed { wallet: string; signed_at: string; signature: string }
export interface SubmitRequest extends Signed {
  consent: { version: string; accepted: true }
  /** One base64 JPEG (no data: prefix) of the face looking straight at the camera. */
  image: string
}

export interface EventDetails {
  event_id: string
  name: string | null
  venue: string | null
  organizer: string
  starts_at: string
  ends_at: string
  status: 'upcoming' | 'live' | 'ended'
  joining_open: boolean
  min_seen_secs: number
  reward_lamports: number | null
  max_payouts: number | null
  going: number
  paid: number
  spots_left: number | null
  /** The event's oracle keys and threshold. Convenience only: the widget discovers oracles from the chain. */
  oracles?: string[]
  threshold?: number
  consent: { version: string; text: string }
}

export type AttendanceStatus = 'not_joined' | 'on_list' | 'paid'
export interface StatusResponse { status: AttendanceStatus; tx: string | null }

export type SignAction = 'join' | 'camera-token'

export function signedMessage(
  action: SignAction, eventId: string, wallet: string, signedAt: string, consentVersion?: string,
): string {
  return [
    'Attend Now',
    `Action: ${action}`,
    `Event: ${eventId}`,
    `Wallet: ${wallet}`,
    ...(action === 'join' ? [`Consent: ${consentVersion}`] : []),
    `Time: ${signedAt}`,
  ].join('\n')
}

/** `signed_at` as the oracle expects it: ISO 8601 UTC without milliseconds. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly issues?: Issue[]

  constructor(status: number, code: string, message: string, issues?: Issue[]) {
    super(message)
    this.status = status
    this.code = code
    this.issues = issues
  }
}

/** `name` labels network errors ("Could not reach <name>"). */
export function createApi(baseUrl: string, eventId: string, name = 'OnSight') {
  const root = `${baseUrl.replace(/\/$/, '')}/api/v1/events/${encodeURIComponent(eventId)}`

  async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    let res: Response
    try {
      res = await fetch(root + path, {
        method: init?.method ?? 'GET',
        headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
      })
    } catch {
      throw new ApiError(0, 'network', `Could not reach ${name}. Check your connection.`)
    }
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const err = data?.error
      throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `Request failed (${res.status})`, err?.issues)
    }
    return data as T
  }

  return {
    event: () => call<EventDetails>(''),
    test: (image: string) => call<TestResponse>('/attendance/test', { method: 'POST', body: { image } }),
    submit: (body: SubmitRequest) =>
      call<{ status: 'on_list'; event_id: string; wallet: string }>('/attendance', { method: 'POST', body }),
    status: (wallet: string) => call<StatusResponse>(`/attendance/${encodeURIComponent(wallet)}`),
  }
}

export type Api = ReturnType<typeof createApi>
