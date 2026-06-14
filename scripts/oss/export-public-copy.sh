#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ALLOWLIST_PATH="${BITTY_PUBLIC_COPY_ALLOWLIST:-${SCRIPT_DIR}/public-copy-allowlist.txt}"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <destination-directory>" >&2
  exit 2
fi

DEST_DIR="$1"
if [[ -z "${DEST_DIR}" || "${DEST_DIR}" == "/" ]]; then
  echo "refusing unsafe destination: ${DEST_DIR}" >&2
  exit 2
fi

mkdir -p "${DEST_DIR}"
DEST_REAL="$(cd "${DEST_DIR}" && pwd)"
ROOT_REAL="$(cd "${ROOT_DIR}" && pwd)"

if [[ "${DEST_REAL}" == "${ROOT_REAL}" || "${DEST_REAL}" == "${ROOT_REAL}/"* ]]; then
  echo "destination must be outside the source repository: ${DEST_REAL}" >&2
  exit 2
fi

if [[ -n "$(find "${DEST_REAL}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "destination must be empty: ${DEST_REAL}" >&2
  exit 2
fi

copy_path() {
  local rel_path="$1"
  local src="${ROOT_REAL}/${rel_path}"
  local dst="${DEST_REAL}/${rel_path}"

  if [[ ! -e "${src}" ]]; then
    echo "allowlist path not found: ${rel_path}" >&2
    exit 1
  fi

  mkdir -p "$(dirname "${dst}")"
  if [[ -d "${src}" ]]; then
    mkdir -p "${dst}"
    rsync -a \
      --exclude '.DS_Store' \
      --exclude 'node_modules' \
      --exclude '.expo' \
      --exclude 'ios' \
      --exclude 'android' \
      --exclude 'logs' \
      --exclude '.env' \
      "${src}/" "${dst}/"
  else
    cp -p "${src}" "${dst}"
  fi
}

while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
  line="${raw_line%%#*}"
  line="$(printf '%s' "${line}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [[ -z "${line}" ]] && continue
  copy_path "${line}"
done < "${ALLOWLIST_PATH}"

echo "public copy written to ${DEST_REAL}"
