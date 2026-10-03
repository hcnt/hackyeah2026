/*
 * Registration card — the one piece of the event page meant to be swapped out.
 *
 * It's fully self-contained (own stylesheet, no dependency on the page's CSS),
 * and EventPage only renders whatever node it's given in the `registration` slot:
 *
 *   <EventPage event={event} registration={<OurRegistrationWidget />} />
 *
 * A replacement widget only needs to fill the column width (566px on desktop).
 * Use <RegistrationCardShell> to keep the Luma-style frame + "Registration"
 * header around your own content.
 */
import type { ReactNode } from 'react'
import { ApprovalIcon } from './icons'
import './registration-card.css'

type ShellProps = {
  title?: string
  children: ReactNode
}

export function RegistrationCardShell({ title = 'Registration', children }: ShellProps) {
  return (
    <div className="rc-card">
      <div className="rc-header">{title}</div>
      <div className="rc-inner">{children}</div>
    </div>
  )
}

type Props = {
  approvalTitle?: string
  approvalText?: string
  message?: string
  ctaLabel?: string
  onRegister?: () => void
}

export default function RegistrationCard({
  approvalTitle = 'Approval Required',
  approvalText = 'Your registration is subject to host approval.',
  message = 'Welcome! To join the event, please register below.',
  ctaLabel = 'Request to Join',
  onRegister,
}: Props) {
  return (
    <RegistrationCardShell>
      <div className="rc-content">
        <div className="rc-approval">
          <div className="rc-info-row">
            <div className="rc-info-icon">
              <ApprovalIcon />
            </div>
            <div>
              <div className="rc-info-title">{approvalTitle}</div>
              <div className="rc-info-sub">{approvalText}</div>
            </div>
          </div>
        </div>
        <div>{message}</div>
        <div className="rc-cta">
          <button type="button" className="rc-button" onClick={onRegister}>
            <div className="rc-button-label">{ctaLabel}</div>
          </button>
        </div>
      </div>
    </RegistrationCardShell>
  )
}
