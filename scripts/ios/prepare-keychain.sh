#!/usr/bin/env bash
set -euo pipefail

KEYCHAIN_PATH="${KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-}"
PARTITION_LIST="${KEYCHAIN_PARTITION_LIST:-apple-tool:,apple:,codesign:}"

if [[ -z "${KEYCHAIN_PASSWORD}" ]]; then
  echo "[prepare-keychain] KEYCHAIN_PASSWORD is required." >&2
  echo "[prepare-keychain] Example: export KEYCHAIN_PASSWORD='<mac-login-password>'" >&2
  exit 1
fi

if [[ ! -f "${KEYCHAIN_PATH}" ]]; then
  echo "[prepare-keychain] keychain not found: ${KEYCHAIN_PATH}" >&2
  exit 1
fi

echo "[prepare-keychain] Unlocking keychain: ${KEYCHAIN_PATH}"
security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}"

echo "[prepare-keychain] Applying key partition list for codesign tools"
security set-key-partition-list -S "${PARTITION_LIST}" -s -k "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_PATH}" >/dev/null

echo "[prepare-keychain] Done"
