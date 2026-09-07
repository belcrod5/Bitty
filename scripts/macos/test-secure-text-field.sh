#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPO_DIR="${REPO_ROOT}/expo"
RN_DIR="${EXPO_DIR}/node_modules/react-native-macos"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bitty-secure-text-field.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

# Compile the actual patched controls and delegate adapter, without launching Bitty.
# Pods headers must already exist (scripts/macos/build-expo-macos.sh prepares them).
xcrun clang++ -std=c++20 -fobjc-arc -fmodules \
  -Wno-protocol -Wno-incomplete-implementation -Wno-objc-protocol-property-synthesis \
  -Wno-property-attribute-mismatch \
  -I"${EXPO_DIR}/macos/Pods/Headers/Public/React-Core" \
  -I"${EXPO_DIR}/macos/Pods/Headers/Private/React-RCTText" \
  -I"${EXPO_DIR}/macos/Pods/Headers/Public/Yoga" \
  "${RN_DIR}/Libraries/Text/TextInput/Singleline/RCTUITextField.mm" \
  "${RN_DIR}/Libraries/Text/TextInput/Singleline/macOS/RCTUISecureTextField.mm" \
  "${RN_DIR}/Libraries/Text/TextInput/RCTBackedTextInputDelegateAdapter.mm" \
  "${REPO_ROOT}/scripts/macos/tests/secure-text-field.mm" \
  -framework AppKit -o "${TEST_DIR}/secure-text-field"
"${TEST_DIR}/secure-text-field"
