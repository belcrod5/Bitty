import test from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { readBrowserControlEndpoint, discoverBrowserControlTargets } from "../src/browser-control-discovery.mjs";

test("ActivePort reader handles user-enabled Chrome without HTTP endpoints and bounds its input", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bitty-discovery-")); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "DevToolsActivePort");
  await assert.rejects(readBrowserControlEndpoint(directory), { code: "chrome_debugging_not_enabled" });
  await fs.writeFile(file, "9222\n/devtools/browser/BROWSER\n");
  assert.equal(await readBrowserControlEndpoint(directory), "ws://127.0.0.1:9222/devtools/browser/BROWSER");
  for (const value of ["65536\n/devtools/browser/BROWSER", "9222\n/devtools/page/PAGE", "9222\n/devtools/browser/B?secret=private", "9222\n/devtools/browser/B\nEXTRA", "x".repeat(5000)]) {
    await fs.writeFile(file, value); await assert.rejects(readBrowserControlEndpoint(directory), { code: "chrome_debugging_endpoint_invalid" });
  }
  await assert.rejects(readBrowserControlEndpoint("relative"));
});

test("discovery sends one metadata command, filters exact page origins, closes and never returns titles or URL paths", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await new Promise((r) => server.once("listening", r));
  t.after(() => server.close()); let closed;
  const done = new Promise((r) => { closed = r; });
  server.on("connection", (socket) => {
    socket.once("close", closed); socket.once("message", (raw) => {
      assert.deepEqual(JSON.parse(String(raw)), { id: 1, method: "Target.getTargets", params: { filter: [{ type: "page" }, { exclude: true }] } });
      socket.send(JSON.stringify({ id: 1, result: { targetInfos: [
        { targetId: "ONE", type: "page", url: "https://example.com/private?SECRET", title: "SECRET" },
        { targetId: "TWO", type: "page", url: "https://example.com/another" },
        { targetId: "PRIVATE", type: "page", url: "https://other.example" },
        { targetId: "IFRAME", type: "iframe", url: "https://example.com" },
      ] } }));
    });
  });
  const result = await discoverBrowserControlTargets(`ws://127.0.0.1:${server.address().port}/devtools/browser/B`, "https://example.com");
  assert.deepEqual(result, { targets: [{ targetId: "ONE", origin: "https://example.com" }, { targetId: "TWO", origin: "https://example.com" }] });
  await done;
});

test("discovery denies unsafe endpoints before connecting", async () => {
  for (const endpoint of ["ws://example.com:9222/devtools/browser/B", "ws://localhost:9222/devtools/browser/B", "ws://127.0.0.1:9222/devtools/page/P", "ws://user@127.0.0.1:9222/devtools/browser/B"]) await assert.rejects(discoverBrowserControlTargets(endpoint, "https://example.com"));
  await assert.rejects(discoverBrowserControlTargets("ws://127.0.0.1:9222/devtools/browser/B", "https://example.com/private"));
});


test("discovery permission and command waits are bounded and close without returning raw errors", async (t) => {
  const server = createServer(), ws = new WebSocketServer({ noServer: true }), sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => setTimeout(() => { if (!socket.destroyed) ws.handleUpgrade(req, socket, head, (connection) => ws.emit("connection", connection)); }, 60));
  let mode = "empty";
  ws.on("connection", (socket) => socket.on("message", () => {
    if (mode === "timeout") return;
    socket.send(JSON.stringify(mode === "error" ? { id: 1, error: { message: "PRIVATE_RAW_ERROR" } } : { id: 1, result: { targetInfos: [] } }));
  }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { for (const socket of sockets) socket.destroy(); ws.close(); server.close(); });
  const endpoint = `ws://127.0.0.1:${server.address().port}/devtools/browser/B`;
  assert.deepEqual(await discoverBrowserControlTargets(endpoint, "https://example.com", { connectTimeoutMs: 200, timeoutMs: 20 }), { targets: [] });
  await assert.rejects(discoverBrowserControlTargets(endpoint, "https://example.com", { connectTimeoutMs: 20 }), { code: "chrome_permission_timeout" });
  for (mode of ["timeout", "error"]) await assert.rejects(discoverBrowserControlTargets(endpoint, "https://example.com", { connectTimeoutMs: 200, timeoutMs: 20 }), (error) => error.code === "chrome_discovery_unavailable" && !error.message.includes("PRIVATE"));
});
