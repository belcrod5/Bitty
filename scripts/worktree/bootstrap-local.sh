#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="${DEFAULT_REPO_ROOT}"
DO_ENV=0
DO_PRIVATE_RUNNER=0
DO_EXPO=0
DO_IOS_NATIVE=0

usage() {
  cat >&2 <<'EOF'
Usage: ./scripts/worktree/bootstrap-local.sh [--repo-root <path>] [--env] [--private-runner] [--expo] [--ios-native]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      if [[ $# -lt 2 ]]; then
        echo "[bootstrap-local] --repo-root requires a value" >&2
        usage
        exit 1
      fi
      REPO_ROOT="$2"
      shift 2
      ;;
    --env)
      DO_ENV=1
      shift
      ;;
    --private-runner)
      DO_PRIVATE_RUNNER=1
      shift
      ;;
    --expo)
      DO_EXPO=1
      shift
      ;;
    --ios-native)
      DO_IOS_NATIVE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[bootstrap-local] unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -d "${REPO_ROOT}" ]]; then
  echo "[bootstrap-local] repo root not found: ${REPO_ROOT}" >&2
  exit 1
fi

REPO_ROOT="$(cd "${REPO_ROOT}" && pwd -P)"

if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.env"
  set +a
fi

require_main_repo_root() {
  if [[ -z "${BITTY_MAIN_REPO_ROOT:-}" ]]; then
    echo "[bootstrap-local] BITTY_MAIN_REPO_ROOT is required. Set it in ${REPO_ROOT}/.env or export it before running." >&2
    exit 1
  fi
  if [[ ! -d "${BITTY_MAIN_REPO_ROOT}" ]]; then
    echo "[bootstrap-local] BITTY_MAIN_REPO_ROOT not found: ${BITTY_MAIN_REPO_ROOT}" >&2
    exit 1
  fi
  cd "${BITTY_MAIN_REPO_ROOT}" && pwd -P
}

MAIN_REPO_ROOT=""
if [[ "${DO_ENV}" == "1" || "${DO_IOS_NATIVE}" == "1" ]]; then
  MAIN_REPO_ROOT="$(require_main_repo_root)"
fi

copy_local_env_files() {
  if [[ "${MAIN_REPO_ROOT}" == "${REPO_ROOT}" ]]; then
    return 0
  fi

  local copied=0
  local source_path=""
  local relative_path=""
  local target_path=""

  while IFS= read -r source_path; do
    relative_path="${source_path#"${MAIN_REPO_ROOT}/"}"
    target_path="${REPO_ROOT}/${relative_path}"
    mkdir -p "$(dirname "${target_path}")"
    cp -p "${source_path}" "${target_path}"
    echo "[bootstrap-local] copied ${relative_path}"
    copied=$((copied + 1))
  done < <(
    find "${MAIN_REPO_ROOT}" \
      -path "${MAIN_REPO_ROOT}/.git" -prune -o \
      -path "${MAIN_REPO_ROOT}/expo/node_modules" -prune -o \
      -path "${MAIN_REPO_ROOT}/expo/ios" -prune -o \
      -path "${MAIN_REPO_ROOT}/private_runner/node_modules" -prune -o \
      -path "${MAIN_REPO_ROOT}/private_runner/logs" -prune -o \
      -type f \( -name ".env" -o -name ".env.*" \) \
      ! -name "*.example" \
      -print | sort
  )

  if [[ "${copied}" -eq 0 ]]; then
    echo "[bootstrap-local] no local env files found"
  fi

  if [[ ! -f "${REPO_ROOT}/.env" ]] || ! grep -q '^BITTY_MAIN_REPO_ROOT=' "${REPO_ROOT}/.env"; then
    {
      echo
      echo "BITTY_MAIN_REPO_ROOT=${MAIN_REPO_ROOT}"
    } >> "${REPO_ROOT}/.env"
    echo "[bootstrap-local] ensured BITTY_MAIN_REPO_ROOT in .env"
  fi
}

ensure_npm_install() {
  local package_dir="$1"
  local label="$2"

  if [[ -d "${package_dir}/node_modules" ]]; then
    return 0
  fi
  if [[ ! -f "${package_dir}/package.json" ]]; then
    echo "[bootstrap-local] ${label} package.json not found: ${package_dir}" >&2
    exit 1
  fi

  echo "[bootstrap-local] installing ${label} dependencies"
  (cd "${package_dir}" && npm install)
}

copy_ios_native_from_main() {
  local source_ios="${MAIN_REPO_ROOT}/expo/ios"
  local target_ios="${REPO_ROOT}/expo/ios"

  if [[ "${MAIN_REPO_ROOT}" == "${REPO_ROOT}" || ! -d "${source_ios}/Bitty.xcworkspace" ]]; then
    return 1
  fi

  if ! command -v rsync >/dev/null 2>&1; then
    echo "[bootstrap-local] rsync is required to copy expo/ios safely" >&2
    exit 1
  fi

  mkdir -p "${target_ios}"
  echo "[bootstrap-local] copying expo/ios from main worktree"
  rsync -a \
    --exclude '/build/' \
    --exclude 'DerivedData/' \
    --exclude 'xcuserdata/' \
    --exclude '*.xcuserstate' \
    --exclude '*.p12' \
    --exclude '*.mobileprovision' \
    --exclude '*.key' \
    --exclude '*.pem' \
    "${source_ios}/" "${target_ios}/"
}

ensure_ios_native_workspace() {
  local expo_dir="${REPO_ROOT}/expo"
  local ios_dir="${expo_dir}/ios"
  local workspace_path="${ios_dir}/Bitty.xcworkspace"

  if [[ -d "${workspace_path}" ]]; then
    return 0
  fi

  if ! copy_ios_native_from_main; then
    echo "[bootstrap-local] generating expo/ios workspace"
    (cd "${expo_dir}" && npx expo prebuild --platform ios)
  fi

  if [[ ! -d "${workspace_path}" ]]; then
    echo "[bootstrap-local] failed to prepare iOS workspace: ${workspace_path}" >&2
    exit 1
  fi
}

ensure_ios_pods() {
  local ios_dir="${REPO_ROOT}/expo/ios"
  local manifest_lock="${ios_dir}/Pods/Manifest.lock"

  if ! command -v pod >/dev/null 2>&1; then
    echo "[bootstrap-local] CocoaPods is required because expo/ios/Pods is missing" >&2
    exit 1
  fi

  if [[ -d "${ios_dir}/Pods" && -f "${manifest_lock}" ]] &&
    [[ ! "${REPO_ROOT}/expo/package.json" -nt "${manifest_lock}" ]] &&
    [[ ! "${REPO_ROOT}/expo/package-lock.json" -nt "${manifest_lock}" ]] &&
    [[ ! "${ios_dir}/Podfile" -nt "${manifest_lock}" ]] &&
    [[ ! "${ios_dir}/Podfile.properties.json" -nt "${manifest_lock}" ]]; then
    return 0
  fi

  echo "[bootstrap-local] installing/updating iOS pods"
  (cd "${ios_dir}" && pod install)
}

if [[ "${DO_ENV}" == "1" ]]; then
  copy_local_env_files
fi
if [[ "${DO_PRIVATE_RUNNER}" == "1" ]]; then
  ensure_npm_install "${REPO_ROOT}/private_runner" "private_runner"
fi
if [[ "${DO_EXPO}" == "1" ]]; then
  ensure_npm_install "${REPO_ROOT}/expo" "expo"
fi
if [[ "${DO_IOS_NATIVE}" == "1" ]]; then
  ensure_ios_native_workspace
  ensure_ios_pods
fi
