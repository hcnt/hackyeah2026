// Pairing the stage with an event's oracles: one organizer signature, posted to every oracle, returns a camera token
// and a stage token per oracle. Oracles issue the same tokens for the whole event, so the stage keeps them in this
// browser until the event ends: a refresh, or arriving from the organizer page, needs no wallet. A token an oracle no
// longer accepts (it restarted) shows up as an expired connection on the stage, which then asks for a new signature.
import type { OracleEntry } from '@/widget/chain'
import { ApiError } from '@/widget/api'
import { shortAddress, signAction, type Connection } from '@/widget/wallet'
import { requestCameraToken, type CameraTokenResponse } from './api'

export type PairResult =
  | { oracle: OracleEntry; ok: true; tokens: CameraTokenResponse }
  | { oracle: OracleEntry; ok: false; message: string }

interface Stored {
  end: number // unix seconds; the tokens are useless after the event's end
  tokens: Record<string, CameraTokenResponse> // by oracle URL
}

const key = (eventId: string) => `onsight:pairing:${eventId}`

/** Signs once and asks every oracle for its tokens. Throws only when the wallet signature fails. */
export async function pairWithOracles(conn: Connection, eventId: string, oracles: OracleEntry[]): Promise<PairResult[]> {
  const signed = await signAction(conn, 'camera-token', eventId)
  return Promise.all(
    oracles.map((oracle): Promise<PairResult> =>
      requestCameraToken(oracle.url, eventId, signed, oracle.name || shortAddress(oracle.key)).then(
        (tokens) => ({ oracle, ok: true, tokens }),
        (err: unknown) => ({ oracle, ok: false, message: err instanceof ApiError ? err.message : 'Request failed' }),
      ),
    ),
  )
}

export function savePairing(eventId: string, end: number, results: PairResult[]): void {
  const tokens: Record<string, CameraTokenResponse> = {}
  for (const r of results) if (r.ok) tokens[r.oracle.url] = r.tokens
  if (Object.keys(tokens).length === 0) return
  try {
    localStorage.setItem(key(eventId), JSON.stringify({ end, tokens } satisfies Stored))
  } catch {
    // storage unavailable (private mode, blocked): the stage just asks for the signature again
  }
}

/** The saved tokens for the event's oracles that have them, or null when nothing usable is saved. */
export function loadPairing(eventId: string, oracles: OracleEntry[], nowMs = Date.now()): PairResult[] | null {
  let stored: Stored | null = null
  try {
    stored = JSON.parse(localStorage.getItem(key(eventId)) ?? 'null') as Stored | null
  } catch {
    return null
  }
  if (!stored || typeof stored.end !== 'number' || stored.end * 1000 < nowMs || !stored.tokens) return null
  const results = oracles.flatMap((oracle): PairResult[] => {
    const t = stored.tokens[oracle.url]
    return t && typeof t.camera_token === 'string' && typeof t.stage_token === 'string' ? [{ oracle, ok: true, tokens: t }] : []
  })
  return results.length > 0 ? results : null
}

export function clearPairing(eventId: string): void {
  try {
    localStorage.removeItem(key(eventId))
  } catch {
    // nothing to clear
  }
}
