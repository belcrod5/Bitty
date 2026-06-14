#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLOW_PATH="${1:-maestro/flows/ios-smoke.yaml}"
DEVICE="${MAESTRO_IOS_DEVICE:-}"
MAESTRO_HOME_DIR="${MAESTRO_HOME_DIR:-$ROOT_DIR/.maestro-home}"

mkdir -p "$MAESTRO_HOME_DIR/.maestro"
mkdir -p "$ROOT_DIR/.maestro-output"

export JAVA_OPTS="${JAVA_OPTS:-} -Duser.home=$MAESTRO_HOME_DIR"
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED="${MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED:-true}"

if [[ -z "$DEVICE" ]]; then
  DEVICE="$(xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p' | head -n 1)"
fi

if [[ -z "$DEVICE" ]]; then
  echo "No booted iOS Simulator found. Boot one first, or set MAESTRO_IOS_DEVICE to a Simulator UDID." >&2
  exit 1
fi

cd "$ROOT_DIR"
exec maestro --platform ios --device "$DEVICE" test "$FLOW_PATH"
