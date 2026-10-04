// The cog: an event's frozen terms, its links, and withdrawing what's left (before the start or after the end).
import { useState } from 'react'
import { Copy, ExternalLink, UserRound } from 'lucide-react'
import { shortAddress } from '../widget/wallet'
import { useAccount, useBackend, walletErrorText } from './account'
import { fmtDate, fmtTime, sol, statusOf, withdrawable, type EventRow } from './model'
import { Modal, Notice, Spinner, StatusPill, useCopy, useNow, useToast } from './ui'

/** Links that keep ?rpc= and ?program=, so the attendee page reads the same deployment. */
export function eventLinks(id: string) {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}`
  const q = new URLSearchParams(window.location.search)
  q.set('event', id)
  return { attendee: `${base}?${q}` }
}

export function EventSettings({ event, onClose, onChanged }: { event: EventRow; onClose: () => void; onChanged: (row: EventRow) => void }) {
  const backend = useBackend()
  const account = useAccount()
  const copy = useCopy()
  const toast = useToast()
  const now = useNow(backend.now)
  const status = statusOf(event, now)
  const links = eventLinks(event.id)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isOrganizer = account.address === event.organizer
  const left = withdrawable(event)
  const canWithdraw = !event.withdrawn && status !== 'ongoing' && isOrganizer

  async function withdraw() {
    setError(null)
    setStep('Preparing the transaction…')
    try {
      await backend.withdraw(account.conn, event, setStep)
      toast(status === 'planned' ? 'Event cancelled, deposit returned' : 'Remaining deposit withdrawn')
      account.refreshBalance()
      onChanged({ ...event, withdrawn: true, returnedLamports: left })
    } catch (err) {
      setError(walletErrorText(err))
    } finally {
      setStep(null)
    }
  }

  return (
    <Modal title={event.name} subtitle={<StatusPill status={status} />} onClose={onClose}>
      <dl className="os-kv">
        {event.venue && (
          <>
            <dt>Venue</dt>
            <dd>{event.venue}</dd>
          </>
        )}
        <dt>Starts</dt>
        <dd>
          {fmtDate(event.start)}, {fmtTime(event.start)}
        </dd>
        <dt>Ends</dt>
        <dd>
          {fmtDate(event.end)}, {fmtTime(event.end)}
        </dd>
        <dt>Reward per attendee</dt>
        <dd>{sol(event.rewardLamports)} SOL</dd>
        <dt>Entrants</dt>
        <dd>
          {event.paidCount} paid of {event.maxPaid}
        </dd>
        <dt>Oracle fee</dt>
        <dd>{sol(event.feeLamports)} SOL per paid attendee</dd>
        <dt>Payout rule</dt>
        <dd>
          {event.threshold} of {event.oracles.length} oracles agree
        </dd>
        <dt>Event id</dt>
        <dd>
          <button type="button" className="os-btn os-btn--ghost os-btn--sm" onClick={() => copy(event.id, 'Event id')}>
            <span className="mono">{shortAddress(event.id)}</span> <Copy size={13} />
          </button>
        </dd>
      </dl>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 20 }}>
        <a className="os-btn os-btn--secondary os-btn--sm" href={links.attendee} target="_blank" rel="noreferrer">
          <UserRound size={14} /> Attendee page
        </a>
        <a className="os-btn os-btn--secondary os-btn--sm" href={backend.addressUrl(event.id)} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> Explorer
        </a>
      </div>

      <div style={{ display: 'grid', gap: 10, marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--line-soft)' }}>
        <p className="muted" style={{ fontSize: 12.5 }}>
          Terms are frozen on chain once the event exists. To change them, cancel before the start and create a new reward.
        </p>
        {event.withdrawn ? (
          <Notice tone="ok" title="Deposit withdrawn">
            {event.returnedLamports !== null && `${sol(event.returnedLamports)} SOL went back to the organiser: unpaid rewards and oracle fees plus the account deposit.`}
          </Notice>
        ) : (
          <>
            <button
              type="button"
              className={status === 'planned' ? 'os-btn os-btn--danger os-btn--block' : 'os-btn os-btn--block'}
              disabled={!canWithdraw || !!step}
              onClick={() => void withdraw()}
            >
              {step ? (
                <>
                  <Spinner /> {step}
                </>
              ) : status === 'planned' ? (
                `Cancel event and withdraw ${sol(left)} SOL`
              ) : (
                `Withdraw ${sol(left)} SOL`
              )}
            </button>
            <p className="os-actions-hint">
              {!isOrganizer
                ? account.address
                  ? 'Only the organiser’s wallet can withdraw.'
                  : 'Sign in with the organiser’s wallet to withdraw.'
                : status === 'ongoing'
                  ? `Withdrawing unlocks when the event ends (${fmtTime(event.end)}).`
                  : 'Unpaid rewards, unused oracle fees and the account rent go back to your wallet.'}
            </p>
          </>
        )}
        {error && <Notice tone="bad" title="Withdraw failed">{error}</Notice>}
      </div>
    </Modal>
  )
}
