import EventPage from '@/event-page/EventPage'
import { event } from '@/event-page/eventData'
import Widget from '@/widget/Widget'

// Demo event seeded by the backend stub (backend/app/oracle.py). Override with ?event=<event_id>.
const DEMO_EVENT_ID = 'AttendNowDemoEvent1111111111111111111111111'
const eventId = new URLSearchParams(window.location.search).get('event') ?? DEMO_EVENT_ID

export default function App() {
  return <EventPage event={event} registration={<Widget eventId={eventId} />} />
}
