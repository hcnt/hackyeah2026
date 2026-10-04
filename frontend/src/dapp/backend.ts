// The two data sources behind the same screens: `live` talks to the on_sight program on Solana from the organizer's
// wallet, `demo` keeps everything in memory with the placeholder events (and a clock frozen at the demo's evening).
import { DEFAULT_PROGRAM_ID, DEFAULT_RPC_URL } from '../widget/chain'
import type { Connection } from '../widget/wallet'
import {
  checkCreateEvent,
  createEvent,
  eventLamports,
  eventRent,
  FEE_LAMPORTS,
  getBalance,
  withdrawRemaining,
  type EventParams,
} from '../organizer/program'
import { explorerTxUrl } from '../venue/payload'
import { listOrganizerEvents, readEvent, readOracleStatus, readPayouts } from './chainData'
import { remaining, type EventRow, type OracleStatus, type Payout } from './model'

export type Step = (step: string) => void

export interface Backend {
  mode: 'live' | 'demo'
  /** Shown in the nav: "Devnet", "Demo data", or the RPC host. */
  network: string
  rpcUrl: string
  programId: string
  /** Wall clock in ms; the demo runs on its own clock. */
  now(): number
  feePerAttendee: bigint
  rent(): Promise<bigint>
  balance(address: string): Promise<bigint>
  listEvents(organizer: string): Promise<EventRow[]>
  getEvent(id: string, organizer: string | null): Promise<EventRow | null>
  /** Checks the terms against the program without the wallet (simulation). Throws with the reason. */
  checkTerms(organizer: string, params: EventParams): Promise<void>
  launch(conn: Connection | null, organizer: string, params: EventParams, onStep: Step): Promise<{ event: string; signature: string }>
  withdraw(conn: Connection | null, event: EventRow, onStep: Step): Promise<string>
  oracles(event: EventRow): Promise<OracleStatus[]>
  payouts(event: EventRow): Promise<Payout[]>
  txUrl(signature: string): string
  addressUrl(address: string): string
}

// ---------- Live ----------

/** Events of this organizer seen in this browser, so withdrawn (closed) accounts still show up under "Past". */
const cacheKey = (organizer: string, programId: string) => `onsight:events:${programId}:${organizer}`

type Stored = Omit<EventRow, 'rewardLamports' | 'feeLamports' | 'returnedLamports'> & {
  rewardLamports: string
  feeLamports: string
  returnedLamports: string | null
}

function loadCache(organizer: string, programId: string): EventRow[] {
  try {
    const raw = JSON.parse(localStorage.getItem(cacheKey(organizer, programId)) ?? '[]') as Stored[]
    return raw.map((r) => ({
      ...r,
      rewardLamports: BigInt(r.rewardLamports),
      feeLamports: BigInt(r.feeLamports),
      returnedLamports: r.returnedLamports === null ? null : BigInt(r.returnedLamports),
    }))
  } catch {
    return []
  }
}

function saveCache(organizer: string, programId: string, rows: EventRow[]) {
  const stored: Stored[] = rows.map((r) => ({
    ...r,
    rewardLamports: r.rewardLamports.toString(),
    feeLamports: r.feeLamports.toString(),
    returnedLamports: r.returnedLamports === null ? null : r.returnedLamports.toString(),
  }))
  try {
    localStorage.setItem(cacheKey(organizer, programId), JSON.stringify(stored))
  } catch {
    // storage blocked: withdrawn events just won't be listed
  }
}

function patchCache(organizer: string, programId: string, row: EventRow) {
  const rows = loadCache(organizer, programId).filter((r) => r.id !== row.id)
  saveCache(organizer, programId, [row, ...rows])
}

export function liveBackend(): Backend {
  const q = new URLSearchParams(window.location.search)
  const rpcUrl = q.get('rpc') || DEFAULT_RPC_URL
  const programId = q.get('program') || DEFAULT_PROGRAM_ID
  const cluster = /devnet/.test(rpcUrl) ? 'Devnet' : /testnet/.test(rpcUrl) ? 'Testnet' : /mainnet/.test(rpcUrl) ? 'Mainnet' : new URL(rpcUrl).host
  let rentCache: Promise<bigint> | null = null

  return {
    mode: 'live',
    network: cluster,
    rpcUrl,
    programId,
    now: () => Date.now(),
    feePerAttendee: FEE_LAMPORTS,
    rent: () => (rentCache ??= eventRent(rpcUrl).catch((e) => ((rentCache = null), Promise.reject(e)))),
    balance: (address) => getBalance(rpcUrl, address),

    async listEvents(organizer) {
      const open = await listOrganizerEvents(rpcUrl, programId, organizer)
      const openIds = new Set(open.map((e) => e.id))
      // A cached event whose account is gone was withdrawn (closed); keep its last known numbers.
      const closed = loadCache(organizer, programId)
        .filter((e) => !openIds.has(e.id))
        .map((e) => (e.withdrawn ? e : { ...e, withdrawn: true, returnedLamports: e.returnedLamports ?? remaining(e) }))
      const rows = [...open, ...closed]
      saveCache(organizer, programId, rows)
      return rows
    },

    async getEvent(id, organizer) {
      const row = await readEvent(rpcUrl, programId, id)
      if (row) {
        if (organizer === row.organizer) patchCache(organizer, programId, row)
        return row
      }
      const cached = organizer ? loadCache(organizer, programId).find((e) => e.id === id) : undefined
      return cached ? { ...cached, withdrawn: true, returnedLamports: cached.returnedLamports ?? remaining(cached) } : null
    },

    checkTerms: (organizer, params) => checkCreateEvent(rpcUrl, programId, organizer, params),

    async launch(conn, organizer, params, onStep) {
      if (!conn) throw new Error('Connect your wallet first.')
      const created = await createEvent(conn, rpcUrl, programId, params, onStep)
      patchCache(organizer, programId, {
        id: created.event,
        name: params.name,
        venue: params.venue || null,
        organizer,
        start: params.start,
        end: params.end,
        rewardLamports: params.rewardLamports,
        feeLamports: FEE_LAMPORTS,
        maxPaid: params.maxPaid,
        paidCount: 0,
        oracles: params.oracles,
        threshold: params.threshold,
        withdrawn: false,
        returnedLamports: null,
      })
      return created
    },

    async withdraw(conn, event, onStep) {
      if (!conn) throw new Error('Connect the organizer wallet first.')
      const before = await eventLamports(rpcUrl, event.id).catch(() => null)
      const tx = await withdrawRemaining(conn, rpcUrl, programId, event.id, onStep)
      patchCache(event.organizer, programId, { ...event, withdrawn: true, returnedLamports: before ?? remaining(event) })
      return tx
    },

    oracles: (event) => readOracleStatus(rpcUrl, programId, event.id),
    payouts: (event) => readPayouts(rpcUrl, event),
    txUrl: explorerTxUrl,
    addressUrl: (a) => `https://explorer.solana.com/address/${encodeURIComponent(a)}?cluster=devnet`,
  }
}

// ---------- Demo ----------

/** What a 327-byte Event account deposits on devnet, as eventRent() reads it live (getMinimumBalanceForRentExemption). */
const DEMO_RENT = 2_311_400n

const SOL = 1_000_000_000n
const sol = (n: number) => (BigInt(Math.round(n * 1000)) * SOL) / 1000n
/** The demo opens at 4 Oct 2026, 20:17:50 local time, so the ongoing meetup "Ends in 01:42:10". */
const DEMO_START = new Date(2026, 9, 4, 20, 17, 50).getTime()
export const DEMO_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const DEMO_ORACLES = ['9c4e1HNxQM1GsbPNrUwRAo3eDghR6xLeGGzuKauUsPD3', 'Ora2kWq1fN8bZr3uYtVx5mHsLcPdEeGjKa7iQ4oT6nB']
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime() / 1000
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function demoRow(
  id: string,
  name: string,
  venue: string,
  start: number,
  end: number,
  reward: number,
  maxPaid: number,
  paidCount: number,
  returned?: number,
): EventRow {
  return {
    id,
    name,
    venue,
    organizer: DEMO_WALLET,
    start,
    end,
    rewardLamports: sol(reward),
    feeLamports: FEE_LAMPORTS,
    maxPaid,
    paidCount,
    oracles: DEMO_ORACLES,
    threshold: 2,
    withdrawn: returned !== undefined,
    returnedLamports: returned === undefined ? null : sol(returned),
  }
}

const DEMO_LIVE_ID = 'DMABDq39byngbxquc3B9sSBcoHdYGMedGoL9GjbcxZSo'
const randomKey = () => Array.from({ length: 44 }, () => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 58)]).join('')

export function demoBackend(): Backend {
  const loadedAt = Date.now()
  const now = () => DEMO_START + (Date.now() - loadedAt)
  let balance = sol(120)
  const events: EventRow[] = [
    demoRow('SBNk1kRakowBuilders1111111111111111111111111', 'Solana Builders Night Kraków', 'Kraków Technology Park', at(2026, 11, 12, 18), at(2026, 11, 12, 22), 0.5, 100, 0),
    demoRow('DeFiBreakfastWarsaw1111111111111111111111111', 'DeFi Breakfast Warsaw', 'Varso Tower, Warsaw', at(2026, 12, 3, 8, 30), at(2026, 12, 3, 11), 0.4, 50, 0),
    demoRow(DEMO_LIVE_ID, 'Solana Dev Meetup Kraków', 'Hub:raum Kraków', at(2026, 10, 4, 18), at(2026, 10, 4, 22), 0.25, 100, 60),
    demoRow('NFTNightGdansk11111111111111111111111111111', 'NFT Night Gdańsk', 'Olivia Star, Gdańsk', at(2026, 9, 18, 19), at(2026, 9, 18, 23), 0.3, 100, 90, 3),
    demoRow('ValidatorTalksWroclaw111111111111111111111111', 'Validator Talks Wrocław', 'Concordia Design, Wrocław', at(2026, 9, 5, 17), at(2026, 9, 5, 20), 0.2, 50, 50, 0),
    demoRow('Web3FoundersCoffee1111111111111111111111111', 'Web3 Founders Coffee Kraków', 'Cafe Mięta, Kraków', at(2026, 8, 22, 9), at(2026, 8, 22, 11), 0.2, 40, 32, 1.6),
  ]
  const signatures = new Map<string, [number, number]>([[DEMO_LIVE_ID, [61, 60]]])
  const t = (h: number, m: number, s: number) => new Date(2026, 9, 4, h, m, s).getTime()
  const payouts = new Map<string, Payout[]>([
    [
      DEMO_LIVE_ID,
      [
        { tx: randomKey() + randomKey(), wallet: DEMO_WALLET, lamports: sol(0.25), at: t(18, 42, 5) },
        { tx: randomKey() + randomKey(), wallet: '3mPqVb7wXn2dKe4sRtYu9hJz6aCfLg1oNi8kM5pQ2LcZ', lamports: sol(0.25), at: t(18, 41, 37) },
        { tx: randomKey() + randomKey(), wallet: '9vRtYw3eQa6sDf8gHj2kLz5xCv7bNm4pTu1iOy9r8HbN', lamports: sol(0.25), at: t(18, 40, 12) },
        { tx: randomKey() + randomKey(), wallet: '5kLwPq8rTy2uIo6pAs4dFg7hJk1lZx3cVb9nMq2w4QxD', lamports: sol(0.25), at: t(18, 38, 59) },
      ],
    ],
  ])
  const find = (id: string) => events.find((e) => e.id === id) ?? null

  // Attendees keep checking in at the ongoing meetup while the demo is open.
  window.setInterval(() => {
    const live = find(DEMO_LIVE_ID)
    if (!live || live.paidCount >= live.maxPaid || now() / 1000 > live.end) return
    live.paidCount += 1
    const [a, b] = signatures.get(DEMO_LIVE_ID) ?? [0, 0]
    signatures.set(DEMO_LIVE_ID, [a + 1, b + 1])
    payouts.get(DEMO_LIVE_ID)?.unshift({ tx: randomKey() + randomKey(), wallet: randomKey(), lamports: live.rewardLamports, at: now() })
  }, 9000)

  return {
    mode: 'demo',
    network: 'Demo data',
    rpcUrl: '',
    programId: '',
    now,
    feePerAttendee: FEE_LAMPORTS,
    rent: async () => DEMO_RENT,
    balance: async () => balance,
    listEvents: async () => (await wait(250), events.map((e) => ({ ...e }))),
    getEvent: async (id) => (await wait(150), find(id) && { ...find(id)! }),
    async checkTerms(_organizer, p) {
      await wait(700)
      const cost = (p.rewardLamports + FEE_LAMPORTS) * BigInt(p.maxPaid) + DEMO_RENT
      if (cost > balance) throw new Error('Not enough SOL in this wallet for the deposit.')
    },
    async launch(_conn, organizer, p, onStep) {
      onStep('Approve it in your wallet…')
      await wait(900)
      onStep('Waiting for the network to confirm…')
      await wait(1100)
      const id = randomKey()
      balance -= (p.rewardLamports + FEE_LAMPORTS) * BigInt(p.maxPaid) + DEMO_RENT
      events.unshift({ ...demoRow(id, p.name, p.venue, p.start, p.end, 0, p.maxPaid, 0), rewardLamports: p.rewardLamports, organizer })
      return { event: id, signature: randomKey() + randomKey() }
    },
    async withdraw(_conn, event, onStep) {
      onStep('Approve it in your wallet…')
      await wait(900)
      const row = find(event.id)
      if (row) {
        row.returnedLamports = remaining(row)
        balance += remaining(row) + DEMO_RENT
        row.withdrawn = true
      }
      return randomKey() + randomKey()
    },
    async oracles(event) {
      const [a, b] = signatures.get(event.id) ?? [0, 0]
      return [
        { key: DEMO_ORACLES[0], name: 'Oracle 1', url: 'https://oracle.onsight.site', signatures: a, online: true },
        { key: DEMO_ORACLES[1], name: 'Oracle 2', url: 'https://oracle-2.onsight.site', signatures: b, online: true },
      ]
    },
    payouts: async (event) => [...(payouts.get(event.id) ?? [])],
    txUrl: (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`,
    addressUrl: (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`,
  }
}
