import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createCodexAppServerClient } from "../src/codex-app-server-client.mjs";

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  send(raw) {
    this.sent.push(JSON.parse(String(raw)));
  }

  close(code, reason) {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.emit("close", code, Buffer.from(reason));
  }

  receive(message) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

test("preserves Codex App Server request, notification, and completion semantics", async () => {
  const client = createCodexAppServerClient({
    upstreamUrl: "ws://codex.test",
    upstreamToken: "secret",
    WebSocketImpl: FakeWebSocket,
  });
  client.ws.open();
  await client.openPromise;
  assert.equal(client.ws.options.headers.authorization, "Bearer secret");

  const response = client.request("thread/read", { threadId: "thread-1" }, 1000);
  assert.deepEqual(client.ws.sent[0], { id: 1, method: "thread/read", params: { threadId: "thread-1" } });
  client.ws.receive({ id: 1, result: { thread: { id: "thread-1" } } });
  assert.deepEqual(await response, { thread: { id: "thread-1" } });

  const notifications = [];
  client.addNotificationListener((method, params) => notifications.push({ method, params }));
  const completion = client.waitForTurnCompletion();
  client.ws.receive({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1" } });
  completion.expect({ threadId: "thread-1", turnId: "turn-1" });
  await completion.promise;
  assert.deepEqual(notifications, [{
    method: "turn/completed",
    params: { threadId: "thread-1", turnId: "turn-1" },
  }]);
});

test("routes native approval requests through the registered handler", async () => {
  const client = createCodexAppServerClient({
    upstreamUrl: "ws://codex.test",
    WebSocketImpl: FakeWebSocket,
  });
  client.ws.open();
  await client.openPromise;
  client.addServerRequestHandler(async (request) => ({
    decision: request.params.allow ? "accept" : "decline",
  }));

  client.ws.receive({ id: 42, method: "item/commandExecution/requestApproval", params: { allow: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.ws.sent[0], { id: 42, result: { decision: "accept" } });
});

test("routes auth refresh to its dedicated handler exactly once", async () => {
  const client = createCodexAppServerClient({
    upstreamUrl: "ws://codex.test",
    authRefreshHandler: async () => ({ accessToken: "fresh", accountId: "account" }),
    WebSocketImpl: FakeWebSocket,
  });
  client.ws.open();
  await client.openPromise;
  let ordinaryCalls = 0;
  client.addServerRequestHandler(async () => {
    ordinaryCalls += 1;
    return { unexpected: true };
  });

  client.ws.receive({ id: 43, method: "account/chatgptAuthTokens/refresh", params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ordinaryCalls, 0);
  assert.deepEqual(client.ws.sent[0], {
    id: 43,
    result: { accessToken: "fresh", accountId: "account" },
  });
});

test("sends one JSON-RPC error for unhandled and throwing server requests", async () => {
  const client = createCodexAppServerClient({ upstreamUrl: "ws://codex.test", WebSocketImpl: FakeWebSocket });
  client.ws.open();
  await client.openPromise;
  client.addServerRequestHandler(async (request) => {
    if (request.method === "throw") throw new Error("secret token must not leak");
    return undefined;
  });

  client.ws.receive({ id: 44, method: "unknown", params: {} });
  client.ws.receive({ id: 45, method: "throw", params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.ws.sent.length, 2);
  assert.deepEqual(client.ws.sent[0], {
    id: 44,
    error: { code: -32601, message: "Codex server request method not handled" },
  });
  assert.deepEqual(client.ws.sent[1], {
    id: 45,
    error: { code: -32603, message: "Codex server request failed" },
  });
});

test("abort closes the App Server socket and rejects pending RPCs", async () => {
  const controller = new AbortController();
  const client = createCodexAppServerClient({
    upstreamUrl: "ws://codex.test",
    signal: controller.signal,
    WebSocketImpl: FakeWebSocket,
  });
  client.ws.open();
  await client.openPromise;
  const pending = client.request("turn/start", {}, 1000);
  controller.abort();

  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(client.ws.closedWith, { code: 1000, reason: "aborted" });
});

test("calls onClose once for explicit close and repeated socket close events", async () => {
  let calls = 0;
  const client = createCodexAppServerClient({
    upstreamUrl: "ws://codex.test",
    onClose: () => { calls += 1; },
    WebSocketImpl: FakeWebSocket,
  });
  client.ws.open();
  await client.openPromise;
  client.close();
  client.close();
  client.ws.emit("close", 1000, Buffer.from("late"));
  assert.equal(calls, 1);
});

test("calls onClose once when the remote socket closes", async () => {
  let calls = 0;
  const client = createCodexAppServerClient({
    upstreamUrl: "ws://codex.test",
    onClose: () => { calls += 1; },
    WebSocketImpl: FakeWebSocket,
  });
  client.ws.open();
  await client.openPromise;
  client.ws.emit("close", 1006, Buffer.from("remote"));
  client.ws.emit("close", 1006, Buffer.from("duplicate"));
  assert.equal(calls, 1);
});
