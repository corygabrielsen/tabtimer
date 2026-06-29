# Chrome Web Store listing

Version-controlled source for the Web Store listing so it's reproducible rather
than re-improvised in the dashboard each submission. Keep this in sync with the
dashboard.

## Visibility

Unlisted.

## Single purpose

Show how much time you've actively spent on social-media sites today, as an
on-page overlay and a toolbar popup.

## Short description

See how much time you've spent on social media sites today.

## Privacy policy URL

<https://github.com/corygabrielsen/tabtimer/blob/master/PRIVACY.md>

## Permission justifications

- **storage** — Persist each tracked site's daily elapsed time and the
  show/hide preference locally in `chrome.storage.local`. No data leaves the
  device.
- **scripting** — Register the content script at runtime for the sites the user
  has enabled, so the overlay can render and measure active time.
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
