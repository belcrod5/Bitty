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
