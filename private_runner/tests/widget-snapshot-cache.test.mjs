import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("native widget merges retained icons only for the same complete metadata and source cache", async (t) => {
  try { await promisify(execFile)("swift", ["--version"]); }
  catch (error) {
    if (error.code === "ENOENT") { t.skip("Swift toolchain is unavailable; native model execution requires Swift"); return; }
    throw error;
  }
  const source = await fs.readFile(new URL("../../expo/modules/bitty-widgets/ios/BittyWidgetSnapshotStore.swift", import.meta.url), "utf8");
  const model = source.slice(source.indexOf("struct IncomingWidgetSnapshot"), source.indexOf("final class BittyWidgetSnapshotStore"));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "widget-cache-test-"));
  try {
    const script = path.join(directory, "main.swift");
    await fs.writeFile(script, `import Foundation\n${model}\n
      func snapshot(_ etag: String?, _ unchanged: Bool?, _ icons: [(String, String)]) -> IncomingWidgetSnapshot {
        return IncomingWidgetSnapshot(version: 1, connected: true,
          orchestrators: icons.map { .init(id: $0.0, name: $0.0, icon: $0.1) }, selectedId: "main", runningCount: 1,
          overview: "current", overviewFetchedAt: 1, fiveHourRemaining: 90, weeklyRemaining: 80,
          usageLimitReached: false, usageFetchedAt: 1, updatedAt: nil, metadataEtag: etag, iconsUnchanged: unchanged)
      }
      let etag = String(repeating: "a", count: 64)
      let previous = snapshot(etag, nil, [("main", "cached-pixels"), ("other", "other-pixels")])
      let unchanged = snapshot(etag, true, [("main", ""), ("other", "")])
      let merged = unchanged.mergingCachedIcons(previous)
      precondition(merged?.orchestrators.map { $0.icon } == ["cached-pixels", "other-pixels"])
      precondition(unchanged.mergingCachedIcons(nil) == nil)
      precondition(unchanged.mergingCachedIcons(snapshot(String(repeating: "b", count: 64), nil, [("main", "wrong")])) == nil)
      precondition(unchanged.mergingCachedIcons(snapshot(etag, nil, [("main", "only-one")])) == nil)
      precondition(snapshot(nil, nil, [("main", "new-full-icon")]).mergingCachedIcons(previous)?.orchestrators[0].icon == "new-full-icon")
      precondition(snapshot(etag, nil, [("main", "")]).mergingCachedIcons(previous)?.orchestrators[0].icon == "")
      precondition(snapshot("invalid", true, [("main", "")]).mergingCachedIcons(previous) == nil)
      print("PASS native metadata merge, missing cache, mismatched metadata, membership, legacy/full and icon clear")
    `);
    const result = await promisify(execFile)("swift", ["-module-cache-path", path.join(directory, "modules"), script], { timeout: 60_000 });
    assert.match(result.stdout, /PASS native metadata merge/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
