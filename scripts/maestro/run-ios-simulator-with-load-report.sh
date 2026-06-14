#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLOW_PATH="${1:-maestro/flows/ios-smoke.yaml}"
APP_ID="${MAESTRO_APP_ID:-app.bitty.mobile}"
DEVICE="${MAESTRO_IOS_DEVICE:-}"
SAMPLE_INTERVAL_SECONDS="${MAESTRO_LOAD_SAMPLE_INTERVAL_SECONDS:-1}"
RUN_ID="${MAESTRO_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
MAESTRO_HOME_DIR="${MAESTRO_HOME_DIR:-$ROOT_DIR/.maestro-home}"
OUTPUT_DIR="$ROOT_DIR/.maestro-output/perf/$RUN_ID"
SAMPLES_PATH="$OUTPUT_DIR/ios-process-samples.tsv"
REPORT_PATH="$OUTPUT_DIR/report.md"
VIDEO_PATH="${MAESTRO_VIDEO_PATH:-$ROOT_DIR/debug-videos/maestro-ios-load-$RUN_ID.mp4}"

mkdir -p "$MAESTRO_HOME_DIR/.maestro"
mkdir -p "$OUTPUT_DIR"
mkdir -p "$(dirname "$VIDEO_PATH")"

export JAVA_OPTS="${JAVA_OPTS:-} -Duser.home=$MAESTRO_HOME_DIR"
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED="${MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED:-true}"

if [[ -z "$DEVICE" ]]; then
  DEVICE="$(xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p' | head -n 1)"
fi

if [[ -z "$DEVICE" ]]; then
  echo "No booted iOS Simulator found. Boot one first, or set MAESTRO_IOS_DEVICE to a Simulator UDID." >&2
  exit 1
fi

echo -e "timestamp\tpid\tcpu_percent\trss_kb\tcommand" > "$SAMPLES_PATH"

sample_load() {
  while true; do
    local timestamp
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    xcrun simctl spawn "$DEVICE" /bin/ps -A -o pid=,pcpu=,rss=,comm= 2>/dev/null \
      | awk -v timestamp="$timestamp" -v app_id="$APP_ID" '
          index($0, app_id) || index($0, "Bitty") || index($0, "bitty") {
            found = 1
            pid = $1
            cpu = $2
            rss = $3
            $1 = ""
            $2 = ""
            $3 = ""
            sub(/^ +/, "")
            printf "%s\t%s\t%s\t%s\t%s\n", timestamp, pid, cpu, rss, $0
          }
          END {
            if (!found) {
              printf "%s\t\t\t\tAPP_NOT_RUNNING\n", timestamp
            }
          }
        ' >> "$SAMPLES_PATH"
    sleep "$SAMPLE_INTERVAL_SECONDS"
  done
}

write_report() {
  local maestro_status="$1"
  awk -F '\t' \
    -v report_path="$REPORT_PATH" \
    -v samples_path="$SAMPLES_PATH" \
    -v video_path="$VIDEO_PATH" \
    -v flow_path="$FLOW_PATH" \
    -v device="$DEVICE" \
    -v app_id="$APP_ID" \
    -v maestro_status="$maestro_status" '
      NR > 1 {
        total_rows++
        if ($5 == "APP_NOT_RUNNING") {
          missing_rows++
          next
        }
        cpu = $3 + 0
        rss_mb = ($4 + 0) / 1024
        sample_rows++
        cpu_sum += cpu
        rss_sum += rss_mb
        if (sample_rows == 1 || cpu > cpu_max) cpu_max = cpu
        if (sample_rows == 1 || rss_mb > rss_max) rss_max = rss_mb
        if (first_ts == "") first_ts = $1
        last_ts = $1
      }
      END {
        status_label = maestro_status == 0 ? "success" : "failed"
        cpu_avg = sample_rows ? cpu_sum / sample_rows : 0
        rss_avg = sample_rows ? rss_sum / sample_rows : 0
        printf "# Maestro iOS Load Report\n\n" > report_path
        printf "- status: %s\n", status_label >> report_path
        printf "- flow: `%s`\n", flow_path >> report_path
        printf "- device: `%s`\n", device >> report_path
        printf "- appId: `%s`\n", app_id >> report_path
        printf "- video: `%s`\n", video_path >> report_path
        printf "- samples: `%s`\n", samples_path >> report_path
        printf "- window: %s to %s\n\n", first_ts ? first_ts : "-", last_ts ? last_ts : "-" >> report_path
        printf "## Process Load\n\n" >> report_path
        printf "| metric | value |\n| --- | ---: |\n" >> report_path
        printf "| samples | %d |\n", sample_rows >> report_path
        printf "| app not running samples | %d |\n", missing_rows >> report_path
        printf "| avg CPU %% | %.2f |\n", cpu_avg >> report_path
        printf "| max CPU %% | %.2f |\n", cpu_max >> report_path
        printf "| avg RSS MB | %.1f |\n", rss_avg >> report_path
        printf "| max RSS MB | %.1f |\n", rss_max >> report_path
      }
    ' "$SAMPLES_PATH"
}

record_pid=""
sampler_pid=""

cleanup() {
  if [[ -n "$record_pid" ]] && kill -0 "$record_pid" 2>/dev/null; then
    kill -INT "$record_pid" 2>/dev/null || true
    wait "$record_pid" 2>/dev/null || true
  fi
  if [[ -n "$sampler_pid" ]] && kill -0 "$sampler_pid" 2>/dev/null; then
    kill "$sampler_pid" 2>/dev/null || true
    wait "$sampler_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

sample_load &
sampler_pid="$!"

xcrun simctl io "$DEVICE" recordVideo "$VIDEO_PATH" &
record_pid="$!"
sleep 1

set +e
cd "$ROOT_DIR"
maestro --platform ios --device "$DEVICE" test "$FLOW_PATH"
maestro_status="$?"
set -e

cleanup
record_pid=""
sampler_pid=""

write_report "$maestro_status"

echo "Report: $REPORT_PATH"
echo "Video: $VIDEO_PATH"

exit "$maestro_status"
