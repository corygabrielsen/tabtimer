# Privacy Policy

_Last updated: 2026-06-28_

Tab Timer is built to keep your data on your own device.

## What it does

Tab Timer measures how long you actively spend on a fixed list of social-media
sites (see `host_permissions` in `manifest.json`) and shows a running total for
the current day.

## What it stores

- Per-site elapsed time for the current day, kept in `chrome.storage.local` on
  your own browser profile.
- A single preference for whether the on-page overlay is shown or hidden.

That's all. Tab Timer only reads the **hostname** of the pages it runs on (to
pick which counter to update). It does not read page content, your browsing
history, form data, or anything you type.

## What it does NOT do

- It does **not** transmit any data off your device. There are no servers, no
  network requests, no analytics, and no third-party SDKs.
- It does **not** sell or share data, because it never collects it anywhere but
  your local browser storage.
- It does **not** track you across sites or build a profile.

## Your control

- Use **Reset today** in the popup to clear the current day's count for a site.
- Past days' counters are pruned automatically on startup.
- Uninstalling the extension removes all of its local storage.

## Contact

Questions: open an issue at
<https://github.com/corygabrielsen/tabtimer> or email corygabrielsen@gmail.com.
