#!/usr/bin/env bash
set -euo pipefail

if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "[setup-login] Macのターミナルから直接実行してください。" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

command -v node >/dev/null || { echo "[setup-login] Node.jsが必要です。" >&2; exit 1; }
"$PROJECT_ROOT/scripts/worktree/bootstrap-local.sh" --repo-root "$PROJECT_ROOT" --env --private-runner
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

if [ -z "${MJ_APIKEY_PUBLIC:-${MAILJET_API_KEY:-}}" ] ||
   [ -z "${MJ_APIKEY_PRIVATE:-${MAILJET_API_SECRET:-}}" ] ||
   [ -z "${RUNNER_LOGIN_MAIL_FROM:-}" ]; then
  echo "[setup-login] private_runner/.envのメール送信設定が必要です。" >&2
  exit 1
fi
if [ ! -r "${RUNNER_TOKEN_FILE:-private_runner/logs/runner-token}" ] ||
   [ ! -s "${RUNNER_TOKEN_FILE:-private_runner/logs/runner-token}" ]; then
  echo "[setup-login] 既存のRunner tokenファイルを確認してください。" >&2
  exit 1
fi
node --check "$SCRIPT_DIR/tools/runner-login.mjs"
(cd "$SCRIPT_DIR" && node --input-type=module -e 'await import("qrcode-terminal")')

echo "対応版アプリのビルドを先に済ませてください。"
echo "これからRunnerを再起動します。現在の会話は、アプリで再ログインするまで切断されます。"
echo "メール・Authenticatorを用意し、復旧コードを保存できる状態にしてください。"
read -r -p "初期登録を始めるには START と入力してください: " answer
if [ "$answer" != "START" ]; then
  echo "中止しました。Runnerは再起動していません。"
  exit 0
fi

node --input-type=module <<'JS'
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { requestControl, resolveControlSocket } from "./skills/bitty-session-orchestrator/scripts/runner-control.mjs";

const socket = await resolveControlSocket(process.cwd());
const previous = await fs.lstat(socket).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
const restart = spawnSync("./private_runner/restart-keep-token.sh", ["--mode", "full"], { stdio: "inherit" });
if (restart.error || restart.status !== 0) process.exit(restart.status || 1);
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    const current = await fs.lstat(socket);
    if (!previous || current.dev !== previous.dev || current.ino !== previous.ino) {
      const response = await requestControl(socket, "/health", { timeout: 1000 });
      if (response.ok && (await response.json()).ok === true) process.exit(0);
    }
  } catch {}
  await setTimeout(250);
}
console.error("[setup-login] Runnerの起動を確認できませんでした。private_runner/logs/run-local.logを確認してください。");
process.exit(1);
JS

node "$SCRIPT_DIR/tools/runner-login.mjs" setup
read -r -p "復旧コードを安全に保存したら Enter を押してください: " answer
echo "次の接続QRはBittyアプリで読み取り、メールコードとAuthenticatorでログインしてください。"
exec "$SCRIPT_DIR/run-local.sh" pairing-qr
