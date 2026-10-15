#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RN_DIR="${REPO_ROOT}/expo/node_modules/react-native-macos"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bitty-scroll-animation.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

# Compile the real scroll controls without Pods or a React renderer. The Fabric
# component header imported by RCTEnhancedScrollView.h is unused by this control.
mkdir -p "${TEST_DIR}/React"
for header in RCTUIKit RCTAssert RCTDefines RCTUtils; do
  ln -s "${RN_DIR}/React/Base/${header}.h" "${TEST_DIR}/React/${header}.h"
done
ln -s "${RN_DIR}/React/Fabric/Utils/RCTGenericDelegateSplitter.h" "${TEST_DIR}/React/RCTGenericDelegateSplitter.h"
touch "${TEST_DIR}/React/RCTViewComponentView.h"

xcrun clang++ -std=c++20 -x objective-c++ -fobjc-arc -fmodules \
  -DNS_BLOCK_ASSERTIONS=1 \
  -I"${TEST_DIR}" -I"${RN_DIR}/ReactCommon" \
  -I"${RN_DIR}/React/Fabric/Mounting/ComponentViews/ScrollView" \
  "${RN_DIR}/React/Base/macOS/RCTUIKit.m" \
  "${RN_DIR}/React/Fabric/Utils/RCTGenericDelegateSplitter.mm" \
  "${RN_DIR}/React/Fabric/Mounting/ComponentViews/ScrollView/RCTEnhancedScrollView.mm" \
  "${REPO_ROOT}/scripts/macos/tests/scroll-animation.mm" \
  -framework AppKit -framework QuartzCore -framework CoreImage \
  -o "${TEST_DIR}/scroll-animation"
"${TEST_DIR}/scroll-animation"
