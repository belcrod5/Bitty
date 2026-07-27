#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/bitty-maestro-test.XXXXXX")"
TEST_ROOT="$(cd "${TEST_ROOT}" && pwd)"
CALL_LOG="${TEST_ROOT}/calls.log"
FAKE_BIN="${TEST_ROOT}/bin"
DEVICE_ID="11111111-2222-3333-4444-555555555555"

cleanup() {
  if [[ -n "${TEST_ROOT}" && -d "${TEST_ROOT}" ]]; then
    rm -rf "${TEST_ROOT}"
  fi
}
trap cleanup EXIT

mkdir -p \
  "${FAKE_BIN}" \
  "${TEST_ROOT}/expo" \
  "${TEST_ROOT}/maestro/flows" \
  "${TEST_ROOT}/scripts/maestro" \
  "${TEST_ROOT}/scripts/worktree"

cp "${SOURCE_ROOT}/scripts/maestro/prepare-ios-simulator.sh" "${TEST_ROOT}/scripts/maestro/"
cp "${SOURCE_ROOT}/scripts/maestro/run-ios-simulator.sh" "${TEST_ROOT}/scripts/maestro/"
cp "${SOURCE_ROOT}/scripts/maestro/run-ios-simulator-with-load-report.sh" "${TEST_ROOT}/scripts/maestro/"

cat > "${TEST_ROOT}/scripts/worktree/bootstrap-local.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'bootstrap:%s\n' "$*" >> "${CALL_LOG}"
EOF

cat > "${FAKE_BIN}/xcrun" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'xcrun:%s\n' "\$*" >> "\${CALL_LOG}"
if [[ "\$*" == "simctl list devices booted" ]]; then
  printf '    iPhone Test (${DEVICE_ID}) (Booted)\\n'
elif [[ "\${1:-}" == "simctl" && "\${2:-}" == "spawn" ]]; then
  printf '123 1.5 2048 app.bitty.mobile\\n'
elif [[ "\${1:-}" == "simctl" && "\${2:-}" == "io" ]]; then
  exit 0
fi
EOF

cat > "${FAKE_BIN}/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npx:%s:%s\n' "${PWD##*/}" "$*" >> "${CALL_LOG}"
EOF

cat > "${FAKE_BIN}/maestro" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'maestro:%s\n' "$*" >> "${CALL_LOG}"
EOF

chmod +x \
  "${FAKE_BIN}/maestro" \
  "${FAKE_BIN}/npx" \
  "${FAKE_BIN}/xcrun" \
  "${TEST_ROOT}/scripts/maestro/prepare-ios-simulator.sh" \
  "${TEST_ROOT}/scripts/maestro/run-ios-simulator.sh" \
  "${TEST_ROOT}/scripts/maestro/run-ios-simulator-with-load-report.sh" \
  "${TEST_ROOT}/scripts/worktree/bootstrap-local.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_equals() {
  local expected="$1"
  local actual="$2"
  [[ "${actual}" == "${expected}" ]] || fail "expected '${expected}', got '${actual}'"
}

assert_log_line() {
  local line_number="$1"
  local expected="$2"
  local actual
  actual="$(sed -n "${line_number}p" "${CALL_LOG}")"
  assert_equals "${expected}" "${actual}"
}

assert_before() {
  local first_pattern="$1"
  local second_pattern="$2"
  local first_line
  local second_line
  first_line="$(grep -n -m 1 "^${first_pattern}" "${CALL_LOG}" | cut -d: -f1)"
  second_line="$(grep -n -m 1 "^${second_pattern}" "${CALL_LOG}" | cut -d: -f1)"
  [[ -n "${first_line}" && -n "${second_line}" && "${first_line}" -lt "${second_line}" ]] ||
    fail "expected '${first_pattern}' before '${second_pattern}'"
}

: > "${CALL_LOG}"
resolved_device="$(
  PATH="${FAKE_BIN}:${PATH}" \
    CALL_LOG="${CALL_LOG}" \
    "${TEST_ROOT}/scripts/maestro/prepare-ios-simulator.sh" 2>/dev/null
)"
assert_equals "${DEVICE_ID}" "${resolved_device}"
assert_log_line 1 "xcrun:simctl list devices booted"
assert_log_line 2 "bootstrap:--repo-root ${TEST_ROOT} --env --expo --ios-native"
assert_log_line 3 "npx:expo:expo run:ios --device ${DEVICE_ID} --no-bundler"

: > "${CALL_LOG}"
explicit_device="$(
  PATH="${FAKE_BIN}:${PATH}" \
    CALL_LOG="${CALL_LOG}" \
    MAESTRO_IOS_DEVICE="explicit-device" \
    "${TEST_ROOT}/scripts/maestro/prepare-ios-simulator.sh" 2>/dev/null
)"
assert_equals "explicit-device" "${explicit_device}"
assert_log_line 1 "bootstrap:--repo-root ${TEST_ROOT} --env --expo --ios-native"
assert_log_line 2 "npx:expo:expo run:ios --device explicit-device --no-bundler"

: > "${CALL_LOG}"
PATH="${FAKE_BIN}:${PATH}" \
  CALL_LOG="${CALL_LOG}" \
  MAESTRO_HOME_DIR="${TEST_ROOT}/maestro-home" \
  "${TEST_ROOT}/scripts/maestro/run-ios-simulator.sh" "maestro/flows/custom.yaml" >/dev/null 2>&1
assert_before "bootstrap:" "npx:"
assert_before "npx:" "maestro:"
grep -q "^maestro:--platform ios --device ${DEVICE_ID} test maestro/flows/custom.yaml$" "${CALL_LOG}" ||
  fail "smoke runner did not pass the prepared device to Maestro"

: > "${CALL_LOG}"
PATH="${FAKE_BIN}:${PATH}" \
  CALL_LOG="${CALL_LOG}" \
  MAESTRO_HOME_DIR="${TEST_ROOT}/maestro-home" \
  MAESTRO_RUN_ID="test-run" \
  MAESTRO_VIDEO_PATH="${TEST_ROOT}/test.mp4" \
  "${TEST_ROOT}/scripts/maestro/run-ios-simulator-with-load-report.sh" "maestro/flows/load.yaml" >/dev/null 2>&1
assert_before "bootstrap:" "npx:"
assert_before "npx:" "maestro:"
grep -q "^maestro:--platform ios --device ${DEVICE_ID} test maestro/flows/load.yaml$" "${CALL_LOG}" ||
  fail "load runner did not pass the prepared device to Maestro"

echo "PASS: Maestro iOS Simulator scripts prepare the current native app before each flow"
