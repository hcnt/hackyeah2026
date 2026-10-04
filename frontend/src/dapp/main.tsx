// Entry of events.html (live: the organiser's wallet and the on_sight program on Solana) and events-demo.html
// (the same screens on placeholder data). The page picks the mode with data-mode on #root.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { demoBackend, liveBackend } from './backend'

const root = document.getElementById('root')!
const backend = root.dataset.mode === 'demo' ? demoBackend() : liveBackend()

createRoot(root).render(
  <StrictMode>
    <App backend={backend} />
  </StrictMode>,
)
