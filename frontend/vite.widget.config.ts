import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Host pages may serve widget.js without a UTF-8 charset, so the bundle must be pure ASCII:
// every non-ASCII character becomes a \u escape (valid in strings, templates, regexes and identifiers).
function asciiOnly(): Plugin {
  return {
    name: 'ascii-only',
    // After minification, which would otherwise turn escapes back into raw characters.
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') {
          chunk.code = chunk.code.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
        }
      }
    },
  }
}

// Builds the embeddable widget as one self-contained script: dist/widget.js.
export default defineConfig({
  plugins: [react(), asciiOnly()],
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
