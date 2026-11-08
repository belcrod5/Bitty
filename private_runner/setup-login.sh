#!/usr/bin/env bash
set -euo pipefail

if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "✕ Macのターミナルから実行してください。" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

command -v node >/dev/null || { echo "✕ Node.jsが必要です。" >&2; exit 1; }
umask 077
PREPARE_LOG="$(mktemp "${TMPDIR:-/tmp}/bitty-login-prepare.XXXXXX")"
echo "◌ 設定を確認しています…"
if ! "$PROJECT_ROOT/scripts/worktree/bootstrap-local.sh" --repo-root "$PROJECT_ROOT" --env --private-runner >"$PREPARE_LOG" 2>&1; then
  echo "✕ 準備できませんでした。詳細: $PREPARE_LOG" >&2
  exit 1
fi
rm -f "$PREPARE_LOG"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

exec node "$SCRIPT_DIR/tools/runner-login.mjs" setup
