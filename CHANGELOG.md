# Changelog

All notable changes to Tab Timer. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-10-28

### Fixed

- Time while the computer is asleep or the lid is closed no longer counts as
  active time, and changing the system clock no longer adds or removes time.
- Midnight no longer wipes the new day's time already logged in other tabs,
  no longer loses the last seconds of the old day, and no longer crashes the
  timer when the rollover is noticed late (for example after waking from
  sleep).
- Re-enabling a site from the popup without reloading the page no longer
  counts its time twice.
- Time is no longer lost when leaving a page: it is saved when the tab is
  hidden or closed, even if an earlier save is still in progress, and a failed
  save is retried.
- Going back or forward to a page restored from the browser's back/forward
  cache keeps the overlay, the time tracking and the block screen working.
- The timer pauses while the block screen is up, so a blocked tab no longer
  uses up the combined daily limit.

### Changed

- Each tracked tab now does less work per second: one timer instead of three,
  and no repeated storage reads.

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

[1.1.1]: https://github.com/corygabrielsen/tabtimer/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/corygabrielsen/tabtimer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/corygabrielsen/tabtimer/releases/tag/v1.0.0
