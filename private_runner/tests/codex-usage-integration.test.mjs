import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocketServer } from "ws";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-codex-usage-ingress-"));
process.env.CODEX_AUTH_STORE_DIR = root;
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-token";
const { __TESTING__: runtime } = await import("../src/server-runtime.mjs");
const { codexUsageService: usage, codexAuthRuntime: auth, codexAuthService, server } = runtime;
const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((resolve) => wsServer.once("listening", resolve));
const clients = [];
const originalActivePayload = auth.activePayload;
let activeAccount = "account-a";
auth.activePayload = () => ({ chatgptAccountId: activeAccount });

const profile = (authId) => ({ version: 1, authId, accountId: `account-${authId}`,
  tokens: { access_token: "test-access", refresh_token: "test-refresh" } });
await codexAuthService.save(profile("a"));
await codexAuthService.save(profile("b"));
await codexAuthService.setActiveAuthId("a");

test.after(async () => {
  auth.activePayload = originalActivePayload;
  for (const client of clients) client.close();
  for (const socket of wsServer.clients) socket.terminate();
  await new Promise((resolve) => wsServer.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await usage.snapshot("account-b");
  await fs.rm(root, { recursive: true, force: true });
});

async function client() {
  const connection = new Promise((resolve) => wsServer.once("connection", resolve));
  const rpc = runtime.createCodexRpcClient({ upstreamUrl: `ws://127.0.0.1:${wsServer.address().port}` });
  clients.push(rpc);
  await rpc.openPromise;
  return { rpc, socket: await connection };
}
async function settled(account, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const snapshot = await usage.snapshot(account);
    if (predicate(snapshot)) return snapshot;
  }
  assert.fail("quota ingress did not settle");
}
function relay(account, threadId = "thread-a") {
  return { usageAccount: Promise.resolve(account), closed: false, threadId, currentTurnId: "turn-a",
    clients: new Set(), eventLog: [], lastSeq: 0, upstreamWs: { readyState: 1, send() {} } };
}
function receive(relay, payload) { runtime.handleCodexRelayUpstreamMessage(relay, JSON.stringify(payload), false); }

test("RPC client, raw relay and status endpoint share one typed-failure account episode", async () => {
  const { socket } = await client();
  socket.send(JSON.stringify({ method: "error", params: { threadId: "agent-session", turnId: "agent-turn",
    error: { codexErrorInfo: "usageLimitExceeded", message: "usage exhausted" } } }));
  const failed = await settled("account-a", (state) => state?.usageLimitReached);
  assert.match(failed.statusText, /利用上限/);
  const raw = relay("account-a");
  receive(raw, { method: "account/rateLimits/updated", params: {
    rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 4102444800 } } } });
  receive(raw, { method: "error", params: { error: { codexErrorInfo: "usageLimitExceeded", message: "same quota" } } });
  await settled("account-a", (state) => state?.statusText.includes("0% left"));
  const stored = JSON.parse(await fs.readFile(path.join(root, "usage.json"), "utf8"));
  assert.equal(stored.accounts["account-a"].episode, 1);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/codex-cli/status`, {
      headers: { authorization: "Bearer test-token" },
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.usageLimitReached, true);
    assert.equal(body.cached, true);
    assert.equal(JSON.stringify(body).includes("test-access"), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("a connection keeps its original account across switches and late events cannot replace active cache", async () => {
  const { socket, rpc } = await client();
  rpc.close();
  activeAccount = "account-b";
  await codexAuthService.setActiveAuthId("b");
  // Account-global rolling updates on an idle old relay cannot be attributed
  // after the shared app-server switches to the new account.
  const oldSnapshot = await usage.snapshot("account-a");
  receive(relay("account-a"), { method: "account/rateLimits/updated", params: {
    rateLimits: { secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 4102444800 } } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await usage.snapshot("account-a"), oldSnapshot);
  assert.equal(await usage.snapshot("account-b"), undefined);
  // A turn-scoped error still belongs to the account that ran that turn.
  rpc.ws.emit("message", Buffer.from(JSON.stringify({ method: "error", params: { error: {
    codexErrorInfo: "usageLimitExceeded", message: "late old turn" } } })));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await usage.snapshot("account-b"), undefined);
  const raw = relay("account-b");
  receive(raw, { method: "error", params: { error: { codexErrorInfo: "rateLimitExceeded", message: "transient" } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await usage.snapshot("account-b"), undefined);
  receive(raw, { method: "error", params: { error: { codexErrorInfo: "usageLimitExceeded", message: "new account quota" } } });
  await settled("account-b", (state) => state?.usageLimitReached);
  socket.close();
});

test("a failed raw turn never emits per-turn completion notifications for partial assistant text", () => {
  const original = runtime.turnCompletionNotifier.notifyTurnCompleted;
  const completions = [];
  runtime.turnCompletionNotifier.notifyTurnCompleted = (event) => completions.push(event);
  try {
    const raw = relay("account-b");
    receive(raw, { method: "item/agentMessage/delta", params: { threadId: "thread-a", turnId: "turn-a", delta: "partial answer" } });
    receive(raw, { method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a", status: "failed", error: {
      codexErrorInfo: "usageLimitExceeded", message: "quota" } } } });
    assert.equal(completions.length, 0);
  } finally { runtime.turnCompletionNotifier.notifyTurnCompleted = original; }
});
