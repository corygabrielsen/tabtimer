#!/usr/bin/env bash
#
# Publish a packaged extension zip to the Chrome Web Store.
#
# Required environment variables:
#   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN - OAuth credentials
#   CWS_EXTENSION_ID                                    - Web Store item id
#   ZIP_PATH                                            - path to the .zip to upload
#
# The item's visibility (Unlisted) is configured once in the Developer
# Dashboard; this script just uploads a new package and publishes it, so it
# goes live with whatever visibility the listing already has.
#
# See PUBLISHING.md for how to obtain the credentials and item id.

set -euo pipefail

: "${CWS_CLIENT_ID:?CWS_CLIENT_ID is required}"
: "${CWS_CLIENT_SECRET:?CWS_CLIENT_SECRET is required}"
: "${CWS_REFRESH_TOKEN:?CWS_REFRESH_TOKEN is required}"
: "${CWS_EXTENSION_ID:?CWS_EXTENSION_ID is required}"
: "${ZIP_PATH:?ZIP_PATH is required}"

if [ ! -f "${ZIP_PATH}" ]; then
  echo "error: zip not found at ${ZIP_PATH}" >&2
  exit 1
fi

echo "Requesting access token..."
token_response="$(curl -sS -X POST https://oauth2.googleapis.com/token \
  --data-urlencode "client_id=${CWS_CLIENT_ID}" \
  --data-urlencode "client_secret=${CWS_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${CWS_REFRESH_TOKEN}" \
  --data-urlencode "grant_type=refresh_token")"
access_token="$(printf '%s' "${token_response}" | jq -r '.access_token // empty')"
if [ -z "${access_token}" ]; then
  echo "error: failed to obtain access token:" >&2
  printf '%s\n' "${token_response}" >&2
  exit 1
fi

echo "Uploading ${ZIP_PATH} to item ${CWS_EXTENSION_ID}..."
upload_response="$(curl -sS \
  -H "Authorization: Bearer ${access_token}" \
  -H "x-goog-api-version: 2" \
  -X PUT -T "${ZIP_PATH}" \
  "https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CWS_EXTENSION_ID}")"
printf '%s\n' "${upload_response}"
upload_state="$(printf '%s' "${upload_response}" | jq -r '.uploadState // empty')"
if [ "${upload_state}" != "SUCCESS" ]; then
  echo "error: upload failed (uploadState=${upload_state:-none})" >&2
  exit 1
fi

echo "Publishing..."
publish_response="$(curl -sS \
  -H "Authorization: Bearer ${access_token}" \
  -H "x-goog-api-version: 2" \
  -H "Content-Length: 0" \
  -X POST \
  "https://www.googleapis.com/chromewebstore/v1.1/items/${CWS_EXTENSION_ID}/publish")"
printf '%s\n' "${publish_response}"
status="$(printf '%s' "${publish_response}" | jq -r '.status // [] | join(" ")')"
echo "publish status: ${status:-none}"

case " ${status} " in
  *" OK "* | *" ITEM_PENDING_REVIEW "*)
    echo "Published (live update, or queued for review)."
    ;;
  *)
    echo "error: publish did not succeed" >&2
    exit 1
    ;;
esac
