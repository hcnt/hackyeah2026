import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    // The stage screen, the event camera and the organizer's event form are separate pages next to the main app.
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        stage: path.resolve(__dirname, 'stage.html'),
        camera: path.resolve(__dirname, 'camera.html'),
        organizer: path.resolve(__dirname, 'organizer.html'),
      },
    },
  },
  server: {
    // Dev only: forward API calls to the local backend (uv run fastapi dev).
    proxy: { '/api': process.env.API_PROXY ?? 'http://localhost:8000' },
  },
})
