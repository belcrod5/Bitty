#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Match run-local.sh: relative paths from .env are resolved from the repository root.
cd "$PROJECT_ROOT"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

TOKEN_FILE="${RUNNER_TOKEN_FILE:-private_runner/logs/runner-token}"
TOKEN_SOURCE="$TOKEN_FILE"
case "$TOKEN_FILE" in
  /*) ;;
  *)
    TOKEN_SOURCE="$PROJECT_ROOT/$TOKEN_FILE"
    if [ ! -f "$TOKEN_SOURCE" ] || [ ! -r "$TOKEN_SOURCE" ]; then
      if ! BITTY_MAIN_REPO_ROOT_VALUE="$(
        # shellcheck disable=SC1091
        if [ -f "$PROJECT_ROOT/.env" ] && ! source "$PROJECT_ROOT/.env" >/dev/null 2>&1; then
          exit 1
        fi
        printf '%s' "${BITTY_MAIN_REPO_ROOT:-}"
      )"; then
        echo "[restart-keep-token] failed to load $PROJECT_ROOT/.env" >&2
        exit 1
      fi
      if [ -n "$BITTY_MAIN_REPO_ROOT_VALUE" ]; then
        TOKEN_SOURCE="$BITTY_MAIN_REPO_ROOT_VALUE/$TOKEN_FILE"
      fi
    fi
    ;;
esac

if [ ! -f "$TOKEN_SOURCE" ] || [ ! -r "$TOKEN_SOURCE" ]; then
  echo "[restart-keep-token] runner token file is not readable: $TOKEN_SOURCE" >&2
  exit 1
fi

RUN_LOCAL_RUNNER_TOKEN="$(<"$TOKEN_SOURCE")"
if [ -z "$RUN_LOCAL_RUNNER_TOKEN" ]; then
  echo "[restart-keep-token] runner token file is empty: $TOKEN_SOURCE" >&2
  exit 1
fi

export RUN_LOCAL_RUNNER_TOKEN
exec "$SCRIPT_DIR/run-local.sh" restart "$@"
