// Isolated real-fs experiment. No Runner, user history, fake clock, or production edits.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createLlmCliSessionIndex } from "../src/llm-cli-session-index.mjs";

const FILES = 1000;
const DIRECTORIES = 25;
const ROUNDS = 5;
const WIDTH = 8;
const sourceUrl = new URL("../src/llm-cli-session-index.mjs", import.meta.url);
const temporary = await fs.realpath(await fs.mkdtemp("/tmp/bitty-index-benchmark-"));
const results = [];

try {
  const original = await fs.readFile(sourceUrl, "utf8");
  const anchor = "    const files = await listCliSessionRolloutFiles(codeCliSessionsDir);";
  const statLine = "        stat = await fileSystem.stat(filePath);";
  assert.equal(original.split(anchor).length, 2);
  assert.equal(original.split(statLine).length, 2);
  // Prefetch only stat in bounded batches. Parsing, merge, persist, and force waves stay unchanged.
  const prefetch = `
    const prefetched = new Map();
    for (let offset = 0; offset < files.length; offset += ${WIDTH}) {
      await Promise.all(files.slice(offset, offset + ${WIDTH}).map(async (filePath) => {
        try { prefetched.set(filePath, await fileSystem.stat(filePath)); }
        catch { prefetched.set(filePath, null); }
      }));
    }`;
  const candidateSource = original
    .replace(anchor, anchor + prefetch)
    .replace(statLine, "        stat = prefetched.get(filePath);\n        if (!stat) throw new Error('stat unavailable');")
    .replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from ${JSON.stringify(new URL(relative, sourceUrl).href)}`);
  const candidatePath = path.join(temporary, "candidate.mjs");
  await fs.writeFile(candidatePath, candidateSource);
  const { createLlmCliSessionIndex: createCandidate } = await import(pathToFileURL(candidatePath));

  for (let round = 0; round < ROUNDS; round += 1) {
    const roundRoot = path.join(temporary, String(round));
    const sessions = path.join(roundRoot, "sessions");
    const cwds = Array.from({ length: DIRECTORIES }, (_, i) => path.join(roundRoot, `repo-${i}`));
    await Promise.all([fs.mkdir(sessions, { recursive: true }), ...cwds.map((cwd) => fs.mkdir(cwd, { recursive: true }))]);
    const rollout = (id) => path.join(sessions, `rollout-${String(id).padStart(5, "0")}.jsonl`);
    const meta = (id) => JSON.stringify({
      type: "session_meta", payload: { id: `session-${id}`, cwd: cwds[id % DIRECTORIES], timestamp: "2026-01-01T00:00:00Z" },
    }) + "\n";
    for (let offset = 0; offset < FILES; offset += 64) {
      await Promise.all(Array.from({ length: Math.min(64, FILES - offset) }, (_, i) => fs.writeFile(rollout(offset + i), meta(offset + i))));
    }
    const variants = [
      { name: "baseline", factory: createLlmCliSessionIndex },
      { name: "stat8", factory: createCandidate },
    ].map(({ name, factory }) => {
      const counters = { calls: 0, active: 0, maxActive: 0, statMs: 0 };
      const fileSystem = { ...fs, async stat(filePath) {
        counters.calls += 1;
        counters.active += 1;
        counters.maxActive = Math.max(counters.maxActive, counters.active);
        const started = performance.now();
        try { return await fs.stat(filePath); }
        finally { counters.active -= 1; counters.statMs += performance.now() - started; }
      } };
      return { name, counters, index: factory({
        cliSessionIndexPath: path.join(roundRoot, `${name}.json`), codeCliSessionsDir: sessions,
        cliSessionIndexRefreshMinIntervalMs: 5000, fileSystem,
        compareSessionHistoryEntries: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.sessionId.localeCompare(a.sessionId),
        normalizeLlmExecutionSessionId: (value) => String(value || "").trim(),
        normalizeReasoningEffort: (value) => String(value || "").trim(),
        normalizeSessionRootRelativePath: (value) => String(value || "").trim(),
        normalizeSessionUpdatedAt: (value) => String(value || "").trim(),
        toUnixPath: (value) => String(value || "").replaceAll("\\", "/"),
        toWorkspaceRelativeFromAbsolutePath: () => "",
      }) };
    });
    const measurements = new Map();
    for (const stage of ["coldIndex", "unchangedForced", "externalChangesForced"]) {
      if (stage === "externalChangesForced") {
        const previousStat = await fs.stat(rollout(0));
        await Promise.all([
          fs.appendFile(rollout(0), JSON.stringify({ type: "event_msg", payload: { type: "note", text: "fixture update" } }) + "\n"),
          fs.unlink(rollout(1)), fs.writeFile(rollout(FILES), meta(FILES)),
        ]);
        await fs.utimes(rollout(0), previousStat.atime, new Date(previousStat.mtimeMs + 2000));
      }
      const ordered = round % 2 === 0 ? variants : [...variants].reverse();
      for (const variant of ordered) {
        Object.assign(variant.counters, { calls: 0, active: 0, maxActive: 0, statMs: 0 });
        const started = performance.now();
        const groups = await variant.index.listCliSessionsForDirectories(cwds, {
          forceRefresh: true, useRolloutMtime: true, includeSubagents: false,
        });
        const elapsedMs = performance.now() - started;
        measurements.set(`${stage}:${variant.name}`, groups);
        results.push({ round: round + 1, stage, variant: variant.name, elapsedMs, ...variant.counters });
      }
      const baseline = measurements.get(`${stage}:baseline`);
      const candidate = measurements.get(`${stage}:stat8`);
      assert.deepEqual(candidate, baseline);
      const entries = baseline.flatMap((group) => group.sessions);
      assert.equal(entries.length, FILES);
      if (stage === "externalChangesForced") {
        assert(entries.some((entry) => entry.sessionId === `session-${FILES}`));
        assert(!entries.some((entry) => entry.sessionId === "session-1"));
        const before = measurements.get("unchangedForced:baseline").flatMap((group) => group.sessions).find((entry) => entry.sessionId === "session-0");
        assert(entries.find((entry) => entry.sessionId === "session-0").updatedAt > before.updatedAt);
      }
    }
    // The source transforms must preserve exact force-wave semantics, not just final rows.
    for (const variant of variants) {
      const beforeCalls = variant.counters.calls;
      await Promise.all([
        variant.index.listCliSessionsForDirectories(cwds, { forceRefresh: true }),
        variant.index.listCliSessionsForDirectories(cwds, { forceRefresh: true }),
      ]);
      assert.equal(variant.counters.calls - beforeCalls, 2 * FILES);
    }
  }
  const summarize = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianSeconds: sorted[Math.floor(sorted.length / 2)] / 1000, minSeconds: sorted[0] / 1000, maxSeconds: sorted.at(-1) / 1000 };
  };
  const summary = ["coldIndex", "unchangedForced", "externalChangesForced"].map((stage) => {
    const values = (variant) => results.filter((row) => row.stage === stage && row.variant === variant).map((row) => row.elapsedMs);
    const baseline = summarize(values("baseline"));
    const stat8 = summarize(values("stat8"));
    const pairedDeltas = values("baseline").map((value, i) => value - values("stat8")[i]);
    return { stage, baseline, stat8, medianSavingSeconds: summarize(pairedDeltas).medianSeconds };
  });
  console.log(JSON.stringify({
    experiment: "real filesystem synthetic index benchmark; not app startup",
    config: { files: FILES, directories: DIRECTORIES, rounds: ROUNDS, statWidth: WIDTH, osCache: "not flushed", alternatingFirstVariant: true },
    checks: { fullResultsEqual: true, createdAppendedDeletedFresh: true, concurrentForceKeepsTrailingScan: true },
    summary, samples: results,
  }, null, 2));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
