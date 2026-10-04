// Shell of the OnSight events app: Luma-style nav, hash routes and the wallet sign-in gate.
//   #/             events overview
//   #/new          new event
//   #/events/<id>  event dashboard
import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, FlaskConical, LogOut, Radio, Wallet } from 'lucide-react'
import { shortAddress } from '../widget/wallet'
import { AccountProvider, useAccount, useBackend } from './account'
import type { Backend } from './backend'
import { sol } from './model'
import { Overview } from './Overview'
import { Setup } from './Setup'
import { Dashboard } from './Dashboard'
import { Avatar, Spinner, ToastProvider, useCopy, useNow, WalletLogo } from './ui'
import './dapp.css'

type Route = { name: 'overview' } | { name: 'new' } | { name: 'event'; id: string }

function parseRoute(): Route {
  const path = window.location.hash.replace(/^#/, '') || '/'
  const m = /^\/events\/([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(path)
  if (m) return { name: 'event', id: m[1] }
  if (path.startsWith('/new')) return { name: 'new' }
  return { name: 'overview' }
}

export function navigate(path: string) {
  window.location.hash = path
  window.scrollTo({ top: 0 })
}

function useRoute(): Route {
  const [route, setRoute] = useState(parseRoute)
  useEffect(() => {
    const onChange = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function App({ backend }: { backend: Backend }) {
  return (
    <AccountProvider backend={backend}>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AccountProvider>
  )
}

function Shell() {
  const route = useRoute()
  const account = useAccount()
  const backend = useBackend()
  const needsWallet = route.name === 'overview'

  return (
    <div className="os">
      <div className="os-wash" aria-hidden />
      <div className="os-main">
        <Nav />
        {needsWallet && !account.address ? (
          account.restoring ? (
            <div className="os-signin">
              <Spinner />
            </div>
          ) : (
            <SignIn />
          )
        ) : route.name === 'new' ? (
          <Setup />
        ) : route.name === 'event' ? (
          <Dashboard key={route.id} id={route.id} />
        ) : (
          <Overview />
        )}
        <footer className="os-footer">
          <span>OnSight · Seen on site, paid on-chain.</span>
          <span>
            OnSight keeps no data: this page reads Solana and the event’s oracles straight from your browser.{' '}
            <a href="https://github.com/hcnt/hackyeah2026" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
              Host it yourself
            </a>
            .
            {backend.mode === 'demo' && (
              <>
                {' '}
                <a href={liveUrl()}>Open the live devnet app →</a>
              </>
            )}
          </span>
        </footer>
      </div>
    </div>
  )
}

function liveUrl() {
  return `${import.meta.env.BASE_URL}events.html${window.location.hash}`
}

function Clock() {
  const backend = useBackend()
  const now = useNow(backend.now, 15_000)
  const d = new Date(now)
  const offset = -d.getTimezoneOffset() / 60
  return (
    <span className="os-clock">
      {d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} GMT{offset >= 0 ? '+' : ''}
      {offset}
    </span>
  )
}

function Nav() {
  const account = useAccount()
  const backend = useBackend()
  return (
    <nav className="os-nav">
      <a className="os-brand" href="#/">
        <span className="os-brand-mark">O</span>
        OnSight
      </a>
      <div className="os-navright">
        <Clock />
        <span className="os-net" data-demo={backend.mode === 'demo'} title={backend.programId ? `Program ${backend.programId}` : undefined}>
          {backend.network}
        </span>
        {account.address ? (
          <WalletMenu />
        ) : (
          <a className="os-btn os-btn--secondary os-btn--sm" href="#/">
            <Wallet size={14} /> Sign in
          </a>
        )}
      </div>
    </nav>
  )
}

function WalletMenu() {
  const account = useAccount()
  const backend = useBackend()
  const copy = useCopy()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const address = account.address!
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="os-walletchip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Avatar address={address} />
        <span className="num">{account.balance === null ? '…' : `${sol(account.balance, 2)} SOL`}</span>
      </button>
      {open && (
        <div className="os-menu" role="menu">
          <div className="os-menu-head">
            <strong className="mono">{shortAddress(address)}</strong>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {account.walletName} · {backend.network}
            </span>
          </div>
          <button type="button" className="os-menu-item" onClick={() => (copy(address, 'Address'), setOpen(false))}>
            <Copy size={15} /> Copy address
          </button>
          <a className="os-menu-item" href={backend.addressUrl(address)} target="_blank" rel="noreferrer">
            <ExternalLink size={15} /> View in explorer
          </a>
          {backend.mode === 'live' && /devnet/i.test(backend.network) && (
            <a className="os-menu-item" href="https://faucet.solana.com" target="_blank" rel="noreferrer">
              <Radio size={15} /> Get devnet SOL
            </a>
          )}
          {backend.mode === 'demo' && (
            <a className="os-menu-item" href={liveUrl()}>
              <FlaskConical size={15} /> Switch to live devnet
            </a>
          )}
          <button type="button" className="os-menu-item" data-tone="danger" onClick={() => (setOpen(false), void account.signOut())}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export function WalletButtons() {
  const account = useAccount()
  if (account.wallets.length === 0) {
    return (
      <div className="os-walletlist">
        <div className="os-notice">
          <strong>No Solana wallet in this browser</strong>
          <div>
            Install MetaMask (with Solana turned on) or Phantom, then reload.{' '}
            <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
              Get MetaMask
            </a>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="os-walletlist">
      {account.wallets.map((w) => (
        <button key={w.name} type="button" className="os-walletbtn" disabled={!!account.connecting} onClick={() => void account.signIn(w.name)}>
          <WalletLogo name={w.name} icon={w.icon} />
          <span>{w.name}</span>
          {account.connecting === w.name && <Spinner />}
        </button>
      ))}
      {account.error && <p className="os-error">{account.error}</p>}
    </div>
  )
}

function SignIn() {
  const backend = useBackend()
  return (
    <div className="os-signin">
      <div className="os-card os-signin-card">
        <div className="os-signin-icon">
          <span className="os-brand-mark" style={{ width: 32, height: 32, fontSize: 18 }}>
            O
          </span>
        </div>
        <h1>Welcome to OnSight</h1>
        <p>
          Sign in with your Solana wallet to create attendance rewards and see your events. Signing in costs nothing and
          sends no transaction.
        </p>
        <WalletButtons />
        {backend.mode === 'demo' && <p style={{ marginTop: 18, fontSize: 12.5 }}>Demo mode: nothing here touches a real wallet.</p>}
      </div>
    </div>
  )
}
