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

# keychainのアクセス許可は署名のdesignated requirementに紐づく。adhocだと
# リビルドごとに別アプリ扱いで毎回パスワードを要求されるため、必ず署名する。
# 種類の異なる証明書間で揺れると許可が切れるので、優先順位を固定して選ぶ
# (BITTY_MACOS_SIGN_IDENTITY で明示指定も可能)。
SIGNING_IDENTITY="${BITTY_MACOS_SIGN_IDENTITY:-}"
if [[ -z "${SIGNING_IDENTITY}" ]]; then
  for pattern in '"Developer ID Application:' '"Apple Development:' '"Mac Developer:'; do
    SIGNING_IDENTITY="$(
      security find-identity -v -p codesigning 2>/dev/null |
        awk -v pat="${pattern}" 'index($0, pat){print $2; exit}'
    )"
    [[ -n "${SIGNING_IDENTITY}" ]] && break
  done
fi
if [[ -n "${SIGNING_IDENTITY}" ]]; then
  echo "[build-macos] Using code signing identity ${SIGNING_IDENTITY}"
  CODE_SIGN_ARGS=(
    CODE_SIGNING_ALLOWED=YES
    CODE_SIGNING_REQUIRED=YES
    CODE_SIGN_STYLE=Manual
    CODE_SIGN_IDENTITY="${SIGNING_IDENTITY}"
  )
else
  echo "[build-macos] No macOS code signing identity found; building unsigned"
  CODE_SIGN_ARGS=(
    CODE_SIGNING_ALLOWED=NO
    CODE_SIGNING_REQUIRED=NO
  )
fi

echo "[build-macos] Preparing native dependencies"
(cd "${EXPO_DIR}/macos" && pod install --silent)

cd "${EXPO_DIR}"

echo "[build-macos] Building Release"
# Keep Application Support outside the sandbox container regardless of signing availability.
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
  CODE_SIGN_ENTITLEMENTS= \
  "${CODE_SIGN_ARGS[@]}" \
  build

if [[ ! -d "${APP_PATH}" ]]; then
  echo "[build-macos] app not found: ${APP_PATH}" >&2
  exit 1
fi

echo "[build-macos] Built ${APP_PATH}"
