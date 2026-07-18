#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IOS_DIR="${REPO_ROOT}/expo/ios"
ENV_FILE="${IOS_ENV_FILE:-${REPO_ROOT}/.env.ios.local}"
BOOTSTRAP_LOCAL_SCRIPT="${REPO_ROOT}/scripts/worktree/bootstrap-local.sh"

if [[ -x "${BOOTSTRAP_LOCAL_SCRIPT}" ]]; then
  "${BOOTSTRAP_LOCAL_SCRIPT}" --repo-root "${REPO_ROOT}" --env --expo --ios-native
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

DEVICE_ID="${IOS_DEVICE_ID:-}"
CONFIGURATION="${IOS_CONFIGURATION:-Release}"
SCHEME="${IOS_SCHEME:-Bitty}"
WORKSPACE_PATH="${IOS_WORKSPACE_PATH:-${IOS_DIR}/Bitty.xcworkspace}"
DERIVED_DATA_PATH="${IOS_DERIVED_DATA_PATH:-${IOS_DIR}/build/oneshot-derived-data}"
DEVELOPMENT_TEAM="${IOS_DEVELOPMENT_TEAM:-}"
LAUNCH_AFTER_INSTALL="${IOS_LAUNCH_AFTER_INSTALL:-0}"
BUNDLE_ID_OVERRIDE="${IOS_BUNDLE_ID:-}"

if [[ -z "${DEVICE_ID}" ]]; then
  echo "[build-ios] IOS_DEVICE_ID is required. Set it in ${ENV_FILE}." >&2
  exit 1
fi

"${SCRIPT_DIR}/prepare-keychain.sh"

if [[ ! -d "${WORKSPACE_PATH}" ]]; then
  echo "[build-ios] workspace not found: ${WORKSPACE_PATH}" >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "[build-ios] xcodebuild is not available." >&2
  exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "[build-ios] xcrun is not available." >&2
  exit 1
fi

echo "[build-ios] Building scheme=${SCHEME} configuration=${CONFIGURATION}"
xcodebuild_args=(
  -workspace "${WORKSPACE_PATH}" \
  -scheme "${SCHEME}" \
  -configuration "${CONFIGURATION}" \
  -destination "id=${DEVICE_ID}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  -allowProvisioningUpdates \
)

if [[ -n "${DEVELOPMENT_TEAM}" ]]; then
  xcodebuild_args+=(DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM}")
fi

xcodebuild "${xcodebuild_args[@]}" build

PRODUCTS_DIR="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-iphoneos"
APP_PATH="$(find "${PRODUCTS_DIR}" -maxdepth 1 -type d -name '*.app' | head -n 1)"

if [[ -z "${APP_PATH}" ]]; then
  echo "[build-ios] .app not found in ${PRODUCTS_DIR}" >&2
  exit 1
fi

if ! APP_ENTITLEMENTS="$(codesign -d --entitlements - "${APP_PATH}" 2>/dev/null)"; then
  echo "[build-ios] failed to read signed app entitlements: ${APP_PATH}" >&2
  exit 1
fi
if [[ "${APP_ENTITLEMENTS}" != *"aps-environment"* ]]; then
  echo "[build-ios] signed app is missing aps-environment; refusing to install a build without PUSH support" >&2
  exit 1
fi

echo "[build-ios] Installing ${APP_PATH} to device ${DEVICE_ID}"
xcrun devicectl device install app --device "${DEVICE_ID}" "${APP_PATH}"

if [[ "${LAUNCH_AFTER_INSTALL}" == "1" ]]; then
  BUNDLE_ID="${BUNDLE_ID_OVERRIDE}"
  if [[ -z "${BUNDLE_ID}" ]]; then
    BUNDLE_ID="$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${APP_PATH}/Info.plist")"
  fi
  echo "[build-ios] Launching ${BUNDLE_ID}"
  xcrun devicectl device process launch --device "${DEVICE_ID}" "${BUNDLE_ID}"
fi

echo "[build-ios] Completed successfully"
