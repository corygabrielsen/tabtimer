# Tab Timer

[![CI](https://github.com/corygabrielsen/tabtimer/actions/workflows/ci.yml/badge.svg)](https://github.com/corygabrielsen/tabtimer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Tab Timer counts the time you actually spend on the sites you choose — only
while the tab is in front of you — and blocks a site once you reach the daily
limit you set for it.

- **Choose your sites** — installs with **no host-permission prompt**. Track a
  suggested site in one tap or add your own; Chrome asks for access the first
  time you add each one.
- **Limits in one tap** — pick 15m, 30m, 1h or 2h (or a custom number of
  minutes) per site from the popup or settings, plus an optional cap across all
  tracked sites. Limits are off by default.
- **A block screen that means it** — once a limit is reached the page is
  covered: no scrolling behind it, fullscreen video exits, playing media
  pauses. It leads with **Close tab** and shows today's time by the hour;
  holding **2 more minutes** snoozes (2 seconds at first, longer as the day
  goes on), and limits reset at midnight.
- **Honest counting** — time only counts while the tab is visible and focused.
  It pauses after 5 minutes without keyboard or mouse input and while the
  screen is locked (playing video or audio keeps counting), and sleep never
  counts. Only one tab in one window counts at a time.
- **At a glance** — a small timer at the top of tracked pages (click to switch
  between today, this visit and time open), and a popup showing today's time
  against the limit.
- **See where the time went** — an activity page shows today by hour or the
  week by day, split by site, for the last 30 days. Pick a site to see it
  against its limit and change the limit right there.
- **Private by design** — everything stays in your browser's local storage;
  nothing is ever sent anywhere. See [PRIVACY.md](PRIVACY.md).

> Screenshots for the listing live in [`store-assets/`](store-assets/).

## Install

From source (development):

1. `pnpm install && pnpm build`
2. Chrome → Extensions → enable **Developer mode**
3. **Load unpacked** → select `dist/`
4. The settings page opens on first run — pick the sites to track (or use the
   popup's **Track this site**).

## Develop

```sh
pnpm install      # Node >= 24 (see .nvmrc)
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
pnpm test:e2e     # Playwright: built extension in real Chromium
```

`pnpm test:e2e` builds a test variant to `dist-e2e/` (pre-granted access to
local fixture hosts) and loads it unpacked in Chromium. First run needs
`pnpm exec playwright install chromium`.

These also run in CI on every push and pull request. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Tech

TypeScript · Vite 6 (@crxjs) · Manifest V3 · ESLint 9 (flat) · Prettier · Vitest · pnpm

## Publishing

Published to the Chrome Web Store (Unlisted) via a manual GitHub Actions
workflow — see [PUBLISHING.md](PUBLISHING.md) and [STORE_LISTING.md](STORE_LISTING.md).

## License

[MIT](LICENSE) © Cory Gabrielsen
