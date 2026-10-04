import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createLlmCliSessionIndex } from "../src/llm-cli-session-index.mjs";

function percentile(values, fraction) {
  const sorted = values.toSorted((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3));
}

test("actual Codex index load and session lookup at planned corpus sizes", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "activity-index-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  for (const n of [100, 1000, 5000]) {
    const indexPath = path.join(temp, `index-${n}.json`);
    const entries = Array.from({ length: n }, (_, i) => ({
      filePath: path.join(temp, `rollout-${i}.jsonl`), sessionId: `session-${i}`,
      parentSessionId: i ? `session-${i - 1}` : "", mtimeMs: 1, size: 1,
      cwd: temp, directory: "", updatedAt: "2026-01-01T00:00:00.000Z",
      isSubagent: i > 0,
    }));
    await fs.writeFile(indexPath, JSON.stringify({ version: 4, entries }));
    const counts = { readdir: 0, stat: 0, readFile: 0 };
    const fileSystem = {
      ...fs,
      readdir(...args) { counts.readdir++; return fs.readdir(...args); },
      stat(...args) { counts.stat++; return fs.stat(...args); },
      readFile(...args) { counts.readFile++; return fs.readFile(...args); },
    };
    const makeIndex = () => createLlmCliSessionIndex({
      cliSessionIndexPath: indexPath, cliSessionIndexRefreshMinIntervalMs: 60_000,
      cliSessionScanMaxFiles: n, codeCliSessionsDir: temp, fileSystem,
      compareSessionHistoryEntries: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
      normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
      normalizeReasoningEffort: (value) => String(value || "").trim(),
      normalizeSessionRootRelativePath: (value) => String(value || "").trim(),
      normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
      toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
      toWorkspaceRelativeFromAbsolutePath: () => "",
    });
    const index = makeIndex();
    await index.ensureCliSessionIndexLoaded();
    assert.equal(index.selectCliSessionIndexEntryBySessionId(`session-${n - 1}`).parentSessionId,
      `session-${n - 2}`);
    for (const depth of [1, 3, 10]) {
      // This loop only times the existing index lookup at each ancestor step.
      // It is not a production ancestry resolver or a caller-identity gate.
      const walk = (instance) => {
        let id = `session-${n - 1}`;
        for (let step = 0; step < depth; step++) {
          const entry = instance.selectCliSessionIndexEntryBySessionId(id);
          assert.ok(entry);
          id = entry.parentSessionId;
        }
      };
      for (let i = 0; i < 100; i++) walk(index);
      const before = { ...counts };
      const warm = [];
      for (let i = 0; i < 1000; i++) {
        const start = performance.now();
        walk(index);
        warm.push(performance.now() - start);
      }
      const io = Object.fromEntries(Object.keys(counts).map((key) => [key, counts[key] - before[key]]));
      assert.deepEqual(io, { readdir: 0, stat: 0, readFile: 0 });
      console.log(JSON.stringify({ gate: "codex_index_lookup", phase: "warm", n, depth, runs: 1000,
        p50Ms: percentile(warm, 0.5), p95Ms: percentile(warm, 0.95), maxMs: Number(Math.max(...warm).toFixed(3)),
        failed: 0, ...io, threadReadRpc: 0 }));
      const cold = [];
      const coldBefore = { ...counts };
      for (let i = 0; i < 20; i++) {
        const fresh = makeIndex();
        const start = performance.now();
        await fresh.ensureCliSessionIndexLoaded();
        walk(fresh);
        cold.push(performance.now() - start);
      }
      console.log(JSON.stringify({ gate: "codex_index_lookup", phase: "app_cold", n, depth, runs: 20,
        p50Ms: percentile(cold, 0.5), p95Ms: percentile(cold, 0.95), maxMs: Number(Math.max(...cold).toFixed(3)),
        failed: 0, readdir: counts.readdir - coldBefore.readdir, stat: counts.stat - coldBefore.stat,
        readFile: counts.readFile - coldBefore.readFile, threadReadRpc: 0 }));
    }
  }
});
