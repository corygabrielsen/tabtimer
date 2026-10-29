# Privacy Policy

_Last updated: 2026-10-28_

Tab Timer is built to keep your data on your own device.

## What it does

Tab Timer measures how long you actively spend on the sites you choose to enable
and shows a running total for the current day. No site is tracked until you
enable it.

## What it stores

Everything is kept in `chrome.storage.local` on your own browser profile:

- `day:YYYY-MM-DD`: for each day, the active time per tracked site, split into
  the 24 hours of the day. The last 30 days are kept; older days are deleted
  automatically.
- `limits`: any daily time limits you set (per site and across all sites).
- `prefs`: whether the on-page overlay is shown, and its size.
- `snoozeUntil`: the end time of a "5 more minutes" snooze.
- `idleState`: whether you are at the computer right now (`active`), away
  after 5 minutes without keyboard or mouse input (`idle`), or have the screen
  locked (`locked`), so time away isn't counted.
- `schema`: the storage format version. Data stored in an older format is
  deleted once when the extension is updated.

While the browser runs, the extension also keeps the recent times you were
idle or locked, and the last few minutes of credited time, in
`chrome.storage.session` (memory only, cleared when the browser closes), so it
can take back time counted after your last input.

The `idle` permission tells Tab Timer only whether you are active, idle or
locked, never what you are doing. It is read locally to pause timing and is
never transmitted.

That's all. Tab Timer only reads the **address** of the pages it runs on (to
pick which site's counter to update). It does not read page content, your
browsing history, form data, or anything you type.

## What it does NOT do

- It does **not** transmit any data off your device. There are no servers, no
  network requests, no analytics, and no third-party SDKs.
- It does **not** sell or share data, because it never collects it anywhere but
  your local browser storage.
- It does **not** track you across sites or build a profile.

## Your control

- Use **Reset today** in the popup to clear the current day's count for a site.
- Days older than 30 days are deleted automatically.
- Uninstalling the extension removes all of its local storage.

## Contact

Questions: open an issue at
<https://github.com/corygabrielsen/tabtimer> or email corygabrielsen@gmail.com.
