// What the OnSight events app shows, independent of where it comes from (the chain or the demo data).
import { formatSol } from '../organizer/program'

export type Status = 'planned' | 'ongoing' | 'past'

export interface EventRow {
  /** The Event account's address (the event id the widget, stage and oracles use). */
  id: string
  name: string
  venue: string | null
  organizer: string
  /** Unix seconds (chain clock). */
  start: number
  end: number
  rewardLamports: bigint
  feeLamports: bigint
  maxPaid: number
  paidCount: number
  oracles: string[]
  threshold: number
  /** Lamports in the Event account. withdraw_remaining closes it and sends all of them to the organizer: unpaid rewards,
   *  unpaid oracle fees and the account deposit. */
  balanceLamports: bigint
  /** True once withdraw_remaining closed the account; `returnedLamports` is what went back to the organizer. */
  withdrawn: boolean
  returnedLamports: bigint | null
}

export interface OracleStatus {
  key: string
  name: string
  url: string | null
  /** Attendees who signed up through this oracle ("going"). */
  signatures: number | null
  online: boolean
}

export interface Payout {
  tx: string
  wallet: string
  lamports: bigint
  /** Unix ms. */
  at: number
}

export function statusOf(e: Pick<EventRow, 'start' | 'end'>, nowMs: number): Status {
  const now = nowMs / 1000
  if (now < e.start) return 'planned'
  if (now <= e.end) return 'ongoing'
  return 'past'
}

export const prizePool = (e: EventRow) => e.rewardLamports * BigInt(e.maxPaid)
export const prizesPaid = (e: EventRow) => e.rewardLamports * BigInt(e.paidCount)
/** Rewards still in the event's pool (0 once withdrawn). */
export const remaining = (e: EventRow) => (e.withdrawn ? 0n : e.rewardLamports * BigInt(Math.max(0, e.maxPaid - e.paidCount)))
/** What withdraw_remaining would send back now: the whole Event account (0 once withdrawn). */
export const withdrawable = (e: EventRow) => (e.withdrawn ? 0n : e.balanceLamports)

export function sol(lamports: bigint, digits = 4): string {
  const [whole, frac = ''] = formatSol(lamports).split('.')
  const f = frac.slice(0, digits).replace(/0+$/, '')
  return f ? `${whole}.${f}` : whole
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function fmtDate(unix: number): string {
  const d = new Date(unix * 1000)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function fmtTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function fmtDuration(secs: number): string {
  const total = Math.max(0, Math.round(secs / 60))
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m'
}

export function fmtDurationLong(secs: number): string {
  const total = Math.max(0, Math.round(secs / 60))
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'}`
  return `${n(d, 'day')}, ${n(h, 'hour')}, ${n(m, 'minute')}`
}

/** "01:42:10" (or "3d 01:42:10" past a day). */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hms = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
  return d ? `${d}d ${hms}` : hms
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
