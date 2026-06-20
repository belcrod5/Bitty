#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$PROJECT_ROOT/../.." && pwd)"
LOCAL_NODE_BIN="$WORKSPACE_ROOT/.local/node-v24.14.1-darwin-x64/bin"
BOOTSTRAP_LOCAL_SCRIPT="$PROJECT_ROOT/scripts/worktree/bootstrap-local.sh"

# Ensure server.mjs path resolution is stable regardless of invocation directory.
cd "$PROJECT_ROOT"

if [ -x "$LOCAL_NODE_BIN/node" ]; then
  export PATH="$LOCAL_NODE_BIN:$PATH"
fi

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

usage() {
  cat <<'EOF'
Usage: ./run-local.sh [start|stop|restart|status] [--mode full|codex-only|runner-only]

Modes:
  full         Target both codex app-server and runner server (default)
  codex-only   Target only codex app-server (for WS connectivity isolation)
  runner-only  Target only runner server (stt/tts/voices/logs)

Commands:
  start        Start target services (default when omitted)
  stop         Stop target services
  restart      Stop then start target services (detached by default)
  status       Show listener/health status for target services

Environment overrides:
  RUN_LOCAL_MODE=full|codex-only|runner-only
  CODEX_ENABLE=0|1
  RUNNER_ENABLE=0|1
  RUN_LOCAL_RESTART_DETACHED=1|0
  RUN_LOCAL_RESTART_DELAY_SEC=<seconds>
  RUN_LOCAL_REUSE_EXISTING=1|0
EOF
}

if [ -z "${CODEX_HOME:-}" ]; then
  export CODEX_HOME="$HOME/.codex"
fi
case "$CODEX_HOME" in
  "~/"*) export CODEX_HOME="$HOME/${CODEX_HOME#~/}" ;;
  /*) ;;
  *) export CODEX_HOME="$PROJECT_ROOT/$CODEX_HOME" ;;
esac

# Keep codex app-server loopback-only by default. The runner proxies /codex-ws
# to 127.0.0.1:4500, while exposing only the runner port to other devices.
CODEX_APP_SERVER_LISTEN="${CODEX_APP_SERVER_LISTEN:-ws://127.0.0.1:4500}"
CODEX_APP_SERVER_WS_AUTH="${CODEX_APP_SERVER_WS_AUTH:-}"
CODEX_APP_SERVER_TOKEN_FILE="${CODEX_APP_SERVER_TOKEN_FILE:-}"
CODEX_APP_SERVER_TOKEN_SHA256="${CODEX_APP_SERVER_TOKEN_SHA256:-}"
CODEX_APP_SERVER_SHARED_SECRET_FILE="${CODEX_APP_SERVER_SHARED_SECRET_FILE:-}"
CODEX_APP_SERVER_ISSUER="${CODEX_APP_SERVER_ISSUER:-}"
CODEX_APP_SERVER_AUDIENCE="${CODEX_APP_SERVER_AUDIENCE:-}"
CODEX_APP_SERVER_MAX_CLOCK_SKEW_SECONDS="${CODEX_APP_SERVER_MAX_CLOCK_SKEW_SECONDS:-}"
RUN_LOCAL_KILL_EXISTING="${RUN_LOCAL_KILL_EXISTING:-1}"
RUN_LOCAL_MODE="${RUN_LOCAL_MODE:-full}"
CODEX_ENABLE="${CODEX_ENABLE:-1}"
RUNNER_ENABLE="${RUNNER_ENABLE:-1}"
RUNNER_PORT="${RUNNER_PORT:-${PORT:-8788}}"
RUNNER_LOG_REQUESTS="${RUNNER_LOG_REQUESTS:-1}"
RUN_LOCAL_COMMAND="start"
RUN_LOCAL_COMMAND_SET=0
RUN_LOCAL_FOREGROUND="${RUN_LOCAL_FOREGROUND:-0}"
RUN_LOCAL_INTERNAL_LAUNCH="${RUN_LOCAL_INTERNAL_LAUNCH:-0}"
RUN_LOCAL_DEFERRED_RESTART="${RUN_LOCAL_DEFERRED_RESTART:-0}"
RUN_LOCAL_RESTART_DETACHED="${RUN_LOCAL_RESTART_DETACHED:-1}"
RUN_LOCAL_RESTART_DELAY_SEC="${RUN_LOCAL_RESTART_DELAY_SEC:-1}"
RUN_LOCAL_REUSE_EXISTING="${RUN_LOCAL_REUSE_EXISTING:-1}"
RUN_LOCAL_LOG_FILE="${RUN_LOCAL_LOG_FILE:-$SCRIPT_DIR/logs/run-local.log}"
RUN_LOCAL_SCREEN_SESSION="${RUN_LOCAL_SCREEN_SESSION:-private_runner_${RUNNER_PORT}}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    start|stop|restart|status)
      if [ "$RUN_LOCAL_COMMAND_SET" = "1" ]; then
        echo "[run-local] command is already set to ${RUN_LOCAL_COMMAND}; duplicate: $1" >&2
        usage
        exit 1
      fi
      RUN_LOCAL_COMMAND="$1"
      RUN_LOCAL_COMMAND_SET=1
      shift
      ;;
    --mode)
      if [ "$#" -lt 2 ]; then
        echo "[run-local] --mode requires a value" >&2
        usage
        exit 1
      fi
      RUN_LOCAL_MODE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[run-local] unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if { [ "$RUN_LOCAL_COMMAND" = "start" ] || [ "$RUN_LOCAL_COMMAND" = "restart" ]; } && [ -x "$BOOTSTRAP_LOCAL_SCRIPT" ]; then
  PARSED_RUN_LOCAL_COMMAND="$RUN_LOCAL_COMMAND"
  PARSED_RUN_LOCAL_MODE="$RUN_LOCAL_MODE"
  "$BOOTSTRAP_LOCAL_SCRIPT" --repo-root "$PROJECT_ROOT" --env --private-runner
  if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
  fi
  RUN_LOCAL_COMMAND="$PARSED_RUN_LOCAL_COMMAND"
  RUN_LOCAL_MODE="$PARSED_RUN_LOCAL_MODE"
fi

resolve_mode() {
  case "$RUN_LOCAL_MODE" in
    full)
      CODEX_ENABLE=1
      RUNNER_ENABLE=1
      ;;
    codex-only)
      CODEX_ENABLE=1
      RUNNER_ENABLE=0
      ;;
    runner-only)
      CODEX_ENABLE=0
      RUNNER_ENABLE=1
      ;;
    *)
      echo "[run-local] invalid RUN_LOCAL_MODE: $RUN_LOCAL_MODE (expected: full|codex-only|runner-only)" >&2
      exit 1
      ;;
  esac
}
resolve_mode

# RUN_LOCAL_FOREGROUND=1 is an internal control flag for the nohup-launched
# foreground supervisor process. If it leaks into unrelated shells (for example
# via inherited env in child tools), force it back to detached mode.
if [ "$RUN_LOCAL_FOREGROUND" = "1" ] && [ "$RUN_LOCAL_INTERNAL_LAUNCH" != "1" ]; then
  RUN_LOCAL_FOREGROUND=0
fi

if [ "$CODEX_ENABLE" != "1" ] && [ "$RUNNER_ENABLE" != "1" ]; then
  echo "[run-local] no target service selected (CODEX_ENABLE=0 and RUNNER_ENABLE=0)" >&2
  exit 1
fi

find_listening_pids() {
  local port="$1"
  local listen_pids=""
  if command -v lsof >/dev/null 2>&1; then
    listen_pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  fi

  # On macOS, lsof may hide listeners owned by another user. netstat -v still
  # exposes the PID, which lets preflight fail clearly instead of missing it.
  if [ -z "$listen_pids" ] && command -v netstat >/dev/null 2>&1; then
    listen_pids="$(
      netstat -anv -p tcp 2>/dev/null \
        | awk -v port="$port" '
          $6 == "LISTEN" && $4 ~ ("[.:]" port "$") && $11 ~ /^[0-9]+$/ && $11 != "0" {
            print $11
          }
        ' \
        | sort -u
    )"
  fi

  listen_pids="${listen_pids//$'\n'/ }"
  listen_pids="${listen_pids%" "}"
  echo "$listen_pids"
}

http_ok() {
  local url="$1"
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  curl -fsS --max-time 1 "$url" >/dev/null 2>&1
}

can_reuse_codex_app_server() {
  if [ "${RUN_LOCAL_REUSE_EXISTING:-0}" != "1" ] || [ -z "${LISTEN_PORT:-}" ]; then
    return 1
  fi
  http_ok "http://127.0.0.1:${LISTEN_PORT}/healthz"
}

can_reuse_runner() {
  if [ "${RUN_LOCAL_REUSE_EXISTING:-0}" != "1" ]; then
    return 1
  fi
  http_ok "http://127.0.0.1:${RUNNER_PORT}/health"
}

has_inaccessible_listener() {
  local listen_pids="$1"
  local pid
  for pid in $listen_pids; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

should_reuse_inaccessible_codex_app_server() {
  local listen_pids="$1"
  [ -n "$listen_pids" ] && has_inaccessible_listener "$listen_pids" && can_reuse_codex_app_server
}

should_reuse_inaccessible_runner() {
  local listen_pids="$1"
  [ -n "$listen_pids" ] && has_inaccessible_listener "$listen_pids" && can_reuse_runner
}

will_reuse_codex_app_server() {
  if [ "$CODEX_ENABLE" != "1" ] || [ -z "${LISTEN_PORT:-}" ]; then
    return 1
  fi
  can_reuse_codex_app_server
}

elevation_required() {
  local reason="$1"
  echo "[run-local] requires elevated execution: ${reason}" >&2
  echo "[run-local] hint: stop the listed PID(s) from a privileged terminal, or rerun from a shell that can stop the target services and write CODEX_HOME=${CODEX_HOME}" >&2
  exit 77
}

pid_list_contains() {
  local needle="$1"
  local pids="$2"
  local pid
  for pid in $pids; do
    if [ "$pid" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

require_signal_access_to_listeners() {
  local port="$1"
  local label="$2"
  local listen_pids="$3"
  local action="${4:-stop}"
  local inaccessible=""
  local pid
  for pid in $listen_pids; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      continue
    fi
    inaccessible="${inaccessible}${inaccessible:+ }${pid}"
  done
  if [ -z "$inaccessible" ]; then
    return 0
  fi

  local still_listening
  local blocked=""
  still_listening="$(find_listening_pids "$port")"
  for pid in $inaccessible; do
    if pid_list_contains "$pid" "$still_listening"; then
      blocked="${blocked}${blocked:+ }${pid}"
    fi
  done
  if [ -n "$blocked" ]; then
    elevation_required "cannot ${action} ${label} on port ${port}; current process cannot signal PID(s): ${blocked}"
  fi
}

require_codex_home_write_access() {
  if [ "$CODEX_ENABLE" != "1" ]; then
    return 0
  fi
  if will_reuse_codex_app_server; then
    return 0
  fi
  if ! mkdir -p "$CODEX_HOME" >/dev/null 2>&1; then
    elevation_required "cannot create CODEX_HOME=${CODEX_HOME}"
  fi

  local probe_path
  probe_path="${CODEX_HOME}/.run-local-write-test.$$"
  if ! (umask 077; : >"$probe_path") >/dev/null 2>&1; then
    elevation_required "cannot write CODEX_HOME=${CODEX_HOME}; codex app-server would fail to update its sqlite state"
  fi
  rm -f "$probe_path" >/dev/null 2>&1 || true
}

preflight_signal_access_for_targets() {
  local reuse_mode="${1:-none}"
  local listen_pids
  if [ "$CODEX_ENABLE" = "1" ] && [ -n "$LISTEN_PORT" ]; then
    listen_pids="$(find_listening_pids "$LISTEN_PORT")"
    if [ -n "$listen_pids" ]; then
      if [ "$reuse_mode" = "healthy" ] && can_reuse_codex_app_server; then
        :
      elif [ "$reuse_mode" = "inaccessible" ] && should_reuse_inaccessible_codex_app_server "$listen_pids"; then
        :
      else
        require_signal_access_to_listeners "$LISTEN_PORT" "codex app-server" "$listen_pids" "stop"
      fi
    fi
  fi
  if [ "$RUNNER_ENABLE" = "1" ]; then
    listen_pids="$(find_listening_pids "$RUNNER_PORT")"
    if [ -n "$listen_pids" ]; then
      if [ "$reuse_mode" = "healthy" ] && can_reuse_runner; then
        return 0
      fi
      if [ "$reuse_mode" = "inaccessible" ] && should_reuse_inaccessible_runner "$listen_pids"; then
        return 0
      fi
      require_signal_access_to_listeners "$RUNNER_PORT" "runner" "$listen_pids" "stop"
    fi
  fi
}

preflight_start_targets() {
  require_codex_home_write_access
  if [ "${RUN_LOCAL_KILL_EXISTING:-0}" = "1" ]; then
    preflight_signal_access_for_targets healthy
  fi
}

preflight_restart_targets() {
  preflight_signal_access_for_targets none
  require_codex_home_write_access
}

wait_for_port_release() {
  local port="$1"
  local still_listening
  for _ in 1 2 3 4 5; do
    sleep 0.2
    still_listening="$(find_listening_pids "$port")"
    if [ -z "$still_listening" ]; then
      break
    fi
  done
  still_listening="$(find_listening_pids "$port")"
  echo "$still_listening"
}

kill_listening_port_for_start() {
  local port="$1"
  local label="${2:-server}"
  local listen_pids
  listen_pids="$(find_listening_pids "$port")"
  if [ -z "$listen_pids" ]; then
    return 0
  fi

  if [ "${RUN_LOCAL_KILL_EXISTING:-0}" != "1" ]; then
    echo "[run-local] ${label} port ${port} is already in use by PID(s): ${listen_pids}" >&2
    exit 1
  fi

  echo "[run-local] ${label} port ${port} is busy; stopping PID(s): ${listen_pids}" >&2
  require_signal_access_to_listeners "$port" "$label" "$listen_pids" "stop"
  kill $listen_pids >/dev/null 2>&1 || true

  local still_listening
  still_listening="$(wait_for_port_release "$port")"
  if [ -n "$still_listening" ]; then
    echo "[run-local] ${label} force-killing PID(s): ${still_listening}" >&2
    require_signal_access_to_listeners "$port" "$label" "$still_listening" "force-stop"
    kill -9 $still_listening >/dev/null 2>&1 || true
    sleep 0.2
    still_listening="$(find_listening_pids "$port")"
    if [ -n "$still_listening" ]; then
      echo "[run-local] failed to free ${label} port ${port}; PID(s) still listening: ${still_listening}" >&2
      exit 1
    fi
  fi
}

stop_listening_port() {
  local port="$1"
  local label="${2:-server}"
  local listen_pids
  listen_pids="$(find_listening_pids "$port")"
  if [ -z "$listen_pids" ]; then
    echo "[run-local] ${label} is not listening on port ${port}" >&2
    return 0
  fi

  echo "[run-local] stopping ${label} on port ${port}; PID(s): ${listen_pids}" >&2
  require_signal_access_to_listeners "$port" "$label" "$listen_pids" "stop"
  kill $listen_pids >/dev/null 2>&1 || true

  local still_listening
  still_listening="$(wait_for_port_release "$port")"
  if [ -n "$still_listening" ]; then
    echo "[run-local] force-killing ${label} PID(s): ${still_listening}" >&2
    require_signal_access_to_listeners "$port" "$label" "$still_listening" "force-stop"
    kill -9 $still_listening >/dev/null 2>&1 || true
    sleep 0.2
    still_listening="$(find_listening_pids "$port")"
    if [ -n "$still_listening" ]; then
      echo "[run-local] failed to stop ${label} on port ${port}; PID(s) still listening: ${still_listening}" >&2
      exit 1
    fi
  fi
}

extract_listen_port() {
  local listen="$1"
  if [[ "$listen" =~ ^ws://[^:/]+:([0-9]{1,5})$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

LISTEN_PORT="$(extract_listen_port "$CODEX_APP_SERVER_LISTEN" || true)"

truncate_log_dir_files() {
  local log_dir="$1"
  local log_path
  if [ ! -d "$log_dir" ]; then
    return 0
  fi
  for log_path in "$log_dir"/*; do
    if [ -f "$log_path" ]; then
      : >"$log_path"
    fi
  done
}

reset_runtime_logs() {
  local log_path
  mkdir -p "$SCRIPT_DIR/logs"
  for log_path in "$SCRIPT_DIR"/logs/*.log "$SCRIPT_DIR/logs/llm_tool_audit.jsonl" "$RUN_LOCAL_LOG_FILE"; do
    if [ -f "$log_path" ]; then
      : >"$log_path"
    fi
  done
  truncate_log_dir_files "$SCRIPT_DIR/logs/client_auto_logs"
  truncate_log_dir_files "$SCRIPT_DIR/logs/codex_ws_proxy"
  truncate_log_dir_files "$SCRIPT_DIR/logs/llm_request_payloads"
  echo "[run-local] reset runtime logs under $SCRIPT_DIR/logs" >&2
}

screen_session_exists() {
  local session="$1"
  if ! command -v screen >/dev/null 2>&1; then
    return 1
  fi
  screen -ls 2>/dev/null | grep -Eq "[[:space:]][0-9]+\\.${session}[[:space:]]"
}

wait_for_screen_session() {
  local session="$1"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if screen_session_exists "$session"; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

start_screen_supervisor() {
  local session="$1"
  shift

  if ! command -v screen >/dev/null 2>&1; then
    return 127
  fi
  if screen_session_exists "$session"; then
    echo "[run-local] detached screen session already exists: ${session}" >&2
    return 0
  fi

  RUN_LOCAL_LOG_FILE="$RUN_LOCAL_LOG_FILE" \
    RUN_LOCAL_INTERNAL_LAUNCH="${RUN_LOCAL_INTERNAL_LAUNCH:-}" \
    RUN_LOCAL_FOREGROUND="${RUN_LOCAL_FOREGROUND:-}" \
    RUN_LOCAL_DEFERRED_RESTART="${RUN_LOCAL_DEFERRED_RESTART:-}" \
    RUN_LOCAL_RESTART_DETACHED="${RUN_LOCAL_RESTART_DETACHED:-}" \
    screen -dmS "$session" /bin/bash -lc 'exec "$@" >>"$RUN_LOCAL_LOG_FILE" 2>&1' bash "$@"
}

start_nohup_supervisor() {
  RUN_LOCAL_INTERNAL_LAUNCH="$1" RUN_LOCAL_FOREGROUND="$2" RUN_LOCAL_DEFERRED_RESTART="$3" \
    nohup "$SCRIPT_PATH" "$4" "${@:5}" >>"$RUN_LOCAL_LOG_FILE" 2>&1 &
  echo "$!"
}

start_in_background() {
  mkdir -p "$(dirname "$RUN_LOCAL_LOG_FILE")"
  if ! command -v screen >/dev/null 2>&1 && ! command -v nohup >/dev/null 2>&1; then
    echo "[run-local] nohup is required for detached start but was not found" >&2
    exit 1
  fi

  local mode_arg=()
  if [ -n "${RUN_LOCAL_MODE:-}" ]; then
    mode_arg=(--mode "$RUN_LOCAL_MODE")
  fi

  if command -v screen >/dev/null 2>&1; then
    RUN_LOCAL_INTERNAL_LAUNCH=1 RUN_LOCAL_FOREGROUND=1 \
      start_screen_supervisor "$RUN_LOCAL_SCREEN_SESSION" "$SCRIPT_PATH" start "${mode_arg[@]}"
    if wait_for_screen_session "$RUN_LOCAL_SCREEN_SESSION"; then
      echo "[run-local] started in screen session (${RUN_LOCAL_SCREEN_SESSION})" >&2
      echo "[run-local] logs: $RUN_LOCAL_LOG_FILE" >&2
      return 0
    fi
    if can_reuse_runner || can_reuse_codex_app_server; then
      echo "[run-local] start completed; target services were already running" >&2
      echo "[run-local] logs: $RUN_LOCAL_LOG_FILE" >&2
      return 0
    fi
    echo "[run-local] failed to start screen session; check $RUN_LOCAL_LOG_FILE" >&2
    exit 1
  fi

  local launcher_pid
  launcher_pid="$(start_nohup_supervisor 1 1 0 start "${mode_arg[@]}")"
  sleep 1
  if ! kill -0 "$launcher_pid" >/dev/null 2>&1; then
    local rc=0
    wait "$launcher_pid" || rc="$?"
    if [ "$rc" = "0" ]; then
      echo "[run-local] start completed; target services were already running" >&2
      echo "[run-local] logs: $RUN_LOCAL_LOG_FILE" >&2
      exit 0
    fi
    echo "[run-local] failed to start background process (exit=${rc}); check $RUN_LOCAL_LOG_FILE" >&2
    exit "$rc"
  fi

  echo "[run-local] started in background (launcher pid=${launcher_pid})" >&2
  echo "[run-local] logs: $RUN_LOCAL_LOG_FILE" >&2
}

restart_in_background() {
  mkdir -p "$(dirname "$RUN_LOCAL_LOG_FILE")"
  if ! command -v screen >/dev/null 2>&1 && ! command -v nohup >/dev/null 2>&1; then
    echo "[run-local] nohup is required for detached restart but was not found" >&2
    exit 1
  fi

  local mode_arg=()
  if [ -n "${RUN_LOCAL_MODE:-}" ]; then
    mode_arg=(--mode "$RUN_LOCAL_MODE")
  fi

  if command -v screen >/dev/null 2>&1; then
    RUN_LOCAL_DEFERRED_RESTART=1 RUN_LOCAL_INTERNAL_LAUNCH=1 RUN_LOCAL_FOREGROUND=1 RUN_LOCAL_RESTART_DETACHED=0 \
      start_screen_supervisor "$RUN_LOCAL_SCREEN_SESSION" "$SCRIPT_PATH" restart "${mode_arg[@]}"
    if wait_for_screen_session "$RUN_LOCAL_SCREEN_SESSION"; then
      echo "[run-local] scheduled screen restart (${RUN_LOCAL_SCREEN_SESSION})" >&2
      echo "[run-local] logs: $RUN_LOCAL_LOG_FILE" >&2
      return 0
    fi
    if can_reuse_runner || can_reuse_codex_app_server; then
      echo "[run-local] restart completed; target services are running" >&2
      echo "[run-local] logs: $RUN_LOCAL_LOG_FILE" >&2
      return 0
    fi
    echo "[run-local] failed to schedule screen restart; check $RUN_LOCAL_LOG_FILE" >&2
    exit 1
  fi

  local launcher_pid
  launcher_pid="$(start_nohup_supervisor 0 0 1 restart "${mode_arg[@]}")"
  sleep 1
  if ! kill -0 "$launcher_pid" >/dev/null 2>&1; then
    local rc=0
    wait "$launcher_pid" || rc="$?"
    if [ "$rc" = "0" ]; then
      echo "[run-local] restart completed; target services were already running" >&2
      echo "[run-local] logs: $RUN_LOCAL_LOG_FILE" >&2
      exit 0
    fi
    echo "[run-local] failed to schedule detached restart (exit=${rc}); check $RUN_LOCAL_LOG_FILE" >&2
    exit "$rc"
  fi

  echo "[run-local] scheduled detached restart (launcher pid=${launcher_pid})" >&2
  echo "[run-local] logs: $RUN_LOCAL_LOG_FILE" >&2
}

run_stop() {
  local allow_reuse="${1:-0}"
  local listen_pids
  if [ "$CODEX_ENABLE" = "1" ] && [ -n "$LISTEN_PORT" ]; then
    listen_pids="$(find_listening_pids "$LISTEN_PORT")"
    if [ "$allow_reuse" = "1" ] && [ -z "$listen_pids" ] && can_reuse_codex_app_server; then
      echo "[run-local] keeping existing codex app-server on port ${LISTEN_PORT}; health check passed but listener PID is not visible" >&2
    elif [ "$allow_reuse" = "1" ] && should_reuse_inaccessible_codex_app_server "$listen_pids"; then
      echo "[run-local] keeping existing codex app-server on port ${LISTEN_PORT}; current process cannot signal PID(s): ${listen_pids}" >&2
    else
      stop_listening_port "$LISTEN_PORT" "codex app-server"
    fi
  fi
  if [ "$RUNNER_ENABLE" = "1" ]; then
    listen_pids="$(find_listening_pids "$RUNNER_PORT")"
    if [ "$allow_reuse" = "1" ] && [ -z "$listen_pids" ] && can_reuse_runner; then
      echo "[run-local] keeping existing runner on port ${RUNNER_PORT}; health check passed but listener PID is not visible" >&2
    elif [ "$allow_reuse" = "1" ] && should_reuse_inaccessible_runner "$listen_pids"; then
      echo "[run-local] keeping existing runner on port ${RUNNER_PORT}; current process cannot signal PID(s): ${listen_pids}" >&2
    else
      stop_listening_port "$RUNNER_PORT" "runner"
    fi
  fi
}

run_status_target() {
  local label="$1"
  local port="$2"
  local health_url="$3"
  local listen_pids
  listen_pids="$(find_listening_pids "$port")"

  if [ -z "$listen_pids" ]; then
    if [ -n "$health_url" ] && http_ok "$health_url"; then
      echo "[run-local] ${label} port ${port}: pid=hidden health=ok" >&2
      return 0
    fi
    echo "[run-local] ${label} port ${port}: not listening" >&2
    return 1
  fi

  local pid_count
  pid_count="$(echo "$listen_pids" | awk '{print NF}')"
  local status_rc=0
  if [ "$pid_count" -gt 1 ]; then
    status_rc=2
    echo "[run-local] ${label} port ${port}: listening pid(s)=${listen_pids} duplicate=yes" >&2
  else
    echo "[run-local] ${label} port ${port}: listening pid=${listen_pids}" >&2
  fi

  if [ -n "$health_url" ]; then
    if http_ok "$health_url"; then
      echo "[run-local] ${label} health=ok (${health_url})" >&2
    else
      echo "[run-local] ${label} health=fail (${health_url})" >&2
      if [ "$status_rc" = "0" ]; then
        status_rc=1
      fi
    fi
  fi

  return "$status_rc"
}

run_status() {
  echo "[run-local] command=status mode=${RUN_LOCAL_MODE} codex_enable=${CODEX_ENABLE} runner_enable=${RUNNER_ENABLE}" >&2
  local status_rc=0
  local rc=0

  if [ "$CODEX_ENABLE" = "1" ]; then
    if [ -z "$LISTEN_PORT" ]; then
      echo "[run-local] codex app-server: unsupported listen format: ${CODEX_APP_SERVER_LISTEN}" >&2
      status_rc=1
    else
      rc=0
      run_status_target "codex app-server" "$LISTEN_PORT" "http://127.0.0.1:${LISTEN_PORT}/healthz" || rc=$?
      if [ "$rc" -gt "$status_rc" ]; then
        status_rc="$rc"
      fi
    fi
  fi

  if [ "$RUNNER_ENABLE" = "1" ]; then
    rc=0
    run_status_target "runner" "$RUNNER_PORT" "http://127.0.0.1:${RUNNER_PORT}/health" || rc=$?
    if [ "$rc" -gt "$status_rc" ]; then
      status_rc="$rc"
    fi
  fi

  if [ "$status_rc" = "2" ]; then
    echo "[run-local] status result: duplicate listeners detected" >&2
  elif [ "$status_rc" = "1" ]; then
    echo "[run-local] status result: some targets are unavailable/unhealthy" >&2
  else
    echo "[run-local] status result: all targets look healthy" >&2
  fi

  return "$status_rc"
}

if [ "$RUN_LOCAL_COMMAND" = "status" ]; then
  run_status
  exit $?
fi

if [ "$RUN_LOCAL_COMMAND" = "stop" ]; then
  echo "[run-local] command=stop mode=${RUN_LOCAL_MODE}" >&2
  preflight_signal_access_for_targets none
  run_stop 0
  echo "[run-local] stop complete" >&2
  exit 0
fi

if [ "$RUN_LOCAL_COMMAND" = "restart" ]; then
  preflight_restart_targets
  if [ "$RUN_LOCAL_DEFERRED_RESTART" != "1" ] && [ "$RUN_LOCAL_RESTART_DETACHED" = "1" ]; then
    echo "[run-local] command=restart mode=${RUN_LOCAL_MODE} (detached)" >&2
    restart_in_background
    exit 0
  fi
  echo "[run-local] command=restart mode=${RUN_LOCAL_MODE}" >&2
  if [ "$RUN_LOCAL_DEFERRED_RESTART" = "1" ] && [ "${RUN_LOCAL_RESTART_DELAY_SEC:-0}" != "0" ]; then
    sleep "$RUN_LOCAL_RESTART_DELAY_SEC"
  fi
  run_stop 0
  RUN_LOCAL_COMMAND="start"
fi

if [ "$RUN_LOCAL_COMMAND" = "start" ] && [ "$RUN_LOCAL_FOREGROUND" != "1" ]; then
  preflight_start_targets
  start_in_background
  exit 0
fi

# Do not leak run-local control flags into managed child processes.
unset RUN_LOCAL_FOREGROUND
unset RUN_LOCAL_INTERNAL_LAUNCH
unset RUN_LOCAL_DEFERRED_RESTART
unset RUN_LOCAL_RESTART_DETACHED
unset RUN_LOCAL_RESTART_DELAY_SEC

CODEX_REUSED=0
RUNNER_REUSED=0

if [ "$CODEX_ENABLE" = "1" ] && [ -n "$LISTEN_PORT" ]; then
  require_codex_home_write_access
  if can_reuse_codex_app_server; then
    CODEX_REUSED=1
    echo "[run-local] reusing existing codex app-server on port ${LISTEN_PORT}" >&2
  else
    kill_listening_port_for_start "$LISTEN_PORT" "codex app-server"
  fi
fi
if [ "$RUNNER_ENABLE" = "1" ]; then
  if can_reuse_runner; then
    RUNNER_REUSED=1
    echo "[run-local] reusing existing runner on port ${RUNNER_PORT}" >&2
  else
    kill_listening_port_for_start "$RUNNER_PORT" "runner"
  fi
fi

reset_runtime_logs

echo "[run-local] command=start mode=${RUN_LOCAL_MODE} codex_enable=${CODEX_ENABLE} runner_enable=${RUNNER_ENABLE}" >&2
if [ "$CODEX_ENABLE" = "1" ]; then
  if [ -n "$CODEX_APP_SERVER_WS_AUTH" ]; then
    echo "[run-local] starting codex app-server listen=${CODEX_APP_SERVER_LISTEN} ws-auth=${CODEX_APP_SERVER_WS_AUTH}" >&2
  else
    echo "[run-local] starting codex app-server listen=${CODEX_APP_SERVER_LISTEN} ws-auth=none" >&2
  fi
fi
if [ "$RUNNER_ENABLE" = "1" ]; then
  echo "[run-local] starting runner server port=${RUNNER_PORT} (stt/tts/voices/logs)" >&2
fi

RUNNER_PID=""
CODEX_PID=""
shutdown_started=0

terminate_pid() {
  local pid="$1"
  local name="$2"
  if [ -z "$pid" ]; then
    return 0
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  echo "[run-local] stopping ${name} pid=${pid}" >&2
  kill "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  if [ "$shutdown_started" = "1" ]; then
    return 0
  fi
  shutdown_started=1
  terminate_pid "$CODEX_PID" "codex app-server"
  terminate_pid "$RUNNER_PID" "runner"
  wait "${CODEX_PID:-}" >/dev/null 2>&1 || true
  wait "${RUNNER_PID:-}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [ "$RUNNER_ENABLE" = "1" ] && [ "$RUNNER_REUSED" != "1" ]; then
  (
    export RUNNER_LOG_REQUESTS
    export PORT="$RUNNER_PORT"
    exec node "$SCRIPT_DIR/server.mjs"
  ) &
  RUNNER_PID="$!"
fi

if [ "$CODEX_ENABLE" = "1" ] && [ "$CODEX_REUSED" != "1" ]; then
  CODEX_CMD=(codex app-server --listen "$CODEX_APP_SERVER_LISTEN")
  if [ -n "$CODEX_APP_SERVER_WS_AUTH" ]; then
    CODEX_CMD+=(--ws-auth "$CODEX_APP_SERVER_WS_AUTH")
  fi
  if [ -n "$CODEX_APP_SERVER_TOKEN_FILE" ]; then
    CODEX_CMD+=(--ws-token-file "$CODEX_APP_SERVER_TOKEN_FILE")
  fi
  if [ -n "$CODEX_APP_SERVER_TOKEN_SHA256" ]; then
    CODEX_CMD+=(--ws-token-sha256 "$CODEX_APP_SERVER_TOKEN_SHA256")
  fi
  if [ -n "$CODEX_APP_SERVER_SHARED_SECRET_FILE" ]; then
    CODEX_CMD+=(--ws-shared-secret-file "$CODEX_APP_SERVER_SHARED_SECRET_FILE")
  fi
  if [ -n "$CODEX_APP_SERVER_ISSUER" ]; then
    CODEX_CMD+=(--ws-issuer "$CODEX_APP_SERVER_ISSUER")
  fi
  if [ -n "$CODEX_APP_SERVER_AUDIENCE" ]; then
    CODEX_CMD+=(--ws-audience "$CODEX_APP_SERVER_AUDIENCE")
  fi
  if [ -n "$CODEX_APP_SERVER_MAX_CLOCK_SKEW_SECONDS" ]; then
    CODEX_CMD+=(--ws-max-clock-skew-seconds "$CODEX_APP_SERVER_MAX_CLOCK_SKEW_SECONDS")
  fi
  "${CODEX_CMD[@]}" &
  CODEX_PID="$!"
fi

sleep 0.3
if [ "$CODEX_ENABLE" = "1" ] && [ "$CODEX_REUSED" != "1" ] && ! kill -0 "$CODEX_PID" >/dev/null 2>&1; then
  echo "[run-local] codex app-server failed to start; see logs above" >&2
  wait "$CODEX_PID"
  exit 1
fi
if [ "$RUNNER_ENABLE" = "1" ] && [ "$RUNNER_REUSED" != "1" ] && ! kill -0 "$RUNNER_PID" >/dev/null 2>&1; then
  echo "[run-local] runner failed to start; see logs above" >&2
  wait "$RUNNER_PID"
  exit 1
fi

STARTED_MSG="[run-local] started"
if [ "$CODEX_ENABLE" = "1" ]; then
  if [ "$CODEX_REUSED" = "1" ]; then
    STARTED_MSG="${STARTED_MSG} codex pid=reused"
  else
    STARTED_MSG="${STARTED_MSG} codex pid=${CODEX_PID}"
  fi
fi
if [ "$RUNNER_ENABLE" = "1" ]; then
  if [ "$RUNNER_REUSED" = "1" ]; then
    STARTED_MSG="${STARTED_MSG} runner pid=reused"
  else
    STARTED_MSG="${STARTED_MSG} runner pid=${RUNNER_PID}"
  fi
fi
echo "$STARTED_MSG" >&2

if [ -n "$RUNNER_PID" ] && [ -n "$CODEX_PID" ]; then
  while true; do
    if ! kill -0 "$CODEX_PID" >/dev/null 2>&1; then
      wait "$CODEX_PID"
      rc=$?
      exit "$rc"
    fi
    if ! kill -0 "$RUNNER_PID" >/dev/null 2>&1; then
      wait "$RUNNER_PID"
      rc=$?
      exit "$rc"
    fi
    sleep 0.2
  done
elif [ -n "$CODEX_PID" ]; then
  wait "$CODEX_PID"
  exit $?
elif [ -n "$RUNNER_PID" ]; then
  wait "$RUNNER_PID"
  exit $?
elif [ "$CODEX_REUSED" = "1" ] || [ "$RUNNER_REUSED" = "1" ]; then
  echo "[run-local] target services are already running" >&2
  exit 0
else
  echo "[run-local] no active process to wait for" >&2
  exit 1
fi
