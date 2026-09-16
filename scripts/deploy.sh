#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${CLOUDFLARE_PAGES_PROJECT:-markdown-to-discord}"
CANONICAL_URL="${CANONICAL_URL:-https://markdowntodiscord.com}"
BRANCH="${CLOUDFLARE_PAGES_BRANCH:-main}"
WRANGLER_VERSION="${WRANGLER_VERSION:-4.132.0}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy a dirty working tree. Commit or stash changes first." >&2
  exit 1
fi

COMMIT_SHA="$(git rev-parse HEAD)"
COMMIT_MESSAGE="$(git log -1 --pretty=%s)"

npm run release:check
for file in dist/index.html dist/404.html dist/_headers dist/_redirects dist/sitemap.xml dist/robots.txt; do
  [[ -f "$file" ]] || { echo "Missing release artifact: $file" >&2; exit 1; }
done

printf '{"commit":"%s"}\n' "$COMMIT_SHA" > dist/version.json
npx --yes "wrangler@${WRANGLER_VERSION}" whoami >/dev/null
npx --yes "wrangler@${WRANGLER_VERSION}" pages deploy dist \
  --project-name "$PROJECT_NAME" \
  --branch "$BRANCH" \
  --commit-hash "$COMMIT_SHA" \
  --commit-message "$COMMIT_MESSAGE" \
  --commit-dirty=false

for attempt in $(seq 1 30); do
  deployed="$(curl --fail --silent --show-error "${CANONICAL_URL}/version.json" 2>/dev/null || true)"
  if [[ "$deployed" == *"$COMMIT_SHA"* ]]; then break; fi
  if [[ "$attempt" == 30 ]]; then
    echo "Deployment did not reach ${CANONICAL_URL} within 150 seconds." >&2
    exit 1
  fi
  sleep 5
done

for path in / /discord-markdown-guide/ /sitemap.xml /robots.txt; do
  curl --fail --silent --show-error --location --head "${CANONICAL_URL}${path}" >/dev/null
done
curl --fail --silent --show-error "${CANONICAL_URL}/" | grep -Fq "Markdown to Discord"
curl --fail --silent --show-error "${CANONICAL_URL}/discord-markdown-guide/" | grep -Fq "Discord Markdown Guide"

if ! npm run indexnow:submit; then
  echo "Warning: deployment succeeded, but IndexNow submission failed." >&2
fi

echo "Verified ${COMMIT_SHA} at ${CANONICAL_URL}"
