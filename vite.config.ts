import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import baseManifest from './manifest.json'
import pkg from './package.json'

// Single sources of truth assembled at build time so nothing drifts:
//   - the version lives in package.json
//   - the tracked sites live in host_permissions; the content script's
//     `matches` is derived from them rather than duplicated.
const manifest = {
  ...baseManifest,
  version: pkg.version,
  content_scripts: baseManifest.content_scripts.map((cs) => ({
    ...cs,
    matches: baseManifest.host_permissions,
  })),
}

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
