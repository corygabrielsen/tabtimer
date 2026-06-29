import { defineConfig } from 'vite'

// The content script is injected dynamically via
// chrome.scripting.registerContentScripts (see src/background.ts), which needs
// a single self-contained classic script — not the code-split ES modules the
// crx build produces. Bundle it as one IIFE at dist/content.js, appended to
// the crx build output (emptyOutDir: false).
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: 'src/content.ts',
      formats: ['iife'],
      name: 'TabTimerContent',
      fileName: () => 'content.js',
    },
  },
})
