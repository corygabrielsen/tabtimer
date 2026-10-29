import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import baseManifest from './manifest.json'
import pkg from './package.json'
import { E2E, E2E_HOST_PERMISSIONS, OUT_DIR } from './build.e2e'

// The version lives in package.json; stamp it onto the manifest at build time
// so they can't diverge. The content script isn't declared here — it's built
// separately (vite.content.config.ts) and registered dynamically at runtime.
//
// The e2e variant (TABTIMER_E2E=1) also requests the fixture hosts up front,
// standing in for the user's runtime grant, and builds to its own directory.
// With the flag unset the manifest and output are exactly the production ones.
const manifest = {
  ...baseManifest,
  version: pkg.version,
  ...(E2E ? { host_permissions: E2E_HOST_PERMISSIONS } : {}),
}

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: OUT_DIR,
    // No source maps in the shipped package: they publish readable original
    // source to the Web Store, bloat the zip, and (via the content-script's
    // web_accessible_resources) are probeable by every tracked site.
    sourcemap: false,
  },
})
