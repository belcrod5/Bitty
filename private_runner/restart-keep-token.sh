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

RUNNER_TOKEN_FILE="${RUNNER_TOKEN_FILE:-$SCRIPT_DIR/logs/runner-token}"
if [ ! -f "$RUNNER_TOKEN_FILE" ] || [ ! -r "$RUNNER_TOKEN_FILE" ]; then
  echo "[restart-keep-token] runner token file is not readable: $RUNNER_TOKEN_FILE" >&2
  exit 1
fi

RUN_LOCAL_RUNNER_TOKEN="$(<"$RUNNER_TOKEN_FILE")"
if [ -z "$RUN_LOCAL_RUNNER_TOKEN" ]; then
  echo "[restart-keep-token] runner token file is empty: $RUNNER_TOKEN_FILE" >&2
  exit 1
fi

export RUN_LOCAL_RUNNER_TOKEN
exec "$SCRIPT_DIR/run-local.sh" restart "$@"
