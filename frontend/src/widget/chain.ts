// Reads an event's oracles straight from the on_sight program on Solana, so the attendee's widget (not our API)
// decides which oracles receive the join. Plain JSON-RPC over fetch plus small decoders; the only dependency is bs58.
//
// Layouts mirror contracts/on_sight/lib.rs (Anchor: 8-byte discriminator = sha256("account:<Name>")[:8]):
//   Event:      organizer 32 | oracles 3×32 | oracle_count u8 | threshold u8 | event_id u64 | start i64 | end i64 |
//               reward u64 | fee u64 | max_paid u32 | paid_count u32 | min_seen_secs u32 | bump u8 |
//               name (u32 LE length + UTF-8, ≤ 64) | venue (u32 LE length + UTF-8, ≤ 64)
//   OracleInfo: oracle 32 | name (u32 LE length + UTF-8) | url (u32 LE length + UTF-8) | bump u8   (PDA ["oracle", key])
import bs58 from 'bs58'

export const DEFAULT_RPC_URL = 'https://api.devnet.solana.com'
// TODO after the new deploy: the on_sight program id that has the oracle registry. The id below is the OLD
// program (no OracleInfo accounts, different Event layout), so until then reads fail and the widget falls back to
// single-oracle mode (api-base). Override per page with the `program-id` attribute.
export const DEFAULT_PROGRAM_ID = '4YhphZrWqUUdjnyT3c8r6Wre2e27BZvqoCQWbEmcQdmf'

const MAX_ORACLES = 3
const EVENT_ORACLES_OFFSET = 8 + 32
const EVENT_COUNT_OFFSET = EVENT_ORACLES_OFFSET + 32 * MAX_ORACLES
const MAX_NAME = 32
const MAX_URL = 128
const MAX_EVENT_NAME = 64
const MAX_EVENT_VENUE = 64

export interface OracleEntry {
  /** The oracle's key (base58), as listed in the Event. */
  key: string
  name: string
  /** Base URL of its API, without a trailing slash. */
  url: string
}

export interface EventOracles {
  /** How many different oracles must see a wallet before the program pays. */
  threshold: number
  /** Oracles listed on the event that have a registry entry, in the event's order. */
  oracles: OracleEntry[]
  /** Oracles listed on the event without a (valid) registry entry: the widget cannot reach them. */
  unregistered: string[]
  /** Organizer, times, payout counters, name and venue of the Event account (null if they don't decode). */
  meta: EventMeta | null
}

export interface EventMeta {
  organizer: string
  /** Unix seconds (chain clock). */
  start: number
  end: number
  rewardLamports: number
  /** Oracle fee per paid attendee, frozen into the event at creation. */
  feeLamports: number
  maxPaid: number
  paidCount: number
  minSeenSecs: number
  name: string
  /** null when the event has no venue. */
  venue: string | null
}

export class ChainError extends Error {}

interface RpcAccount {
  data: [string, string]
  owner: string
}

/** Waits before each retry of a rate-limited call; the public devnet RPC allows only a few connections per IP. */
const RATE_LIMIT_BACKOFF_MS = [1000, 2000, 4000, 8000]

function isRateLimited(status: number, message: string | undefined): boolean {
  return status === 429 || /rate limit|too many requests/i.test(message ?? '')
}

/** One JSON-RPC call; retried with backoff while the RPC answers "rate limited". */
export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
    } catch {
      throw new ChainError('Could not reach the Solana RPC.')
    }
    const body = await res.json().catch(() => null)
    if (res.ok && body && !body.error && 'result' in body) return body.result as T
    const message: string | undefined = body?.error?.message
    if (isRateLimited(res.status, message) && attempt < RATE_LIMIT_BACKOFF_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS[attempt]))
      continue
    }
    if (isRateLimited(res.status, message)) {
      throw new ChainError('The Solana RPC is rate limiting this browser. Wait a minute and try again, or use another RPC with ?rpc=<url>.')
    }
    throw new ChainError(message ?? `Solana RPC failed (${res.status})`)
  }
}

export async function getMultipleAccounts(rpcUrl: string, keys: string[]): Promise<(RpcAccount | null)[]> {
  const result = await rpcCall<{ value?: unknown }>(rpcUrl, 'getMultipleAccounts', [
    keys,
    { encoding: 'base64', commitment: 'confirmed' },
  ])
  if (!Array.isArray(result?.value) || result.value.length !== keys.length) throw new ChainError('Solana RPC failed (bad reply)')
  return result.value as (RpcAccount | null)[]
}

export function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    all.set(p, off)
    off += p.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all))
}

const utf8 = new TextEncoder()

export async function discriminator(account: string): Promise<Uint8Array> {
  return (await sha256(utf8.encode(`account:${account}`))).slice(0, 8)
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  return data.length >= prefix.length && prefix.every((b, i) => data[i] === b)
}

// ed25519 "is this 32-byte string a curve point?" (what Solana's PublicKey::is_on_curve checks): decompressing y
// succeeds iff (y² − 1) / (d·y² + 1) is a square mod p. Needed only to derive PDAs, which must be OFF the curve.
const P = 2n ** 255n - 19n

function mod(a: bigint): bigint {
  const r = a % P
  return r < 0n ? r + P : r
}

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n
  let b = mod(base)
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P
    b = (b * b) % P
  }
  return result
}

const D = mod(-121665n * pow(121666n, P - 2n))

function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i])
  y = mod(y)
  const y2 = (y * y) % P
  const u = mod(y2 - 1n)
  const v = mod(D * y2 + 1n)
  const x2 = (u * pow(v, P - 2n)) % P
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n
}

/** Solana's find_program_address: the first bump from 255 down whose hash is off the curve. */
export async function findProgramAddress(seeds: Uint8Array[], programId: string): Promise<string> {
  const program = bs58.decode(programId)
  const marker = utf8.encode('ProgramDerivedAddress')
  for (let bump = 255; bump >= 0; bump--) {
    const hash = await sha256(...seeds, Uint8Array.of(bump), program, marker)
    if (!isOnCurve(hash)) return bs58.encode(hash)
  }
  throw new ChainError('No program address found for these seeds.')
}

export function oracleInfoAddress(oracle: string, programId: string): Promise<string> {
  return findProgramAddress([utf8.encode('oracle'), bs58.decode(oracle)], programId)
}

/** `oracles[0..oracle_count]` and `threshold` of an Event account's data, or null if it is not one. */
export function decodeEventOracles(data: Uint8Array, disc: Uint8Array): { oracles: string[]; threshold: number } | null {
  if (!startsWith(data, disc) || data.length < EVENT_COUNT_OFFSET + 2) return null
  const count = data[EVENT_COUNT_OFFSET]
  const threshold = data[EVENT_COUNT_OFFSET + 1]
  if (count < 1 || count > MAX_ORACLES || threshold < 1 || threshold > count) return null
  const oracles = []
  for (let i = 0; i < count; i++) {
    const at = EVENT_ORACLES_OFFSET + 32 * i
    oracles.push(bs58.encode(data.slice(at, at + 32)))
  }
  return { oracles, threshold }
}

// Event: … threshold u8 | event_id u64 | start i64 | end i64 | reward u64 | fee u64 | max_paid u32 | paid_count u32 |
// min_seen_secs u32 | bump u8 | name | venue. EVENT_META_OFFSET points at `start` (event_id is skipped).
const EVENT_META_OFFSET = EVENT_COUNT_OFFSET + 2 + 8
const EVENT_TEXT_OFFSET = EVENT_META_OFFSET + 44 + 1

/**
 * Organizer, times, counters, name and venue of an Event account's data (already checked by decodeEventOracles).
 * Null when the account is too short or the strings are out of bounds / not UTF-8 (e.g. the older layout without them).
 */
export function decodeEventMeta(data: Uint8Array): EventMeta | null {
  if (data.length < EVENT_TEXT_OFFSET) return null
  const name = readString(data, EVENT_TEXT_OFFSET, MAX_EVENT_NAME)
  const venue = name && readString(data, name[1], MAX_EVENT_VENUE)
  if (!name || !venue || name[0] === '') return null
  const view = new DataView(data.buffer, data.byteOffset, data.length)
  const at = EVENT_META_OFFSET
  return {
    organizer: bs58.encode(data.slice(8, 40)),
    start: Number(view.getBigInt64(at, true)),
    end: Number(view.getBigInt64(at + 8, true)),
    rewardLamports: Number(view.getBigUint64(at + 16, true)),
    feeLamports: Number(view.getBigUint64(at + 24, true)),
    maxPaid: view.getUint32(at + 32, true),
    paidCount: view.getUint32(at + 36, true),
    minSeenSecs: view.getUint32(at + 40, true),
    name: name[0],
    venue: venue[0] || null,
  }
}

function readString(data: Uint8Array, at: number, max: number): [string, number] | null {
  if (at + 4 > data.length) return null
  const len = new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0, true)
  if (len > max || at + 4 + len > data.length) return null
  try {
    return [new TextDecoder('utf-8', { fatal: true }).decode(data.slice(at + 4, at + 4 + len)), at + 4 + len]
  } catch {
    return null
  }
}

/** An OracleInfo account's data, or null if it is not one. */
export function decodeOracleInfo(data: Uint8Array, disc: Uint8Array): OracleEntry | null {
  if (!startsWith(data, disc) || data.length < 8 + 32) return null
  const name = readString(data, 40, MAX_NAME)
  const url = name && readString(data, name[1], MAX_URL)
  if (!name || !url || !/^https?:\/\/./.test(url[0])) return null
  return { key: bs58.encode(data.slice(8, 40)), name: name[0], url: url[0].replace(/\/+$/, '') }
}

/** The event's oracles and threshold from the chain, with each oracle's registered name and URL. */
export async function readEventOracles(rpcUrl: string, programId: string, eventId: string): Promise<EventOracles> {
  let eventKey: Uint8Array
  try {
    eventKey = bs58.decode(eventId)
  } catch {
    throw new ChainError('The event id is not a Solana address.')
  }
  if (eventKey.length !== 32) throw new ChainError('The event id is not a Solana address.')
  const [eventDisc, infoDisc] = await Promise.all([discriminator('Event'), discriminator('OracleInfo')])

  const [eventAcc] = await getMultipleAccounts(rpcUrl, [eventId])
  if (!eventAcc || eventAcc.owner !== programId) throw new ChainError('No such event on the chain.')
  const eventData = base64Bytes(eventAcc.data[0])
  const event = decodeEventOracles(eventData, eventDisc)
  if (!event) throw new ChainError('No such event on the chain.')

  const addresses = await Promise.all(event.oracles.map((o) => oracleInfoAddress(o, programId)))
  const infos = await getMultipleAccounts(rpcUrl, addresses)
  const oracles: OracleEntry[] = []
  const unregistered: string[] = []
  event.oracles.forEach((key, i) => {
    const acc = infos[i]
    const info = acc && acc.owner === programId ? decodeOracleInfo(base64Bytes(acc.data[0]), infoDisc) : null
    if (info && info.key === key) oracles.push(info)
    else unregistered.push(key)
  })
  return { threshold: event.threshold, oracles, unregistered, meta: decodeEventMeta(eventData) }
}
