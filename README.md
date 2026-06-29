# Tab Timer

[![CI](https://github.com/corygabrielsen/tabtimer/actions/workflows/ci.yml/badge.svg)](https://github.com/corygabrielsen/tabtimer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Chrome extension that shows how much time you've actively spent on social-media
sites today — as an unobtrusive on-page overlay and a toolbar popup.

- **On-page overlay** — a small pill at the top of tracked sites showing the
  running time; expand it for Today / Focus / Session, or hide it.
- **Popup** — the active site's time today, with a reset and a show/hide toggle.
- **Private by design** — everything stays in `chrome.storage.local`; nothing is
  ever sent off your device. See [PRIVACY.md](PRIVACY.md).

> Screenshots for the listing live in [`store-assets/`](store-assets/).

## Install

From source (development):

1. `pnpm install && pnpm build`
2. Chrome → Extensions → enable **Developer mode**
3. **Load unpacked** → select `dist/`

## Develop

```sh
pnpm install      # Node >= 20 (see .nvmrc)
pnpm dev          # Vite dev server
pnpm build        # production build to dist/
pnpm watch        # rebuild on changes
pnpm package      # build + zip the store artifact
```

## Quality

```sh
pnpm typecheck
pnpm lint
pnpm format       # or format:check
pnpm test         # vitest
```

These also run in CI on every push and pull request. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Tech

TypeScript · Vite 6 (@crxjs) · Manifest V3 · ESLint 9 (flat) · Prettier · Vitest · pnpm

## Publishing

Published to the Chrome Web Store (Unlisted) via a manual GitHub Actions
workflow — see [PUBLISHING.md](PUBLISHING.md) and [STORE_LISTING.md](STORE_LISTING.md).

## License

[MIT](LICENSE) © Cory Gabrielsen
