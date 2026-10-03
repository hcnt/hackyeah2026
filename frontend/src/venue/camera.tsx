// Entry of camera.html: the event camera on a phone.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/opsz.css'
import '../index.css'
import { CameraPage } from './CameraPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CameraPage />
  </StrictMode>,
)
