// Solana wallets through the Wallet Standard. MetaMask registers itself here when its Solana
// support is on; Phantom and others show up the same way, so they work as a fallback.
// Without the extension (any phone browser, desktop without MetaMask), MetaMask Connect registers a "MetaMask"
// wallet instead that reaches the MetaMask mobile app: a deep link on phones, a QR code on desktop.
import { useEffect, useState } from 'react'
import { createSolanaClient, type SolanaClient } from '@metamask/connect-solana'
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
export const PHANTOM_DOWNLOAD_URL = 'https://phantom.com/download'

export type WalletId = 'metamask' | 'phantom'
export const WALLET_NAMES: Record<WalletId, string> = { metamask: 'MetaMask', phantom: 'Phantom' }

/** Phones and tablets, where wallets live in an app instead of a browser extension. */
export function isMobile(): boolean {
  const ua = navigator.userAgent
  return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/**
 * Phantom's universal link that reopens `href` in the Phantom app's browser, where Phantom is in the page like the
 * extension on desktop. Without the app it lands on Phantom's download page. Phantom's own SDK does the same.
 */
export function phantomBrowseUrl(href = window.location.href): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(window.location.origin)}`
}

/** True inside Phantom: its app's browser, or desktop with only the Phantom extension. */
export function prefersPhantom(): boolean {
  const w = window as { phantom?: { solana?: { isPhantom?: boolean } }; ethereum?: { isMetaMask?: boolean; isPhantom?: boolean } }
  return !!w.phantom?.solana?.isPhantom && !(w.ethereum?.isMetaMask && !w.ethereum.isPhantom)
}

let metaMaskConnect: Promise<SolanaClient> | null = null

/**
 * Starts MetaMask Connect once per page. It waits about a second for the extension and registers its own wallet
 * only when no MetaMask is in the page. Start it on load, not on click: a phone only follows the deep link to the
 * app while the tap that triggered it is still fresh.
 */
export function startMetaMaskConnect(): Promise<SolanaClient> {
  metaMaskConnect ??= createSolanaClient({
    dapp: { name: 'OnSight', url: window.location.origin },
    // Joining only signs a message, which works the same on any cluster; MetaMask mobile only offers mainnet.
    api: { supportedNetworks: { mainnet: 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' } },
    analytics: { enabled: false },
  })
  metaMaskConnect.catch(() => {
    metaMaskConnect = null
  })
  return metaMaskConnect
}

/** The MetaMask Connect wallet, for when the user taps sign up before it registered. Null if it failed to start. */
export async function metaMaskConnectWallet(): Promise<Wallet | null> {
  try {
    return (await startMetaMaskConnect()).getWallet()
  } catch {
    return null
  }
}

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

export function isPhantom(wallet: Wallet): boolean {
  return /phantom/i.test(wallet.name)
}

/** Solana-capable wallets in the page, MetaMask first. Updates when wallets register late. */
export function useSolanaWallets(): Wallet[] {
  const [wallets, setWallets] = useState<Wallet[]>(() => listWallets())
  useEffect(() => {
    startMetaMaskConnect().catch(() => {})
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
  if (!account) throw new Error(`Choose a Solana account in ${wallet.name} to continue.`)
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

/**
 * Asks the wallet to sign `text` (costs nothing). Right after connect this makes a wallet that remembered the site
 * (MetaMask returns the account without a prompt, even while locked) open and unlock now, not at the first transaction.
 */
export async function signText({ wallet, account }: Connection, text: string): Promise<void> {
  const { signMessage } = (wallet.features as SolanaSignMessageFeature)[SolanaSignMessage]
  await signMessage({ account, message: new TextEncoder().encode(text) })
}

/**
 * True when a MetaMask call failed because the wallet isn't usable right now. Seen when MetaMask locked
 * itself after connecting: its keyrings are unloaded, so signing fails with "KeyringController - Keyring not
 * found." instead of asking to unlock. The connection itself is fine; unlocking and retrying works.
 */
export function isLockedWallet(err: unknown): boolean {
  return /keyring not found|no keyring found/i.test((err as Error | null)?.message ?? '')
}

/** True when the user closed or rejected the wallet prompt. */
export function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null
  return e?.code === 4001 || /reject|denied|cancel/i.test(e?.message ?? '')
}

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address
}
