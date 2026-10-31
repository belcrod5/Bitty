import assert from "node:assert/strict";
import test from "node:test";
import { createAppStatusSnapshot } from "../src/app-status-snapshot.mjs";

function inputs(overrides = {}) {
  return { listOrchestrators: async () => ({ orchestrators: [{ id: "main", name: "メイン", icon: "data:image/png;base64,a",
    unreadCount: 42, privateField: "NEVER EXPORT" }], selectedId: "main" }),
    countActiveSessions: async () => ({ count: 7 }), taskOverview: async () => ({ status: "present", markdown: "## **全体**\n- [ ] 実装\n- [x] 調査" }),
    currentUsage: async () => ({ fiveHourRemaining: 90, weeklyRemaining: 65, fetchedAt: "2026-10-18T00:00:00.000Z", usageLimitReached: false,
      accessToken: "NEVER EXPORT", statusText: "NEVER EXPORT" }), now: () => 500, ...overrides };
}

test("foreground and background share global display data without credentials/history/raw checklist", async () => {
  const result = await createAppStatusSnapshot(inputs())();
  assert.deepEqual(result, { version: 1, connected: true, orchestrators: [{ id: "main", name: "メイン", icon: "data:image/png;base64,a" }],
    selectedId: "main", runningCount: 7, overview: "全体\n実装\n調査", overviewFetchedAt: 500,
    fiveHourRemaining: 90, weeklyRemaining: 65, usageFetchedAt: Date.parse("2026-10-18T00:00:00.000Z"), usageLimitReached: false });
  assert(!JSON.stringify(result).includes("NEVER EXPORT"));
});

test("required metadata failure rejects instead of erasing recipient/icon cache", async () => {
  await assert.rejects(createAppStatusSnapshot(inputs({ listOrchestrators: async () => { throw new Error("transient"); } }))(), /metadata/);
});

test("pending/unavailable overview never falls back to original tasks or conversation", async () => {
  for (const overview of [{ status: "pending" }, { status: "unavailable" }, null]) {
    const result = await createAppStatusSnapshot(inputs({ taskOverview: async () => ({ ...overview,
      taskChecklist: { markdown: "NEVER EXPORT" }, messages: [{ text: "NEVER EXPORT" }] }) }))();
    assert.equal(result.overview, "");
    assert(!JSON.stringify(result).includes("NEVER EXPORT"));
  }
});

test("partial failures are unknown without refreshing an old usage timestamp", async () => {
  const result = await createAppStatusSnapshot(inputs({ countActiveSessions: async () => { throw new Error("offline"); },
    currentUsage: async () => { throw new Error("account unavailable"); } }))();
  assert.equal(result.runningCount, null); assert.equal(result.fiveHourRemaining, null);
  assert.equal(result.usageFetchedAt, 0); assert.equal(result.overview, "全体\n実装\n調査");
});


test("matching static metadata omits only icon bodies while live widget state stays fresh", async () => {
  let count = 1;
  const snapshot = createAppStatusSnapshot(inputs({ listOrchestrators: async () => ({ etag: "metadata-a", selectedId: "main",
    orchestrators: [{ id: "main", name: "Main", icon: "data:image/png;base64,large" }] }),
    countActiveSessions: async () => ({ count: count++ }) }));
  const full = await snapshot();
  const changed = await snapshot(full.metadataEtag);
  assert.equal(full.orchestrators[0].icon, "data:image/png;base64,large");
  assert.equal(changed.iconsUnchanged, true);
  assert.equal(changed.orchestrators[0].icon, "");
  assert.equal(changed.runningCount, 2);
  assert.equal((await snapshot("different-metadata")).orchestrators[0].icon, full.orchestrators[0].icon);
});
