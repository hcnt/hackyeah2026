// Entry of stage.html: the organizer's stage screen.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/opsz.css'
import '../index.css'
import { StagePage } from './StagePage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StagePage />
  </StrictMode>,
)
