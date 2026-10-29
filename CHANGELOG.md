# Changelog

All notable changes to Tab Timer. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.5.0] - 2026-10-28

### Changed

- Counting is now managed in one place for the whole browser, so it stays
  exact across windows: with two windows open side by side, only the one
  you're using counts, never both at once.
- Time stays exact after the browser suspends the extension in the
  background, and if the browser crashes, at most a minute is lost.
- Tab Timer now uses Chrome's alarms (the `alarms` permission) to save time
  once a minute while a tracked page is in use. This adds no install or
  update prompt.

## [1.4.0] - 2026-10-28

### Changed

- Time no longer counts while you're away from the computer or the screen is
  locked. You count as away after 5 minutes without keyboard or mouse input,
  and the time since your last input is taken back, so stepping away is never
  counted. Reading a page without scrolling keeps counting for those 5
  minutes.
- Video or audio playing on a tracked site keeps counting while you're not
  touching the keyboard or mouse, so watching counts. A locked screen always
  pauses the count.
- Tab Timer now asks Chrome whether you're idle (the `idle` permission). This
  adds no install or update prompt, and the idle state never leaves your
  device.

## [1.3.0] - 2026-10-28

Upgrading resets stored time, sites and limits once (new storage format).

### Changed

- Time now counts under the site you'd expect, using the public list of domain
  suffixes: `news.bbc.co.uk` counts as `bbc.co.uk`, each `*.github.io` site is
  its own, and an IP address or `localhost` stays as it is. Before, every
  address under a suffix like `co.uk` was lumped together.
- Adding a site by a bare suffix such as `co.uk` or `github.io` is refused,
  since it would cover every site under it.
- Time is now recorded by the hour of the day it was spent, ready for an
  activity view. The last 30 days are kept; older days are removed
  automatically.

### Fixed

- Setting a limit in the popup while the settings page is open (or the other
  way round) no longer loses one of the two changes.
- A web page can no longer reset or change another site's time or limits.

## [1.2.2] - 2026-10-28

### Fixed

- The page behind the block screen can no longer be scrolled: not with the
  mouse wheel or trackpad, touch, the keyboard (Space, Page Up/Down, Home/End,
  arrow keys), or middle-click autoscroll, including on sites that scroll the
  page body or an inner panel instead of the whole page. Once it goes away,
  the page is back where you left it and scrolls normally.
- The block screen is now fully opaque: nothing of the page shows through it,
  in light or dark mode.

## [1.2.1] - 2026-10-28

### Fixed

- The block screen now really blocks the page: keyboard focus moves to "5 more
  minutes" and stays on the block screen (Tab no longer reaches the page), the
  page behind it can't be clicked or read by screen readers, and Escape doesn't
  dismiss it. Dismissing it returns focus to where you were.
- Video and audio playing on the page pause when the block screen appears and
  stay paused; nothing resumes on its own afterwards.
- Hitting a limit while a video is fullscreen now leaves fullscreen, and the
  page can't go back into fullscreen while blocked, so the block screen can't
  end up hidden behind a fullscreen player.
- A page's own scroll setting is restored exactly after the block screen goes
  away, instead of being cleared.
- Screen readers now hear the time on the collapsed on-page timer, not just its
  label.

## [1.2.0] - 2026-10-28

### Changed

- Redesigned popup: the current site's time leads, with a meter toward its
  limit, how much time is left, and a clear state (tracking, limit reached,
  snoozed, not tracked, or a page that can't be tracked) with the one action
  that state needs.
- Redesigned settings page, grouped into Sites, Daily limits, On-page timer and
  Privacy. Changes save as you make them, with inline validation; suggested
  sites are one-tap chips, and the tracked sites table shows today's time.
- Light and dark themes follow the system setting, and all text meets WCAG AA
  contrast, including the on-page timer and block screen.
- Daily limits are set with one tap: preset chips (Off, 15m, 30m, 1h, 2h for a
  site; Off, 1h, 2h, 3h, 4h for all sites combined), plus a Custom option for
  any whole number of minutes, in the popup and on the settings page.
- "Reset today" in the popup asks for a second click to confirm.

### Fixed

- Typing a limit in the popup no longer saves each keystroke (typing "30"
  briefly set a 1-minute limit and could block the page at once).
- The settings page no longer briefly shows sites you just removed after
  quick back-to-back changes.

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

[1.5.0]: https://github.com/corygabrielsen/tabtimer/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/corygabrielsen/tabtimer/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/corygabrielsen/tabtimer/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/corygabrielsen/tabtimer/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/corygabrielsen/tabtimer/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/corygabrielsen/tabtimer/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/corygabrielsen/tabtimer/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/corygabrielsen/tabtimer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/corygabrielsen/tabtimer/releases/tag/v1.0.0
