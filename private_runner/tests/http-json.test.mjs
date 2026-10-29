import assert from "node:assert/strict";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { json } from "../src/http-json.mjs";

const payload = { sessions: Array.from({ length: 300 }, (_, index) => ({
  sessionRef: { backendId: "codex", nativeSessionId: `session-${index}` },
  title: `通信量の確認 ${index}`, updatedAt: "2026-10-30T00:00:00.000Z",
  summary: { contextUsage: null, modelRef: "test-model", reasoningEffort: "high", lastReadAt: "" },
})) };

function request(server, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

test("JSON transfer negotiates gzip, preserves validators and headers, and reduces wire bytes", async () => {
  const server = http.createServer((_req, res) => json(res, 200, payload, {
    etag: 'W/"snapshot"', vary: "Authorization, Accept-Encoding", "cache-control": "private, no-cache",
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const identity = await request(server);
    for (const encoding of ["gzip", "br, GZip; q=0.5", "*;q=0.8"]) {
      const compressed = await request(server, { "accept-encoding": encoding });
      assert.equal(compressed.status, 200);
      assert.equal(compressed.headers["content-encoding"], "gzip");
      assert.equal(Number(compressed.headers["content-length"]), compressed.body.length);
      assert.deepEqual(gunzipSync(compressed.body), identity.body);
      assert.ok(compressed.body.length < identity.body.length / 4);
      assert.equal(compressed.headers.etag, identity.headers.etag);
      assert.equal(compressed.headers.vary, "Authorization, Accept-Encoding");
      assert.equal(compressed.headers["cache-control"], "private, no-cache");
      if (encoding === "gzip") console.info(`[HTTP synthetic] JSON=${identity.body.length} wire=${compressed.body.length} bytes`);
    }
    for (const encoding of ["identity", "br", "gzip;q=0", "*;q=1,gzip;q=0"]) {
      const uncompressed = await request(server, { "accept-encoding": encoding });
      assert.equal(uncompressed.headers["content-encoding"], undefined);
      assert.deepEqual(uncompressed.body, identity.body);
    }
    const head = await request(server, { "accept-encoding": "gzip" }, "HEAD");
    assert.equal(head.headers["content-encoding"], "gzip");
    assert.equal(head.body.length, 0);
    assert.ok(Number(head.headers["content-length"]) > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("small JSON responses stay uncompressed for clients accepting gzip", async () => {
  const server = http.createServer((_req, res) => json(res, 400, { error: "invalid_request" }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(server, { "accept-encoding": "gzip" });
    assert.equal(response.status, 400);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(response.body), { error: "invalid_request" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
