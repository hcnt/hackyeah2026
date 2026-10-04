// Builds, simulates and sends the organizer's on_sight transactions (create_event, withdraw_remaining) from their wallet.
// Same instructions as scripts/devnet_event.py and backend/app/chain/presence_chain.py, with a legacy transaction
// serialized by hand so the pages need no Solana SDK (like widget/chain.ts).
import bs58 from 'bs58'
import type { WalletAccount } from '@wallet-standard/base'
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features'
import {
  base64Bytes,
  ChainError,
  decodeOracleInfo,
  discriminator,
  findProgramAddress,
  getMultipleAccounts,
  oracleInfoAddress,
  rpcCall as rpc,
  sha256,
} from '../widget/chain'
import type { Connection } from '../widget/wallet'

export const LAMPORTS_PER_SOL = 1_000_000_000n
/** lib.rs FEE_LAMPORTS: paid per rewarded attendee to the oracle whose report paid, frozen into the Event. */
export const FEE_LAMPORTS = 2_000_000n
export const MAX_ORACLES = 3
export const MAX_EVENT_NAME = 64
export const MAX_EVENT_VENUE = 64
/** The demo oracle, registered as OnSight at https://oracle.onsight.site. */
export const DEFAULT_ORACLE = '9c4e1HNxQM1GsbPNrUwRAo3eDghR6xLeGGzuKauUsPD3'
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'
/** 8 + Event::INIT_SPACE in lib.rs: discriminator, fixed fields, then name and venue at their max length. */
const EVENT_ACCOUNT_SPACE = 8 + 32 + 32 * MAX_ORACLES + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 4 + 4 + 4 + 1 + (4 + MAX_EVENT_NAME) + (4 + MAX_EVENT_VENUE)

/** PresenceError in lib.rs, in order: Anchor numbers custom errors from 6000. */
const PROGRAM_ERRORS = [
  'End must be after start',
  'Reward and max attendees must be > 0',
  'Math overflow',
  'Event has not started yet',
  'Event has ended',
  'Max attendees already paid',
  'Not allowed while the event is running',
  'Oracles must be 1 to 3 distinct, non-default keys',
  'Threshold must be between 1 and the number of oracles',
  "Signer is not one of this event's oracles",
  'Oracle name must be 1 to 32 bytes, no control characters',
  'Oracle url must start with https:// or http://, be at most 128 bytes, no spaces',
  "Report must follow an ed25519 check of the attendee's signed join message for this event",
  'Event name must be 1 to 64 bytes, venue at most 64, no control characters',
]

export interface EventParams {
  oracles: string[]
  threshold: number
  /** Unix seconds (chain clock). */
  start: number
  end: number
  rewardLamports: bigint
  maxPaid: number
  minSeenSecs: number
  name: string
  venue: string
}

export interface CreatedEvent {
  /** The Event account's address: the event id the widget, stage screen and oracles use. */
  event: string
  signature: string
}

/** What the organizer's wallet pays: rewards and oracle fees go to the event's vault, rent keeps the account alive. */
export function eventBudget(rewardLamports: bigint, maxPaid: number): bigint {
  return (rewardLamports + FEE_LAMPORTS) * BigInt(maxPaid)
}

/** "1.5" → 1_500_000_000n; null unless a plain non-negative decimal with at most 9 fraction digits. */
export function parseSol(text: string): bigint | null {
  const m = /^\s*(\d*)(?:[.,](\d{0,9}))?\s*$/.exec(text)
  if (!m || (m[1] === '' && !m[2])) return null
  return BigInt(m[1] || '0') * LAMPORTS_PER_SOL + BigInt((m[2] ?? '').padEnd(9, '0'))
}

export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** The program's BadEventText rule, checked before anything is sent. */
export function eventTextError(label: string, value: string, min: number, max: number): string | null {
  const n = utf8.encode(value).length
  if (n < min || n > max) return min > 0 ? `${label} must be ${min}–${max} bytes (now ${n}).` : `${label} must be at most ${max} bytes (now ${n}).`
  if (/\p{Cc}/u.test(value)) return `${label} must not contain control characters.`
  return null
}

export function isPublicKey(text: string): boolean {
  try {
    return bs58.decode(text).length === 32
  } catch {
    return false
  }
}

const utf8 = new TextEncoder()

export async function getBalance(rpcUrl: string, address: string): Promise<bigint> {
  const r = await rpc<{ value: number }>(rpcUrl, 'getBalance', [address, { commitment: 'confirmed' }])
  return BigInt(r.value)
}

/** Lamports the new Event account holds on top of the budget; returned with the rest by withdraw_remaining. */
export async function eventRent(rpcUrl: string): Promise<bigint> {
  return BigInt(await rpc<number>(rpcUrl, 'getMinimumBalanceForRentExemption', [EVENT_ACCOUNT_SPACE]))
}

/**
 * Oracles without an entry in the program's registry (OracleInfo, PDA ["oracle", key]). The stage screen and the
 * attendee widget find an oracle's API only there, so an event with none of its oracles registered can't pair cameras.
 */
export async function unregisteredOracles(rpcUrl: string, programId: string, oracles: string[]): Promise<string[]> {
  const [disc, addresses] = await Promise.all([
    discriminator('OracleInfo'),
    Promise.all(oracles.map((o) => oracleInfoAddress(o, programId))),
  ])
  const infos = await getMultipleAccounts(rpcUrl, addresses)
  return oracles.filter((key, i) => {
    const acc = infos[i]
    const info = acc && acc.owner === programId ? decodeOracleInfo(base64Bytes(acc.data[0]), disc) : null
    return info?.key !== key
  })
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}

function i64(n: number): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigInt64(0, BigInt(n), true)
  return b
}

function borshString(s: string): Uint8Array {
  const raw = utf8.encode(s)
  return concat(u32(raw.length), raw)
}

/** Solana's compact-u16 length prefix. */
function shortVec(n: number): Uint8Array {
  const out = []
  do {
    let byte = n & 0x7f
    n >>= 7
    if (n) byte |= 0x80
    out.push(byte)
  } while (n)
  return Uint8Array.from(out)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * An unsigned legacy transaction with one instruction whose only signer (and fee payer) is `signer`, followed by the
 * `writable` and then the `readonly` accounts, in that order.
 */
function buildTransaction(
  programId: string,
  signer: string,
  writable: string[],
  readonly: string[],
  data: Uint8Array,
  blockhash: string,
): Uint8Array {
  // Account order: writable signers, then writable non-signers, then read-only non-signers (the program id last).
  const keys = [signer, ...writable, ...readonly, programId]
  const accounts = keys.slice(0, -1).map((_, i) => i)
  const message = concat(
    Uint8Array.of(1, 0, readonly.length + 1), // 1 signature, 0 read-only signed, read-only unsigned incl. the program
    shortVec(keys.length),
    ...keys.map((k) => bs58.decode(k)),
    bs58.decode(blockhash),
    shortVec(1),
    Uint8Array.of(keys.length - 1), // program id index
    shortVec(accounts.length),
    Uint8Array.from(accounts),
    shortVec(data.length),
    data,
  )
  return concat(shortVec(1), new Uint8Array(64), message)
}

async function instructionData(name: string, ...args: Uint8Array[]): Promise<Uint8Array> {
  return concat((await sha256(utf8.encode(`global:${name}`))).slice(0, 8), ...args)
}

interface SimResult {
  err: unknown
  logs: string[] | null
}

function programErrorText(err: unknown, logs: string[] | null): string {
  const custom = (err as { InstructionError?: [number, { Custom?: number }] } | null)?.InstructionError?.[1]?.Custom
  if (typeof custom === 'number' && PROGRAM_ERRORS[custom - 6000]) return PROGRAM_ERRORS[custom - 6000]
  if (logs?.some((l) => /insufficient lamports/i.test(l))) return 'Not enough SOL in this wallet for the deposit.'
  const line = logs?.slice().reverse().find((l) => /error|failed/i.test(l))
  return line ?? `The program refused the transaction (${JSON.stringify(err)}).`
}

/**
 * Polls until the sent transaction is confirmed. RPC errors while polling (e.g. rate limits) don't fail it: the
 * transaction is already on its way, so only a failed transaction or the timeout ends the wait.
 */
async function waitConfirmed(rpcUrl: string, signature: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    let st: { err: unknown; confirmationStatus?: string } | null
    try {
      const r = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(
        rpcUrl,
        'getSignatureStatuses',
        [[signature]],
      )
      st = r.value[0]
    } catch {
      continue
    }
    if (st?.err) throw new ChainError(programErrorText(st.err, null))
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return
  }
  throw new ChainError(
    `The transaction was sent but not confirmed within ${timeoutMs / 1000} s; it may still go through. Check it before trying again: https://explorer.solana.com/tx/${signature}?cluster=devnet`,
  )
}

function walletChain(account: WalletAccount, rpcUrl: string): `${string}:${string}` {
  const wanted = /devnet/.test(rpcUrl) ? 'solana:devnet' : /testnet/.test(rpcUrl) ? 'solana:testnet' : 'solana:mainnet'
  return (account.chains.find((c) => c === wanted) ?? wanted) as `${string}:${string}`
}

/**
 * Simulates the transaction (so program errors show before the wallet prompt), has the wallet sign and send it, and
 * waits for confirmation. Returns the signature.
 */
async function signSimulateSend(
  { wallet, account }: Connection,
  rpcUrl: string,
  build: (blockhash: string) => Uint8Array,
  onStep: (step: string) => void,
): Promise<string> {
  const { value } = await rpc<{ value: { blockhash: string } }>(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }])
  const tx = build(value.blockhash)

  onStep('Checking the transaction with the program…')
  const sim = await rpc<{ value: SimResult }>(rpcUrl, 'simulateTransaction', [
    base64(tx),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
  ])
  if (sim.value.err) throw new ChainError(programErrorText(sim.value.err, sim.value.logs))

  onStep('Approve it in your wallet…')
  const chain = walletChain(account, rpcUrl)
  let signature: string
  const signAndSend = (wallet.features as Partial<SolanaSignAndSendTransactionFeature>)[SolanaSignAndSendTransaction]
  const signOnly = (wallet.features as Partial<SolanaSignTransactionFeature>)[SolanaSignTransaction]
  if (signAndSend) {
    const [out] = await signAndSend.signAndSendTransaction({ account, chain, transaction: tx })
    signature = bs58.encode(out.signature)
  } else if (signOnly) {
    const [out] = await signOnly.signTransaction({ account, chain, transaction: tx })
    signature = await rpc<string>(rpcUrl, 'sendTransaction', [base64(out.signedTransaction), { encoding: 'base64' }])
  } else {
    throw new ChainError(`${wallet.name} can’t sign Solana transactions.`)
  }

  onStep('Waiting for the network to confirm…')
  await waitConfirmed(rpcUrl, signature)
  return signature
}

/**
 * Creates and funds the event: create_event(event_id u64, oracles Vec<Pubkey>, threshold u8, start i64, end i64,
 * reward u64, max_paid u32, min_seen_secs u32, name String, venue String) with accounts [organizer (signer, w),
 * event PDA (w), system program]. The organizer's wallet moves the whole budget ((reward + fee) × max_paid) into the
 * new Event account.
 */
export async function createEvent(
  conn: Connection,
  rpcUrl: string,
  programId: string,
  p: EventParams,
  onStep: (step: string) => void,
): Promise<CreatedEvent> {
  const organizer = conn.account.address
  const { event, data } = await createEventInstruction(programId, organizer, p, BigInt(Date.now()))
  const signature = await signSimulateSend(
    conn,
    rpcUrl,
    (blockhash) => buildTransaction(programId, organizer, [event], [SYSTEM_PROGRAM_ID], data, blockhash),
    onStep,
  )
  return { event, signature }
}

/**
 * Simulates create_event for `organizer` without asking the wallet anything, so terms the program would refuse (or a
 * balance that can't cover them) show up before the organizer commits to them. Throws a ChainError with the reason.
 */
export async function checkCreateEvent(rpcUrl: string, programId: string, organizer: string, p: EventParams): Promise<void> {
  const { event, data } = await createEventInstruction(programId, organizer, p, BigInt(Date.now()))
  const { value } = await rpc<{ value: { blockhash: string } }>(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }])
  const tx = buildTransaction(programId, organizer, [event], [SYSTEM_PROGRAM_ID], data, value.blockhash)
  const sim = await rpc<{ value: SimResult }>(rpcUrl, 'simulateTransaction', [
    base64(tx),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
  ])
  if (sim.value.err) throw new ChainError(programErrorText(sim.value.err, sim.value.logs))
}

async function createEventInstruction(programId: string, organizer: string, p: EventParams, eventId: bigint) {
  const event = await findProgramAddress([utf8.encode('event'), bs58.decode(organizer), u64(eventId)], programId)
  const data = await instructionData(
    'create_event',
    u64(eventId),
    u32(p.oracles.length),
    ...p.oracles.map((o) => bs58.decode(o)),
    Uint8Array.of(p.threshold),
    i64(p.start),
    i64(p.end),
    u64(p.rewardLamports),
    u32(p.maxPaid),
    u32(p.minSeenSecs),
    borshString(p.name),
    borshString(p.venue),
  )
  return { event, data }
}

/**
 * withdraw_remaining() with accounts [organizer (signer, w), event (w)]: closes the Event account and returns what is
 * left of the deposit, with the account's rent, to the organizer. The program allows it only before the start or
 * after the end (EventRunning otherwise) and only for the event's organizer.
 */
export async function withdrawRemaining(
  conn: Connection,
  rpcUrl: string,
  programId: string,
  event: string,
  onStep: (step: string) => void,
): Promise<string> {
  const data = await instructionData('withdraw_remaining')
  return signSimulateSend(
    conn,
    rpcUrl,
    (blockhash) => buildTransaction(programId, conn.account.address, [event], [], data, blockhash),
    onStep,
  )
}

/** Lamports in the Event account, or null when it no longer exists (withdrawn). */
export async function eventLamports(rpcUrl: string, event: string): Promise<bigint | null> {
  const r = await rpc<{ value: { lamports: number } | null }>(rpcUrl, 'getAccountInfo', [
    event,
    { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
  ])
  return r.value ? BigInt(r.value.lamports) : null
}
