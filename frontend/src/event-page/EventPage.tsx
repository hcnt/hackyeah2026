import { useEffect, useState, type ReactNode } from 'react'
import RegistrationCard from './RegistrationCard'
import type { EventData, Social } from './eventData'
import {
  ChevronIcon,
  InstagramIcon,
  LinkedInIcon,
  MailIcon,
  MarkIcon,
  PinIcon,
  TranslateIcon,
  Wordmark,
  XIcon,
} from './icons'
import './event-page.css'

type Props = {
  event: EventData
  /** Replaces the whole registration card. Defaults to the Luma-style card. */
  registration?: ReactNode
}

const SOCIAL_ICON = { x: XIcon, linkedin: LinkedInIcon, instagram: InstagramIcon }

function Socials({ items, variant }: { items: Social[]; variant: 'under' | 'side' }) {
  return (
    <div className={`ep-socials ${variant}`}>
      {items.map((s) => {
        const Icon = SOCIAL_ICON[s.kind]
        return (
          <a key={s.kind + s.href} href={s.href} target="_blank" rel="noreferrer" aria-label={s.kind}>
            <Icon />
          </a>
        )
      })}
    </div>
  )
}

function formatNow(d: Date) {
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const offset = -d.getTimezoneOffset() / 60
  return `${time} GMT${offset >= 0 ? '+' : ''}${offset}`
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])
  return formatNow(now)
}

function Nav() {
  const now = useClock()
  return (
    <nav className="ep-nav">
      <a className="ep-nav-logo" href="/">
        <div className="wordmark">
          <Wordmark />
        </div>
      </a>
      <div className="ep-nav-right-wrap">
        <div className="ep-nav-right">
          <div className="ep-nav-time">{now}</div>
          <div className="ep-nav-link">
            <a href="#">Discover Events</a>
          </div>
          <div style={{ margin: '-4px 0' }}>
            <button type="button" className="ep-btn ep-btn-light nav">
              <div className="label">Sign In</div>
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}

function Cover({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="ep-cover">
      <div className="ep-cover-glow">
        <img src={src} alt="" aria-hidden />
      </div>
      <div className="ep-cover-frame">
        <div className="ep-cover-inner">
          <img src={src} alt={alt} />
        </div>
      </div>
    </div>
  )
}

function Presenter({ presenter }: { presenter: EventData['presenter'] }) {
  return (
    <div className="ep-presented">
      <div className="ep-presented-row">
        <img src={presenter.avatarUrl} alt="" />
        <div className="ep-presented-text">
          <div className="ep-presented-label">Presented by</div>
          <a href={presenter.href} className="ep-presented-name">
            <div className="ellipsis">{presenter.name}</div>
            <ChevronIcon />
          </a>
        </div>
        <button type="button" className="ep-btn ep-btn-light">
          <div className="label">Follow</div>
        </button>
      </div>
      <Socials items={presenter.socials} variant="under" />
    </div>
  )
}

function SidebarDetails({ event }: { event: EventData }) {
  return (
    <>
      <Presenter presenter={event.presenter} />

      <div>
        <div className="ep-section-head">Hosted By</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {event.hosts.map((h) => (
            <div key={h.name} className="ep-host">
              <a href={h.href} className="ep-host-link">
                <div className="ep-avatar" style={{ backgroundImage: `url("${h.avatarUrl}")` }} />
                <div className="ellipsis">{h.name}</div>
              </a>
              <Socials items={h.socials} variant="side" />
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="ep-section-head">{event.going.count} Going</div>
        <button type="button" className="ep-going">
          <div className="ep-going-avatars">
            {event.going.avatarUrls.map((url) => (
              <div key={url} className="ep-avatar" style={{ backgroundImage: `url("${url}")` }} />
            ))}
          </div>
          <div className="ep-going-names">{event.going.summary}</div>
        </button>
      </div>

      <div className="ep-left-actions">
        <button type="button" className="ep-btn ep-btn-link">
          <div className="label">Contact the Host</div>
        </button>
        <button type="button" className="ep-btn ep-btn-link">
          <div className="label">Report Event</div>
        </button>
      </div>
    </>
  )
}

function TitleBlock({ event }: { event: EventData }) {
  const { featured, date, location } = event
  return (
    <div>
      <div className="ep-title-wrap">
        <div style={{ minWidth: 0 }}>
          <a href={featured.href}>
            <div className="ep-featured">
              <div className="ep-avatar" style={{ backgroundImage: `url("${featured.avatarUrl}")` }} />
              <div className="ep-featured-text">
                {featured.label} <b>{featured.name}</b>
              </div>
              <div className="ep-featured-chevron">
                <ChevronIcon />
              </div>
            </div>
          </a>
          <h1 className="ep-title">{event.title}</h1>
        </div>
      </div>

      <div className="ep-meta">
        <div className="ep-meta-hover">
          <div className="ep-meta-row">
            <div className="ep-meta-icon">
              <div className="ep-cal">
                <div className="ep-cal-month">{date.month}</div>
                <div className="ep-cal-day">{date.day}</div>
              </div>
            </div>
            <div className="ep-meta-text">
              <div className="ep-meta-title ellipsis">{date.title}</div>
              <div className="ep-meta-sub ellipsis">{date.subtitle}</div>
            </div>
          </div>
        </div>
        <div className="ep-meta-row">
          <div className="ep-meta-icon">
            <PinIcon />
          </div>
          <div className="ep-meta-text">
            <div className="ep-meta-title ellipsis">{location.title}</div>
            <div className="ep-meta-sub ellipsis">{location.subtitle}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Footer() {
  return (
    <footer className="ep-footer">
      <div className="ep-footer-inner">
        <div className="ep-footer-left">
          <a href="/" className="ep-footer-mark" aria-label="Home">
            <MarkIcon />
          </a>
          <div className="ep-footer-links">
            <a href="#">Discover</a>
            <a href="#">Pricing</a>
            <a href="#">Help</a>
          </div>
        </div>
        <div className="ep-footer-right">
          <a className="icon" href="#" aria-label="Instagram">
            <InstagramIcon />
          </a>
          <a className="icon" href="#" aria-label="X">
            <XIcon />
          </a>
          <a className="icon" href="#" aria-label="Email">
            <MailIcon />
          </a>
          <a className="ep-footer-app" href="#">
            Get the App
          </a>
        </div>
      </div>
    </footer>
  )
}

export default function EventPage({ event, registration }: Props) {
  const { location } = event
  const mapQuery = `${location.lat},${location.lng}`

  return (
    <div className="ep">
      <Nav />
      <div className="ep-page">
        <div className="ep-bg" />
        <div style={{ position: 'relative' }}>
          <div className="ep-container">
            <div className="ep-left">
              <Cover src={event.coverUrl} alt={`Cover Image for ${event.title}`} />
              <div className="ep-left-desktop">
                <SidebarDetails event={event} />
              </div>
            </div>

            <div className="ep-right">
              <TitleBlock event={event} />

              {registration ?? <RegistrationCard />}

              <div className="ep-about">
                <div className="ep-section-head">
                  <span>About Event</span>
                  <button type="button" className="ep-translate" aria-label="Translate">
                    <TranslateIcon />
                  </button>
                </div>
                <div className="ep-content">{event.about}</div>
              </div>

              <div className="mobile-only" style={{ flexDirection: 'column', gap: 24 }}>
                <SidebarDetails event={event} />
              </div>

              <div>
                <div className="ep-section-head">Location</div>
                <div className="ep-location-info">
                  <div>{location.note}</div>
                  <div className="ep-location-sub">{location.subtitle}</div>
                </div>
                <div className="ep-map">
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <iframe
                      title="Map"
                      loading="lazy"
                      src={`https://maps.google.com/maps?q=${encodeURIComponent(mapQuery)}&z=13&output=embed`}
                    />
                  </a>
                </div>
              </div>
            </div>
          </div>
          <Footer />
        </div>
      </div>
    </div>
  )
}
