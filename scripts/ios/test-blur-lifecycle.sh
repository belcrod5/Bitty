#!/bin/bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo "Usage: $0 <booted-simulator-udid>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BLUR_DIR="${REPO_ROOT}/expo/node_modules/expo-blur/ios"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bitty-blur-lifecycle.XXXXXX")"
APP_DIR="${TEST_DIR}/BlurLifecycle.app"
BUNDLE_ID="dev.bitty.tests.blur-lifecycle.${RANDOM}"
SIMULATOR_ID="$1"
cleanup() {
  xcrun simctl terminate "$SIMULATOR_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl uninstall "$SIMULATOR_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT
mkdir -p "$APP_DIR"

# Compile the installed implementation without Expo's unrelated enum registration.
sed '/^import ExpoModulesCore$/d' "$BLUR_DIR/BlurEffectView.swift" > "$TEST_DIR/BlurEffectView.swift"
sed -e 's/^import ExpoModulesCore$/import UIKit/' -e 's/String, Enumerable/String/' \
  "$BLUR_DIR/TintStyle.swift" > "$TEST_DIR/TintStyle.swift"
cat > "$APP_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>BlurLifecycle</string>
<key>CFBundleName</key><string>BlurLifecycle</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>18.0</string>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
<key>UILaunchScreen</key><dict/>
</dict></plist>
PLIST
xcrun --sdk iphonesimulator swiftc \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target "$(uname -m)-apple-ios18.0-simulator" \
  -module-cache-path "$TEST_DIR/module-cache" \
  "$REPO_ROOT/scripts/ios/tests/blur-lifecycle.swift" \
  "$TEST_DIR/BlurEffectView.swift" "$TEST_DIR/TintStyle.swift" \
  -o "$APP_DIR/BlurLifecycle"
codesign --force --sign - "$APP_DIR" >/dev/null 2>&1
xcrun simctl install "$SIMULATOR_ID" "$APP_DIR"
xcrun simctl launch "$SIMULATOR_ID" "$BUNDLE_ID" >/dev/null
APP_DATA="$(xcrun simctl get_app_container "$SIMULATOR_ID" "$BUNDLE_ID" data)"
for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ -f "$APP_DATA/Documents/result.txt" ]]; then
    result="$(cat "$APP_DATA/Documents/result.txt")"
    echo "$result"
    [[ "$result" == PASS:* ]]
    exit
  fi
  sleep 0.1
done
echo "FAIL: simulator blur test did not produce a result within 10 seconds" >&2
exit 1
