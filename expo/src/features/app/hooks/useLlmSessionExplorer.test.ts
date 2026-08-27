import { renderHook } from "@testing-library/react-native";
import { listCodexAppServerThreads, readCodexAppServerThread } from "../../codex/codexAppServerClient";
import { readAgentHistory } from "../../agent/client";
import { buildLlmSessionHistoryEntry, useLlmSessionExplorer } from "./useLlmSessionExplorer";

jest.mock("../../codex/codexAppServerClient", () => ({
  listCodexAppServerThreads: jest.fn(),
  readCodexAppServerThread: jest.fn(),
}));
jest.mock("../../agent/client", () => ({
  ALL_BACKENDS_SCOPE: "all",
  readAgentHistory: jest.fn(),
}));

const mockListCodexAppServerThreads = jest.mocked(listCodexAppServerThreads);
const mockReadCodexAppServerThread = jest.mocked(readCodexAppServerThread);
const mockReadAgentHistory = jest.mocked(readAgentHistory);

function renderExplorerHook(overrides: {
  codexWsUrl?: string;
  onSessionDiagLog?: (event: string, payload?: Record<string, unknown>) => void;
  runnerToken?: string;
  getRunnerHttpAuth?: () => Promise<{ baseUrl: string; token: string }>;
  runnerWebSocketManager?: never;
} = {}) {
  return renderHook(() => useLlmSessionExplorer({
    codexWsUrl: overrides.codexWsUrl ?? "ws://127.0.0.1:8788/runner-ws",
    runnerToken: overrides.runnerToken ?? "runner-token",
    auxServerBaseUrl: () => "http://runner.test",
    getRunnerHttpAuth: overrides.getRunnerHttpAuth
      ?? (async () => ({ baseUrl: "http://runner.test", token: "runner-token" })),
    normalizedLlmDirectoryForRequest: () => "/workspace",
    defaultLlmDirectory: "/workspace",
    nearUnlimitedTimeoutMs: 60_000,
    rawFallbackBackendId: "codex",
    runnerWebSocketManager: overrides.runnerWebSocketManager,
    onSessionDiagLog: overrides.onSessionDiagLog,
  }));
}

test("marks a session with credentials resolved after render", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      sessionId: "thread-1",
      directory: "/workspace",
      source: "all",
      lastReadAt: "2026-07-29T02:00:00.000Z",
      updated: true,
      acpUpdated: false,
      cliUpdated: true,
    }),
  } as unknown as Response);
  const { result } = await renderExplorerHook({
    runnerToken: "",
    getRunnerHttpAuth: async () => ({
      baseUrl: "http://live-runner.test",
      token: "live-token",
    }),
  });

  await result.current.markRunnerSessionRead("thread-1", {
    backendId: "claude",
    directory: "/workspace",
  });

  expect(fetchMock).toHaveBeenCalledWith(
    "http://live-runner.test/sessions/read",
    expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer live-token",
      }),
    })
  );
  const request = fetchMock.mock.calls[0][1];
  expect(JSON.parse(String(request?.body))).toMatchObject({
    backendId: "claude",
    sessionId: "thread-1",
  });
  fetchMock.mockRestore();
});

test("marks a canonical directory with one scoped request", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      scope: "directory",
      status: "full",
      directory: "/canonical/workspace",
      source: "all",
      lastReadAt: "2026-08-10T02:00:00.000Z",
      selectedCount: 205,
      foundCount: 205,
      updatedCount: 201,
      stores: {
        acp: { status: "success", selectedCount: 5, foundCount: 5, updatedCount: 4 },
        cli: { status: "success", selectedCount: 205, foundCount: 205, updatedCount: 201 },
      },
    }),
  } as unknown as Response);
  const { result } = await renderExplorerHook();

  const response = await result.current.markRunnerDirectoryRead("/workspace");
  expect(response).toMatchObject({ status: "full", directory: "/canonical/workspace", selectedCount: 205 });
  const request = fetchMock.mock.calls[0]?.[1];
  expect(JSON.parse(String(request?.body))).toEqual({
    scope: "directory",
    directory: "/workspace",
    source: "all",
  });
  fetchMock.mockRestore();
});

test("fetchLatestSessionForDirectory returns the entry identity, not just the id", async () => {
  mockListCodexAppServerThreads.mockResolvedValue({
    data: [{
      backendId: "claude",
      threadId: "claude-session-1",
      parentThreadId: "",
      agentRole: "",
      agentDisplayName: "",
      preview: "hello",
      modelProvider: "claude",
      modelRef: "sonnet",
      sourceKind: "appServer",
      cwd: "/workspace",
      createdAt: "",
      updatedAt: "2026-08-22T00:00:00.000Z",
      contextUsedPct: null,
    }],
    nextCursor: "",
    backwardsCursor: "",
  } as never);
  const { result } = await renderExplorerHook();

  const latest = await result.current.fetchLatestSessionForDirectory("/workspace");

  expect(latest).toEqual({ sessionId: "claude-session-1", backendId: "claude" });
  expect(mockListCodexAppServerThreads).toHaveBeenCalledWith(expect.objectContaining({
    backendId: "all",
    cwd: "/workspace",
    limit: 1,
  }));
  mockListCodexAppServerThreads.mockReset();
});

describe("fetchRunnerSessionMessages", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockReadCodexAppServerThread.mockReset();
    mockReadAgentHistory.mockReset();
  });

  it("reads a saved Codex entry with its own backend even while Claude is globally selected", async () => {
    mockReadAgentHistory.mockResolvedValue({
      sessionRef: { backendId: "codex", nativeSessionId: "thread-1" },
      canonicalCwd: "/native/workspace",
      items: [{ id: "item-1", role: "assistant", content: [{ type: "text", text: "saved" }] }],
    });
    const { result } = await renderExplorerHook({
      runnerWebSocketManager: {} as never,
    });

    const restored = await result.current.fetchRunnerSessionMessages("thread-1", "/workspace", {
      backendId: "codex",
    });

    expect(mockReadAgentHistory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      backendId: "codex",
      nativeSessionId: "thread-1",
    }));
    expect(restored).toMatchObject({
      backendId: "codex",
      cwd: "/native/workspace",
      modelRef: "",
    });
  });

  it("restores provider-neutral active-run state instead of forcing the session idle", async () => {
    mockReadAgentHistory.mockResolvedValue({
      sessionRef: { backendId: "claude", nativeSessionId: "thread-1" },
      canonicalCwd: "/native/workspace",
      items: [{ id: "item-1", role: "assistant", content: [{ type: "text", text: "partial" }] }],
      activeRun: {
        runId: "run-1",
        state: "running",
        startedAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:01.000Z",
        waitingForAction: false,
      },
    });
    const { result } = await renderExplorerHook({ runnerWebSocketManager: {} as never });

    const restored = await result.current.fetchRunnerSessionMessages("thread-1", "/workspace", {
      backendId: "claude",
    });

    expect(restored).toMatchObject({
      backendId: "claude",
      sourceKind: "agent",
      threadStatusType: "active",
      hasRunningTurn: true,
      runningTurn: {
        status: "running",
        startedAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:01.000Z",
      },
    });
  });

  it("maps neutral history itemType to the collapsed internal-context kind", async () => {
    mockReadAgentHistory.mockResolvedValue({
      sessionRef: { backendId: "claude", nativeSessionId: "thread-1" },
      canonicalCwd: "/native/workspace",
      items: [
        { id: "ctx-1", role: "user", itemType: "internal_context", content: [{ type: "text", text: "<recommended_plugins>list</recommended_plugins>" }] },
        { id: "ctx-2", role: "assistant", itemType: "unclassified_context", content: [{ type: "text", text: "goal body" }] },
        { id: "side-1", role: "assistant", itemType: "sidechain", content: [{ type: "text", text: "subagent" }] },
        { id: "msg-1", role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const { result } = await renderExplorerHook({
      runnerWebSocketManager: {} as never,
    });

    const restored = await result.current.fetchRunnerSessionMessages("thread-1", "/workspace", {
      backendId: "claude",
    });

    expect(restored.messages.map((message) => ({ itemId: message.itemId, kind: message.kind }))).toEqual([
      { itemId: "ctx-1", kind: "internal_context" },
      { itemId: "ctx-2", kind: "unclassified_context" },
      { itemId: "side-1", kind: "sidechain" },
      { itemId: "msg-1", kind: undefined },
    ]);
  });

  it("loads saved history from the bounded runner page API", async () => {
    mockReadCodexAppServerThread.mockResolvedValue({
      threadId: "thread-1",
      preview: "",
      modelProvider: "openai",
      sourceKind: "cli",
      cwd: "/workspace",
      createdAt: "",
      updatedAt: "",
      messages: [],
      contextUsedPct: null,
      sessionState: "idle",
      threadStatusType: "idle",
      waitingOnApproval: false,
      latestTurnStatus: "",
      hasRunningTurn: false,
      runningTurn: null,
    });
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        found: true,
        source: "cli",
        messages: [
          { role: "assistant", content: "goal body", at: "before", itemId: "goal-1", kind: "unclassified_context" },
          { role: "assistant", content: "latest", at: "now", itemId: "msg-1" },
        ],
        olderCursor: "opaque-1",
      }),
    } as unknown as Response);
    const { result } = await renderExplorerHook();

    const restored = await result.current.fetchRunnerSessionMessages("thread-1", "/workspace");

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/session-messages");
    expect(url.searchParams.get("limit")).toBeNull();
    expect(url.searchParams.get("cursor")).toBeNull();
    expect(restored.messages).toEqual([
      {
        role: "assistant",
        content: "goal body",
        at: "before",
        kind: "unclassified_context",
        itemId: "goal-1",
        inheritedFromParent: undefined,
        commandExecution: undefined,
      },
      { role: "assistant", content: "latest", at: "now", itemId: "msg-1", inheritedFromParent: undefined, commandExecution: undefined },
    ]);
    expect(restored.olderCursor).toBe("opaque-1");
  });

  it("returns the runner page promptly and preserves App Server metadata that arrives later", async () => {
    let resolveLive!: (value: any) => void;
    mockReadCodexAppServerThread.mockImplementation(() => new Promise((resolve) => {
      resolveLive = resolve;
    }));
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        found: true,
        source: "cli",
        messages: [{ role: "assistant", content: "latest", at: "now", itemId: "msg-1" }],
        olderCursor: null,
      }),
    } as unknown as Response);
    const { result } = await renderExplorerHook();

    const restored = await result.current.fetchRunnerSessionMessages("thread-1", "/workspace");

    expect(restored.messages).toHaveLength(1);
    expect(mockReadCodexAppServerThread).toHaveBeenCalledTimes(1);
    expect(restored.liveStatePromise).toBeDefined();

    resolveLive({
      threadId: "thread-1",
      threadStatusType: "active",
      hasRunningTurn: true,
      runningTurn: {
        status: "running",
        summary: "working",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    await expect(restored.liveStatePromise).resolves.toEqual({
      threadId: "thread-1",
      threadStatusType: "active",
      hasRunningTurn: true,
      runningTurn: {
        status: "running",
        summary: "working",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });
  });

  it("passes an older cursor only to runner and skips App Server history", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ found: true, messages: [], olderCursor: null }),
    } as unknown as Response);
    const { result } = await renderExplorerHook();

    await result.current.fetchRunnerSessionMessages("thread-1", "/workspace", { cursor: "opaque-1" });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("cursor")).toBe("opaque-1");
    expect(mockReadCodexAppServerThread).not.toHaveBeenCalled();
  });

  it("requests a forward delta with sinceCursor and surfaces latestCursor/moreAfter/replacesItemId", async () => {
    mockReadCodexAppServerThread.mockResolvedValue(null as never);
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        found: true,
        source: "cli",
        messages: [
          { role: "assistant", content: "resolved pair", at: "now", itemId: "item-2", replacesItemId: "item-1" },
        ],
        olderCursor: null,
        latestCursor: "latest-2",
        moreAfter: true,
      }),
    } as unknown as Response);
    const { result } = await renderExplorerHook();

    const restored = await result.current.fetchRunnerSessionMessages("thread-1", "/workspace", {
      sinceCursor: "latest-1",
      skipLiveState: true,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("sinceCursor")).toBe("latest-1");
    expect(url.searchParams.get("cursor")).toBeNull();
    expect(restored.messages[0]?.replacesItemId).toBe("item-1");
    expect(restored.latestCursor).toBe("latest-2");
    expect(restored.moreAfter).toBe(true);
    // skipLiveState指定時はApp ServerへのライブRPCを発行しない(moreAfter連鎖用)。
    expect(mockReadCodexAppServerThread).not.toHaveBeenCalled();
  });

  it("does not retry a failed sinceCursor request without directory and keeps the error code", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: "stale_history_cursor", message: "stale" }),
    } as unknown as Response);
    const { result } = await renderExplorerHook();

    await expect(result.current.fetchRunnerSessionMessages("thread-1", "/workspace", {
      sinceCursor: "latest-1",
      skipLiveState: true,
    })).rejects.toMatchObject({ code: "stale_history_cursor" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchRunnerSessionContextUsedPct", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockReadAgentHistory.mockReset();
  });

  it("prefers the backend-neutral history contextUsage when a backendId is known", async () => {
    mockReadAgentHistory.mockResolvedValue({
      sessionRef: { backendId: "claude", nativeSessionId: "thread-1" },
      items: [],
      contextUsage: { usedPct: 7, totalTokens: 14000, contextWindowTokens: 200000 },
    });
    const fetchMock = jest.spyOn(global, "fetch");
    const { result } = await renderExplorerHook({
      runnerWebSocketManager: {} as never,
    });

    const usedPct = await result.current.fetchRunnerSessionContextUsedPct("thread-1", "/workspace", {
      backendId: "claude",
    });

    expect(usedPct).toBe(7);
    expect(mockReadAgentHistory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      backendId: "claude",
      nativeSessionId: "thread-1",
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy snapshot endpoint when the neutral history has no contextUsage", async () => {
    mockReadAgentHistory.mockResolvedValue({
      sessionRef: { backendId: "codex", nativeSessionId: "thread-1" },
      items: [],
    });
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        found: true,
        contextUsage: { usedPct: 42 },
      }),
    } as unknown as Response);
    const { result } = await renderExplorerHook({
      runnerWebSocketManager: {} as never,
    });

    const usedPct = await result.current.fetchRunnerSessionContextUsedPct("thread-1", "/workspace", {
      backendId: "codex",
    });

    expect(usedPct).toBe(42);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("fetchSessionHistory runner snapshot failures", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockListCodexAppServerThreads.mockReset();
  });

  it("posts exactly the listed session ids to the bounded summary endpoint", async () => {
    mockListCodexAppServerThreads.mockResolvedValue({
      data: ["session-1", "session-2"].map((threadId) => ({
        threadId,
        parentThreadId: "",
        agentRole: "",
        agentDisplayName: "",
        preview: threadId,
        modelProvider: "",
        sourceKind: "cli",
        cwd: "/workspace",
        createdAt: "2026-07-17T00:00:00Z",
        updatedAt: "2026-07-17T00:00:00Z",
        contextUsedPct: null,
      })),
      nextCursor: "",
      backwardsCursor: "",
    });
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        sessions: [{
          sessionId: "session-2",
          contextUsage: { usedPct: 10 },
        }],
        missingSessionIds: ["session-1"],
      }),
    } as unknown as Response);
    const { result } = await renderExplorerHook();

    const history = await result.current.fetchSessionHistory("/workspace");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://runner.test/session-summaries",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer runner-token",
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          directory: "/workspace",
          sessionIds: ["session-1", "session-2"],
        }),
      })
    );
    expect(history.entries[1].contextUsedPct).toBe(10);
  });

  it("logs a failed snapshot fetch and keeps contextUsedPct null instead of 0", async () => {
    mockListCodexAppServerThreads.mockResolvedValue({
      data: [{
        threadId: "session-1",
        parentThreadId: "",
        agentRole: "",
        agentDisplayName: "",
        preview: "hello",
        modelProvider: "",
        sourceKind: "cli",
        cwd: "/workspace",
        createdAt: "2026-07-17T00:00:00Z",
        updatedAt: "2026-07-17T00:00:00Z",
        contextUsedPct: null,
      }],
      nextCursor: "",
      backwardsCursor: "",
    });
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: "unauthorized" }),
    } as unknown as Response);
    const onSessionDiagLog = jest.fn();
    const { result } = await renderExplorerHook({ onSessionDiagLog });

    const history = await result.current.fetchSessionHistory("/workspace");

    expect(onSessionDiagLog).toHaveBeenCalledWith(
      "runner_session_snapshot_map_failed",
      expect.objectContaining({
        directory: "/workspace",
        message: "unauthorized",
        elapsedMs: expect.any(Number),
      })
    );
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].contextUsedPct).toBeNull();
  });

  it("requests every subagent source kind through paginated directory history", async () => {
    mockListCodexAppServerThreads.mockResolvedValue({
      data: [{
        threadId: "child-1",
        parentThreadId: "parent-1",
        agentRole: "",
        agentDisplayName: "",
        preview: "child",
        modelProvider: "",
        sourceKind: "subAgent",
        cwd: "/workspace",
        createdAt: "2026-07-17T00:00:00Z",
        updatedAt: "2026-07-17T00:00:00Z",
        contextUsedPct: null,
      }],
      nextCursor: "next-page",
      backwardsCursor: "",
    });
    const { result } = await renderExplorerHook();

    const history = await result.current.fetchSessionHistory("/workspace", {
      cursor: "current-page",
      includeRunnerSnapshots: false,
      includeSubagents: true,
    });

    expect(mockListCodexAppServerThreads).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      cursor: "current-page",
      sourceKinds: [
        "cli",
        "vscode",
        "appServer",
        "exec",
        "subAgent",
        "subAgentReview",
        "subAgentCompact",
        "subAgentThreadSpawn",
        "subAgentOther",
      ],
    }));
    expect(history.entries[0]).toMatchObject({
      sessionId: "child-1",
      parentSessionId: "parent-1",
      source: "subagent",
    });
    expect(history.nextCursor).toBe("next-page");
  });

  it("defaults the directory history scope to all backends and keeps mixed entries with partial errors", async () => {
    mockListCodexAppServerThreads.mockResolvedValue({
      data: [
        {
          backendId: "claude",
          threadId: "session-claude",
          parentThreadId: "",
          agentRole: "",
          agentDisplayName: "",
          preview: "claude hello",
          modelProvider: "claude",
          modelRef: "sonnet",
          sourceKind: "appServer",
          cwd: "/workspace",
          createdAt: "2026-08-21T00:00:00Z",
          updatedAt: "2026-08-22T00:00:00Z",
          contextUsedPct: null,
        },
        {
          backendId: "codex",
          threadId: "session-codex",
          parentThreadId: "",
          agentRole: "",
          agentDisplayName: "",
          preview: "codex hello",
          modelProvider: "codex",
          modelRef: "gpt-5.6-sol",
          sourceKind: "appServer",
          cwd: "/workspace",
          createdAt: "2026-08-21T00:00:00Z",
          updatedAt: "2026-08-21T00:00:00Z",
          contextUsedPct: null,
        },
      ],
      nextCursor: "",
      backwardsCursor: "",
      partialErrors: [{ backendId: "other", code: "backend_unavailable", message: "down" }],
    });
    const { result } = await renderExplorerHook();

    const history = await result.current.fetchSessionHistory("/workspace", {
      includeRunnerSnapshots: false,
    });

    expect(mockListCodexAppServerThreads).toHaveBeenCalledWith(expect.objectContaining({ backendId: "all" }));
    expect(history.entries.map((entry) => ({ backendId: entry.backendId, sessionId: entry.sessionId }))).toEqual([
      { backendId: "claude", sessionId: "session-claude" },
      { backendId: "codex", sessionId: "session-codex" },
    ]);
  });

  it("preserves a Claude session backend and model from the backend catalog entry", async () => {
    mockListCodexAppServerThreads.mockResolvedValue({
      data: [{
        backendId: "claude",
        threadId: "session-claude",
        parentThreadId: "",
        agentRole: "",
        agentDisplayName: "",
        preview: "hello",
        modelProvider: "claude",
        modelRef: "sonnet",
        sourceKind: "appServer",
        cwd: "/workspace",
        createdAt: "2026-08-21T00:00:00Z",
        updatedAt: "2026-08-21T00:00:00Z",
        contextUsedPct: null,
      }],
      nextCursor: "",
      backwardsCursor: "",
    });
    const { result } = await renderExplorerHook({ codexWsUrl: "" });

    const history = await result.current.fetchSessionHistory("/workspace", {
      backendId: "claude",
      includeRunnerSnapshots: false,
    });

    expect(mockListCodexAppServerThreads).toHaveBeenCalledWith(expect.objectContaining({ backendId: "claude" }));
    expect(history.entries[0]).toMatchObject({
      backendId: "claude",
      sessionId: "session-claude",
      modelRef: "sonnet",
    });
  });
});

describe("buildLlmSessionHistoryEntry", () => {
  it("uses the thread cwd instead of the parent discovery scope", () => {
    const entry = buildLlmSessionHistoryEntry({
      threadId: "session-1",
      cwd: "/workspace/bitty/subagent-worktree",
    } as never, ".", new Map());

    expect(entry.directory).toBe("/workspace/bitty/subagent-worktree");
    expect(entry.cwd).toBe("/workspace/bitty/subagent-worktree");
  });

  it("falls back to the discovery scope when cwd is unavailable", () => {
    const entry = buildLlmSessionHistoryEntry({
      threadId: "session-1",
      cwd: "",
    } as never, "/workspace/bitty", new Map());

    expect(entry.directory).toBe("/workspace/bitty");
  });

  it("keeps a null contextUsedPct null instead of rounding it to 0", () => {
    const entry = buildLlmSessionHistoryEntry({
      threadId: "session-1",
      cwd: "/workspace/bitty",
      contextUsedPct: null,
    } as never, "/workspace/bitty", new Map());

    expect(entry.contextUsedPct).toBeNull();
  });

  it("prefers the runner snapshot value over the thread list value", () => {
    const entry = buildLlmSessionHistoryEntry({
      threadId: "session-1",
      cwd: "/workspace/bitty",
      contextUsedPct: 10,
    } as never, "/workspace/bitty", new Map([[
      "session-1",
      { contextUsedPct: 41.6, modelRef: "", reasoningEffort: "", latestToolLabel: "", lastReadAt: "" },
    ]]));

    expect(entry.contextUsedPct).toBe(42);
  });

  it("uses provider-neutral list settings when no legacy snapshot exists", () => {
    const entry = buildLlmSessionHistoryEntry({
      threadId: "session-1",
      cwd: "/workspace/bitty",
      modelRef: "sonnet",
      reasoningEffort: "high",
    } as never, "/workspace/bitty", new Map());

    expect(entry.modelRef).toBe("sonnet");
    expect(entry.reasoningEffort).toBe("high");
  });

  it("prefers backend-aware provider-neutral read state over a legacy snapshot", () => {
    const entry = buildLlmSessionHistoryEntry({
      threadId: "session-1",
      cwd: "/workspace/bitty",
      lastReadAt: "2026-08-24T03:00:00.000Z",
    } as never, "/workspace/bitty", new Map([[
      "session-1",
      { contextUsedPct: null, modelRef: "", reasoningEffort: "", latestToolLabel: "", lastReadAt: "2026-08-23T03:00:00.000Z" },
    ]]));

    expect(entry.lastReadAt).toBe("2026-08-24T03:00:00.000Z");
  });
});

test("paginates one directory subagent sequence, deduplicates it, and groups every parent", async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    threadId: `child-a-${index}`,
    parentThreadId: "parent-a",
    sourceKind: "subAgent",
    cwd: "/workspace",
    threadStatusType: "active",
  }));
  mockListCodexAppServerThreads
    .mockResolvedValueOnce({
      data: firstPage as never,
      nextCursor: "page-2",
      backwardsCursor: "",
    })
    .mockResolvedValueOnce({
      data: [
        firstPage[0],
        { threadId: "child-b", parentThreadId: "parent-b", sourceKind: "subAgent", cwd: "/workspace", threadStatusType: "idle" },
      ] as never,
      nextCursor: "",
      backwardsCursor: "",
    });
  const { result } = await renderExplorerHook();

  const grouped = await result.current.fetchSessionChildrenHistory(
    ["parent-a", "parent-b"],
    "/workspace",
    { includeRunnerSnapshots: false }
  );

  expect(mockListCodexAppServerThreads).toHaveBeenCalledTimes(2);
  expect(mockListCodexAppServerThreads.mock.calls[1][0]).toEqual(expect.objectContaining({ cursor: "page-2" }));
  expect(grouped["parent-a"]).toHaveLength(50);
  expect(grouped["parent-a"][0]).toEqual(
    expect.objectContaining({ sessionId: "child-a-0", threadStatusType: "active" })
  );
  expect(grouped["parent-b"]).toEqual([
    expect.objectContaining({ sessionId: "child-b", threadStatusType: "idle" }),
  ]);
});
