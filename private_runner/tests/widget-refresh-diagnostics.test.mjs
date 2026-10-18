import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "widget-refresh-diagnostics-"));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "PRIVATE_AUTH_CANARY";
process.env.PUSH_DEVICE_STORE_PATH = path.join(tempDir, "push.json");
process.env.CLIENT_STATE_STORE_PATH = path.join(tempDir, "client-state.json");
const { __TESTING__: runtime } = await import("../src/server-runtime.mjs");
const { server, voiceContextService, codexAuthRuntime, codexAuthService, codexUsageService } = runtime;
const privateText = "PRIVATE_CONTENT_CANARY";
const metadata = async () => ({ selectedId: "main", orchestrators: [{ id: "main", name: privateText, icon: "" }] });
voiceContextService.list = metadata;
voiceContextService.taskOverview = async () => ({ status: "present", markdown: privateText });
codexAuthRuntime.activePayload = () => ({ chatgptAccountId: "PRIVATE_ACCOUNT_CANARY" });
codexAuthService.acquireLease = () => () => {};
codexUsageService.snapshot = async () => ({ fetchedAt: "2026-10-18T06:14:00Z" });

test("snapshot endpoint logs only bounded correlation/status/count/duration for success and failures", async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    if (String(args[0]).startsWith("[widget-refresh]")) lines.push(args.join(" "));
  };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/app/status-snapshot`;
  const id = "3AFC4EA1-99BC-4A74-A31E-2EE7144B26BA";
  try {
    const success = await fetch(url, { headers: {
      authorization: "Bearer PRIVATE_AUTH_CANARY", "x-bitty-widget-refresh-id": id,
    } });
    assert.equal(success.status, 200);
    const snapshot = await success.json();
    assert.equal(snapshot.runningCount, 0);
    assert.equal(snapshot.overview, privateText);
    assert.match(lines[0], new RegExp(`^\\[widget-refresh\\] event=response at=\\S+ id=${id} status=200 count=0 duration_ms=\\d+$`));

    const unauthorized = await fetch(url, { headers: { "x-bitty-widget-refresh-id": privateText } });
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    assert.match(lines[1], / id=none status=401 count=-1 duration_ms=\d+$/u);

    voiceContextService.list = async () => { throw new Error(privateText); };
    const unavailable = await fetch(url, { headers: {
      authorization: "Bearer PRIVATE_AUTH_CANARY", "x-bitty-widget-refresh-id": `${id}-PRIVATE_SUFFIX`,
    } });
    assert.equal(unavailable.status, 503);
    await unavailable.text();
    assert.match(lines[2], / id=none status=503 count=-1 duration_ms=\d+$/u);
    assert.equal(lines.length, 3);
    assert(!lines.join("\n").includes("PRIVATE"), "must never log payloads, credentials, account IDs or arbitrary headers/errors");
  } finally {
    console.log = originalLog;
    voiceContextService.list = metadata;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
