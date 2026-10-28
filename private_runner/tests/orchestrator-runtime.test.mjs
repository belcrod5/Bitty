import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrchestratorRuntime } from "../src/orchestrator-runtime.mjs";

const OTHER = "12345678-1234-4234-8234-123456789abc";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-process-test-"));
  const mainWorkspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "orchestrators", OTHER, "workspace");
  await fs.mkdir(mainWorkspace, { recursive: true }); await fs.mkdir(otherWorkspace, { recursive: true });
  const children = [];
  const calls = [];
  let auth = { accessToken: "test-token-a", accountId: "account-a" };
  let rejectLogin = false;
  let authWait;
  const manager = createOrchestratorRuntime({ rootDir: root,
    childEnv: { PATH: "/bin", HOME: "/shared-home", CODEX_HOME: "/shared-codex", OPENAI_API_KEY: "never-inherit", CUSTOM: "never-inherit" },
    resolveAuth: async (options) => { calls.push({ method: "resolveAuth", options }); if (authWait) await authWait; return auth; },
    spawnImpl(bin, args, options) {
      const child = new EventEmitter();
      child.exitCode = null; child.stderr = { resume() {} };
      child.kill = (signal) => { child.exitCode = 0; child.signal = signal; queueMicrotask(() => child.emit("exit", 0)); return true; };
      children.push({ child, bin, args, options });
      return child;
    },
    createClient(options) {
      const owner = children.find((entry) => options.upstreamUrl.includes(entry.args[entry.args.indexOf("--listen") + 1].slice("unix://".length)));
      assert.ok(owner);
      let closed = false;
      return { options, openPromise: Promise.resolve(),
        async request(method, params) {
          calls.push({ method, params, owner });
          if (method === "initialize") return { codexHome: owner.options.env.CODEX_HOME };
          if (method === "account/login/start") return { type: rejectLogin ? "wrong" : "chatgptAuthTokens" };
          return {};
        },
        notify() {}, close() { if (!closed) { closed = true; options.onClose?.(); } },
      };
    },
  });
  t.after(async () => { await manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, mainWorkspace, otherWorkspace, children, calls, manager,
    setAuth(value) { auth = value; },
    blockAuth() { let release; authWait = new Promise((resolve) => { release = resolve; }); return release; }, rejectLogin() { rejectLogin = true; } };
}

test("specialists own separate processes, homes, sessions and short private sockets without inherited secrets", async (t) => {
  const f = await fixture(t);
  const a = await f.manager.createClient({ orchestratorId: "main", workspaceDirectory: f.mainWorkspace });
  const b = await f.manager.createClient({ orchestratorId: OTHER, workspaceDirectory: f.otherWorkspace });
  assert.equal(f.children.length, 2);
  assert.notEqual(a.options.upstreamUrl, b.options.upstreamUrl);
  for (const owner of f.children) {
    assert.equal(owner.args.includes('cli_auth_credentials_store="ephemeral"'), true);
    assert.equal(owner.args.includes('project_root_markers=[".bitty-orchestrator-root"]'), true);
    assert.equal(owner.options.env.OPENAI_API_KEY, undefined);
    assert.equal(owner.options.env.CUSTOM, undefined);
    assert.equal(owner.options.env.CODEX_SQLITE_HOME, owner.options.env.CODEX_HOME);
    assert.equal(owner.options.env.HOME.startsWith(path.dirname(owner.options.cwd)), true);
    assert.equal(owner.options.env.CODEX_HOME.startsWith(path.dirname(owner.options.cwd)), true);
    assert.equal(owner.args[owner.args.indexOf("--listen") + 1].length < 100, true);
    assert.equal(owner.options.shell, false);
  }
  assert.notEqual(f.children[0].options.env.HOME, f.children[1].options.env.HOME);
  assert.notEqual(f.children[0].options.env.CODEX_HOME, f.children[1].options.env.CODEX_HOME);
  assert.equal(f.calls.filter((call) => call.method === "account/login/start").length, 2);
  assert.equal(f.calls.filter((call) => call.method === "initialize").length, 4);
  a.close(); b.close();
});

test("a reused process receives current authentication after account changes and refreshes only its account", async (t) => {
  const f = await fixture(t);
  const options = { orchestratorId: "main", workspaceDirectory: f.mainWorkspace };
  const a = await f.manager.createClient(options);
  a.close();
  (await f.manager.createClient(options)).close();
  assert.equal(f.children.length, 1);
  assert.equal(f.calls.filter((call) => call.method === "account/login/start").length, 1);
  f.setAuth({ accessToken: "test-token-b", accountId: "account-b" });
  const b = await f.manager.createClient(options);
  assert.equal(f.calls.filter((call) => call.method === "account/login/start").length, 2);
  const refresh = b.options.authRefreshHandler;
  await assert.rejects(refresh({ params: { reason: "unauthorized", previousAccountId: "account-a" } }), { code: "orchestrator_runtime_unavailable" });
  assert.deepEqual(await refresh({ params: { reason: "unauthorized", previousAccountId: "account-b" } }), {
    accessToken: "test-token-b", chatgptAccountId: "account-b",
  });
  assert.equal(f.calls.filter((call) => call.method === "resolveAuth").at(-1).options.forceRefresh, true);
  b.close();
});

test("dispose stops the owned process and closes leases before deletion; restart retains its home", async (t) => {
  const f = await fixture(t);
  let closed = 0;
  const options = { orchestratorId: "main", workspaceDirectory: f.mainWorkspace, onClose() { closed++; } };
  await f.manager.createClient(options);
  const firstHome = f.children[0].options.env.CODEX_HOME;
  const oldSocket = f.children[0].args[f.children[0].args.indexOf("--listen") + 1].slice("unix://".length);
  await f.manager.dispose("main");
  assert.equal(closed, 1);
  assert.equal(f.children[0].child.signal, "SIGTERM");
  await assert.rejects(fs.stat(path.dirname(oldSocket)), { code: "ENOENT" });
  assert.equal((await fs.stat(firstHome)).isDirectory(), true);
  (await f.manager.createClient(options)).close();
  assert.equal(f.children.length, 2);
  assert.equal(f.children[1].options.env.CODEX_HOME, firstHome);
});

test("cross-owner workspace, failed authentication and stopped manager never fall back to shared Codex", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.manager.createClient({ orchestratorId: "main", workspaceDirectory: f.otherWorkspace }), { code: "orchestrator_runtime_unavailable" });
  await assert.rejects(f.manager.createClient({ orchestratorId: "invalid", workspaceDirectory: f.mainWorkspace }), { code: "orchestrator_runtime_unavailable" });
  assert.equal(f.children.length, 0);
  f.rejectLogin();
  await assert.rejects(f.manager.createClient({ orchestratorId: "main", workspaceDirectory: f.mainWorkspace }), { code: "orchestrator_runtime_unavailable" });
  await f.manager.shutdown();
  await assert.rejects(f.manager.createClient({ orchestratorId: "main", workspaceDirectory: f.mainWorkspace }), { code: "orchestrator_runtime_unavailable" });
});


test("dispose and shutdown during authentication cannot return a new client for a stopped process", async (t) => {
  for (const shutdown of [false, true]) {
    const f = await fixture(t);
    const release = f.blockAuth();
    const pending = f.manager.createClient({ orchestratorId: "main", workspaceDirectory: f.mainWorkspace });
    for (let i = 0; i < 100 && !f.calls.some((call) => call.method === "resolveAuth"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(f.calls.some((call) => call.method === "resolveAuth"), true);
    if (shutdown) await f.manager.shutdown(); else await f.manager.dispose("main");
    release();
    await assert.rejects(pending, { code: "orchestrator_runtime_unavailable" });
    assert.equal(f.calls.some((call) => call.method === "account/login/start"), false);
  }
});

test("an already cancelled request never starts a process or resolves credentials", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.manager.createClient({ orchestratorId: "main", workspaceDirectory: f.mainWorkspace, signal: controller.signal }), { code: "ABORT_ERR" });
  assert.equal(f.children.length, 0); assert.equal(f.calls.length, 0);
});


test("IPC disconnect removes the dying process before another client can reuse its socket", async (t) => {
  const f = await fixture(t);
  const options = { orchestratorId: "main", workspaceDirectory: f.mainWorkspace };
  const first = await f.manager.createClient(options);
  f.children[0].child.emit("disconnect");
  const next = await f.manager.createClient(options);
  assert.equal(f.children.length, 2);
  assert.notEqual(first.options.upstreamUrl, next.options.upstreamUrl);
  next.close();
});
