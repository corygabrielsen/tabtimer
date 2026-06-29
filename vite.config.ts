import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'
import pkg from './package.json'

// package.json is the single source of truth for the version; stamp it onto
// the manifest at build time so they can never diverge.
manifest.version = pkg.version

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    // No source maps in the shipped package: they publish readable original
    // source to the Web Store, bloat the zip, and (via the content-script's
    // web_accessible_resources) are probeable by every tracked site.
    sourcemap: false,
  },
})
