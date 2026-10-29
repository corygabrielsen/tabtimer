# Contributing

Thanks for your interest in Tab Timer.

## Setup

Requires pnpm 12 (pinned via `packageManager` in `package.json`). Node 25+
no longer bundles Corepack, so install pnpm with npm:

```sh
npm i -g pnpm@12      # once
pnpm install          # Node >= 24 (see .nvmrc)
pnpm dev              # Vite dev server
pnpm build            # production build to dist/
pnpm package          # build + zip the store artifact
```

## Before you push

CI runs these on every push and pull request; run them locally first:

```sh
pnpm typecheck
pnpm lint
pnpm format:check     # or `pnpm format` to fix
pnpm test
pnpm build
pnpm test:e2e         # Playwright, real Chromium (see below)
```

`pnpm test:e2e` builds the e2e variant (`TABTIMER_E2E=1`, output in
`dist-e2e/`; see `build.e2e.ts`) and runs the suite in `e2e/` against it,
loaded as an unpacked extension. The variant only adds `host_permissions` for
the fixture hosts — standing in for the user's runtime grant, which would
otherwise need a permission prompt — and the production build is unaffected.
Install the browser once with `pnpm exec playwright install chromium` (add
`--with-deps` on a fresh Linux box).

Optionally install the git hooks so they run on commit:

```sh
pre-commit install
```

## Conventions

- TypeScript, strict mode; Prettier-formatted (no semicolons, single quotes).
- Conventional commit subjects in the imperative mood (`feat:`, `fix:`,
  `build:`, …).
- Add or update unit tests (`vitest`) for logic changes, and e2e tests for
  user-visible overlay/block behaviour.
- Tracked sites are chosen at runtime: each is an optional host permission the
  user grants, and the content script is registered for the granted hosts
  (see `src/core/site.ts` and `src/sw/contentScripts.ts`). A site is a
  registrable domain under the Public Suffix List (`tldts`), resolved in the
  service worker, popup and options page; `content.js` never bundles it.
- Only the service worker writes `chrome.storage.local`: pages and the content
  script send typed requests (`src/core/messages.ts`) and read storage directly.

## Versioning

`package.json` holds the version; the build stamps it onto the manifest. A PR
with a user-visible change bumps it ([SemVer](https://semver.org/): new
feature → minor, fix → patch) and adds an entry to `CHANGELOG.md`.
Development builds also carry the commit in `version_name`, so the extensions
page shows which build is loaded.
