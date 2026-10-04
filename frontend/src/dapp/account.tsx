// The organizer's wallet session. Live: a Wallet Standard wallet (MetaMask, Phantom, …) signed in with a free message;
// the choice is remembered and reconnected silently on the next visit. Demo: a pretend wallet with 120 SOL.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Wallet } from '@wallet-standard/base'
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features'
import { nowIso } from '../widget/api'
import { ChainError } from '../widget/chain'
import { connect, disconnect, isLockedWallet, isUserRejection, signText, useSolanaWallets, type Connection } from '../widget/wallet'
import { DEMO_WALLET, type Backend } from './backend'

export interface WalletOption {
  name: string
  icon: string | null
}

export interface Account {
  address: string | null
  walletName: string | null
  conn: Connection | null
  balance: bigint | null
  wallets: WalletOption[]
  /** Name of the wallet being connected, while it is. */
  connecting: string | null
  /** True until the silent reconnect of a remembered wallet has finished. */
  restoring: boolean
  error: string | null
  signIn(name: string): Promise<void>
  signOut(): Promise<void>
  refreshBalance(): void
}

const AccountContext = createContext<Account | null>(null)
const BackendContext = createContext<Backend | null>(null)

export function useAccount(): Account {
  const a = useContext(AccountContext)
  if (!a) throw new Error('useAccount outside AccountProvider')
  return a
}

export function useBackend(): Backend {
  const b = useContext(BackendContext)
  if (!b) throw new Error('useBackend outside AccountProvider')
  return b
}

export function walletErrorText(err: unknown): string {
  if (isUserRejection(err)) return 'You closed the wallet prompt. Nothing was sent.'
  if (isLockedWallet(err)) return 'Your wallet is locked. Unlock it and try again.'
  if (err instanceof ChainError) return err.message
  return (err as Error | null)?.message || 'The wallet request failed.'
}

const REMEMBER_KEY = 'onsight:wallet'

function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY)
  } catch {
    return null
  }
}

function remember(name: string | null) {
  try {
    if (name) localStorage.setItem(REMEMBER_KEY, name)
    else localStorage.removeItem(REMEMBER_KEY)
  } catch {
    // storage blocked: sign in again next time
  }
}

/** Reconnects a wallet that already trusts this site, without a prompt; null when it would need one. */
async function connectSilently(wallet: Wallet): Promise<Connection | null> {
  const { connect: run } = (wallet.features as StandardConnectFeature)[StandardConnect]
  const { accounts } = await run({ silent: true })
  const account = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0]
  return account ? { wallet, account } : null
}

export function AccountProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  const value = backend.mode === 'demo' ? <DemoAccount backend={backend}>{children}</DemoAccount> : <LiveAccount backend={backend}>{children}</LiveAccount>
  return <BackendContext.Provider value={backend}>{value}</BackendContext.Provider>
}

function useBalance(backend: Backend, address: string | null) {
  const [balance, setBalance] = useState<bigint | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!address) return
    let cancelled = false
    backend.balance(address).then(
      (b) => !cancelled && setBalance(b),
      () => !cancelled && setBalance(null),
    )
    return () => {
      cancelled = true
    }
  }, [backend, address, tick])
  return [address ? balance : null, useCallback(() => setTick((n) => n + 1), [])] as const
}

function LiveAccount({ backend, children }: { backend: Backend; children: ReactNode }) {
  const found = useSolanaWallets()
  const [conn, setConn] = useState<Connection | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(() => remembered() !== null)
  const [balance, refreshBalance] = useBalance(backend, conn?.account.address ?? null)

  // Wallets register a moment after load; try the remembered one silently once it shows up (or give up after 1.5 s).
  useEffect(() => {
    if (!restoring) return
    const name = remembered()
    const wallet = found.find((w) => w.name === name)
    if (!wallet) {
      const id = window.setTimeout(() => setRestoring(false), 1500)
      return () => window.clearTimeout(id)
    }
    let cancelled = false
    connectSilently(wallet)
      .then((c) => !cancelled && c && setConn(c))
      .catch(() => {})
      .finally(() => !cancelled && setRestoring(false))
    return () => {
      cancelled = true
    }
  }, [found, restoring])

  const signIn = useCallback(
    async (name: string) => {
      const wallet = found.find((w) => w.name === name)
      if (!wallet) return
      setError(null)
      setConnecting(name)
      let c: Connection | null = null
      try {
        c = await connect(wallet)
        // A free signature: makes the wallet open (and unlock) now rather than at the first transaction.
        await signText(
          c,
          `Sign in to OnSight as an event organiser.\n\nWallet: ${c.account.address}\nTime: ${nowIso()}\n\nThis costs nothing and sends no transaction.`,
        )
        setConn(c)
        remember(name)
      } catch (err) {
        if (c) await disconnect(c)
        setError(walletErrorText(err))
      } finally {
        setConnecting(null)
      }
    },
    [found],
  )

  const signOut = useCallback(async () => {
    if (conn) await disconnect(conn)
    setConn(null)
    remember(null)
  }, [conn])

  const value = useMemo<Account>(
    () => ({
      address: conn?.account.address ?? null,
      walletName: conn?.wallet.name ?? null,
      conn,
      balance,
      wallets: found.map((w) => ({ name: w.name, icon: w.icon ?? null })),
      connecting,
      restoring,
      error,
      signIn,
      signOut,
      refreshBalance,
    }),
    [conn, balance, found, connecting, restoring, error, signIn, signOut, refreshBalance],
  )
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
}

const DEMO_WALLETS: WalletOption[] = [
  { name: 'Phantom', icon: null },
  { name: 'MetaMask', icon: null },
]

function DemoAccount({ backend, children }: { backend: Backend; children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(true)
  const [connecting, setConnecting] = useState<string | null>(null)
  const address = signedIn ? DEMO_WALLET : null
  const [balance, refreshBalance] = useBalance(backend, address)

  const value = useMemo<Account>(
    () => ({
      address,
      walletName: signedIn ? 'Phantom' : null,
      conn: null,
      balance,
      wallets: DEMO_WALLETS,
      connecting,
      restoring: false,
      error: null,
      async signIn(name) {
        setConnecting(name)
        await new Promise((r) => setTimeout(r, 700))
        setConnecting(null)
        setSignedIn(true)
      },
      async signOut() {
        setSignedIn(false)
      },
      refreshBalance,
    }),
    [address, signedIn, balance, connecting, refreshBalance],
  )
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
}
