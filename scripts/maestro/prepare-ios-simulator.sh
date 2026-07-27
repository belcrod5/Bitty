#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVICE="${MAESTRO_IOS_DEVICE:-}"
BOOTSTRAP_LOCAL_SCRIPT="${ROOT_DIR}/scripts/worktree/bootstrap-local.sh"

if [[ -z "${DEVICE}" ]]; then
  DEVICE="$(xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p' | head -n 1)"
fi

if [[ -z "${DEVICE}" ]]; then
  echo "No booted iOS Simulator found. Boot one first, or set MAESTRO_IOS_DEVICE to a Simulator UDID." >&2
  exit 1
fi

"${BOOTSTRAP_LOCAL_SCRIPT}" \
  --repo-root "${ROOT_DIR}" \
  --env \
  --expo \
  --ios-native >&2

echo "[maestro-ios] Building and installing the current development build on ${DEVICE}" >&2
(cd "${ROOT_DIR}/expo" && npx expo run:ios --device "${DEVICE}" --no-bundler) >&2

printf '%s\n' "${DEVICE}"
