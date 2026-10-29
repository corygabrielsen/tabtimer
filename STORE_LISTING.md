# Chrome Web Store listing

Version-controlled source for the Web Store listing so it's reproducible rather
than re-improvised in the dashboard each submission. Keep this in sync with the
dashboard.

## Visibility

Unlisted.

## Single purpose

Count the time you actively spend on sites you choose and block a site once
its daily time limit is reached.

## Short description

Counts your active time on chosen sites and blocks them when you reach your daily limit.

## Privacy policy URL

<https://github.com/corygabrielsen/tabtimer/blob/master/PRIVACY.md>

## Permission justifications

- **storage** — Persist each tracked site's daily elapsed time, the show/hide
  preference, and any daily time limits locally in `chrome.storage.local`. No
  data leaves the device.
- **scripting** — Register the content script at runtime for the sites the user
  has enabled, so the overlay can render and measure active time.
- **idle** — Pause timing while the user is away from the computer: Chrome
  reports "idle" after 5 minutes without keyboard or mouse input, and "locked"
  when the screen locks. Time spent away is not counted (unless audio or video
  is playing on the tracked site while idle). Only the active/idle/locked state
  is read, locally; it is never transmitted.
- **alarms** — Save the active time counted so far once a minute, only while a
  tracked page is in use, so it stays exact when Chrome suspends the extension
  in the background and at most a minute is lost if the browser crashes. The
  alarm carries no data and reads nothing.
- **optional host access** — No host access is requested at install. When the
  user enables a site (from the popup or the options page), the extension
  requests access to just that origin; grants are per-site and revocable. The
  content script only reads the page's hostname, never page content.

## Data usage disclosures

- Does the item collect personal or sensitive user data? Only "Web history"
  (time spent on the listed sites), stored **locally**.
- Is data transmitted off the device? **No.**
- Is data sold or transferred to third parties? **No.**
- Is data used for purposes unrelated to the single purpose? **No.**

## Assets

See `store-assets/` for the screenshots and promotional images required by the
dashboard.
