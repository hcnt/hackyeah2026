import EventPage from '@/event-page/EventPage'
import { event } from '@/event-page/eventData'

// To plug in our registration widget later:
//   <EventPage event={event} registration={<OurRegistrationWidget />} />
export default function App() {
  return <EventPage event={event} />
}
