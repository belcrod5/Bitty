import { renderHook } from "@testing-library/react-native";
import { listCodexAppServerThreads, readCodexAppServerThread } from "../../codex/codexAppServerClient";
import { buildLlmSessionHistoryEntry, useLlmSessionExplorer } from "./useLlmSessionExplorer";

jest.mock("../../codex/codexAppServerClient", () => ({
  listCodexAppServerThreads: jest.fn(),
  readCodexAppServerThread: jest.fn(),
}));

const mockListCodexAppServerThreads = jest.mocked(listCodexAppServerThreads);
const mockReadCodexAppServerThread = jest.mocked(readCodexAppServerThread);

function renderExplorerHook(overrides: {
  onSessionDiagLog?: (event: string, payload?: Record<string, unknown>) => void;
  runnerToken?: string;
  getRunnerHttpAuth?: () => Promise<{ baseUrl: string; token: string }>;
} = {}) {
  return renderHook(() => useLlmSessionExplorer({
    codexWsUrl: "ws://127.0.0.1:8788/runner-ws",
    codexWsToken: "runner-token",
    runnerToken: overrides.runnerToken ?? "runner-token",
    auxServerBaseUrl: () => "http://runner.test",
    getRunnerHttpAuth: overrides.getRunnerHttpAuth
      ?? (async () => ({ baseUrl: "http://runner.test", token: "runner-token" })),
    normalizedLlmDirectoryForRequest: () => "/workspace",
    defaultLlmDirectory: "/workspace",
    nearUnlimitedTimeoutMs: 60_000,
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
  fetchMock.mockRestore();
});

describe("fetchRunnerSessionMessages", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockReadCodexAppServerThread.mockReset();
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
});
