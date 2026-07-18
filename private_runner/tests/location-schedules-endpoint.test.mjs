import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "location-schedules-endpoint-"));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_TOKEN = "test-runner-token";
process.env.LOCATION_SCHEDULE_STORE_PATH = path.join(tempDir, "location_schedules.json");

const { __TESTING__ } = await import("../src/server-runtime.mjs");
const { server } = __TESTING__;

test.after(async () => fs.rm(tempDir, { recursive: true, force: true }));

async function withServer(fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function headers(token = "test-runner-token") {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

test("schedule and state APIs require auth, validate, persist, and return a snapshot", async () => {
  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/location-schedules`);
    assert.equal(unauthorized.status, 401);

    const rule = {
      id: "office",
      enabled: false,
      startTime: "09:00",
      endTime: "10:00",
      timeZone: "Asia/Tokyo",
      latitude: 35.6812,
      longitude: 139.7671,
      radiusMeters: 200,
      regionRevision: "revision-office",
      cwd: tempDir,
      modelRef: "gpt-5.6-sol",
      reasoningEffort: "high",
      prompt: "run checks",
    };
    const replaced = await fetch(`${baseUrl}/location-schedules`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ phoneTimeZone: "Asia/Tokyo", rules: [rule] }),
    });
    assert.equal(replaced.status, 200);

    const state = await fetch(`${baseUrl}/location-schedules/state`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ruleId: "office", regionRevision: "revision-office", state: "inside", eventId: "event-1", observedAt: "2026-07-19T00:00:00Z" }),
    });
    assert.equal(state.status, 200);

    const staleState = await fetch(`${baseUrl}/location-schedules/state`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ruleId: "office", regionRevision: "old-revision", state: "outside", eventId: "stale", observedAt: "2026-07-19T00:01:00Z" }),
    });
    assert.equal(staleState.status, 400);

    const snapshotResponse = await fetch(`${baseUrl}/location-schedules`, { headers: headers() });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()).snapshot;
    assert.equal(snapshot.rules[0].model, "gpt-5.6-sol");
    assert.equal(snapshot.states.office.state, "inside");
    assert.ok((await fs.readFile(process.env.LOCATION_SCHEDULE_STORE_PATH, "utf8")).includes("event-1"));

    const invalid = await fetch(`${baseUrl}/location-schedules`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ phoneTimeZone: "Asia/Tokyo", rules: [{ ...rule, endTime: "08:00" }] }),
    });
    assert.equal(invalid.status, 400);
  });
});
