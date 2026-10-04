// Reads for the events app: the organizer's Event accounts, an event's payouts (from its transaction history) and the
// state of its oracles. Plain JSON-RPC like widget/chain.ts; the transaction builders live in organizer/program.ts.
import bs58 from 'bs58'
import {
  base64Bytes,
  decodeEventMeta,
  decodeEventOracles,
  discriminator,
  getMultipleAccounts,
  readEventOracles,
  rpcCall,
} from '../widget/chain'
import type { EventRow, OracleStatus, Payout } from './model'

interface ProgramAccount {
  pubkey: string
  account: { data: [string, string]; owner: string; lamports: number }
}

function decodeRow(id: string, data: Uint8Array, lamports: number, disc: Uint8Array): EventRow | null {
  const oracles = decodeEventOracles(data, disc)
  const meta = oracles && decodeEventMeta(data)
  if (!oracles || !meta) return null
  return {
    id,
    name: meta.name,
    venue: meta.venue,
    organizer: meta.organizer,
    start: meta.start,
    end: meta.end,
    rewardLamports: BigInt(meta.rewardLamports),
    feeLamports: BigInt(meta.feeLamports),
    maxPaid: meta.maxPaid,
    paidCount: meta.paidCount,
    oracles: oracles.oracles,
    threshold: oracles.threshold,
    balanceLamports: BigInt(lamports),
    withdrawn: false,
    returnedLamports: null,
  }
}

/** Every open Event account of `organizer` (memcmp on the discriminator and the organizer field at offset 8). */
export async function listOrganizerEvents(rpcUrl: string, programId: string, organizer: string): Promise<EventRow[]> {
  const disc = await discriminator('Event')
  const accounts = await rpcCall<ProgramAccount[]>(rpcUrl, 'getProgramAccounts', [
    programId,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }, { memcmp: { offset: 8, bytes: organizer } }],
    },
  ])
  return accounts.flatMap((a) => {
    const row = decodeRow(a.pubkey, base64Bytes(a.account.data[0]), a.account.lamports, disc)
    return row ? [row] : []
  })
}

/** One Event account, or null when it doesn't exist (never did, or was withdrawn and closed). */
export async function readEvent(rpcUrl: string, programId: string, id: string): Promise<EventRow | null> {
  const disc = await discriminator('Event')
  const [acc] = await getMultipleAccounts(rpcUrl, [id])
  if (!acc || acc.owner !== programId) return null
  return decodeRow(id, base64Bytes(acc.data[0]), acc.lamports, disc)
}

// ---------- Payouts ----------

interface SignatureInfo {
  signature: string
  err: unknown
  blockTime: number | null
}

interface ParsedTx {
  blockTime: number | null
  meta: { err: unknown; preBalances: number[]; postBalances: number[]; logMessages: string[] | null } | null
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } }
}

const PAYOUT_LOG = /Instruction: ReportSighting/
/** Transactions already looked at, by signature: payouts never change, and non-payouts are remembered as null. */
const txCache = new Map<string, Payout | null>()

function payoutOf(signature: string, tx: ParsedTx, event: string, reward: bigint): Payout | null {
  if (!tx.meta || tx.meta.err || !tx.meta.logMessages?.some((l) => PAYOUT_LOG.test(l))) return null
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey))
  const { preBalances: pre, postBalances: post } = tx.meta
  // The attendee is the account that gained exactly the reward (the oracle gains the fee, the event loses both).
  const i = keys.findIndex((k, j) => k !== event && BigInt(post[j] - pre[j]) === reward)
  if (i < 0) return null
  return { tx: signature, wallet: keys[i], lamports: reward, at: (tx.blockTime ?? Date.now() / 1000) * 1000 }
}

/**
 * The event's latest payouts, newest first, from its transaction history. Each transaction is fetched once and
 * sequentially (the public devnet RPC allows only a few requests at a time).
 */
export async function readPayouts(rpcUrl: string, event: EventRow, limit = 25): Promise<Payout[]> {
  const sigs = await rpcCall<SignatureInfo[]>(rpcUrl, 'getSignaturesForAddress', [event.id, { limit, commitment: 'confirmed' }])
  const out: Payout[] = []
  for (const s of sigs) {
    if (s.err) continue
    if (!txCache.has(s.signature)) {
      const tx = await rpcCall<ParsedTx | null>(rpcUrl, 'getTransaction', [
        s.signature,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ]).catch(() => undefined)
      if (tx === undefined) continue // try again on the next refresh
      txCache.set(s.signature, tx ? payoutOf(s.signature, tx, event.id, event.rewardLamports) : null)
    }
    const p = txCache.get(s.signature)
    if (p) out.push(p)
  }
  return out
}

// ---------- Oracles ----------

const oracleCache = new Map<string, ReturnType<typeof readEventOracles>>()

/**
 * The event's oracles with their registered names, and for each whether its API answers and how many attendees signed
 * up through it (GET /api/v1/events/{id}, no signature needed).
 */
export async function readOracleStatus(rpcUrl: string, programId: string, eventId: string): Promise<OracleStatus[]> {
  // An event's oracles and their registry entries are fixed, so read them from the chain once per page.
  const cacheKey = `${rpcUrl}|${programId}|${eventId}`
  let pending = oracleCache.get(cacheKey)
  if (!pending) {
    pending = readEventOracles(rpcUrl, programId, eventId)
    oracleCache.set(cacheKey, pending)
    pending.catch(() => oracleCache.delete(cacheKey))
  }
  const ev = await pending
  const registered = await Promise.all(
    ev.oracles.map(async (o): Promise<OracleStatus> => {
      try {
        const ctl = new AbortController()
        const timer = window.setTimeout(() => ctl.abort(), 6000)
        const res = await fetch(`${o.url}/api/v1/events/${encodeURIComponent(eventId)}`, { signal: ctl.signal })
        window.clearTimeout(timer)
        const body = res.ok ? await res.json() : null
        return { key: o.key, name: o.name, url: o.url, signatures: typeof body?.going === 'number' ? body.going : null, online: res.ok }
      } catch {
        return { key: o.key, name: o.name, url: o.url, signatures: null, online: false }
      }
    }),
  )
  const unknown = ev.unregistered.map((key): OracleStatus => ({ key, name: 'Unregistered oracle', url: null, signatures: null, online: false }))
  return [...registered, ...unknown]
}
