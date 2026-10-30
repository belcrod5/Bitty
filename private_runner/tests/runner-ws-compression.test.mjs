import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { listRunnerConnectionEvents } from "../src/runner-connection-events.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-ws-compression-"));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-compression-token";
process.env.CLIENT_STATE_STORE_PATH = path.join(tempDir, "client-state.json");
process.env.CODEX_WS_DEBUG_FILE = path.join(tempDir, "ws-debug.jsonl");
const { __TESTING__ } = await import("../src/server-runtime.mjs");
const { server, runnerWsServer } = __TESTING__;
const fixture = JSON.stringify({ channel: "agent", op: "compression.fixture", payload: {
  sessions: Array.from({ length: 300 }, (_, index) => ({
    sessionRef: { backendId: "codex", nativeSessionId: `session-${index}` },
    title: `通信量の確認 ${index}`, updatedAt: "2026-10-30T00:00:00.000Z",
  })),
} });

test.after(async () => fs.rm(tempDir, { recursive: true, force: true }));
test("runner WS negotiates compression, preserves messages, and accepts uncompressed reconnects", { timeout: 10_000 }, async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const perMessageDeflate of [true, false, true]) {
      const sendFixture = (ws) => ws.send(fixture);
      runnerWsServer.once("connection", sendFixture);
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/runner-ws`, {
        perMessageDeflate, headers: { authorization: "Bearer test-compression-token" },
      });
      try {
        const received = await new Promise((resolve, reject) => {
          ws.on("error", reject);
          ws.on("message", (data) => {
            if (JSON.parse(data).op === "compression.fixture") resolve(data.toString());
          });
        });
        assert.equal(received, fixture);
        assert.equal(ws.extensions.includes("permessage-deflate"), perMessageDeflate);
        const opened = listRunnerConnectionEvents().latestAllowedEvent;
        assert.equal(opened.perMessageDeflate, perMessageDeflate);
        if (perMessageDeflate) assert.ok(ws._socket.bytesRead < Buffer.byteLength(fixture) / 4);
        else assert.ok(ws._socket.bytesRead >= Buffer.byteLength(fixture));
        console.info(`[WS synthetic] deflate=${perMessageDeflate} JSON=${Buffer.byteLength(fixture)} wireIncludingHandshake=${ws._socket.bytesRead} bytes`);
      } finally {
        runnerWsServer.removeListener("connection", sendFixture);
        const closed = new Promise((resolve) => ws.once("close", resolve));
        ws.close();
        await closed;
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
