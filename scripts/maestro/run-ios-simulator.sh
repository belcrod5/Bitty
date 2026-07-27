#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLOW_PATH="${1:-maestro/flows/ios-smoke.yaml}"
MAESTRO_HOME_DIR="${MAESTRO_HOME_DIR:-$ROOT_DIR/.maestro-home}"
DEVICE="$("${ROOT_DIR}/scripts/maestro/prepare-ios-simulator.sh")"

mkdir -p "$MAESTRO_HOME_DIR/.maestro"
mkdir -p "$ROOT_DIR/.maestro-output"

export JAVA_OPTS="${JAVA_OPTS:-} -Duser.home=$MAESTRO_HOME_DIR"
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED="${MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED:-true}"

cd "$ROOT_DIR"
exec maestro --platform ios --device "$DEVICE" test "$FLOW_PATH"
