#!/bin/bash
# macOS Releaseビルドを安定した署名IDで再署名する。
#
# xcodebuild既定のadhoc署名では designated requirement がバイナリのハッシュに
# なるため、リビルドのたびにkeychainから別アプリ扱いされ、保存済み認証情報への
# アクセス許可(パスワード入力)を毎回求められる。チーム証明書で署名すると
# requirement が「バンドルID+チーム」基準になり、リビルド後も許可が持続する。
#
# 使い方: ./scripts/sign-macos-release.sh [app-path]
# 署名IDは BITTY_MACOS_SIGN_IDENTITY で上書き可能。
set -euo pipefail

APP_PATH="${1:-"$(dirname "$0")/../build/macos-release/Build/Products/Release/bitty.app"}"
IDENTITY="${BITTY_MACOS_SIGN_IDENTITY:-Developer ID Application: COLLABO Inc. (U8SYKSPD98)}"

codesign --force --deep --sign "$IDENTITY" "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
codesign -dv "$APP_PATH" 2>&1 | grep -E 'TeamIdentifier|Identifier=' || true
echo "signed: $APP_PATH"
