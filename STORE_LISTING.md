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
- **host access (the social-media domains in `host_permissions`)** — Inject the
  content script on exactly those sites to render the overlay and measure active
  time. The extension only reads the page's hostname; it does not read page
  content. Only the named domains are requested — no `<all_urls>`.

## Data usage disclosures

- Does the item collect personal or sensitive user data? Only "Web history"
  (time spent on the listed sites), stored **locally**.
- Is data transmitted off the device? **No.**
- Is data sold or transferred to third parties? **No.**
- Is data used for purposes unrelated to the single purpose? **No.**

## Assets

See `store-assets/` for the screenshots and promotional images required by the
dashboard.
