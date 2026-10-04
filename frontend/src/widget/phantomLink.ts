// Phantom on phones without Phantom in the page: the browser asks the Phantom app to connect or sign through
// Phantom's deep links (https://docs.phantom.com/phantom-deeplinks), and the app sends the user back here with
// the answer encrypted in the URL. The user stays in their own browser; the app only opens to approve.
//
// Every request leaves the page, so whatever the widget needs afterwards lives in localStorage (not
// sessionStorage: the app may hand the answer to a new tab). The request kind rides along in the return URL.
import nacl from 'tweetnacl'
import bs58 from 'bs58'

const BASE = 'https://phantom.app/ul/v1'
const STORE = 'onsight.phantom'
const PENDING = 'onsight.phantom.pending'
/** Our marker in the return URL; Phantom appends its own parameters after it. */
const MARK = 'onsight_phantom'
const RETURN_PARAMS = [MARK, 'phantom_encryption_public_key', 'nonce', 'data', 'errorCode', 'errorMessage']

/** A Phantom wallet reached through deep links: the user's address plus the session Phantom issued for it. */
export interface PhantomLink {
  link: 'phantom'
  address: string
}

interface Stored {
  /** Our X25519 secret key for this origin's Phantom session (base58). */
  secret: string
  phantomKey?: string
  session?: string
  address?: string
}

/** What the widget saved before leaving to sign, so it can finish the join when the user comes back. */
export interface PendingJoin {
  eventId: string
  signedAt: string
  consentVersion: string
  image: string
  /** Indexes into the event's oracles when retrying only some of them, and the ones that already accepted. */
  targets?: number[]
  accepted?: number[]
}

export type PhantomReturn =
  | { kind: 'connect'; link: PhantomLink }
  | { kind: 'sign'; link: PhantomLink; signature: string; pending: PendingJoin }
  | { kind: 'error'; step: 'connect' | 'sign'; message: string; rejected: boolean; pending: PendingJoin | null }

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or a full store: the request still goes out, the answer just can't be finished here.
  }
}

/** The Phantom session from an earlier connect on this site, if any. Phantom sessions don't expire. */
export function storedPhantomLink(): PhantomLink | null {
  const s = read<Stored>(STORE)
  return s?.address && s.session ? { link: 'phantom', address: s.address } : null
}

function returnUrl(kind: 'connect' | 'sign'): string {
  const url = new URL(window.location.href)
  for (const p of RETURN_PARAMS) url.searchParams.delete(p)
  url.searchParams.set(MARK, kind)
  return url.toString()
}

function sharedKey(s: Stored): Uint8Array {
  return nacl.box.before(bs58.decode(s.phantomKey!), bs58.decode(s.secret))
}

/** Opens Phantom to connect. The page unloads; the answer comes back through takePhantomReturn. */
export function connectPhantom() {
  const keys = nacl.box.keyPair()
  write(STORE, { secret: bs58.encode(keys.secretKey) } satisfies Stored)
  const q = new URLSearchParams({
    app_url: window.location.origin,
    dapp_encryption_public_key: bs58.encode(keys.publicKey),
    redirect_link: returnUrl('connect'),
    cluster: 'devnet',
  })
  window.location.assign(`${BASE}/connect?${q}`)
}

/** Opens Phantom to sign `message` for `pending`. False when there is no session to sign with. */
export function signWithPhantom(message: string, pending: PendingJoin): boolean {
  const s = read<Stored>(STORE)
  if (!s?.session || !s.phantomKey) return false
  write(PENDING, pending)
  const nonce = nacl.randomBytes(24)
  const payload = JSON.stringify({ message: bs58.encode(new TextEncoder().encode(message)), session: s.session, display: 'utf8' })
  const q = new URLSearchParams({
    dapp_encryption_public_key: bs58.encode(nacl.box.keyPair.fromSecretKey(bs58.decode(s.secret)).publicKey),
    nonce: bs58.encode(nonce),
    redirect_link: returnUrl('sign'),
    payload: bs58.encode(nacl.box.after(new TextEncoder().encode(payload), nonce, sharedKey(s))),
  })
  window.location.assign(`${BASE}/signMessage?${q}`)
  return true
}

/** Forgets the session, e.g. after Phantom refused it. */
export function forgetPhantom() {
  write(STORE, null)
  write(PENDING, null)
}

let taken: PhantomReturn | null | undefined

/**
 * Phantom's answer from the URL after the app sent the user back, removed from the address bar on first call.
 * Null when this page load is not a return from Phantom.
 */
export function takePhantomReturn(): PhantomReturn | null {
  taken ??= readReturn()
  return taken
}

function readReturn(): PhantomReturn | null {
  const params = new URLSearchParams(window.location.search)
  const kind = params.get(MARK)
  if (kind !== 'connect' && kind !== 'sign') return null
  const url = new URL(window.location.href)
  for (const p of RETURN_PARAMS) url.searchParams.delete(p)
  window.history.replaceState(window.history.state, '', url)

  const pending = kind === 'sign' ? read<PendingJoin>(PENDING) : null
  write(PENDING, null)
  const errorCode = params.get('errorCode')
  if (errorCode) {
    const rejected = errorCode === '4001'
    return { kind: 'error', step: kind, rejected, pending, message: params.get('errorMessage') || `Phantom error ${errorCode}` }
  }

  const fail = (message: string): PhantomReturn => ({ kind: 'error', step: kind, rejected: false, pending, message })
  const s = read<Stored>(STORE)
  const nonce = params.get('nonce')
  const data = params.get('data')
  if (!s || !nonce || !data) return fail('Phantom sent back an incomplete answer. Try again.')
  if (kind === 'connect') {
    const phantomKey = params.get('phantom_encryption_public_key')
    if (!phantomKey) return fail('Phantom sent back an incomplete answer. Try again.')
    s.phantomKey = phantomKey
  }
  const opened = nacl.box.open.after(bs58.decode(data), bs58.decode(nonce), sharedKey(s))
  if (!opened) return fail('Could not read Phantom’s answer. Try again.')
  const body = JSON.parse(new TextDecoder().decode(opened)) as { public_key?: string; session?: string; signature?: string }

  if (kind === 'connect') {
    if (!body.public_key || !body.session) return fail('Phantom did not share an account. Try again.')
    write(STORE, { ...s, address: body.public_key, session: body.session } satisfies Stored)
    return { kind: 'connect', link: { link: 'phantom', address: body.public_key } }
  }
  if (!body.signature || !s.address) return fail('Phantom did not return a signature. Try again.')
  if (!pending) return fail('This browser lost the photo while Phantom was open. Take it again.')
  return { kind: 'sign', link: { link: 'phantom', address: s.address }, signature: body.signature, pending }
}
