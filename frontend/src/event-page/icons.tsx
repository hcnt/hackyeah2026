import type { SVGProps } from 'react'
import { ChevronRight, Languages, Mail, MapPin, Sparkle, UserRoundCheck } from 'lucide-react'

type P = SVGProps<SVGSVGElement>

export const ChevronIcon = () => <ChevronRight size={16} strokeWidth={2} />
export const PinIcon = () => <MapPin size={20} strokeWidth={1.75} />
export const TranslateIcon = () => <Languages size={15} strokeWidth={2} />
export const MailIcon = () => <Mail size={16} strokeWidth={2} />
export const ApprovalIcon = () => <UserRoundCheck size={16} strokeWidth={2} />
export const MarkIcon = () => <Sparkle size={16} strokeWidth={2} />

export const XIcon = (p: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77zm-1.08 16.17h1.7L7.4 4.73H5.58z" />
  </svg>
)

export const LinkedInIcon = (p: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m3.5 7H5.25v8.5H7.5zM6.38 5.75a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6M18.75 13.4c0-2.3-1.22-3.6-3.05-3.6-1.15 0-1.9.6-2.2 1.15V10H11.3v8.5h2.25v-4.3c0-1.05.45-1.85 1.45-1.85.95 0 1.5.7 1.5 1.85v4.3h2.25z" />
  </svg>
)

export const InstagramIcon = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17.5" cy="6.5" r="0.5" fill="currentColor" />
  </svg>
)

/* Neutral placeholder — swap for our own wordmark. Same 44×16 box as the reference. */
export const Wordmark = () => (
  <svg width="44" height="16" viewBox="0 0 44 16" fill="currentColor" aria-label="Home">
    <text x="0" y="13" fontSize="14" fontWeight="700" fontFamily="inherit" letterSpacing="-0.4">
      event
    </text>
  </svg>
)
