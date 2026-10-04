// Entry of organizer.html: the organizer registers and funds an event on chain.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/opsz.css'
import '../index.css'
import { OrganizerPage } from './OrganizerPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OrganizerPage />
  </StrictMode>,
)
