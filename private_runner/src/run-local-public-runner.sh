preflight_cloudflare_tunnel() {
  if [ "$CLOUDFLARE_TUNNEL_ENABLE" != "1" ]; then
    return 0
  fi
  if [ "$RUNNER_ENABLE" != "1" ]; then
    echo "[run-local] Cloudflare tunnel requires runner mode" >&2
    exit 1
  fi
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "[run-local] cloudflared is required when Cloudflare tunnel is enabled" >&2
    exit 1
  fi
  if [ ! -f "$CLOUDFLARED_CONFIG_PATH" ]; then
    echo "[run-local] CLOUDFLARED_CONFIG_PATH does not exist: $CLOUDFLARED_CONFIG_PATH" >&2
    exit 1
  fi
  if [[ ! "${CLOUDFLARE_TUNNEL_ID:-}" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    echo "[run-local] CLOUDFLARE_TUNNEL_ID must be set to the non-secret Tunnel UUID" >&2
    exit 1
  fi
  if ! cloudflared tunnel --config "$CLOUDFLARED_CONFIG_PATH" ingress validate >/dev/null; then
    echo "[run-local] cloudflared ingress validation failed for: $CLOUDFLARED_CONFIG_PATH" >&2
    exit 1
  fi
  validate_cloudflared_ingress_targets
}

validate_cloudflared_ingress_targets() {
  local expected_service="http://127.0.0.1:${RUNNER_PORT}"
  local found_expected=0
  local found_any=0
  local invalid_services=""
  local service

  while IFS= read -r service; do
    [ -z "$service" ] && continue
    found_any=1
    case "$service" in
      "$expected_service")
        found_expected=1
        ;;
      "http_status:404")
        ;;
      *)
        invalid_services="${invalid_services}${invalid_services:+, }${service}"
        ;;
    esac
  done < <(
    sed -n 's/^[[:space:]]*service:[[:space:]]*//p' "$CLOUDFLARED_CONFIG_PATH" \
      | sed 's/[[:space:]]*#.*$//' \
      | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
  )

  if [ "$found_any" != "1" ]; then
    echo "[run-local] cloudflared config must define ingress service rules" >&2
    exit 1
  fi
  if [ -n "$invalid_services" ]; then
    echo "[run-local] cloudflared config has disallowed service target(s): ${invalid_services}" >&2
    echo "[run-local] allowed service targets: ${expected_service}, http_status:404" >&2
    exit 1
  fi
  if [ "$found_expected" != "1" ]; then
    echo "[run-local] cloudflared config must route the hostname to ${expected_service}" >&2
    exit 1
  fi
}

stop_pid_file() {
  local pid_file="$1"
  local label="$2"
  local expected_command="${3:-}"
  local pid
  if [ ! -f "$pid_file" ]; then
    echo "[run-local] ${label}: pid file not found" >&2
    return 0
  fi
  pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    rm -f "$pid_file"
    echo "[run-local] ${label}: stale pid file removed" >&2
    return 0
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    if ! pid_command_matches "$pid" "$expected_command"; then
      echo "[run-local] ${label}: pid=${pid} command does not match expected target; refusing to stop it" >&2
      return 1
    fi
    echo "[run-local] stopping ${label} pid=${pid}" >&2
    kill "$pid" >/dev/null 2>&1 || true
    sleep 0.2
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "[run-local] force-stopping ${label} pid=${pid}" >&2
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  else
    echo "[run-local] ${label}: pid=${pid} is not running" >&2
  fi
  rm -f "$pid_file"
}

pid_command_matches() {
  local pid="$1"
  local expected_command="$2"
  local command
  if [ -z "$expected_command" ]; then
    return 0
  fi
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"$expected_command"*) return 0 ;;
    *) return 1 ;;
  esac
}

generate_random_runner_token() {
  node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
}

write_runner_token_file() {
  if [ -z "${RUNNER_TOKEN:-}" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$RUNNER_TOKEN_FILE")"
  local old_umask
  old_umask="$(umask)"
  umask 077
  printf '%s\n' "$RUNNER_TOKEN" >"$RUNNER_TOKEN_FILE"
  umask "$old_umask"
}

prepare_runner_runtime_token() {
  if [ "$RUNNER_ENABLE" != "1" ]; then
    return 0
  fi
  if [ -n "${RUN_LOCAL_RUNNER_TOKEN:-}" ]; then
    RUNNER_TOKEN="$RUN_LOCAL_RUNNER_TOKEN"
    export RUNNER_TOKEN
    write_runner_token_file
    RUN_LOCAL_REUSE_EXISTING=0
    echo "[run-local] reusing RUNNER_TOKEN handed over from previous runner" >&2
    return 0
  fi
  case "$RUNNER_TOKEN_MODE" in
    random)
      RUNNER_TOKEN="$(generate_random_runner_token)"
      export RUNNER_TOKEN
      write_runner_token_file
      RUN_LOCAL_REUSE_EXISTING=0
      echo "[run-local] generated per-start RUNNER_TOKEN; existing runner reuse disabled" >&2
      ;;
    env)
      if [ -z "${RUNNER_TOKEN:-}" ]; then
        echo "[run-local] RUNNER_TOKEN is required when RUNNER_TOKEN_MODE=env" >&2
        exit 1
      fi
      write_runner_token_file
      ;;
    *)
      echo "[run-local] invalid RUNNER_TOKEN_MODE: $RUNNER_TOKEN_MODE (expected: random|env)" >&2
      exit 1
      ;;
  esac
}

print_runner_pairing_qr() {
  if [ "$RUNNER_ENABLE" != "1" ] || [ "$RUNNER_PAIRING_QR" != "1" ]; then
    return 0
  fi
  if [ ! -t 1 ]; then
    echo "[run-local] pairing QR not printed because stdout is not a terminal; run: ./private_runner/run-local.sh pairing-qr" >&2
    return 0
  fi
  export RUNNER_TOKEN_FILE
  node "$SCRIPT_DIR/src/print-runner-pairing-qr.mjs" || true
}

run_status_pid_file() {
  local label="$1"
  local pid_file="$2"
  local pid
  if [ ! -f "$pid_file" ]; then
    echo "[run-local] ${label}: not running" >&2
    return 1
  fi
  pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1; then
    echo "[run-local] ${label}: pid=${pid}" >&2
    return 0
  fi
  echo "[run-local] ${label}: stale pid file" >&2
  return 1
}
