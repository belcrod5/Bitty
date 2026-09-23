import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installRunnerWebSocketUpgradeHandler } from "../src/runner-websocket-upgrade.mjs";
import { STREAM_STT_MAX_PAYLOAD_BYTES } from "../src/google-streaming-stt.mjs";

function request(token = "", url = "/runner-ws") {
  return {
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function socketProbe() {
  return {
    writes: [],
    destroyed: false,
    write(value) { this.writes.push(value); },
    destroy() { this.destroyed = true; },
  };
}

function wsServerProbe(options = {}) {
  const server = new EventEmitter();
  server.options = options;
  server.upgrades = 0;
  server.handleUpgrade = (req, socket, head, done) => {
    server.upgrades += 1;
    done(new EventEmitter());
  };
  return server;
}

function install(runnerToken) {
  const server = new EventEmitter();
  const runnerWsServer = wsServerProbe();
  const streamTtsWsServer = wsServerProbe();
  const streamSttWsServer = wsServerProbe({ maxPayload: STREAM_STT_MAX_PAYLOAD_BYTES });
  const debugEvents = [];
  installRunnerWebSocketUpgradeHandler({
    server,
    runnerToken,
    runnerWsPath: "/runner-ws",
    runnerWsServer,
    streamTtsWsServer,
    streamSttWsServer,
    appendDebug: (event, payload) => { debugEvents.push({ event, payload }); },
  });
  return { server, runnerWsServer, streamTtsWsServer, streamSttWsServer, debugEvents };
}

test("rejects a WebSocket upgrade with a mismatched runner token", () => {
  const { server, runnerWsServer } = install("expected-token");
  const socket = socketProbe();

  server.emit("upgrade", request("wrong-token"), socket, Buffer.alloc(0));

  assert.deepEqual(socket.writes, ["HTTP/1.1 401 Unauthorized\r\n\r\n"]);
  assert.equal(socket.destroyed, true);
  assert.equal(runnerWsServer.upgrades, 0);
});

test("routes an authenticated WebSocket upgrade", () => {
  const { server, runnerWsServer } = install("expected-token");
  const socket = socketProbe();

  server.emit("upgrade", request("expected-token"), socket, Buffer.alloc(0));

  assert.equal(socket.destroyed, false);
  assert.equal(runnerWsServer.upgrades, 1);
});

test("routes only the exact authenticated /stream-stt upgrade to the isolated STT server", () => {
  const { server, runnerWsServer, streamTtsWsServer, streamSttWsServer } = install("expected-token");
  const accepted = socketProbe();
  server.emit("upgrade", request("expected-token", "/stream-stt"), accepted, Buffer.alloc(0));
  assert.equal(accepted.destroyed, false);
  assert.equal(streamSttWsServer.upgrades, 1);
  assert.equal(streamSttWsServer.options.maxPayload, 65_536);
  assert.equal(runnerWsServer.upgrades, 0);
  assert.equal(streamTtsWsServer.upgrades, 0);

  const rejected = socketProbe();
  server.emit("upgrade", request("expected-token", "/stream-stt/extra"), rejected, Buffer.alloc(0));
  assert.equal(rejected.destroyed, true);
  assert.equal(streamSttWsServer.upgrades, 1);
});

test("rejects unauthenticated /stream-stt before creating a speech WebSocket", () => {
  const { server, streamSttWsServer } = install("expected-token");
  const socket = socketProbe();
  server.emit("upgrade", request("", "/stream-stt"), socket, Buffer.alloc(0));
  assert.deepEqual(socket.writes, ["HTTP/1.1 401 Unauthorized\r\n\r\n"]);
  assert.equal(socket.destroyed, true);
  assert.equal(streamSttWsServer.upgrades, 0);
});

test("rejects the removed legacy Codex WebSocket path", () => {
  const { server, runnerWsServer } = install("expected-token");
  const req = request("expected-token");
  req.url = "/codex-ws";
  const socket = socketProbe();

  server.emit("upgrade", req, socket, Buffer.alloc(0));

  assert.equal(socket.destroyed, true);
  assert.equal(runnerWsServer.upgrades, 0);
});

test("upgrade logs carry one-way token fingerprints, never the raw token", () => {
  const { server, debugEvents } = install("expected-token");
  const socket = socketProbe();

  server.emit("upgrade", request("wrong-token"), socket, Buffer.alloc(0));

  const upgradeRequest = debugEvents.find((entry) => entry.event === "upgrade_request");
  assert.equal(upgradeRequest.payload.tokenFp, "a999ff56"); // FNV-1a("wrong-token")
  assert.equal(upgradeRequest.payload.expectedTokenFp, "d9c94259"); // FNV-1a("expected-token")
  assert.equal(upgradeRequest.payload.expectedTokenLength, "expected-token".length);

  const rejected = debugEvents.find((entry) => entry.event === "upgrade_rejected");
  assert.equal(rejected.payload.reason, "token_mismatch");
  assert.equal(rejected.payload.tokenFp, "a999ff56");
  assert.equal(rejected.payload.expectedTokenFp, "d9c94259");

  const serialized = JSON.stringify(debugEvents);
  assert.ok(!serialized.includes("wrong-token"));
  assert.ok(!serialized.includes("expected-token"));
});

test("does not accept a runner token from the URL query", () => {
  const { server, runnerWsServer } = install("expected-token");
  const req = request();
  req.url = "/runner-ws?token=expected-token";
  const socket = socketProbe();

  server.emit("upgrade", req, socket, Buffer.alloc(0));

  assert.deepEqual(socket.writes, ["HTTP/1.1 401 Unauthorized\r\n\r\n"]);
  assert.equal(runnerWsServer.upgrades, 0);
});
