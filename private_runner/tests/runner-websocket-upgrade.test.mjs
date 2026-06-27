import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installRunnerWebSocketUpgradeHandler } from "../src/runner-websocket-upgrade.mjs";

function request(token = "") {
  return {
    url: "/runner-ws",
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

function wsServerProbe() {
  const server = new EventEmitter();
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
  installRunnerWebSocketUpgradeHandler({
    server,
    runnerToken,
    runnerWsPath: "/runner-ws",
    runnerWsServer,
    streamTtsWsServer: wsServerProbe(),
    codexProxyWsServer: wsServerProbe(),
    appendDebug: () => {},
  });
  return { server, runnerWsServer };
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

test("does not accept a runner token from the URL query", () => {
  const { server, runnerWsServer } = install("expected-token");
  const req = request();
  req.url = "/runner-ws?token=expected-token";
  const socket = socketProbe();

  server.emit("upgrade", req, socket, Buffer.alloc(0));

  assert.deepEqual(socket.writes, ["HTTP/1.1 401 Unauthorized\r\n\r\n"]);
  assert.equal(runnerWsServer.upgrades, 0);
});
