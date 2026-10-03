// Solana wallets through the Wallet Standard. MetaMask registers itself here when its Solana
// support is on; Phantom and others show up the same way, so they work as a fallback.
import { useEffect, useState } from 'react'
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import {
  StandardConnect,
  StandardDisconnect,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
} from '@wallet-standard/features'
import { SolanaSignMessage, type SolanaSignMessageFeature } from '@solana/wallet-standard-features'
import bs58 from 'bs58'
import { nowIso, signedMessage, type SignAction, type Signed } from './api'

export const METAMASK_DOWNLOAD_URL = 'https://metamask.io/download/'

export function isSolanaWallet(wallet: Wallet): boolean {
  return (
    wallet.chains.some((c) => c.startsWith('solana:')) &&
    StandardConnect in wallet.features &&
    SolanaSignMessage in wallet.features
  )
}

export function isMetaMask(wallet: Wallet): boolean {
  return /metamask/i.test(wallet.name)
}

/** Solana-capable wallets in the page, MetaMask first. Updates when wallets register late. */
export function useSolanaWallets(): Wallet[] {
  const [wallets, setWallets] = useState<Wallet[]>(() => listWallets())
  useEffect(() => {
    const { on } = getWallets()
    const update = () => setWallets(listWallets())
    update()
    const offRegister = on('register', update)
    const offUnregister = on('unregister', update)
    return () => {
      offRegister()
      offUnregister()
    }
  }, [])
  return wallets
}

function listWallets(): Wallet[] {
  return getWallets()
    .get()
    .filter(isSolanaWallet)
    .sort((a, b) => Number(isMetaMask(b)) - Number(isMetaMask(a)))
}

export interface Connection {
  wallet: Wallet
  account: WalletAccount
}

export async function connect(wallet: Wallet): Promise<Connection> {
  const { connect } = (wallet.features as StandardConnectFeature)[StandardConnect]
  const { accounts } = await connect()
  const account = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0]
  if (!account) throw new Error(`${wallet.name} did not share an account`)
  return { wallet, account }
}

export async function disconnect({ wallet }: Connection): Promise<void> {
  const feature = (wallet.features as Partial<StandardDisconnectFeature>)[StandardDisconnect]
  await feature?.disconnect().catch(() => {})
}

/** Signs the oracle's "Attend Now" message for `action` and returns the fields every signed call carries. */
export async function signAction(
  { wallet, account }: Connection,
  action: SignAction,
  eventId: string,
  consentVersion?: string,
): Promise<Signed> {
  const signedAt = nowIso()
  const message = signedMessage(action, eventId, account.address, signedAt, consentVersion)
  const { signMessage } = (wallet.features as SolanaSignMessageFeature)[SolanaSignMessage]
  const [output] = await signMessage({ account, message: new TextEncoder().encode(message) })
  return { wallet: account.address, signed_at: signedAt, signature: bs58.encode(output.signature) }
}

/** True when the user closed or rejected the wallet prompt. */
export function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null
  return e?.code === 4001 || /reject|denied|cancel/i.test(e?.message ?? '')
}

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address
}
