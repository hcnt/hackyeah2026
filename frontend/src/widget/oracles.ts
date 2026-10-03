// The oracles an attendee joins. An event names up to 3 oracles and pays only when `threshold` of them have seen the
// wallet, so every one of them needs the join (photo + signed message). Which oracles, and where they live, comes from
// the chain (chain.ts), not from our API.
import { ApiError, createApi, type Api, type AttendanceStatus, type EventDetails } from './api'
import { DEFAULT_PROGRAM_ID, DEFAULT_RPC_URL, readEventOracles, type EventMeta } from './chain'

export interface Oracle {
  /** Base58 key from the Event account; null in single-oracle fallback mode. */
  key: string | null
  name: string
  host: string
  api: Api
}

export interface OracleSet {
  oracles: Oracle[]
  /** How many oracles must accept the join for it to count. */
  need: number
  /** The event's own threshold (may exceed `oracles.length` when some oracles have no registry entry). */
  threshold: number
  /** Oracles listed on the event that the widget cannot reach (no registry entry). */
  unreachable: number
  /** False in single-oracle fallback mode (api-base). */
  fromChain: boolean
  /** The event's terms as stored on the chain; null in fallback mode or when they don't decode. */
  meta: EventMeta | null
}

export type Settled<T> = { oracle: Oracle; ok: true; value: T } | { oracle: Oracle; ok: false; error: ApiError }

export function hostOf(url: string): string {
  try {
    return new URL(url, window.location.href).host
  } catch {
    return url
  }
}

/**
 * The event's oracles from the chain. If the chain read fails (RPC down, event id not an on-chain Event, program id
 * not deployed yet) or no listed oracle has a registry entry, falls back to single-oracle mode: the api-base backend
 * only, threshold 1 — the widget's behaviour before multi-oracle enrolment.
 */
export async function discoverOracles(opts: {
  eventId: string
  apiBase: string
  rpcUrl?: string
  programId?: string
}): Promise<OracleSet> {
  const { eventId, apiBase } = opts
  try {
    const chain = await readEventOracles(opts.rpcUrl || DEFAULT_RPC_URL, opts.programId || DEFAULT_PROGRAM_ID, eventId)
    if (chain.oracles.length > 0) {
      return {
        oracles: chain.oracles.map((o) => ({
          key: o.key,
          name: o.name,
          host: hostOf(o.url),
          api: createApi(o.url, eventId, o.name),
        })),
        need: Math.min(chain.threshold, chain.oracles.length),
        threshold: chain.threshold,
        unreachable: chain.unregistered.length,
        fromChain: true,
        meta: chain.meta,
      }
    }
  } catch {
    // fall through to single-oracle mode
  }
  return {
    oracles: [{ key: null, name: 'OnSight', host: hostOf(apiBase || window.location.origin), api: createApi(apiBase, eventId) }],
    need: 1,
    threshold: 1,
    unreachable: 0,
    fromChain: false,
    meta: null,
  }
}

function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'unknown', (err as Error | null)?.message ?? 'Request failed')
}

/** Runs `call` against each oracle in parallel; never rejects. */
export function toAll<T>(oracles: Oracle[], call: (api: Api) => Promise<T>): Promise<Settled<T>[]> {
  return Promise.all(
    oracles.map((oracle) =>
      call(oracle.api).then(
        (value): Settled<T> => ({ oracle, ok: true, value }),
        (err): Settled<T> => ({ oracle, ok: false, error: asApiError(err) }),
      ),
    ),
  )
}

/** Event details (and consent text) from the first oracle that answers. */
export async function firstEvent(oracles: Oracle[]): Promise<{ oracle: Oracle; event: EventDetails }> {
  try {
    return await Promise.any(oracles.map((oracle) => oracle.api.event().then((event) => ({ oracle, event }))))
  } catch (err) {
    throw (err as AggregateError).errors?.[0] ?? err
  }
}

function isoSeconds(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * The oracle's event details with every term the chain holds (name, venue, organizer, times, reward, cap, counters)
 * replaced by the on-chain value, so a dishonest oracle cannot show different terms. Status and joining_open are
 * derived from the chain times and `nowMs` the same way the oracle derives them. Without meta: `event` unchanged.
 * Kept from the oracle: consent, going, and anything else the chain doesn't have.
 */
export function withChainTerms(event: EventDetails, meta: EventMeta | null, nowMs = Date.now()): EventDetails {
  if (!meta) return event
  const now = nowMs / 1000
  return {
    ...event,
    name: meta.name,
    venue: meta.venue,
    organizer: meta.organizer,
    starts_at: isoSeconds(meta.start),
    ends_at: isoSeconds(meta.end),
    status: meta.end < now ? 'ended' : meta.start <= now ? 'live' : 'upcoming',
    joining_open: meta.end >= now,
    min_seen_secs: meta.minSeenSecs,
    reward_lamports: meta.rewardLamports,
    max_payouts: meta.maxPaid,
    paid: meta.paidCount,
    spots_left: Math.max(meta.maxPaid - meta.paidCount, 0),
  }
}

export interface Attendance {
  status: AttendanceStatus
  tx: string | null
  /** Oracles that have this wallet on their list (or paid it). */
  onList: number
}

/** The wallet's standing across oracles: paid when any oracle reports paid, on the list once `need` oracles have it. */
export async function attendance(set: OracleSet, wallet: string): Promise<Attendance> {
  const results = await toAll(set.oracles, (api) => api.status(wallet))
  const answered = results.filter((r) => r.ok)
  if (answered.length === 0) throw (results[0] as { error: ApiError }).error
  const paid = answered.find((r) => r.value.status === 'paid')
  const onList = answered.filter((r) => r.value.status !== 'not_joined').length
  if (paid) return { status: 'paid', tx: paid.value.tx, onList }
  return { status: onList >= set.need ? 'on_list' : 'not_joined', tx: null, onList }
}

/** "OnSight: message; Other: message" for the failed results. */
export function failureText(failed: Settled<unknown>[]): string {
  return failed.map((r) => (r.ok ? '' : `${r.oracle.name}: ${r.error.message}`)).filter(Boolean).join(' · ')
}
