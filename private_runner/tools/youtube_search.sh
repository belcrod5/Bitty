#!/usr/bin/env bash
set -euo pipefail

QUERY="${1:-}"
MAX_RESULTS="${2:-5}"

if [[ -z "${QUERY}" ]]; then
  echo "query is required" >&2
  exit 2
fi
if [[ ${#QUERY} -gt 120 ]]; then
  echo "query is too long (max 120)" >&2
  exit 2
fi
if printf '%s' "${QUERY}" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  echo "query must not include control characters" >&2
  exit 2
fi

if ! [[ "${MAX_RESULTS}" =~ ^([1-9]|10)$ ]]; then
  echo "maxResults must be 1-10" >&2
  exit 2
fi

PROJECT_ID="${GOOGLE_CLOUD_PROJECT_ID:-}"
if [[ -n "${PROJECT_ID}" ]]; then
  export CLOUDSDK_CORE_PROJECT="${PROJECT_ID}"
fi
if [[ -n "${CLOUDSDK_ACTIVE_CONFIG_NAME:-}" ]]; then
  export CLOUDSDK_ACTIVE_CONFIG_NAME
fi

YOUTUBE_API_KEY="${YOUTUBE_API_KEY:-${YOUTUBE_DATA_API_KEY:-}}"
ACCESS_TOKEN=""
if [[ -z "${YOUTUBE_API_KEY}" ]]; then
  ACCESS_TOKEN="$(gcloud auth application-default print-access-token 2>/dev/null || true)"
  if [[ -z "${ACCESS_TOKEN}" ]]; then
    ACCESS_TOKEN="$(gcloud auth print-access-token 2>/dev/null || true)"
  fi
  if [[ -z "${ACCESS_TOKEN}" ]]; then
    echo "failed to acquire YouTube credentials. set YOUTUBE_API_KEY or run gcloud auth application-default login" >&2
    exit 1
  fi
fi

CURL_ARGS=(
  -sS
  --fail-with-body
  --max-time
  10
  --get
  -H
  "Accept: application/json"
  "https://youtube.googleapis.com/youtube/v3/search"
  --data-urlencode
  "part=snippet"
  --data-urlencode
  "type=video"
  --data-urlencode
  "q=${QUERY}"
  --data-urlencode
  "order=date"
  --data-urlencode
  "maxResults=${MAX_RESULTS}"
  --data-urlencode
  "regionCode=${YOUTUBE_REGION_CODE:-JP}"
  --data-urlencode
  "relevanceLanguage=${YOUTUBE_RELEVANCE_LANGUAGE:-ja}"
  --data-urlencode
  "safeSearch=${YOUTUBE_SAFE_SEARCH:-moderate}"
  --data-urlencode
  "fields=items(id/videoId,snippet/title,snippet/channelTitle,snippet/publishedAt)"
)
if [[ -n "${YOUTUBE_API_KEY}" ]]; then
  CURL_ARGS+=(--data-urlencode "key=${YOUTUBE_API_KEY}")
else
  CURL_ARGS+=(-H "Authorization: Bearer ${ACCESS_TOKEN}")
fi
if [[ -n "${PROJECT_ID}" && -z "${YOUTUBE_API_KEY}" ]]; then
  CURL_ARGS+=(-H "X-Goog-User-Project: ${PROJECT_ID}")
fi

RAW_JSON="$(curl "${CURL_ARGS[@]}")"

RAW_JSON="${RAW_JSON}" node <<'NODE'
const raw = process.env.RAW_JSON || "{}";
let parsed = {};
try {
  parsed = JSON.parse(raw);
} catch {
  console.error("invalid JSON from YouTube API");
  process.exit(1);
}
const items = Array.isArray(parsed.items) ? parsed.items : [];
const toEpoch = (raw) => {
  const ms = Date.parse(String(raw || ""));
  return Number.isFinite(ms) ? ms : 0;
};

const results = items
  .map((item, index) => ({
    index,
    videoId: String(item?.id?.videoId || ""),
    title: String(item?.snippet?.title || ""),
    channelTitle: String(item?.snippet?.channelTitle || ""),
    publishedAt: String(item?.snippet?.publishedAt || ""),
  }))
  .filter((item) => item.videoId && item.title)
  .sort((a, b) => {
    const diff = toEpoch(b.publishedAt) - toEpoch(a.publishedAt);
    if (diff !== 0) return diff;
    return a.index - b.index;
  })
  .map(({ index: _index, ...item }) => item);
process.stdout.write(`${JSON.stringify({ results })}\n`);
NODE
