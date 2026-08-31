#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXPO_DIR="${REPO_ROOT}/expo"
WORKSPACE_PATH="${EXPO_DIR}/macos/bitty.xcworkspace"
DERIVED_DATA_PATH="${EXPO_DIR}/build/macos-release"
APP_PATH="${DERIVED_DATA_PATH}/Build/Products/Release/bitty.app"
BOOTSTRAP_LOCAL_SCRIPT="${REPO_ROOT}/scripts/worktree/bootstrap-local.sh"

if [[ -x "${BOOTSTRAP_LOCAL_SCRIPT}" ]]; then
  "${BOOTSTRAP_LOCAL_SCRIPT}" --repo-root "${REPO_ROOT}" --expo
fi

if [[ ! -d "${WORKSPACE_PATH}" ]]; then
  echo "[build-macos] workspace not found: ${WORKSPACE_PATH}" >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "[build-macos] xcodebuild is not available." >&2
  exit 1
fi

if ! command -v pod >/dev/null 2>&1; then
  echo "[build-macos] CocoaPods is not available." >&2
  exit 1
fi

echo "[build-macos] Preparing native dependencies"
(cd "${EXPO_DIR}/macos" && pod install --silent)

cd "${EXPO_DIR}"

echo "[build-macos] Building Release"
xcodebuild \
  -quiet \
  -workspace "${WORKSPACE_PATH}" \
  -scheme bitty-macOS \
  -configuration Release \
  -sdk macosx \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build

if [[ ! -d "${APP_PATH}" ]]; then
  echo "[build-macos] app not found: ${APP_PATH}" >&2
  exit 1
fi

echo "[build-macos] Built ${APP_PATH}"
