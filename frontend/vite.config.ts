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
  server: {
    // Dev only: forward API calls to the local backend (uv run fastapi dev).
    proxy: { '/api': process.env.API_PROXY ?? 'http://localhost:8000' },
  },
})
