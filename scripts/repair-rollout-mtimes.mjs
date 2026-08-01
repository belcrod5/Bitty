// Repairs codex rollout file mtimes that were clobbered by the old mark-read
// implementation (it rewrote the session file, so the mtime became the read
// time, and codex thread/list reports that mtime as the session updatedAt).
//
// A file is considered damaged when its current mtime matches the lastReadAt
// recorded in cli_sessions_index.json. The true last-activity time is recovered
// from the newest parseable `timestamp` inside the rollout jsonl itself.
//
// Usage:
//   node scripts/repair-rollout-mtimes.mjs          # dry run (report only)
//   node scripts/repair-rollout-mtimes.mjs --apply  # actually restore mtimes
import { promises as fs } from "node:fs";
import path from "node:path";

const INDEX_PATH = path.resolve(
  process.env.CLI_SESSION_INDEX_PATH || "private_runner/logs/cli_sessions_index.json",
);
const MATCH_TOLERANCE_MS = 5000;
const TAIL_READ_BYTES = 256 * 1024;
const APPLY = process.argv.includes("--apply");

function parseIsoMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

async function readLastEventTimestampMs(filePath, size) {
  const handle = await fs.open(filePath, "r");
  try {
    const length = Math.min(TAIL_READ_BYTES, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const ms = parseIsoMs(JSON.parse(line)?.timestamp);
        if (ms !== null) return ms;
      } catch {
        // A truncated first chunk line or partial write: keep scanning upward.
      }
    }
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

const index = JSON.parse(await fs.readFile(INDEX_PATH, "utf8"));
const entries = Array.isArray(index?.entries) ? index.entries : [];
let damaged = 0;
let repaired = 0;
let skipped = 0;
for (const entry of entries) {
  const lastReadMs = parseIsoMs(entry?.lastReadAt);
  if (lastReadMs === null) continue;
  const filePath = String(entry?.filePath || "");
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch {
    continue;
  }
  if (Math.abs(stat.mtimeMs - lastReadMs) > MATCH_TOLERANCE_MS) continue;
  damaged += 1;
  const trueMs = await readLastEventTimestampMs(filePath, stat.size).catch(() => null);
  if (trueMs === null || trueMs > Date.now() || trueMs >= stat.mtimeMs) {
    skipped += 1;
    console.log(`skip (no usable timestamp): ${filePath}`);
    continue;
  }
  if (APPLY) {
    await fs.utimes(filePath, stat.atime, new Date(trueMs));
  }
  repaired += 1;
  console.log(
    `${APPLY ? "repaired" : "would repair"}: ${path.basename(filePath)} ` +
    `${stat.mtime.toISOString()} -> ${new Date(trueMs).toISOString()}`,
  );
}
console.log(
  `\n${APPLY ? "applied" : "dry run"}: damaged=${damaged} repaired=${repaired} skipped=${skipped}` +
  ` (index: ${entries.length} entries)`,
);
