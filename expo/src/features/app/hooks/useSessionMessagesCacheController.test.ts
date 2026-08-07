const mockFiles = new Map<string, string>();

jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  getInfoAsync: jest.fn(async (path: string) => ({ exists: mockFiles.has(path) })),
  readAsStringAsync: jest.fn(async (path: string) => {
    const value = mockFiles.get(path);
    if (typeof value === "undefined") throw new Error(`missing: ${path}`);
    return value;
  }),
  writeAsStringAsync: jest.fn(async (path: string, value: string) => {
    mockFiles.set(path, value);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const value = mockFiles.get(from);
    mockFiles.delete(to);
    if (typeof value !== "undefined") mockFiles.set(to, value);
    mockFiles.delete(from);
  }),
  deleteAsync: jest.fn(async (path: string) => {
    if (path.endsWith("/")) {
      for (const key of [...mockFiles.keys()]) {
        if (key.startsWith(path)) mockFiles.delete(key);
      }
      return;
    }
    mockFiles.delete(path);
  }),
  makeDirectoryAsync: jest.fn(async () => {}),
  readDirectoryAsync: jest.fn(async (path: string) => {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const key of mockFiles.keys()) {
      if (!key.startsWith(prefix)) continue;
      names.add(key.slice(prefix.length).split("/")[0]);
    }
    return [...names];
  }),
}));

import type {
  RunnerSessionMessage,
  RunnerSessionMessagesResult,
} from "./useLlmSessionExplorer";
import { createSessionMessagesCacheController } from "./useSessionMessagesCacheController";
import { parseSessionCacheFile } from "../utils/sessionMessagesCache";

const CACHE_DIR = "file:///cache/session-messages-cache/";
const SESSION_ID = "0198a2b4-1111-7ccc-8ddd-eeeeffff0000";

function row(itemId: string, content: string, overrides: Partial<RunnerSessionMessage> = {}): RunnerSessionMessage {
  return {
    role: "assistant",
    content,
    at: "2026-08-07T00:00:00.000Z",
    itemId,
    ...overrides,
  };
}

function makeResult(overrides: Partial<RunnerSessionMessagesResult> = {}): RunnerSessionMessagesResult {
  return {
    threadId: SESSION_ID,
    sourceKind: "cli",
    cwd: "/workspace",
    updatedAt: "2026-08-07T00:00:00.000Z",
    modelRef: "gpt-5",
    reasoningEffort: "medium",
    latestToolLabel: "",
    messages: [],
    contextUsedPct: 10,
    threadStatusType: "idle",
    hasRunningTurn: false,
    runningTurn: null,
    olderCursor: null,
    latestCursor: "cursor-1",
    ...overrides,
  };
}

function makeCodedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function makeController(
  fetchSessionMessages: jest.Mock,
  overrides: Partial<Parameters<typeof createSessionMessagesCacheController>[0]> = {},
) {
  return createSessionMessagesCacheController({
    fetchSessionMessages: fetchSessionMessages as never,
    writeDebounceMs: 0,
    ...overrides,
  });
}

beforeEach(() => {
  mockFiles.clear();
  jest.clearAllMocks();
});

describe("fetchRunnerSessionMessagesCached", () => {
  it("fetches the full history on a miss, then only the delta on the next access", async () => {
    const fullResult = makeResult({
      messages: [row("a", "first"), row("b", "second")],
      latestCursor: "cursor-1",
      olderCursor: "older-1",
    });
    const deltaResult = makeResult({
      messages: [row("c", "third")],
      latestCursor: "cursor-2",
      olderCursor: null,
      moreAfter: false,
      contextUsedPct: 55,
      updatedAt: "2026-08-07T01:00:00.000Z",
    });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(fullResult)
      .mockResolvedValueOnce(deltaResult);
    const controller = makeController(fetchMock);

    const first = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    expect(first).toBe(fullResult);
    expect(fetchMock).toHaveBeenNthCalledWith(1, SESSION_ID, "/workspace");

    const second = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    expect(fetchMock).toHaveBeenNthCalledWith(2, SESSION_ID, "/workspace", { sinceCursor: "cursor-1" });
    expect(second.messages.map((item) => item.itemId)).toEqual(["a", "b", "c"]);
    // メタは毎回サーバー応答の値を使う(キャッシュから出さない)。
    expect(second.contextUsedPct).toBe(55);
    expect(second.updatedAt).toBe("2026-08-07T01:00:00.000Z");
    // olderページング用カーソルは全文取得時のものを維持する。
    expect(second.olderCursor).toBe("older-1");
    expect(second.latestCursor).toBe("cursor-2");
    expect(second.moreAfter).toBe(false);
  });

  it("passes older paging requests through without touching the cache", async () => {
    const pageResult = makeResult({ messages: [row("z", "older")] });
    const fetchMock = jest.fn().mockResolvedValue(pageResult);
    const controller = makeController(fetchMock);

    const page = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace", { cursor: "older-1" });

    expect(page).toBe(pageResult);
    expect(fetchMock).toHaveBeenCalledWith(SESSION_ID, "/workspace", { cursor: "older-1" });
  });

  it("applies replacement rows (itemId match and replacesItemId) from the delta", async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeResult({
        messages: [
          row("a", "boundary", { commandExecution: { command: "ls", status: "running", exitCode: null } }),
          row("b", "assistant"),
        ],
        latestCursor: "cursor-1",
      }))
      .mockResolvedValueOnce(makeResult({
        messages: [
          row("a", "boundary", { commandExecution: { command: "ls", status: "completed", exitCode: 0 } }),
          row("b2", "assistant resolved", { replacesItemId: "b" }),
          row("c", "new"),
        ],
        latestCursor: "cursor-2",
        moreAfter: false,
      }));
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    const second = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    expect(second.messages.map((item) => item.itemId)).toEqual(["a", "b2", "c"]);
    expect(second.messages[0]?.commandExecution?.status).toBe("completed");
    expect(second.messages[1]?.replacesItemId).toBeUndefined();
  });

  it("chains moreAfter pages without live-state RPCs and merges every page", async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeResult({ messages: [row("a", "first")], latestCursor: "cursor-1" }))
      .mockResolvedValueOnce(makeResult({ messages: [row("b", "second")], latestCursor: "cursor-2", moreAfter: true }))
      .mockResolvedValueOnce(makeResult({ messages: [row("c", "third")], latestCursor: "cursor-3", moreAfter: false }));
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    const second = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    expect(fetchMock).toHaveBeenNthCalledWith(2, SESSION_ID, "/workspace", { sinceCursor: "cursor-1" });
    expect(fetchMock).toHaveBeenNthCalledWith(3, SESSION_ID, "/workspace", {
      sinceCursor: "cursor-2",
      skipLiveState: true,
    });
    expect(second.messages.map((item) => item.itemId)).toEqual(["a", "b", "c"]);
    expect(second.latestCursor).toBe("cursor-3");
  });

  it("falls back to a full fetch when the moreAfter chain exceeds the limit", async () => {
    const overflowDelta = makeResult({ messages: [row("x", "page")], latestCursor: "cursor-next", moreAfter: true });
    const recoveredFull = makeResult({ messages: [row("f", "full")], latestCursor: "cursor-full" });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeResult({ messages: [row("a", "first")], latestCursor: "cursor-1" }))
      .mockResolvedValueOnce(overflowDelta)
      .mockResolvedValueOnce(overflowDelta)
      .mockResolvedValueOnce(recoveredFull);
    const controller = makeController(fetchMock, { maxDeltaChains: 1 });

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    const second = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    expect(second).toBe(recoveredFull);
    // 上限1連鎖: sinceCursor 2回のあと全文取得(第4引数なし)へ。
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(4, SESSION_ID, "/workspace");

    // 全文結果でキャッシュが上書きされている(次回は新カーソルで差分)。
    fetchMock.mockResolvedValueOnce(makeResult({ messages: [], latestCursor: "cursor-full", moreAfter: false }));
    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    expect(fetchMock).toHaveBeenNthCalledWith(5, SESSION_ID, "/workspace", { sinceCursor: "cursor-full" });
  });

  it("discards the cache on 409 and recovers with a full fetch", async () => {
    const recoveredFull = makeResult({ messages: [row("f", "full")], latestCursor: "cursor-full" });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeResult({ messages: [row("a", "first")], latestCursor: "cursor-1" }))
      .mockRejectedValueOnce(makeCodedError("stale_history_cursor", "stale"))
      .mockResolvedValueOnce(recoveredFull);
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    await controller.flushPendingWrites();
    expect(mockFiles.has(`${CACHE_DIR}${SESSION_ID}.jsonl`)).toBe(true);

    const second = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    expect(second).toBe(recoveredFull);
    await controller.flushPendingWrites();
    // 破棄→全文再取得の結果で保存し直されている。
    const persisted = parseSessionCacheFile(mockFiles.get(`${CACHE_DIR}${SESSION_ID}.jsonl`) || "", SESSION_ID);
    expect(persisted?.latestCursor).toBe("cursor-full");
    expect(persisted?.rows.map((item) => item.itemId)).toEqual(["f"]);
  });

  it("keeps the cache and retries the delta after a network error", async () => {
    const recoveredFull = makeResult({ messages: [row("f", "full")], latestCursor: "cursor-full" });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeResult({ messages: [row("a", "first")], latestCursor: "cursor-1" }))
      .mockRejectedValueOnce(new Error("request timeout (12000ms)"))
      .mockResolvedValueOnce(recoveredFull);
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    const second = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    expect(second).toBe(recoveredFull);
    expect(fetchMock).toHaveBeenNthCalledWith(2, SESSION_ID, "/workspace", { sinceCursor: "cursor-1" });
    expect(fetchMock).toHaveBeenNthCalledWith(3, SESSION_ID, "/workspace");
  });

  it("propagates the error when both the delta and the full fallback fail", async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeResult({ messages: [row("a", "first")], latestCursor: "cursor-1" }))
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("still down"));
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    await expect(controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace"))
      .rejects.toThrow("still down");

    // ネットワークエラーではキャッシュを破棄しない: 次回も差分から試す。
    fetchMock.mockResolvedValueOnce(makeResult({ messages: [], latestCursor: "cursor-1", moreAfter: false }));
    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    expect(fetchMock).toHaveBeenLastCalledWith(SESSION_ID, "/workspace", { sinceCursor: "cursor-1" });
  });

  it("does not cache responses from servers without latestCursor (legacy behavior)", async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResult({
      messages: [row("a", "first")],
      latestCursor: null,
    }));
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    // 2回とも全量取得(sinceCursorなし)。
    expect(fetchMock).toHaveBeenNthCalledWith(1, SESSION_ID, "/workspace");
    expect(fetchMock).toHaveBeenNthCalledWith(2, SESSION_ID, "/workspace");
    await controller.flushPendingWrites();
    expect(mockFiles.has(`${CACHE_DIR}${SESSION_ID}.jsonl`)).toBe(false);
  });

  it("does not cache a full result whose restored session id mismatches", async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResult({
      threadId: "some-other-session",
      messages: [row("a", "first")],
      latestCursor: "cursor-1",
    }));
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    expect(fetchMock).toHaveBeenNthCalledWith(2, SESSION_ID, "/workspace");
  });

  it("uses live state from the first delta response and metadata from the last", async () => {
    const liveStatePromise = Promise.resolve(null);
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(makeResult({ messages: [row("a", "first")], latestCursor: "cursor-1" }))
      .mockResolvedValueOnce(makeResult({
        messages: [row("b", "tool: Read file.ts")],
        latestCursor: "cursor-2",
        moreAfter: true,
        hasRunningTurn: true,
        threadStatusType: "active",
        runningTurn: { status: "running", summary: "working", startedAt: "s", updatedAt: "u" },
        liveStatePromise,
      }))
      .mockResolvedValueOnce(makeResult({
        messages: [row("c", "done")],
        latestCursor: "cursor-3",
        moreAfter: false,
        hasRunningTurn: false,
        contextUsedPct: 77,
      }));
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    const second = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    expect(second.hasRunningTurn).toBe(true);
    expect(second.threadStatusType).toBe("active");
    expect(second.liveStatePromise).toBe(liveStatePromise);
    expect(second.contextUsedPct).toBe(77);
    expect(second.latestToolLabel).toBe("Read");
  });
});

describe("persistence", () => {
  it("hydrates the cache from disk in a fresh controller instance", async () => {
    const fetchMock1 = jest.fn().mockResolvedValueOnce(makeResult({
      messages: [row("a", "first"), row("b", "second")],
      latestCursor: "cursor-1",
      olderCursor: "older-1",
    }));
    const controller1 = makeController(fetchMock1);
    await controller1.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    await controller1.flushPendingWrites();

    const fetchMock2 = jest.fn().mockResolvedValueOnce(makeResult({
      messages: [row("c", "third")],
      latestCursor: "cursor-2",
      moreAfter: false,
    }));
    const controller2 = makeController(fetchMock2);
    const restored = await controller2.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    expect(fetchMock2).toHaveBeenCalledWith(SESSION_ID, "/workspace", { sinceCursor: "cursor-1" });
    expect(restored.messages.map((item) => item.itemId)).toEqual(["a", "b", "c"]);
    expect(restored.olderCursor).toBe("older-1");
  });

  it("wipes the cache directory when the index version mismatches", async () => {
    mockFiles.set(`${CACHE_DIR}index.json`, JSON.stringify({ version: 999, sessions: {
      [SESSION_ID]: { bytes: 10, lastAccessAtMs: 1, updatedAtMs: 1 },
    } }));
    mockFiles.set(`${CACHE_DIR}${SESSION_ID}.jsonl`, "stale contents");
    const fetchMock = jest.fn().mockResolvedValueOnce(makeResult({
      messages: [row("a", "first")],
      latestCursor: "cursor-1",
    }));
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    // version不一致→全破棄→ミス扱いの全文取得。
    expect(fetchMock).toHaveBeenCalledWith(SESSION_ID, "/workspace");
    expect(mockFiles.get(`${CACHE_DIR}${SESSION_ID}.jsonl`)).not.toBe("stale contents");
  });

  it("discards a corrupt session file and falls back to a full fetch", async () => {
    const fetchMock1 = jest.fn().mockResolvedValueOnce(makeResult({
      messages: [row("a", "first")],
      latestCursor: "cursor-1",
    }));
    const controller1 = makeController(fetchMock1);
    await controller1.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    await controller1.flushPendingWrites();
    mockFiles.set(`${CACHE_DIR}${SESSION_ID}.jsonl`, "{broken");

    const fetchMock2 = jest.fn().mockResolvedValueOnce(makeResult({
      messages: [row("a", "first")],
      latestCursor: "cursor-1",
    }));
    const controller2 = makeController(fetchMock2);
    await controller2.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");

    expect(fetchMock2).toHaveBeenCalledWith(SESSION_ID, "/workspace");
  });

  it("trims oversized sessions on write and invalidates olderCursor", async () => {
    const bigRows = [row("a", "x".repeat(300)), row("b", "y".repeat(300)), row("c", "z".repeat(300))];
    const fetchMock = jest.fn().mockResolvedValueOnce(makeResult({
      messages: bigRows,
      latestCursor: "cursor-1",
      olderCursor: "older-1",
    }));
    const controller = makeController(fetchMock, { maxSessionBytes: 800 });

    const result = await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    // 返却値はトリムしない(表示は全量)。
    expect(result.messages).toHaveLength(3);
    await controller.flushPendingWrites();

    const persisted = parseSessionCacheFile(mockFiles.get(`${CACHE_DIR}${SESSION_ID}.jsonl`) || "", SESSION_ID);
    expect(persisted?.rows.map((item) => item.itemId)).toEqual(["b", "c"]);
    expect(persisted?.olderCursor).toBeNull();
  });

  it("evicts least recently used sessions when the total cache exceeds the limit", async () => {
    const otherSessionId = "0198a2b4-2222-7ccc-8ddd-eeeeffff0000";
    let clock = 1_000;
    const fullFor = (threadId: string) => makeResult({
      threadId,
      messages: [row("a", "x".repeat(400))],
      latestCursor: "cursor-1",
    });
    const fetchMock = jest.fn().mockImplementation(async (sessionId: string) => fullFor(sessionId));
    const controller = makeController(fetchMock, {
      maxTotalBytes: 600,
      now: () => (clock += 1),
    });

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    await controller.flushPendingWrites();
    await controller.fetchRunnerSessionMessagesCached(otherSessionId, "/workspace");
    await controller.flushPendingWrites();

    expect(mockFiles.has(`${CACHE_DIR}${SESSION_ID}.jsonl`)).toBe(false);
    expect(mockFiles.has(`${CACHE_DIR}${otherSessionId}.jsonl`)).toBe(true);
    const index = JSON.parse(mockFiles.get(`${CACHE_DIR}index.json`) || "{}");
    expect(Object.keys(index.sessions || {})).toEqual([otherSessionId]);
  });

  it("cleans up orphan session files missing from the index at startup", async () => {
    mockFiles.set(`${CACHE_DIR}index.json`, JSON.stringify({ version: 1, sessions: {} }));
    mockFiles.set(`${CACHE_DIR}orphan-session.jsonl`, "leftover");
    const fetchMock = jest.fn().mockResolvedValueOnce(makeResult({
      messages: [row("a", "first")],
      latestCursor: "cursor-1",
    }));
    const controller = makeController(fetchMock);

    await controller.fetchRunnerSessionMessagesCached(SESSION_ID, "/workspace");
    await controller.flushPendingWrites();

    expect(mockFiles.has(`${CACHE_DIR}orphan-session.jsonl`)).toBe(false);
  });
});
