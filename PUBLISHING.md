# Publishing to the Chrome Web Store

Auto-publish is a manual GitHub Actions workflow
(`.github/workflows/publish.yml`). It builds the extension, packages `dist/`,
and uploads + publishes it through the Chrome Web Store API using the
dependency-free script `scripts/publish-chrome-web-store.sh`.

The workflow can only run after the one-time setup below. After that, publishing
is: **Actions → "Publish to Chrome Web Store" → Run workflow**.

Visibility is **Unlisted** — that's a setting on the listing (step 1), not
something the API toggles. The workflow just ships a new package; it goes live
with whatever visibility the listing already has.

---

## One-time setup

### 1. Create the listing and set it Unlisted

The API can upload and publish updates, but it cannot create the listing or fill
in required store metadata — do that once by hand.

1. Build a package locally:
   ```sh
   pnpm install && pnpm build
   ( cd dist && zip -r ../tabtimer.zip . )
   ```
2. Go to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   → **Add new item** → upload `tabtimer.zip`.
3. Fill in the required fields: description, an icon, at least one screenshot
   (1280×800 or 640×400), category, language, single purpose, permission
   justifications, and the data-use disclosures.
4. Under **Distribution**, set **Visibility → Unlisted**.
5. Save and **Submit for review** (the first publish must go through review).
6. Copy the **Item ID** (the long id in the dashboard URL). You'll need it as
   `CWS_EXTENSION_ID`.

### 2. Enable the API and create OAuth credentials

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or
   pick a project.
2. **APIs & Services → Library** → enable **Chrome Web Store API**.
3. **APIs & Services → OAuth consent screen** → External. Add your developer
   Google account under **Test users** (a Testing app is fine; no verification
   needed for your own use).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   application type **Desktop app**. Save the **Client ID** and **Client
   secret**.

### 3. Get a refresh token

Easiest path — the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/):

1. First add `https://developers.google.com/oauthplayground` as an **Authorized
   redirect URI** on the OAuth client from step 2 (Credentials → your client →
   edit).
2. Open the Playground → gear icon (⚙) → check **Use your own OAuth
   credentials** → paste the Client ID and secret.
3. In the left **Scopes** box, enter exactly:
   ```
   https://www.googleapis.com/auth/chromewebstore
   ```
   → **Authorize APIs** → sign in with the developer account → allow.
4. Click **Exchange authorization code for tokens** and copy the **Refresh
   token**.

<details>
<summary>Alternative: manual loopback flow (no Playground)</summary>

1. Add `http://localhost` as an Authorized redirect URI on the OAuth client.
2. Open this URL in a browser (substitute your client id):
   ```
   https://accounts.google.com/o/oauth2/auth?response_type=code&access_type=offline&prompt=consent&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fchromewebstore&redirect_uri=http%3A%2F%2Flocalhost&client_id=YOUR_CLIENT_ID
   ```
3. Approve. The browser redirects to `http://localhost/?code=...` (the page
   won't load — that's fine). Copy the `code` value from the address bar.
4. Exchange it for a refresh token:
   ```sh
   curl -sS -X POST https://oauth2.googleapis.com/token \
     --data-urlencode "client_id=YOUR_CLIENT_ID" \
     --data-urlencode "client_secret=YOUR_CLIENT_SECRET" \
     --data-urlencode "code=THE_CODE" \
     --data-urlencode "grant_type=authorization_code" \
     --data-urlencode "redirect_uri=http://localhost"
   ```
   The JSON response contains `refresh_token`.
   </details>

### 4. Add the credentials to GitHub

Repo → **Settings → Secrets and variables → Actions**.

Secrets (encrypted):

| Name                | Value                     |
| ------------------- | ------------------------- |
| `CWS_CLIENT_ID`     | OAuth client id           |
| `CWS_CLIENT_SECRET` | OAuth client secret       |
| `CWS_REFRESH_TOKEN` | refresh token from step 3 |

Variable (not secret — the id is public):

| Name               | Value               |
| ------------------ | ------------------- |
| `CWS_EXTENSION_ID` | Item ID from step 1 |

Or with the `gh` CLI:

```sh
gh secret set CWS_CLIENT_ID
gh secret set CWS_CLIENT_SECRET
gh secret set CWS_REFRESH_TOKEN
gh variable set CWS_EXTENSION_ID --body "your-item-id"
```

---

## Publishing

- Bump the version in `package.json` (the single source of truth — the build
  stamps it onto the manifest), commit, and tag the release.
- **Actions** tab → **Publish to Chrome Web Store** → **Run workflow**. Leave
  the version blank to publish `package.json`'s version, or type an override.
- The version **must be higher than the currently published version** every
  time, or the Web Store rejects the upload.

## Testing the script locally

```sh
pnpm build
( cd dist && zip -r ../tabtimer.zip . )
export CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... CWS_REFRESH_TOKEN=... CWS_EXTENSION_ID=...
ZIP_PATH=tabtimer.zip ./scripts/publish-chrome-web-store.sh
```

## Notes

- Unlisted items are not searchable; they're installable only via the direct
  store link. Each new version still goes through Chrome's review.
- `refresh_token` is long-lived but can be revoked if the OAuth app stays in
  "Testing" for a long time or you revoke access. If publishing starts failing
  with `invalid_grant`, redo step 3.
