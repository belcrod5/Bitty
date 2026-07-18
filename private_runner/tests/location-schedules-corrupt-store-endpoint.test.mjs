import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "location-schedules-corrupt-endpoint-"));
const storePath = path.join(tempDir, "location_schedules.json");
const corruptStore = "{not-json";
await fs.writeFile(storePath, corruptStore, "utf8");

process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.LOCATION_SCHEDULE_STORE_PATH = storePath;

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const { server } = __TESTING__;

test.after(async () => fs.rm(tempDir, { recursive: true, force: true }));

test("all schedule APIs return 503 without changing a corrupt store or stopping the server", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    "content-type": "application/json",
    authorization: "Bearer test-runner-token",
  };
  try {
    const requests = [
      fetch(`${baseUrl}/location-schedules`, { headers }),
      fetch(`${baseUrl}/location-schedules`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ phoneTimeZone: "Asia/Tokyo", rules: [] }),
      }),
      fetch(`${baseUrl}/location-schedules/state`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ruleId: "home",
          regionRevision: "revision-home",
          state: "inside",
          eventId: "event-1",
          observedAt: "2026-07-19T00:00:00Z",
        }),
      }),
    ];
    for (const response of await Promise.all(requests)) {
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "location_schedule_store_unavailable");
    }

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(await fs.readFile(storePath, "utf8"), corruptStore);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
