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
} = {}) {
  return renderHook(() => useLlmSessionExplorer({
    codexWsUrl: "ws://127.0.0.1:8788/runner-ws",
    codexWsToken: "runner-token",
    runnerToken: "runner-token",
    auxServerBaseUrl: () => "http://runner.test",
    getRunnerHttpAuth: async () => ({ baseUrl: "http://runner.test", token: "runner-token" }),
    normalizedLlmDirectoryForRequest: () => "/workspace",
    defaultLlmDirectory: "/workspace",
    nearUnlimitedTimeoutMs: 60_000,
    onSessionDiagLog: overrides.onSessionDiagLog,
  }));
}

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
        messages: [{ role: "assistant", content: "latest", at: "now", itemId: "msg-1" }],
        olderCursor: "opaque-1",
      }),
    } as unknown as Response);
    const { result } = await renderExplorerHook();

    const restored = await result.current.fetchRunnerSessionMessages("thread-1", "/workspace");

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/session-messages");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("cursor")).toBeNull();
    expect(url.searchParams.get("limit")).not.toBe("all");
    expect(restored.messages).toEqual([
      { role: "assistant", content: "latest", at: "now", itemId: "msg-1", inheritedFromParent: undefined, commandExecution: undefined },
    ]);
    expect(restored.olderCursor).toBe("opaque-1");
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
