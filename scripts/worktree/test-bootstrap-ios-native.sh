#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/bitty-bootstrap-ios-test.XXXXXX")"
trap 'rm -rf "${TEST_ROOT}"' EXIT
FAKE_BIN="${TEST_ROOT}/bin"
MAIN="${TEST_ROOT}/main"
mkdir -p "${FAKE_BIN}" "${MAIN}/expo/ios/Bitty.xcworkspace" \
  "${MAIN}/expo/ios/Pods/React-Core-prebuilt" \
  "${MAIN}/expo/ios/Pods/ReactNativeDependencies"

cat > "${FAKE_BIN}/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npx:%s\n' "$*" >> "${CALL_LOG}"
EOF
cat > "${FAKE_BIN}/pod" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'pod:%s\n' "$*" >> "${CALL_LOG}"
[[ "$*" == "install" ]]
if [[ "${FAIL_POD:-0}" == "1" ]]; then
  exit 1
fi
touch Pods/Manifest.lock
EOF
chmod +x "${FAKE_BIN}/npx" "${FAKE_BIN}/pod"

for file in expo/package.json expo/package-lock.json expo/ios/Podfile expo/ios/Podfile.properties.json; do
  mkdir -p "${MAIN}/$(dirname "${file}")"
  touch "${MAIN}/${file}"
  touch -t 202610010000 "${MAIN}/${file}"
done
touch "${MAIN}/expo/ios/Pods/Manifest.lock"
touch -t 202610020000 "${MAIN}/expo/ios/Pods/Manifest.lock"
for marker in \
  Pods/.last_build_configuration \
  Pods/React-Core-prebuilt/.last_build_configuration \
  Pods/ReactNativeDependencies/.last_build_configuration; do
  printf Release > "${MAIN}/expo/ios/${marker}"
  touch -t 202610030000 "${MAIN}/expo/ios/${marker}"
done

run_bootstrap() {
  local worktree="$1"
  PATH="${FAKE_BIN}:${PATH}" \
    BITTY_MAIN_REPO_ROOT="${MAIN}" \
    CALL_LOG="${TEST_ROOT}/calls.log" \
    FAIL_POD="${FAIL_POD:-0}" \
    "${SOURCE_ROOT}/scripts/worktree/bootstrap-local.sh" \
      --repo-root "${worktree}" --ios-native > "${TEST_ROOT}/output.log" 2>&1
}

assert_empty_markers() {
  local worktree="$1"
  for marker in \
    Pods/.last_build_configuration \
    Pods/React-Core-prebuilt/.last_build_configuration \
    Pods/ReactNativeDependencies/.last_build_configuration; do
    [[ -f "${worktree}/expo/ios/${marker}" && ! -s "${worktree}/expo/ios/${marker}" ]] || {
      echo "expected empty ${marker}" >&2
      exit 1
    }
  done
}

assert_calls() {
  local actual
  actual="$(cat "${TEST_ROOT}/calls.log")"
  if [[ "${actual}" != "$1" ]]; then
    printf 'expected calls: %s\nactual calls: %s\n' "$1" "${actual}" >&2
    exit 1
  fi
}

# First copy reuses main's Pods, but must reinstall once even if the copied
# Manifest.lock is newer than every dependency input.
mkdir -p "${TEST_ROOT}/copied/expo"
cp -p "${MAIN}/expo/package.json" "${MAIN}/expo/package-lock.json" "${TEST_ROOT}/copied/expo/"
: > "${TEST_ROOT}/calls.log"
run_bootstrap "${TEST_ROOT}/copied"
assert_calls $'npx:expo prebuild --platform ios --no-install\npod:install'
assert_empty_markers "${TEST_ROOT}/copied"

# An existing workspace can retain a Release marker from before a newer pod
# install; cache hit still has to invalidate that stale marker.
cp -pR "${MAIN}" "${TEST_ROOT}/stale"
for marker in \
  Pods/.last_build_configuration \
  Pods/React-Core-prebuilt/.last_build_configuration \
  Pods/ReactNativeDependencies/.last_build_configuration; do
  touch -t 202610010000 "${TEST_ROOT}/stale/expo/ios/${marker}"
done
: > "${TEST_ROOT}/calls.log"
run_bootstrap "${TEST_ROOT}/stale"
assert_calls 'npx:expo prebuild --platform ios --no-install'
assert_empty_markers "${TEST_ROOT}/stale"

# A current marker needs no pod install and no replacement.
cp -pR "${MAIN}" "${TEST_ROOT}/current"
: > "${TEST_ROOT}/calls.log"
run_bootstrap "${TEST_ROOT}/current"
assert_calls 'npx:expo prebuild --platform ios --no-install'
[[ "$(cat "${TEST_ROOT}/current/expo/ios/Pods/.last_build_configuration")" == Release ]]

# A failed pod install must not leave the old Release marker in place.
cp -pR "${MAIN}" "${TEST_ROOT}/failed"
touch "${TEST_ROOT}/failed/expo/package.json"
: > "${TEST_ROOT}/calls.log"
FAIL_POD=1
if run_bootstrap "${TEST_ROOT}/failed"; then
  echo 'expected pod install failure' >&2
  exit 1
fi
assert_empty_markers "${TEST_ROOT}/failed"

echo 'iOS native bootstrap tests passed'
