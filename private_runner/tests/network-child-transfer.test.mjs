import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createAgentService } from "../src/agent/agent-service.mjs";
import { createCodexSessionChildrenObserver } from "../src/codex-session-children.mjs";
import { operationStore, sessionStore } from "./agent-service-fixtures.mjs";

test("synthetic child lists preserve displayed titles while eliminating unrelated item transfers", { timeout: 10_000 }, async () => {
  const native = Array.from({ length: 10 }, (_, index) => ({
    sessionRef: { backendId: "codex", nativeSessionId: `synthetic-child-${index}` },
    parentSessionRef: { backendId: "codex", nativeSessionId: "synthetic-parent" },
    canonicalCwd: "/synthetic", title: `Synthetic child ${index}: ${"long initial delegation instructions. ".repeat(300)}`,
  }));
  const service = createAgentService({
    backends: [{ backendId: "codex", getStatus: async () => ({ readiness: { ready: true }, capabilities: { session: { list: true } } }),
      listSessions: async () => ({ sessions: native }) }],
    operationStore: operationStore(), sessionStore: sessionStore(), workspaceAdmission: { assertAllowed: async (_subject, cwd) => cwd },
    resolveCanonicalCwd: async (cwd) => cwd,
  });
  const reduced = await service.listSessions({ backendId: "codex", cwd: "/synthetic" });
  for (let i = 0; i < native.length; i++) assert.equal(reduced.sessions[i].title, `${Array.from(native[i].title).slice(0, 199).join("")}…`);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: {
    threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true,
  } });
  await once(server, "listening");
  const nativeEvents = Array.from({ length: 100 }, (_, index) => ["item/completed", {
    threadId: "synthetic-parent", item: { id: `item-${index}`, type: ["commandExecution", "reasoning", "agentMessage"][index % 3] },
  }]);
  nativeEvents.push(["item/completed", { threadId: "synthetic-parent", item: { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["synthetic-child-0"] } }]);
  nativeEvents.push(["turn/completed", { threadId: "synthetic-child-0" }]);
  const measurements = [];
  server.on("connection", (socket) => socket.on("message", (data) => {
    const request = JSON.parse(data);
    socket.send(JSON.stringify({ channel: "agent", op: "sessions.list.result", requestId: request.id,
      payload: request.legacy ? { sessions: native } : reduced }));
  }));
  try {
    for (const legacy of [true, false]) {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { perMessageDeflate: true });
      await once(socket, "open");
      const initialSocketBytes = socket._socket.bytesRead;
      let decodedBytes = 0, requests = 0;
      const pending = new Map();
      socket.on("message", (data) => {
        decodedBytes += data.length;
        const response = JSON.parse(data);
        pending.get(response.requestId)?.(); pending.delete(response.requestId);
      });
      const work = [];
      const requestList = () => {
        const id = String(++requests);
        work.push(new Promise((resolve) => { pending.set(id, resolve); }));
        socket.send(JSON.stringify({ id, legacy }));
      };
      const observe = createCodexSessionChildrenObserver({ resolveSession: async () => null, onChanged: requestList });
      for (const [method, params] of nativeEvents) {
        if (legacy) requestList();
        else await observe(method, params);
      }
      await Promise.all(work);
      measurements.push({ requests, decodedBytes, socketResponseBytes: socket._socket.bytesRead - initialSocketBytes });
      socket.close(); await once(socket, "close");
    }
  } finally {
    server.close(); await once(server, "close");
  }
  const [before, after] = measurements;
  assert.equal(before.requests, 102);
  assert.equal(after.requests, 2);
  assert.ok(after.decodedBytes < before.decodedBytes / 100);
  assert.ok(after.socketResponseBytes < before.socketResponseBytes / 20);
  console.info(`[child transfer fixture] before=${JSON.stringify(before)} after=${JSON.stringify(after)}; socket response bytes include WS frames, exclude handshake/TLS; decoded bytes are complete response JSON`);
});
