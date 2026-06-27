#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
API=https://api.cloudflare.com/client/v4
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing command: $1"; }
var() { [[ -n "${!1:-}" ]] || die "unset environment variable: $1"; }
call() {
  local method=$1 path=$2 body=${3:-} out auth_config
  auth_config=$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN")
  if [[ -n "$body" ]]; then
    out=$(curl -fsS --config /dev/fd/3 -X "$method" "$API$path" -H 'Content-Type: application/json' --data-binary @/dev/fd/4 3<<<"$auth_config" 4<<<"$body") || die "API request failed: $method $path"
  else
    out=$(curl -fsS --config /dev/fd/3 -X "$method" "$API$path" -H 'Content-Type: application/json' 3<<<"$auth_config") || die "API request failed: $method $path"
  fi
  jq -e '.success' >/dev/null <<<"$out" || { jq -r '.errors[]? | "API error \(.code): \(.message)"' <<<"$out" >&2; return 1; }
  printf %s "$out"
}
list_one_page() {
  local out
  if ! out=$(call GET "$1"); then
    return 1
  fi
  jq -e '(.result_info.total_pages // 1) <= 1' >/dev/null <<<"$out" || die 'more than 100 resources found; inspect all pages before changing anything'
  printf %s "$out"
}
common() {
  need curl; need jq; need cloudflared
  for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ZONE_ID CLOUDFLARE_HOSTNAME CLOUDFLARE_TUNNEL_NAME CLOUDFLARE_ACCESS_APP_NAME CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID; do var "$name"; done
  [[ "$CLOUDFLARE_HOSTNAME" =~ ^[A-Za-z0-9.-]+$ ]] || die 'invalid hostname'
  [[ "$CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID" =~ ^[A-Za-z0-9-]+$ ]] || die 'invalid Access service token ID'
}
check() {
  local tunnels dns apps ids policies conflict=0
  common
  printf '%s\n' "$(cloudflared --version | head -n1)"
  curl -fsS --max-time 5 http://127.0.0.1:8788/health >/dev/null || die 'Runner /health failed'
  call GET /user/tokens/verify >/dev/null
  call GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/service_tokens/$CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID" >/dev/null || die 'Access service token ID is not readable; no resources changed'
  tunnels=$(list_one_page "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?is_deleted=false&per_page=100")
  dns=$(list_one_page "/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=$CLOUDFLARE_HOSTNAME&per_page=100")
  apps=$(list_one_page "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps?per_page=100")
  jq -e --arg n "$CLOUDFLARE_TUNNEL_NAME" '.result[]? | select(.name==$n)' >/dev/null <<<"$tunnels" && { printf 'conflict: tunnel %s\n' "$CLOUDFLARE_TUNNEL_NAME"; conflict=1; }
  jq -e '.result|length>0' >/dev/null <<<"$dns" && { printf 'conflict: DNS %s\n' "$CLOUDFLARE_HOSTNAME"; conflict=1; }
  ids=$(jq -r --arg n "$CLOUDFLARE_ACCESS_APP_NAME" --arg d "$CLOUDFLARE_HOSTNAME" '.result[]?|select(.name==$n or .domain==$d)|.id' <<<"$apps")
  if [[ -n "$ids" ]]; then
    conflict=1
    while read -r id; do
      policies=$(list_one_page "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$id/policies?per_page=100")
      jq -e '.result[]?|select(.decision=="bypass" or any(.include[]?;has("everyone")))' >/dev/null <<<"$policies" && printf 'unsafe policy: Bypass or Everyone on app %s\n' "$id"
    done <<<"$ids"
    printf 'conflict: Access app name or domain\n'
  fi
  (( conflict == 0 )) || die 'no resources changed'
  printf 'preflight: Runner, token, and conflicts ok\n'
}
preflight_paths() {
  local config_parent config_path credentials_parent credentials_path
  var CLOUDFLARED_CONFIG_PATH
  [[ "$CLOUDFLARED_CONFIG_PATH" == /* ]] || die 'config path must be absolute'
  [[ -d "$(dirname "$CLOUDFLARED_CONFIG_PATH")" ]] || die 'config parent directory does not exist'
  [[ ! -e "$CLOUDFLARED_CONFIG_PATH" && ! -L "$CLOUDFLARED_CONFIG_PATH" ]] || die 'refusing to overwrite existing config or symlink'
  config_parent=$(dirname "$CLOUDFLARED_CONFIG_PATH")
  [[ -w "$config_parent" && -x "$config_parent" ]] || die 'config parent directory is not writable and searchable'
  config_parent=$(cd "$config_parent" && pwd -P)
  config_path="$config_parent/$(basename "$CLOUDFLARED_CONFIG_PATH")"
  case "$config_path" in "$ROOT"|"$ROOT"/*) die 'config must be outside repo';; esac
  CLOUDFLARED_CONFIG_PATH=$config_path

  if [[ -n "${CLOUDFLARED_CREDENTIALS_FILE:-}" ]]; then
    [[ "$CLOUDFLARED_CREDENTIALS_FILE" == /* ]] || die 'credentials path must be absolute'
    [[ "$CLOUDFLARED_CREDENTIALS_FILE" =~ ^/[-A-Za-z0-9_./]+$ ]] || die 'credentials path contains unsupported characters'
    [[ -f "$CLOUDFLARED_CREDENTIALS_FILE" ]] || die 'credentials file does not exist'
    [[ ! -L "$CLOUDFLARED_CREDENTIALS_FILE" ]] || die 'credentials file must not be a symlink'
    credentials_parent=$(cd "$(dirname "$CLOUDFLARED_CREDENTIALS_FILE")" && pwd -P)
    credentials_path="$credentials_parent/$(basename "$CLOUDFLARED_CREDENTIALS_FILE")"
    case "$credentials_path" in "$ROOT"|"$ROOT"/*) die 'credentials must be outside repo';; esac
    CLOUDFLARED_CREDENTIALS_FILE=$credentials_path
  else
    credentials_parent="$HOME/.cloudflared"
    [[ -d "$credentials_parent" ]] || die 'default credentials parent directory does not exist'
    [[ -w "$credentials_parent" && -x "$credentials_parent" ]] || die 'default credentials parent directory is not writable and searchable'
    credentials_parent=$(cd "$credentials_parent" && pwd -P)
    case "$credentials_parent" in "$ROOT"|"$ROOT"/*) die 'credentials must be outside repo';; esac
  fi
}
render() {
  var TUNNEL_ID; var CLOUDFLARE_HOSTNAME; var CLOUDFLARED_CREDENTIALS_FILE
  [[ "$TUNNEL_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || die 'TUNNEL_ID must be a UUID'
  preflight_paths
  sed -e "s/TUNNEL_ID/$TUNNEL_ID/g" -e "s/app\.example\.com/$CLOUDFLARE_HOSTNAME/g" -e "s|CREDENTIALS_FILE|$CLOUDFLARED_CREDENTIALS_FILE|g" "$ROOT/cloudflared/config.yml.example" >"$CLOUDFLARED_CONFIG_PATH"
  chmod 600 "$CLOUDFLARED_CONFIG_PATH"
}
validate() { need cloudflared; var CLOUDFLARED_CONFIG_PATH; cloudflared tunnel --config "$CLOUDFLARED_CONFIG_PATH" ingress validate; }
apply() {
  local tunnels id body dns dns_id app app_id policy policy_id policies
  preflight_paths; check
  cloudflared tunnel create "$CLOUDFLARE_TUNNEL_NAME"
  tunnels=$(list_one_page "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?is_deleted=false&per_page=100")
  id=$(jq -r --arg n "$CLOUDFLARE_TUNNEL_NAME" '.result[]|select(.name==$n)|.id' <<<"$tunnels" | head -n1)
  [[ -n "$id" ]] || die 'created tunnel ID unreadable; inspect before retry'
  printf 'created resource: Tunnel ID %s\n' "$id"
  CLOUDFLARED_CREDENTIALS_FILE=${CLOUDFLARED_CREDENTIALS_FILE:-"$HOME/.cloudflared/$id.json"}
  TUNNEL_ID=$id render; validate
  body=$(jq -cn --arg n "$CLOUDFLARE_HOSTNAME" --arg c "$id.cfargotunnel.com" '{type:"CNAME",name:$n,content:$c,proxied:true}')
  dns=$(call POST "/zones/$CLOUDFLARE_ZONE_ID/dns_records" "$body")
  dns_id=$(jq -er '.result.id | select(type=="string" and length>0)' <<<"$dns") || die 'created DNS ID unreadable; inspect before retry'
  printf 'created resource: DNS record ID %s\n' "$dns_id"
  body=$(jq -cn --arg n "$CLOUDFLARE_ACCESS_APP_NAME" --arg d "$CLOUDFLARE_HOSTNAME" '{name:$n,domain:$d,type:"self_hosted",session_duration:"24h"}')
  app=$(call POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" "$body")
  app_id=$(jq -er '.result.id | select(type=="string" and length>0)' <<<"$app") || die 'created Access app ID unreadable; inspect before retry'
  printf 'created resource: Access app ID %s\n' "$app_id"
  body=$(jq -cn --arg id "$CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID" '{name:"Runner service token",decision:"non_identity",precedence:1,include:[{service_token:{token_id:$id}}]}')
  policy=$(call POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies" "$body")
  policy_id=$(jq -er '.result.id | select(type=="string" and length>0)' <<<"$policy") || die 'created Access policy ID unreadable; inspect before retry'
  printf 'created resource: Access policy ID %s\n' "$policy_id"
  jq -e --arg id "$CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID" '.result.decision=="non_identity" and .result.include==[{service_token:{token_id:$id}}]' >/dev/null <<<"$policy" || die 'Service Auth verification failed'
  policies=$(list_one_page "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies?per_page=100")
  jq -e --arg id "$CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID" '(.result|length)==1 and .result[0].decision=="non_identity" and .result[0].include==[{service_token:{token_id:$id}}]' >/dev/null <<<"$policies" || die 'post-create Service Auth verification failed'
  printf 'created tunnel, DNS, Access app %s, Service Auth policy; run cloudflared with %s\n' "$app_id" "$CLOUDFLARED_CONFIG_PATH"
}
plan() { printf '%s\n' 'check(GET only) -> Tunnel create -> config validate -> DNS -> Access app -> Service Auth for one service token. Existing matches stop all changes.'; }
case "${1:-}" in plan) plan;; check) check;; render) render;; validate) validate;; apply) apply;; *) printf 'usage: %s plan|check|render|validate|apply\n' "$0" >&2; exit 2;; esac
