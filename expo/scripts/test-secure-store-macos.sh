#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIRECTORY="$(mktemp -d /private/tmp/bitty-secure-store-tests.XXXXXX)"
TEST_BINARY="${TEST_DIRECTORY}/secure-store-macos-tests"
export BITTY_KEYCHAIN_TEST_SUITE="bitty.secure-store-test.$(uuidgen)"

cleanup() {
  local scenario
  for scenario in legacy canonical both failure delete; do
    security delete-generic-password \
      -s "${BITTY_KEYCHAIN_TEST_SUITE}.${scenario}" >/dev/null 2>&1 || true
  done
  rm -rf "${TEST_DIRECTORY}"
}
trap cleanup EXIT

swiftc \
  "${SCRIPT_DIR}/../node_modules/expo-secure-store/ios/SecureStoreMacOSKeychain.swift" \
  "${SCRIPT_DIR}/test-secure-store-macos.swift" \
  -module-cache-path "${TEST_DIRECTORY}/module-cache" \
  -framework Security \
  -o "${TEST_BINARY}"

"${TEST_BINARY}"
