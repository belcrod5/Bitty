#!/usr/bin/env node
import { requestControl, resolveControlSocket } from "../../skills/bitty-session-orchestrator/scripts/runner-control.mjs";
import { validateRunnerLoginState } from "../src/runner-login-store.mjs";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import qrcode from "qrcode-terminal";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const action = process.argv[2] || "setup";
if (action === "--help") {
  console.log("使い方: node private_runner/tools/runner-login.mjs [setup|reset|unlock]\nsetup: 初期設定　reset: 認証の初期化　unlock: 停止後のロック解除\n所有者のMacで実行してください。");
  process.exit(0);
}

let rl;
try {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("terminal_required");
  if (!["setup", "reset", "unlock"].includes(action)) throw new Error("unknown_action");
  const logs = await fs.realpath(path.join(repository, "private_runner/logs"));
  const directory = path.resolve(process.env.RUNNER_LOGIN_DIRECTORY || path.join(logs, "runner-login"));
  const socketPath = await resolveControlSocket(repository);
  rl = createInterface({ input: process.stdin, output: process.stdout });

  const writerPid = async () => {
    const file = path.join(directory, "writer.lock");
    const stat = await fs.lstat(file).catch((failure) => { if (failure.code === "ENOENT") return null; throw failure; });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error("unsafe_writer_lock");
    const pid = Number(await fs.readFile(file, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("invalid_writer_lock");
    return pid;
  };
  const pairing = async () => {
    const answer = (await rl.question("接続QRを表示しますか？ [y/N]: ")).trim().toLowerCase();
    if (!["y", "yes", "はい"].includes(answer)) return;
    const result = spawnSync(process.execPath, [path.join(repository, "private_runner/src/print-runner-pairing-qr.mjs")], { cwd: repository, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("pairing_unavailable");
  };

  if (action === "setup") {
    const stateFile = path.join(directory, "state.json");
    const parent = await fs.lstat(directory).catch((failure) => { if (failure.code === "ENOENT") return null; throw failure; });
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700)) throw new Error("runner_login_storage_permissions");
    const stat = await fs.lstat(stateFile).catch((failure) => { if (failure.code === "ENOENT") return null; throw failure; });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error("runner_login_storage_permissions");
      let state;
      try { state = JSON.parse(await fs.readFile(stateFile, "utf8")); }
      catch (failure) { if (failure instanceof SyntaxError) throw new Error("runner_login_store_invalid"); throw failure; }
      validateRunnerLoginState(state);
      if (state.owner) {
        console.log("\n✓ 初期設定は完了しています。\nアプリでログインしてください。サーバーは再起動しません。");
        await pairing();
        process.exit(0);
      }
    }
  }

  if (action === "unlock") {
    const lock = path.join(directory, "writer.lock");
    const stat = await fs.lstat(lock).catch((failure) => { if (failure.code !== "ENOENT") throw failure; return null; });
    if (stat) {
      const pid = await writerPid();
      if (!pid) throw new Error("writer_lock_changed");
      try { process.kill(pid, 0); throw new Error("runner_still_running"); }
      catch (failure) { if (failure.code !== "ESRCH") throw failure; }
    }
    const socket = await fs.lstat(socketPath).catch((failure) => { if (failure.code !== "ENOENT") throw failure; return null; });
    if (socket) {
      if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o777) !== 0o600) throw new Error("unsafe_control_socket");
      await new Promise((resolve, reject) => {
        const probe = net.createConnection({ path: socketPath });
        probe.setTimeout(3000, () => probe.destroy(new Error("control_socket_unknown")));
        probe.once("connect", () => { probe.destroy(); reject(new Error("runner_still_running")); });
        probe.once("error", (failure) => { if (["ECONNREFUSED", "ENOENT"].includes(failure.code)) resolve(); else reject(failure); });
      });
    }
    if (!stat && !socket) throw new Error("no_stale_control_files");
    console.log("停止したサーバーの古いロックを解除します。認証情報は残ります。");
    if (!["解除", "UNLOCK"].includes(await rl.question("解除するには「解除」と入力: "))) throw new Error("cancelled");
    const current = await fs.lstat(lock).catch((failure) => { if (failure.code !== "ENOENT") throw failure; return null; });
    if (stat ? (!current || current.ino !== stat.ino || current.dev !== stat.dev) : current) throw new Error("writer_lock_changed");
    if (stat) await fs.unlink(lock);
    if (socket) {
      const currentSocket = await fs.lstat(socketPath);
      if (currentSocket.ino !== socket.ino || currentSocket.dev !== socket.dev) throw new Error("writer_lock_changed");
      await fs.unlink(socketPath);
    }
    console.log("✓ ロックを解除しました。認証情報は残っています。");
  } else {
    const tokenPath = process.env.RUNNER_TOKEN_FILE || path.join(logs, "runner-token");
    const file = path.resolve(repository, tokenPath);
    const stat = await fs.lstat(file).catch((failure) => { if (failure.code === "ENOENT") return null; throw failure; });
    let token;
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error("unsafe_local_credential");
      token = (await fs.readFile(file, "utf8")).trim();
    } else token = process.env.RUNNER_TOKEN;
    if (!token) throw new Error("local_credential_missing");
    const request = async (route, input) => {
      const response = await requestControl(socketPath, route, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
      }, body: JSON.stringify(input) });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || "request_failed"), { code: value.error || "request_failed" });
      return value;
    };
    if (action === "reset") {
      console.log("すべての端末をログアウトし、メール・認証アプリの登録を解除します。");
      if (!["初期化", "RESET OWNER"].includes(await rl.question("初期化するには「初期化」と入力: "))) throw new Error("cancelled");
      await request("/auth/setup/reset", { confirm: "RESET OWNER" });
      console.log("✓ 認証を初期化しました。setup-login.shで登録し直してください。\n会話と所有者IDは残っています。");
    } else {
      if (!(process.env.MJ_APIKEY_PUBLIC || process.env.MAILJET_API_KEY) || !(process.env.MJ_APIKEY_PRIVATE || process.env.MAILJET_API_SECRET) || !process.env.RUNNER_LOGIN_MAIL_FROM) throw new Error("runner_login_mail_unconfigured");
      const healthy = async () => {
        try {
          const response = await requestControl(socketPath, "/health", { headers: { authorization: `Bearer ${token}` }, timeout: 1000 });
          return response.ok && (await response.json()).ok === true;
        } catch { return false; }
      };
      if (!await healthy()) {
        console.log("\nサーバーの起動が必要です。現在の会話は一度切断されます。\n対応版アプリとメール・認証アプリを用意してください。");
        if (!["再起動", "START"].includes(await rl.question("起動するには「再起動」と入力: "))) throw new Error("cancelled");
        if (!await healthy()) {
          const previousPid = await writerPid();
          const diagnostic = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-login-start-"));
          await fs.chmod(diagnostic, 0o700);
          const logFile = path.join(diagnostic, "startup.log"), handle = await fs.open(logFile, "wx", 0o600);
          let result;
          try { result = spawnSync(path.join(repository, "private_runner/restart-keep-token.sh"), ["--mode", "full"], { cwd: repository, stdio: ["ignore", handle.fd, handle.fd] }); }
          finally { await handle.close(); }
          if (result.error || result.status !== 0) throw new Error(`起動できませんでした。詳細: ${logFile}`);
          console.log("◌ サーバーの起動を待っています…");
          const deadline = Date.now() + 60_000;
          while (true) {
            if (await healthy()) {
              const currentPid = await writerPid();
              if (currentPid && currentPid !== previousPid) break;
            }
            if (Date.now() >= deadline) throw new Error(`起動を確認できませんでした。詳細: ${logFile}`);
            await setTimeout(250);
          }
          await fs.rm(diagnostic, { recursive: true });
        }
      }

      const verifyCode = async (label, digits, submit) => {
        for (let attempt = 0; attempt < 5;) {
          const code = (await rl.question(`${label}（${digits}桁）: `)).normalize("NFKC").replace(/\s/g, "");
          if (!new RegExp(`^\\d{${digits}}$`).test(code)) { console.log(`${digits}桁の数字を入力してください。`); continue; }
          try { return await submit(code); }
          catch (failure) {
            if (failure.code !== "invalid_authentication") throw failure;
            attempt++;
            console.log("コードを確認して、もう一度入力してください。");
          }
        }
        throw new Error("invalid_authentication");
      };
      console.log("\n1/3 ✉ メールを確認");
      const email = (await rl.question("メールアドレス: ")).trim();
      const clientBinding = randomBytes(32).toString("base64url");
      const start = await request("/auth/setup/start", { email, clientBinding });
      console.log("最新のメールにある8桁を入力してください。");
      const prepared = await verifyCode("メールのコード", 8, (emailCode) => request("/auth/setup/prepare", { ...start, clientBinding, emailCode }));
      console.log("\n2/3 ▣ 認証アプリに登録\nGoogle Authenticator等で、このQRを読み取ってください。\nBittyが複数ある場合は、今追加した登録を使います。");
      qrcode.generate(prepared.uri, { small: true });
      console.log("復旧コードも続けて表示します。保存先を用意してください。");
      await rl.question("保存の準備ができたら Enter: ");
      const result = await verifyCode("認証アプリのコード", 6, (totpCode) => request("/auth/setup/complete", { setupId: prepared.setupId, clientBinding, totpCode }));
      console.log("\n3/3 ◆ 復旧コードを保存（一度だけ表示）\n" + result.recoveryCodes.join("\n"));
      await rl.question("保存したら Enter: ");
      console.log("\n✓ 初期設定が完了しました。\nアプリでメールを送り直してログインしてください。\n認証アプリは数字が切り替わってから入力します。");
      await pairing();
    }
  }
} catch (failure) {
  const code = String(failure.code || failure.message || "unknown_error").replace(/[\r\n]/g, " ").slice(0, 240);
  const message = {
    terminal_required: "Macのターミナルから実行してください。",
    unknown_action: "setup・reset・unlockのいずれかを指定してください。",
    cancelled: "中止しました。",
    unsafe_local_credential: "制御用ファイルの権限を確認してください。変更せず停止しました。",
    local_credential_missing: "制御用ファイルが見つからないか空です。サーバーの起動設定を確認してください。",
    runner_login_mail_unconfigured: "メール送信の設定がありません。private_runner/.envを確認してください。",
    authentication_required: "サーバーと制御用ファイルが一致しません。restart-keep-token.shで起動し直してください。",
    owner_migration_required: "保存済みの所有者IDが一致しません。データを消さず、移行を確認してください。",
    owner_already_registered: "初期設定は完了しています。アプリでログインしてください。",
    invalid_authentication: "コードを確認できませんでした。最新のメールと認証アプリの登録を確認してください。",
    authentication_rate_limited: "少し待ってから、もう一度お試しください。",
    authentication_unavailable: "登録を完了できませんでした。メール送信設定とサーバーの状態を確認してください。",
    runner_login_store_invalid: "認証データを読み取れません。データを消さず、状態を確認してください。",
    runner_login_storage_permissions: "認証データの権限を確認してください。変更せず停止しました。",
    unsafe_writer_lock: "ロックファイルの権限を確認してください。",
    invalid_writer_lock: "ロックファイルの内容を確認してください。",
    runner_still_running: "サーバーが動いています。停止してから解除してください。",
    unsafe_control_socket: "制御ソケットの権限を確認してください。",
    control_socket_unknown: "サーバーの停止を確認できませんでした。解除せず停止しました。",
    no_stale_control_files: "解除する古いロックはありません。",
    writer_lock_changed: "状態が変わりました。解除せず停止しました。",
    pairing_unavailable: "接続QRを表示できませんでした。接続設定を確認してください。",
    ECONNREFUSED: "サーバーに接続できません。起動状態を確認してください。",
    ENOENT: "必要なファイルが見つかりません。setup-login.shから実行してください。",
  }[code] || `${code}\n初期設定を完了できませんでした。`;
  (code === "cancelled" ? console.log : console.error)(`${code === "cancelled" ? "•" : "✕"} ${message}`);
  if (code !== "cancelled") process.exitCode = 1;
} finally { rl?.close(); }
