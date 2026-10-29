import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import baseManifest from './manifest.json'
import pkg from './package.json'
import { E2E, E2E_HOST_PERMISSIONS, OUT_DIR } from './build.e2e'

// Non-release builds name the commit they came from, e.g. "1.1.0 (ff1e3e6)",
// or "1.1.0 (ff1e3e6, modified)" with uncommitted changes to tracked files, so
// the extensions page shows exactly which build is loaded. Release builds
// (TABTIMER_RELEASE=1, set by the publish workflow) show the plain version.
function versionName(): string | undefined {
  if (process.env.TABTIMER_RELEASE === '1') return undefined
  try {
    const git = (args: string) => execSync(`git ${args}`, { encoding: 'utf8' }).trim()
    const sha = git('rev-parse --short HEAD')
    const modified = git('status --porcelain --untracked-files=no') !== ''
    return `${pkg.version} (${sha}${modified ? ', modified' : ''})`
  } catch {
    return undefined // not a git checkout
  }
}

// The version lives in package.json; stamp it onto the manifest at build time
// so they can't diverge. The content script isn't declared here — it's built
// separately (vite.content.config.ts) and registered dynamically at runtime.
//
// The e2e variant (TABTIMER_E2E=1) also requests the fixture hosts up front,
// standing in for the user's runtime grant, and builds to its own directory.
// With the flag unset the manifest and output are exactly the production ones.
const name = versionName()
const manifest = {
  ...baseManifest,
  version: pkg.version,
  ...(name ? { version_name: name } : {}),
  ...(E2E ? { host_permissions: E2E_HOST_PERMISSIONS } : {}),
}

export default defineConfig({
  plugins: [crx({ manifest })],
  // Compiles the e2e test hook (src/sw/testHook.ts) in or out.
  define: { __TABTIMER_E2E__: JSON.stringify(E2E) },
  resolve: {
    // tldts's own minified build of the Public Suffix List (~46 KB gzipped).
    // Its unminified ES modules bundle to more than twice that.
    alias: [{ find: /^tldts$/, replacement: 'tldts/dist/index.esm.min.js' }],
  },
  build: {
    outDir: OUT_DIR,
    // No source maps in the shipped package: they publish readable original
    // source to the Web Store, bloat the zip, and (via the content-script's
    // web_accessible_resources) are probeable by every tracked site.
    sourcemap: false,
  },
})
