// Pure helpers shared by the stage screen and the camera page: the camera-link payload (carried in the URL fragment,
// so the tokens never reach a server log), WebSocket URL derivation and reconnect backoff. No DOM, no React.

/** One oracle the phone streams to: its API base URL and the camera token it issued for this event. */
export interface CameraTarget {
  /** Oracle base URL (http/https, no trailing slash). */
  url: string
  token: string
}

export interface CameraPayload {
  eventId: string
  oracles: CameraTarget[]
}

/** Wire form inside the fragment, kept short so the QR code stays easy to scan. */
interface WirePayload {
  e: string
  o: { u: string; t: string }[]
}

const MAX_TARGETS = 8
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function utf8ToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToUtf8(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function normalizeBaseUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.search || u.hash || u.username || u.password) return null
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '')
}

export function encodeCameraPayload(p: CameraPayload): string {
  const wire: WirePayload = { e: p.eventId, o: p.oracles.map((o) => ({ u: o.url, t: o.token })) }
  return utf8ToBase64Url(JSON.stringify(wire))
}

/** The payload from a fragment (with or without the leading '#'), or null when it is missing or malformed. */
export function decodeCameraPayload(fragment: string): CameraPayload | null {
  const raw = fragment.replace(/^#/, '').trim()
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
  let wire: unknown
  try {
    wire = JSON.parse(base64UrlToUtf8(raw))
  } catch {
    return null
  }
  if (!wire || typeof wire !== 'object') return null
  const { e, o } = wire as Partial<WirePayload>
  if (typeof e !== 'string' || !BASE58.test(e)) return null
  if (!Array.isArray(o) || o.length === 0 || o.length > MAX_TARGETS) return null
  const oracles: CameraTarget[] = []
  for (const item of o) {
    if (!item || typeof item.u !== 'string' || typeof item.t !== 'string') return null
    const url = normalizeBaseUrl(item.u)
    if (!url || !item.t || !/^[A-Za-z0-9_.~-]+$/.test(item.t)) return null
    if (oracles.some((x) => x.url === url)) continue
    oracles.push({ url, token: item.t })
  }
  return { eventId: e, oracles }
}

/** ws:// for an http oracle, wss:// for an https one, keeping host and any base path. */
export function wsBase(oracleUrl: string): string {
  return oracleUrl.replace(/^http(s?):\/\//i, (_, s: string) => `ws${s}://`).replace(/\/+$/, '')
}

export function cameraWsUrl(oracleUrl: string, cameraToken: string): string {
  return `${wsBase(oracleUrl)}/api/v1/camera/${encodeURIComponent(cameraToken)}`
}

export function stageWsUrl(oracleUrl: string, eventId: string, stageToken: string): string {
  return `${wsBase(oracleUrl)}/api/v1/events/${encodeURIComponent(eventId)}/live?stage_token=${encodeURIComponent(stageToken)}`
}

/** Reconnect delay: 1, 2, 4, 8, 10, 10 … seconds. */
export function backoffMs(attempt: number): number {
  return Math.min(10_000, 1000 * 2 ** Math.max(0, attempt))
}

/** True when a page served over https cannot open this oracle's socket (browsers block ws:// from https). */
export function isMixedContent(pageProtocol: string, oracleUrl: string): boolean {
  return pageProtocol === 'https:' && /^http:\/\//i.test(oracleUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(oracleUrl)
}

export const CLOSE_TOKEN_INVALID = 4401
export const CLOSE_EVENT_GONE = 4404

export function explorerTxUrl(tx: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(tx)}?cluster=devnet`
}
