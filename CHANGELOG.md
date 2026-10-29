# Changelog

All notable changes to Tab Timer. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-28

### Added

- Optional daily time limits: a cap per site and a combined cap across all
  tracked sites, both off by default. Over a cap, the site is covered by a
  block screen showing today's time against the limit, with a "5 more minutes"
  snooze. Limits are set from the options page or the popup and reset at
  midnight.

### Changed

- Development builds show the commit they were built from on the extensions
  page, e.g. `1.1.0 (ff1e3e6)`.
- Development now needs Node 24 or newer (Node 26 LTS recommended) and pnpm 12.

### Security

- The publish workflow validates its version input, pins every action to a
  commit, and runs behind a protected environment.

## [1.0.0]

### Added

- Time tracking on sites you choose, with an on-page overlay (today, focus and
  session timers) and a toolbar popup. Nothing leaves the device.

[1.1.0]: https://github.com/corygabrielsen/tabtimer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/corygabrielsen/tabtimer/releases/tag/v1.0.0
