import EventPage from '@/event-page/EventPage'
import { event } from '@/event-page/eventData'
import EmbeddedWidget from '@/widget/EmbeddedWidget'

// Dev event: create it with POST /api/oracle/dev/events (ENV=dev). Override with ?event=<event_id>.
const DEMO_EVENT_ID = 'DMABDq39byngbxquc3B9sSBcoHdYGMedGoL9GjbcxZSo'
const eventId = new URLSearchParams(window.location.search).get('event') ?? DEMO_EVENT_ID

export default function App() {
  return <EventPage event={event} registration={<EmbeddedWidget eventId={eventId} />} />
}
