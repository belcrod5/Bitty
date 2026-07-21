#!/usr/bin/env bash
set -euo pipefail

DEVPOST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEVPOST_APP_ID="app.bitty.mobile"
DEVPOST_OUTSIDE_LOCATION="35.690921,139.700258"
DEVPOST_STORE_LOCATION="35.681236,139.767125"
DEVPOST_MAESTRO_HOME="${MAESTRO_HOME_DIR:-$DEVPOST_ROOT/.maestro-home}"
DEVPOST_DEVICE="${MAESTRO_IOS_DEVICE:-}"

usage() {
  echo "Usage: $0 <check|outside|chat|file|rule|arrive|notify> [scheduled-session-id]"
  echo
  echo "  check    Show the selected booted Simulator and manual prerequisites."
  echo "  outside  Put the Simulator outside the Grocery Store geofence."
  echo "  chat     Select GPT-5.6 Luna / low and create 買い物リスト.md."
  echo "  file     Open the generated grocery list in Bitty's file editor."
  echo "  rule     Configure a future Grocery Store arrival rule."
  echo "  arrive   Background Bitty and move the Simulator into the geofence."
  echo "  notify   Inject a clearly labelled simulated notification."
}

resolve_device() {
  if [[ -n "$DEVPOST_DEVICE" ]]; then
    return
  fi
  DEVPOST_DEVICE="$(xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p' | head -n 1)"
  if [[ -z "$DEVPOST_DEVICE" ]]; then
    echo "No booted iOS Simulator found. Boot one or set MAESTRO_IOS_DEVICE." >&2
    exit 1
  fi
}

run_flow() {
  local flow_path="$1"
  shift
  mkdir -p "$DEVPOST_MAESTRO_HOME/.maestro" "$DEVPOST_ROOT/.maestro-output"
  JAVA_OPTS="${JAVA_OPTS:-} -Duser.home=$DEVPOST_MAESTRO_HOME" \
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
    maestro --platform ios --device "$DEVPOST_DEVICE" test "$@" "$flow_path"
}

command_name="${1:-}"
resolve_device

case "$command_name" in
  check)
    echo "Simulator UDID: $DEVPOST_DEVICE"
    echo "Required before 'chat':"
    echo "  1. The prebuilt Release app is installed; Metro is not required."
    echo "  2. A workspace directory and chat session selected in Bitty."
    echo "  3. Runner and Codex WS URLs point to 127.0.0.1:8788."
    echo "  4. Runner Token and Codex WS Token entered manually by the owner."
    echo "  5. Location permission granted as Always for $DEVPOST_APP_ID."
    echo "  6. No existing location schedule rules in the app."
    ;;
  outside)
    xcrun simctl location "$DEVPOST_DEVICE" set "$DEVPOST_OUTSIDE_LOCATION"
    echo "Simulator is outside the Grocery Store geofence."
    ;;
  chat)
    run_flow "$DEVPOST_ROOT/maestro/flows/devpost-chat.yaml"
    ;;
  file)
    run_flow "$DEVPOST_ROOT/maestro/flows/devpost-file.yaml"
    ;;
  rule)
    start_time="$(date -v+2M '+%H:%M')"
    end_time="$(date -v+7M '+%H:%M')"
    if [[ "$start_time" > "$end_time" ]]; then
      echo "The demo time window would cross midnight. Run this phase earlier in the day." >&2
      exit 1
    fi
    echo "Rule window: $start_time-$end_time"
    xcrun simctl location "$DEVPOST_DEVICE" set "$DEVPOST_STORE_LOCATION"
    if run_flow "$DEVPOST_ROOT/maestro/flows/devpost-location-rule.yaml" \
      -e "DEMO_START_TIME=$start_time" \
      -e "DEMO_END_TIME=$end_time"; then
      xcrun simctl location "$DEVPOST_DEVICE" set "$DEVPOST_OUTSIDE_LOCATION"
    else
      run_status=$?
      xcrun simctl location "$DEVPOST_DEVICE" set "$DEVPOST_OUTSIDE_LOCATION"
      exit "$run_status"
    fi
    echo "Rule saved. Keep the Simulator outside until the start time."
    ;;
  arrive)
    echo "Run this only after the saved rule window has started."
    read -r -p "Press Return to background Bitty and simulate arrival... "
    run_flow "$DEVPOST_ROOT/maestro/flows/devpost-background.yaml"
    xcrun simctl location "$DEVPOST_DEVICE" set "$DEVPOST_STORE_LOCATION"
    echo "Arrival injected. Wait for the scheduled Codex occurrence to complete."
    echo "Run 'notify' after the scheduled Codex occurrence completes."
    echo "Omit the session ID for the public presentation-only notification."
    ;;
  notify)
    scheduled_session_id="${2:-}"
    if [[ -z "$scheduled_session_id" ]]; then
      xcrun simctl push "$DEVPOST_DEVICE" "$DEVPOST_APP_ID" \
        "$DEVPOST_ROOT/maestro/payloads/devpost-notification.apns"
      echo "Presentation-only notification injected. Open Notification Center if no banner appears."
      exit 0
    fi
    if [[ ! "$scheduled_session_id" =~ ^[A-Za-z0-9_-]{8,128}$ ]]; then
      echo "The scheduled Codex session ID contains unsupported characters." >&2
      exit 1
    fi
    payload_path="$(mktemp -t bitty-devpost-push)"
    trap 'rm -f "$payload_path"' EXIT
    printf '%s\n' \
      '{' \
      '  "Simulator Target Bundle": "app.bitty.mobile",' \
      '  "aps": {' \
      '    "alert": {' \
      '      "title": "Bitty · Grocery Store",' \
      '      "body": "Simulator notification: your scheduled grocery checklist is ready."' \
      '    },' \
      '    "sound": "default",' \
      '    "category": "TURN_COMPLETED"' \
      '  },' \
      "  \"sessionId\": \"$scheduled_session_id\"" \
      '}' > "$payload_path"
    xcrun simctl push "$DEVPOST_DEVICE" "$DEVPOST_APP_ID" "$payload_path"
    echo "Simulated notification injected. Tap it manually to open the real scheduled session."
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
