#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$RUNNER_DIR/native/macos-stt"
BUILD_DIR="$RUNNER_DIR/.native-build"
APP="$BUILD_DIR/BittyMacStt.app"
EXECUTABLE="$APP/Contents/MacOS/BittyMacStt"

if [ -x "$EXECUTABLE" ] && [ "$EXECUTABLE" -nt "$SOURCE_DIR/BittyMacStt.swift" ] && [ "$EXECUTABLE" -nt "$SOURCE_DIR/Info.plist" ]; then
  exit 0
fi

mkdir -p "$APP/Contents/MacOS" "$BUILD_DIR/module-cache"
cp "$SOURCE_DIR/Info.plist" "$APP/Contents/Info.plist"
xcrun swiftc \
  -module-cache-path "$BUILD_DIR/module-cache" \
  -parse-as-library \
  -framework Speech \
  -framework AVFoundation \
  -o "$EXECUTABLE" \
  "$SOURCE_DIR/BittyMacStt.swift"
codesign --force --sign - "$APP"
