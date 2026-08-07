import type { RunnerSessionMessage } from "../hooks/useLlmSessionExplorer";
import {
  createEmptySessionCacheIndex,
  estimateSessionRowsBytes,
  isCacheSafeSessionId,
  mergeSessionMessageRows,
  parseSessionCacheFile,
  parseSessionCacheIndex,
  selectSessionCacheEvictions,
  serializeSessionCacheFile,
  serializeSessionCacheIndex,
  SESSION_MESSAGES_CACHE_VERSION,
  trimSessionRows,
} from "./sessionMessagesCache";

function row(itemId: string, content: string, overrides: Partial<RunnerSessionMessage> = {}): RunnerSessionMessage {
  return {
    role: "assistant",
    content,
    at: "2026-08-07T00:00:00.000Z",
    itemId,
    ...overrides,
  };
}

describe("mergeSessionMessageRows", () => {
  it("appends new delta rows in order", () => {
    const merged = mergeSessionMessageRows(
      [row("a", "first")],
      [row("b", "second"), row("c", "third")],
    );
    expect(merged.map((item) => item.itemId)).toEqual(["a", "b", "c"]);
  });

  it("replaces an existing row in place when itemId matches", () => {
    const merged = mergeSessionMessageRows(
      [row("a", "first"), row("b", "pending", { commandExecution: { command: "ls", status: "running", exitCode: null } })],
      [row("b", "pending", { commandExecution: { command: "ls", status: "completed", exitCode: 0 } }), row("c", "third")],
    );
    expect(merged.map((item) => item.itemId)).toEqual(["a", "b", "c"]);
    expect(merged[1]?.commandExecution?.status).toBe("completed");
  });

  it("replaces the superseded row when replacesItemId is present and strips the marker", () => {
    const merged = mergeSessionMessageRows(
      [row("old-id", "boundary user"), row("b", "assistant")],
      [row("new-id", "boundary user resolved", { replacesItemId: "old-id" })],
    );
    expect(merged.map((item) => item.itemId)).toEqual(["new-id", "b"]);
    expect(merged[0]?.content).toBe("boundary user resolved");
    expect(merged[0]?.replacesItemId).toBeUndefined();
  });

  it("appends a replacement row whose superseded row was already trimmed away", () => {
    const merged = mergeSessionMessageRows(
      [row("b", "assistant")],
      [row("new-id", "resolved", { replacesItemId: "gone-id" })],
    );
    expect(merged.map((item) => item.itemId)).toEqual(["b", "new-id"]);
  });

  it("appends rows without itemId", () => {
    const merged = mergeSessionMessageRows(
      [row("a", "first")],
      [{ role: "user", content: "no id", at: "" }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]?.content).toBe("no id");
  });

  it("does not mutate the cached rows array", () => {
    const cached = [row("a", "first")];
    mergeSessionMessageRows(cached, [row("b", "second")]);
    expect(cached).toHaveLength(1);
  });
});

describe("trimSessionRows", () => {
  it("keeps rows unchanged while under the limit", () => {
    const rows = [row("a", "first"), row("b", "second")];
    const result = trimSessionRows(rows, 10_000);
    expect(result.trimmed).toBe(false);
    expect(result.rows).toBe(rows);
    expect(result.bytes).toBe(estimateSessionRowsBytes(rows));
  });

  it("drops oldest rows first when over the limit", () => {
    const rows = [row("a", "x".repeat(200)), row("b", "y".repeat(200)), row("c", "z".repeat(200))];
    const limit = estimateSessionRowsBytes(rows.slice(1));
    const result = trimSessionRows(rows, limit);
    expect(result.trimmed).toBe(true);
    expect(result.rows.map((item) => item.itemId)).toEqual(["b", "c"]);
    expect(result.bytes).toBeLessThanOrEqual(limit);
  });

  it("keeps at least the newest row even when a single row exceeds the limit", () => {
    const rows = [row("a", "x".repeat(200)), row("b", "y".repeat(500))];
    const result = trimSessionRows(rows, 16);
    expect(result.rows.map((item) => item.itemId)).toEqual(["b"]);
    expect(result.trimmed).toBe(true);
  });
});

describe("session cache file serialization", () => {
  const cache = {
    rows: [row("a", "first"), row("b", "コマンド実行", {
      commandExecution: { command: "ls -la", status: "completed" as const, exitCode: 0 },
    })],
    latestCursor: "cursor-1",
    olderCursor: "older-1",
  };

  it("round-trips rows and cursors through JSONL", () => {
    const text = serializeSessionCacheFile("session-1", cache, 1_000);
    const parsed = parseSessionCacheFile(text, "session-1");
    expect(parsed).not.toBeNull();
    expect(parsed?.latestCursor).toBe("cursor-1");
    expect(parsed?.olderCursor).toBe("older-1");
    expect(parsed?.rows).toHaveLength(2);
    expect(parsed?.rows[1]?.commandExecution).toEqual({ command: "ls -la", status: "completed", exitCode: 0 });
  });

  it("rejects a file for another session", () => {
    const text = serializeSessionCacheFile("session-1", cache, 1_000);
    expect(parseSessionCacheFile(text, "session-2")).toBeNull();
  });

  it("rejects a version mismatch", () => {
    const text = serializeSessionCacheFile("session-1", cache, 1_000);
    const lines = text.split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), v: SESSION_MESSAGES_CACHE_VERSION + 1 });
    expect(parseSessionCacheFile(lines.join("\n"), "session-1")).toBeNull();
  });

  it("rejects a truncated file", () => {
    const text = serializeSessionCacheFile("session-1", cache, 1_000);
    expect(parseSessionCacheFile(text.slice(0, text.length - 5), "session-1")).toBeNull();
  });

  it("rejects an empty rows file and a missing latestCursor", () => {
    expect(parseSessionCacheFile(
      serializeSessionCacheFile("session-1", { rows: [], latestCursor: "cursor-1", olderCursor: null }, 0),
      "session-1",
    )).toBeNull();
    expect(parseSessionCacheFile(
      serializeSessionCacheFile("session-1", { ...cache, latestCursor: "" }, 0),
      "session-1",
    )).toBeNull();
  });
});

describe("session cache index", () => {
  it("round-trips entries", () => {
    const index = createEmptySessionCacheIndex();
    index.sessions["session-1"] = { bytes: 128, lastAccessAtMs: 10, updatedAtMs: 20 };
    const parsed = parseSessionCacheIndex(serializeSessionCacheIndex(index));
    expect(parsed).toEqual(index);
  });

  it("rejects a version mismatch or corrupt payload", () => {
    expect(parseSessionCacheIndex(JSON.stringify({ version: 999, sessions: {} }))).toBeNull();
    expect(parseSessionCacheIndex("not json")).toBeNull();
    expect(parseSessionCacheIndex(JSON.stringify([]))).toBeNull();
  });

  it("drops unsafe session ids while parsing", () => {
    const parsed = parseSessionCacheIndex(JSON.stringify({
      version: SESSION_MESSAGES_CACHE_VERSION,
      sessions: {
        "session-1": { bytes: 1, lastAccessAtMs: 1, updatedAtMs: 1 },
        "../escape": { bytes: 1, lastAccessAtMs: 1, updatedAtMs: 1 },
      },
    }));
    expect(Object.keys(parsed?.sessions || {})).toEqual(["session-1"]);
  });
});

describe("selectSessionCacheEvictions", () => {
  function indexWith(sessions: Record<string, { bytes: number; lastAccessAtMs: number }>) {
    const index = createEmptySessionCacheIndex();
    for (const [sessionId, entry] of Object.entries(sessions)) {
      index.sessions[sessionId] = { ...entry, updatedAtMs: entry.lastAccessAtMs };
    }
    return index;
  }

  it("returns nothing while under the total limit", () => {
    const index = indexWith({ a: { bytes: 100, lastAccessAtMs: 1 } });
    expect(selectSessionCacheEvictions(index, 100)).toEqual([]);
  });

  it("evicts least recently accessed sessions first", () => {
    const index = indexWith({
      newest: { bytes: 100, lastAccessAtMs: 30 },
      oldest: { bytes: 100, lastAccessAtMs: 10 },
      middle: { bytes: 100, lastAccessAtMs: 20 },
    });
    expect(selectSessionCacheEvictions(index, 150)).toEqual(["oldest", "middle"]);
  });

  it("keeps protected sessions even when they are the oldest", () => {
    const index = indexWith({
      protected: { bytes: 100, lastAccessAtMs: 10 },
      other: { bytes: 100, lastAccessAtMs: 20 },
    });
    expect(selectSessionCacheEvictions(index, 150, ["protected"])).toEqual(["other"]);
  });
});

describe("isCacheSafeSessionId", () => {
  it("accepts uuid-style ids and rejects path-like ids", () => {
    expect(isCacheSafeSessionId("0198a2b4-1111-7ccc-8ddd-eeeeffff0000")).toBe(true);
    expect(isCacheSafeSessionId("../etc/passwd")).toBe(false);
    expect(isCacheSafeSessionId("a/b")).toBe(false);
    expect(isCacheSafeSessionId("")).toBe(false);
    expect(isCacheSafeSessionId("a..b")).toBe(false);
  });
});
