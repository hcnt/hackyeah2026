import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Builds the embeddable widget as one self-contained script: dist/widget.js.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/widget/embed.tsx'),
      name: 'AttendNow',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
})
