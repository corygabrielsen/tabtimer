import { defineConfig } from 'vite'
import { OUT_DIR } from './build.e2e'

// The content script is injected dynamically via
// chrome.scripting.registerContentScripts (see src/background.ts), which needs
// a single self-contained classic script — not the code-split ES modules the
// crx build produces. Bundle it as one IIFE at dist/content.js, appended to
// the crx build output (emptyOutDir: false). OUT_DIR is dist/, or dist-e2e/
// for the e2e variant (build.e2e.ts).
export default defineConfig({
  build: {
    outDir: OUT_DIR,
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
