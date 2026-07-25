#!/usr/bin/env bash

CODEX_MINIMUM_APP_SERVER_VERSION="0.145.0"

codex_version_is_supported() {
  local version="$1"
  local minimum="$2"
  local version_major version_minor version_patch
  local minimum_major minimum_minor minimum_patch
  IFS=. read -r version_major version_minor version_patch <<<"$version"
  IFS=. read -r minimum_major minimum_minor minimum_patch <<<"$minimum"
  [ "${version_major:-0}" -gt "${minimum_major:-0}" ] || {
    [ "${version_major:-0}" -eq "${minimum_major:-0}" ] && {
      [ "${version_minor:-0}" -gt "${minimum_minor:-0}" ] || {
        [ "${version_minor:-0}" -eq "${minimum_minor:-0}" ] &&
          [ "${version_patch:-0}" -ge "${minimum_patch:-0}" ]
      }
    }
  }
}

require_codex_minimum_version() {
  if [ "$CODEX_ENABLE" != "1" ]; then
    return 0
  fi
  local output version
  if ! output="$(codex --version 2>/dev/null)"; then
    echo "[run-local] Codex CLIのversionを取得できません。Codexを更新してください: npm install -g @openai/codex@latest" >&2
    return 1
  fi
  version="$(printf '%s\n' "$output" | sed -nE 's/.*[^0-9]([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1)"
  if [ -z "$version" ] || ! codex_version_is_supported "$version" "$CODEX_MINIMUM_APP_SERVER_VERSION"; then
    echo "[run-local] Codex CLI ${version:-unknown} は未対応です。${CODEX_MINIMUM_APP_SERVER_VERSION}以上へ更新してください: npm install -g @openai/codex@latest" >&2
    return 1
  fi
}
