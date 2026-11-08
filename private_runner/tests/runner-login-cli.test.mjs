import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function fixture(t, kind = "current-file") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bl-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runner = path.join(root, "private_runner"), tools = path.join(runner, "tools");
  const helpers = path.join(root, "skills/bitty-session-orchestrator/scripts"), logs = path.join(runner, "logs");
  await Promise.all([fs.mkdir(tools, { recursive: true }), fs.mkdir(helpers, { recursive: true }), fs.mkdir(logs, { recursive: true }), fs.mkdir(path.join(runner, "src"), { recursive: true })]);
  await fs.copyFile(new URL("../tools/runner-login.mjs", import.meta.url), path.join(tools, "runner-login.mjs"));
  await fs.copyFile(new URL("../src/runner-login-store.mjs", import.meta.url), path.join(runner, "src/runner-login-store.mjs"));
  await fs.copyFile(new URL("../../skills/bitty-session-orchestrator/scripts/runner-control.mjs", import.meta.url), path.join(helpers, "runner-control.mjs"));
  await fs.symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(runner, "node_modules"));
  const tokenFile = path.join(logs, "runner-token");
  if (kind !== "missing-file") {
    const target = kind === "symlink-file" ? path.join(logs, "other-token") : tokenFile;
    await fs.writeFile(target, kind === "empty-file" ? "" : "current-runtime-token\n", { mode: 0o600 });
    if (kind === "unsafe-file") await fs.chmod(target, 0o644);
    if (kind === "symlink-file") await fs.symlink(target, tokenFile);
  }
  const preload = path.join(root, "terminal.mjs");
  await fs.writeFile(preload, `import { createRequire } from "node:module";
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    const require = createRequire(${JSON.stringify(path.join(tools, "runner-login.mjs"))});
    require("qrcode-terminal").generate = () => console.log("[QR]");`);
  const received = [];
  let respond = (req) => req.url === "/health" ? { status: 200, body: { ok: true } } : { status: 409, body: { error: "fixture_stop" } };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    received.push({ route: req.url, authorization: req.headers.authorization, body });
    const response = await respond(req, body);
    res.writeHead(response.status, { "content-type": "application/json" }); res.end(JSON.stringify(response.body));
  });
  const socket = path.join(root, "c.sock");
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, RUNNER_TOKEN: "stale-env-token", RUNNER_TOKEN_FILE: tokenFile, RUNNER_CONTROL_SOCKET: socket,
    RUNNER_LOGIN_DIRECTORY: path.join(logs, "runner-login"), MJ_APIKEY_PUBLIC: "test-public", MJ_APIKEY_PRIVATE: "test-private", RUNNER_LOGIN_MAIL_FROM: "test@example.test" };
  return { root, runner, logs, received, env, respond(value) { respond = value; },
    async run(prompts = [], action = "setup") {
      const child = spawn(process.execPath, ["--import", preload, path.join(tools, "runner-login.mjs"), action], { cwd: os.tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", errors = "", cursor = 0, entered = 0;
      const timeout = setTimeout(() => child.kill(), 10000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        while (entered < prompts.length) {
          const [prompt, answer] = prompts[entered], at = output.indexOf(prompt, cursor);
          if (at < 0) break;
          cursor = at + prompt.length; entered++; child.stdin.write(answer + "\n");
        }
      });
      child.stderr.on("data", (chunk) => { errors += chunk; });
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      clearTimeout(timeout);
      assert.ok(!output.includes("stale-env-token") && !output.includes("current-runtime-token"));
      assert.ok(!errors.includes("stale-env-token") && !errors.includes("current-runtime-token"));
      return { code, output, errors };
    },
  };
}

for (const kind of ["current-file", "missing-file", "empty-file", "unsafe-file", "symlink-file"]) {
  test(`owner setup CLI credential precedence: ${kind}`, async (t) => {
    const f = await fixture(t, kind);
    const result = await f.run([["メールアドレス: ", "owner@example.test"]]);
    assert.equal(result.code, 1, result.errors);
    if (kind === "current-file" || kind === "missing-file") {
      assert.deepEqual(f.received.map(({ route, authorization }) => ({ route, authorization })), ["/health", "/auth/setup/start"].map(route => ({ route,
        authorization: `Bearer ${kind === "current-file" ? "current-runtime-token" : "stale-env-token"}` })));
      assert.match(result.errors, /fixture_stop/);
      assert.ok(!result.output.includes("再起動"));
    } else {
      assert.deepEqual(f.received, []);
      assert.match(result.errors, kind === "empty-file" ? /制御用ファイルが見つからないか空/ : /制御用ファイルの権限/);
    }
  });
}

test("Japanese owner setup retries codes without discarding the QR and waits for recovery storage", async (t) => {
  const f = await fixture(t); let emailAttempts = 0;
  f.respond((req, body) => {
    if (req.url === "/health") return { status: 200, body: { ok: true } };
    if (req.url === "/auth/setup/start") return { status: 200, body: { challengeId: "challenge" } };
    if (req.url === "/auth/setup/prepare") {
      if (++emailAttempts === 1) return { status: 400, body: { error: "invalid_authentication" } };
      assert.equal(body.emailCode, "12345678");
      return { status: 200, body: { setupId: "setup", uri: "otpauth://totp/fixture" } };
    }
    assert.equal(body.totpCode, "123456");
    return { status: 200, body: { recoveryCodes: ["fixture-recovery"] } };
  });
  const result = await f.run([["メールアドレス: ", "owner@example.test"], ["メールのコード（8桁）: ", "00000000"],
    ["メールのコード（8桁）: ", "１２３４ ５６７８"], ["保存の準備ができたら Enter: ", ""],
    ["認証アプリのコード（6桁）: ", "１２３ ４５６"], ["保存したら Enter: ", ""], ["接続QRを表示しますか？ [y/N]: ", ""]]);
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.output.match(/\[QR\]/g).length, 1);
  assert.match(result.output, /初期設定が完了しました/);
  assert.ok(result.output.indexOf("fixture-recovery") < result.output.indexOf("保存したら Enter"));
  assert.ok(result.output.indexOf("保存したら Enter") < result.output.indexOf("初期設定が完了"));
});

test("configured state offers connection QR without restarting or touching server state", async (t) => {
  const f = await fixture(t), directory = f.env.RUNNER_LOGIN_DIRECTORY;
  await fs.mkdir(directory, { mode: 0o700 });
  const now = Date.now(), state = { version: 1, ownerSubjectId: "runner:" + "a".repeat(64), generation: 1,
    owner: { email: "owner@example.test", secret: { iv: Buffer.alloc(12).toString("base64"), tag: Buffer.alloc(16).toString("base64"), data: Buffer.alloc(20).toString("base64") }, lastTotpStep: 0, recoveryHashes: [] },
    sessions: [], challenges: [], outbox: [], budget: { windowAt: now, sentAt: 0, attempts: 0, sends: 0 } };
  const file = path.join(directory, "state.json"); await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
  const before = await fs.readFile(file, "utf8");
  const result = await f.run([["接続QRを表示しますか？ [y/N]: ", ""]]);
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /初期設定は完了しています/);
  assert.deepEqual(f.received, []);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("reset uses explicit Japanese confirmation and preserves the server confirmation contract", async (t) => {
  const f = await fixture(t);
  f.respond(() => ({ status: 200, body: { ok: true } }));
  const cancelled = await f.run([["初期化するには「初期化」と入力: ", ""]], "reset");
  assert.equal(cancelled.code, 0); assert.match(cancelled.output, /中止しました/); assert.deepEqual(f.received, []);
  const confirmed = await f.run([["初期化するには「初期化」と入力: ", "初期化"]], "reset");
  assert.equal(confirmed.code, 0, confirmed.errors);
  assert.deepEqual(f.received.map(({ route, body }) => ({ route, body })), [{ route: "/auth/setup/reset", body: { confirm: "RESET OWNER" } }]);
});

test("offline setup waits for a new writer process and keeps startup diagnostics out of the prompts", async (t) => {
  const f = await fixture(t), directory = f.env.RUNNER_LOGIN_DIRECTORY;
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, "writer.lock"), "1234", { mode: 0o600 });
  await fs.writeFile(path.join(f.runner, "restart-keep-token.sh"), `#!/usr/bin/env bash
printf 'technical-startup-noise\\n'
printf '' > "$RUNNER_LOGIN_DIRECTORY/writer.lock"
(sleep 0.15; printf 5678 > "$RUNNER_LOGIN_DIRECTORY/writer.lock"; touch "$PWD/ready.fixture") >/dev/null 2>&1 &
`, { mode: 0o755 });
  f.respond(async (req) => {
    if (req.url !== "/health") return { status: 409, body: { error: "fixture_stop" } };
    const started = await fs.stat(path.join(f.root, "ready.fixture")).then(() => true, () => false);
    return { status: started ? 200 : 503, body: { ok: started } };
  });
  const result = await f.run([["起動するには「再起動」と入力: ", "再起動"], ["メールアドレス: ", "owner@example.test"]]);
  assert.equal(result.code, 1, result.errors);
  assert.match(result.errors, /fixture_stop/);
  assert.ok(!result.output.includes("technical-startup-noise"));
  assert.equal(await fs.readFile(path.join(directory, "writer.lock"), "utf8"), "5678");
  assert.ok(f.received.some(request => request.route === "/auth/setup/start"));
});

test("setup skips restart if an existing Runner becomes ready while confirming", async (t) => {
  const f = await fixture(t); let probes = 0;
  f.respond((req) => req.url === "/health"
    ? { status: ++probes === 1 ? 503 : 200, body: { ok: probes > 1 } }
    : { status: 409, body: { error: "fixture_stop" } });
  const result = await f.run([["起動するには「再起動」と入力: ", "再起動"], ["メールアドレス: ", "owner@example.test"]]);
  assert.equal(result.code, 1, result.errors);
  assert.match(result.errors, /fixture_stop/);
  assert.ok(!result.output.includes("サーバーの起動を待っています"));
});

test("corrupt local state fails before restarting and never prints stored secrets", async (t) => {
  const f = await fixture(t), directory = f.env.RUNNER_LOGIN_DIRECTORY;
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, "state.json"), '{"fixture-private-secret":', { mode: 0o600 });
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.errors, /認証データを読み取れません/);
  assert.ok(!result.errors.includes("fixture-private-secret"));
  assert.deepEqual(f.received, []);
});
