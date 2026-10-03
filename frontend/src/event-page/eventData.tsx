/*
 * Event data rendered by EventPage. Facts (title, dates, place, hosts, links)
 * mirror the reference event; the About body is our own copy laid out in the
 * same block structure (h1 / hr / p / h2) — replace it with the final text.
 */
import type { ReactNode } from 'react'

const IMG = 'https://images.lumacdn.com/cdn-cgi/image/format=auto,fit=cover,dpr=2,background=white,quality=75'
const avatar = (path: string) => `${IMG},anim=false,width=24,height=24/${path}`

const COLOSSEUM = 'https://colosseum.com/hackathon/'
const ARENA = 'https://arena.colosseum.org/'
const SOLANA = 'https://solana.com/'
const TELEGRAM = 'https://t.me/SolanaDevsPolska'
const DEMO_DAY = 'https://luma.com/stpldemoday'

export type Social = { kind: 'x' | 'linkedin' | 'instagram'; href: string }

export type EventData = {
  title: string
  coverUrl: string
  featured: { label: string; name: string; avatarUrl: string; href: string }
  presenter: { name: string; avatarUrl: string; href: string; socials: Social[] }
  hosts: { name: string; avatarUrl: string; href: string; socials: Social[] }[]
  going: { count: number; avatarUrls: string[]; summary: string }
  date: { month: string; day: string; title: string; subtitle: string }
  location: { title: string; subtitle: string; note: string; lat: number; lng: number }
  about: ReactNode
}

export const event: EventData = {
  title: 'SOLANA BUILD STATION WARSAW',
  coverUrl: `${IMG},width=400,height=400/uploads/fa/3b84178b-c2fd-4a7b-a5b2-1b89440c6e35.png`,
  featured: {
    label: 'Featured in',
    name: 'Superteam',
    avatarUrl: avatar('calendars/u2/a513f5d1-a5d1-41be-a955-4d8b4de42934'),
    href: '#',
  },
  presenter: {
    name: 'Superteam Poland',
    avatarUrl: `${IMG},anim=false,width=32,height=32/calendars/iv/5a0b99a3-5422-4d83-a68d-a208e82d8795.png`,
    href: '#',
    socials: [
      { kind: 'x', href: 'https://x.com/SuperteamPOL' },
      { kind: 'linkedin', href: 'https://linkedin.com/company/superteam-pl' },
    ],
  },
  hosts: [
    {
      name: 'Superteam Poland',
      avatarUrl: avatar('avatars/qu/4324a7f0-e764-44ea-88b0-e195ecca36a8'),
      href: '#',
      socials: [
        { kind: 'instagram', href: 'https://instagram.com/Superteam_Poland' },
        { kind: 'x', href: 'https://x.com/SuperteamPOL' },
      ],
    },
  ],
  going: {
    count: 22,
    avatarUrls: [
      avatar('uploads/xg/7f186beb-4df7-4e13-bbbb-03b8877ab92f.jpg'),
      avatar('uploads/iz/6090c60d-aac9-4282-95cd-a8ab71e5bd42.jpg'),
      'https://cdn.lu.ma/cdn-cgi/image/format=auto,fit=cover,dpr=2,anim=false,background=white,quality=75,width=24,height=24/avatars-default/avatar_8.png',
      avatar('avatars/oj/bfc5a8ec-069a-4e6e-865d-5ac6f2fd1a26.jpg'),
      avatar('uploads/2j/9abe62a7-38f8-4690-8408-509d37791cd9.jpg'),
      avatar('avatars/cj/b10f783d-6e92-4b93-970d-8f80c4c33014.jpg'),
    ],
    summary: 'Onur Usalan, Oleksandr Mykytchenko and 20 others',
  },
  date: {
    month: 'Oct',
    day: '6',
    title: 'Tuesday, October 6',
    subtitle: '12:00 PM - Oct 13, 10:00 PM',
  },
  location: {
    title: 'Register to See Address',
    subtitle: 'Warszawa, Województwo mazowieckie',
    note: 'Please register to see the exact location of this event.',
    lat: 52.21818942798449,
    lng: 21.013538461619014,
  },
  about: (
    <>
      <h1>SUPERTEAM POLAND BUILD STATION</h1>
      <hr />
      <p>
        <strong>
          Osiem dni budowania w Warszawie — od 6 do 13 października 2026 — dla zespołów z ekosystemu{' '}
          <a href={SOLANA}>Solana</a>.
        </strong>
      </p>
      <p>
        Przestrzeń stworzona z myślą o drużynach przygotowujących się do <a href={COLOSSEUM}>Colosseum Hackathon</a>.
      </p>
      <p>Spotkaj ludzi, rozwiń projekt i zamień prototyp w produkt gotowy na demo.</p>
      <h2>🚨 WAŻNE:</h2>
      <p>
        Wstęp wymaga konta w{' '}
        <strong>
          <a href={ARENA}>Colosseum</a>
        </strong>{' '}
        oraz rejestracji na hackathon.
      </p>
      <p>Wejście tylko dla uczestników Colosseum, członków STPL i prelegentów.</p>
      <p>
        <strong>Zgłoszenie:</strong> wyślij je przez kartę rejestracji na tej stronie.
      </p>
      <hr />
      <h1>
        <strong>Co Cię czeka?</strong>
      </h1>
      <p>
        💡 <strong>Mentoring</strong> - konsultacje z kodu, produktu i pitchu z mentorami z ekosystemu Solana.
      </p>
      <p>
        🤝 <strong>Networking</strong> - poznaj osoby do zespołu: devów, designerów i marketerów.
      </p>
      <p>
        🍽️ <strong>Strefa relaksu i jedzenie</strong> - zadbamy o to, żebyś mógł skupić się na budowaniu.
      </p>
      <p>
        🏆 <strong>Tracki i nagrody</strong> - zadania od partnerów, granty i wyróżnienia.
      </p>
      <p>
        🎤{' '}
        <strong>
          <a href={DEMO_DAY}>Demo Day</a>
        </strong>{' '}
        - prezentacje przed jury i społecznością, pula nagród $5,000.
      </p>
      <hr />
      <h1>
        <strong>Kiedy i gdzie:</strong>
      </h1>
      <p>
        📍 <strong>Miejsce</strong>: The Shire, Zebra Tower, 12 piętro
        <br />
        📅 <strong>Data</strong>: 6-13 października
        <br />⏰ <strong>Czas</strong>: otwarte 24/7, start 6.10 o 12:00 | Demo Day 13.10 o 18:00
        <br />
        📱 <strong>Telegram:</strong>{' '}
        <em>
          <a href={TELEGRAM}>Dołącz</a>
        </em>
      </p>
      <hr />
      <h1>
        <strong>Dlaczego warto?</strong>
      </h1>
      <p>Tydzień skupionej pracy, mentorów pod ręką i zespołów, które budują to samo co Ty.</p>
      <p>
        <strong>[ENG]</strong>
      </p>
      <h1>SUPERTEAM POLAND BUILD STATION</h1>
      <hr />
      <p>
        <strong>Eight days of building in Warsaw, October 6–13, 2026</strong>
      </p>
      <p>
        A space for teams getting ready for the{' '}
        <strong>
          <a href={COLOSSEUM}>Colosseum Hackathon</a>
        </strong>{' '}
        on{' '}
        <strong>
          <a href={SOLANA}>Solana</a>.
        </strong>
      </p>
      <p>Meet people, grow your project, and turn a prototype into a demo-ready product.</p>
      <h2>🚨 IMPORTANT:</h2>
      <p>
        Entry requires a{' '}
        <strong>
          <a href={ARENA}>Colosseum Account</a>
        </strong>{' '}
        and a hackathon registration.
      </p>
      <p>Open to Colosseum participants, STPL members, and speakers only.</p>
      <p>Apply through the registration card on this page.</p>
      <hr />
      <h1>
        <strong>What to expect:</strong>
      </h1>
      <p>
        💡 <strong>Mentoring</strong> - code, product, and pitch sessions with Solana ecosystem mentors.
      </p>
      <p>
        🤝 <strong>Networking</strong> - meet developers, designers, and marketers for your team.
      </p>
      <p>
        🍽️ <strong>Relax zone and food</strong> - we take care of the basics so you can keep building.
      </p>
      <p>
        🏆 <strong>Tracks and prizes</strong> - partner challenges, grants, and awards.
      </p>
      <p>
        🎤{' '}
        <strong>
          <a href={DEMO_DAY}>Demo Day</a>
        </strong>{' '}
        - present to a jury and the community, $5,000 prize pool.
      </p>
      <hr />
      <h1>
        <strong>When &amp; where:</strong>
      </h1>
      <p>
        📍 <strong>Where</strong>: The Shire, Zebra Tower, 12th floor
        <br />
        📅 <strong>When</strong>: October 6-13
        <br />⏰ <strong>Time:</strong> open 24/7, kick-off Oct 6 at 12:00 PM | Demo Day Oct 13, 6 PM
        <br />
        📱 <strong>Telegram:</strong> <a href={TELEGRAM}>Join</a>
      </p>
      <hr />
      <h1>Why is it worth it?</h1>
      <p>A focused week with mentors on hand and teams building alongside you.</p>
    </>
  ),
}
