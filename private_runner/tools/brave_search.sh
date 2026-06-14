#!/usr/bin/env bash
set -euo pipefail

QUERY="${1:-}"
COUNT="5"
COUNTRY="JP"
SEARCH_LANG="jp"

if [[ $# -gt 1 ]]; then
  echo "only query argument is allowed" >&2
  exit 2
fi

if [[ -z "${QUERY}" ]]; then
  echo "query is required" >&2
  exit 2
fi
if [[ ${#QUERY} -gt 200 ]]; then
  echo "query is too long (max 200)" >&2
  exit 2
fi
if printf '%s' "${QUERY}" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  echo "query must not include control characters" >&2
  exit 2
fi

BRAVE_API_KEY="${BRAVE_API_KEY:-${BRAVE_SEARCH_API_KEY:-}}"
if [[ -z "${BRAVE_API_KEY}" ]]; then
  echo "BRAVE_API_KEY is required" >&2
  exit 1
fi

CURL_ARGS=(
  -sS
  --fail-with-body
  --max-time
  12
  --get
  -H
  "Accept: application/json"
  -H
  "X-Subscription-Token: ${BRAVE_API_KEY}"
  "https://api.search.brave.com/res/v1/web/search"
  --data-urlencode
  "q=${QUERY}"
  --data-urlencode
  "count=${COUNT}"
  --data-urlencode
  "country=${COUNTRY}"
  --data-urlencode
  "search_lang=${SEARCH_LANG}"
  --data-urlencode
  "safesearch=${BRAVE_SAFE_SEARCH:-moderate}"
)

RAW_JSON="$(curl "${CURL_ARGS[@]}")"

RAW_JSON="${RAW_JSON}" node <<'NODE'
const raw = process.env.RAW_JSON || "{}";
let parsed = {};
try {
  parsed = JSON.parse(raw);
} catch {
  console.error("invalid JSON from Brave Search API");
  process.exit(1);
}

const webResults = Array.isArray(parsed?.web?.results) ? parsed.web.results : [];
const fallbackResults = Array.isArray(parsed?.results) ? parsed.results : [];
const source = webResults.length > 0 ? webResults : fallbackResults;

const results = source.map((item) => ({
  title: String(item?.title || "").trim(),
  url: String(item?.url || "").trim(),
  description: String(item?.description || "").trim(),
})).filter((item) => item.title && item.url);

process.stdout.write(`${JSON.stringify({ results })}\n`);
NODE
