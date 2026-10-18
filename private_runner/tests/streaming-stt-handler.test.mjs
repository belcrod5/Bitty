import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createStreamingSttHandler } from "../src/streaming-stt-handler.mjs";

test("saved provider receives the same first start message on each new session", async () => {
  let selected = "macos";
  const received = [];
  const handler = createStreamingSttHandler({
    sttSettings: { get: async () => selected },
    googleHandler: (ws) => ws.on("message", (raw) => received.push(["google", String(raw)])),
    macosHandler: (ws) => ws.on("message", (raw) => received.push(["macos", String(raw)])),
  });
  for (const provider of ["macos", "google"]) {
    selected = provider;
    const ws = new EventEmitter();
    ws.readyState = 1;
    handler(ws);
    ws.emit("message", Buffer.from("start"), false);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(received, [["macos", "start"], ["google", "start"]]);
});

test("does not drop a second control message while provider selection is pending", async () => {
  let resolveSelection;
  const ws = new EventEmitter();
  ws.readyState = 1;
  const sent = [];
  ws.send = (raw) => sent.push(JSON.parse(raw));
  ws.close = () => { ws.readyState = 3; };
  createStreamingSttHandler({
    sttSettings: { get: () => new Promise((resolve) => { resolveSelection = resolve; }) },
    googleHandler: () => assert.fail("provider should not start after protocol failure"),
    macosHandler: () => assert.fail("provider should not start after protocol failure"),
  })(ws);
  ws.emit("message", Buffer.from("start"), false);
  ws.emit("message", Buffer.from("stop"), false);
  resolveSelection("google");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].code, "protocol_order");
  assert.equal(ws.readyState, 3);
});

test("continuation requires an explicit request and a macOS provider; legacy and Google sessions stay unchanged", async () => {
  for (const [provider, url, expected] of [
    ["macos", undefined, false],
    ["macos", "/stream-stt", false],
    ["macos", "/stream-stt?continuation=1", true],
    ["google", "/stream-stt?continuation=1", false],
  ]) {
    const received = [];
    const handler = createStreamingSttHandler({
      sttSettings: { get: async () => provider },
      googleHandler: (_ws, options) => received.push(options),
      macosHandler: (_ws, options) => received.push(options),
    });
    const ws = new EventEmitter();
    ws.readyState = 1;
    handler(ws, url ? { url } : undefined);
    ws.emit("message", Buffer.from("start"), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [{ continuation: expected }]);
  }
});
