import { runCodexRpcSession } from "./rpcSession";
import { listCodexAppServerThreads, listCodexAppServerThreadsBatch, readCodexAppServerThread } from "./threads";
import { listAgentSessions, listAgentSessionsBatch, readAgentHistory } from "../../agent/client";

jest.mock("./rpcSession", () => ({
  ...jest.requireActual("./rpcSession"),
  runCodexRpcSession: jest.fn(),
}));
jest.mock("../../agent/client", () => ({
  ALL_BACKENDS_SCOPE: "all",
  listAgentSessions: jest.fn(),
  listAgentSessionsBatch: jest.fn(),
  readAgentHistory: jest.fn(),
}));

const mockRunCodexRpcSession = jest.mocked(runCodexRpcSession);
const mockListAgentSessions = jest.mocked(listAgentSessions);
const mockReadAgentHistory = jest.mocked(readAgentHistory);

beforeEach(() => {
  mockRunCodexRpcSession.mockReset();
  mockListAgentSessions.mockReset();
  mockReadAgentHistory.mockReset();
});

it("forwards list response byte observation only to the neutral listing", async () => {
  const onListResponseBytes = jest.fn();
  mockListAgentSessions.mockImplementationOnce(async (_manager, _options, onResponseBytes) => {
    onResponseBytes?.(234);
    return { sessions: [] };
  });
  const result = await listCodexAppServerThreads({ cwd: "/workspace", runnerWebSocketManager: {} as never,
    backendId: "all", onListResponseBytes,
  });
  expect(result.data).toEqual([]);
  expect(onListResponseBytes).toHaveBeenCalledWith(234);
  expect(mockListAgentSessions).toHaveBeenCalledWith(expect.anything(), expect.anything(), onListResponseBytes);
});

it("maps an all-backends listing per entry backend and surfaces partial errors", async () => {
  mockListAgentSessions.mockResolvedValue({
    sessions: [
      {
        sessionRef: { backendId: "claude", nativeSessionId: "claude-1" },
        canonicalCwd: "/workspace",
        updatedAt: "2026-08-22T03:00:00.000Z",
        lastReadAt: "2026-08-22T04:00:00.000Z",
        title: "claude session",
        modelId: "sonnet",
        reasoningEffort: "high",
      },
      {
        sessionRef: { backendId: "codex", nativeSessionId: "codex-1" },
        canonicalCwd: "/workspace",
        updatedAt: "2026-08-22T02:00:00.000Z",
        title: "codex session",
        modelId: "gpt-5.6-sol",
      },
    ],
    errors: [{ backendId: "other", code: "backend_unavailable", message: "down" }],
  });

  const result = await listCodexAppServerThreads({
    cwd: "/workspace",
    runnerWebSocketManager: {} as never,
    backendId: "all",
  });

  expect(mockListAgentSessions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ backendId: "all" }), undefined);
  // 既定sourceKinds(メイン系のみ)はサーバー側でsubagentを除外してからページングさせる
  expect(mockListAgentSessions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ includeSubagents: false }), undefined);
  expect(result.data.map((item) => ({ backendId: item.backendId, threadId: item.threadId, modelProvider: item.modelProvider }))).toEqual([
    { backendId: "claude", threadId: "claude-1", modelProvider: "claude" },
    { backendId: "codex", threadId: "codex-1", modelProvider: "codex" },
  ]);
  expect(result.data[0].reasoningEffort).toBe("high");
  expect(result.data[0].lastReadAt).toBe("2026-08-22T04:00:00.000Z");
  expect(result.partialErrors).toEqual([{ backendId: "other", code: "backend_unavailable", message: "down" }]);
  expect(mockRunCodexRpcSession).not.toHaveBeenCalled();
});

it.each(["codex", "claude"])("preserves complete %s summaries without replacing the selected model fields", async (backendId) => {
  const summary = { contextUsage: null, modelRef: "native-model", reasoningEffort: "high", lastReadAt: "2026-10-26" };
  mockListAgentSessions.mockResolvedValue({ sessions: [{
    sessionRef: { backendId, nativeSessionId: "one" }, sourceKind: "cli",
    modelId: "selected-model", reasoningEffort: "low", summary,
  }] });
  const result = await listCodexAppServerThreads({ runnerWebSocketManager: {} as never, backendId: "codex" });
  expect(result.data[0]).toMatchObject({ modelRef: "selected-model", reasoningEffort: "low", summary });
});

it.each([undefined, {}, { contextUsage: null }, { contextUsage: 42, modelRef: "native", reasoningEffort: "high", lastReadAt: "" },
  { contextUsage: [], modelRef: "native", reasoningEffort: "high", lastReadAt: "" }].flatMap((summary) =>
    ["codex", "claude"].map((backendId) => ({ backendId, summary }))))(
  "drops incomplete or malformed $backendId summary $summary so HTTP fallback remains available", async ({ backendId, summary }) => {
    mockListAgentSessions.mockResolvedValue({ sessions: [{
      sessionRef: { backendId, nativeSessionId: "one" }, sourceKind: "cli", summary,
    }] });
    const result = await listCodexAppServerThreads({ runnerWebSocketManager: {} as never, backendId: "codex" });
    expect(result.data[0]).not.toHaveProperty("summary");
  },
);

it.each(["all", "codex"])("does not retry a failed %s listing through raw RPC", async (backendId) => {
  mockListAgentSessions.mockRejectedValue(new Error("runner_ws_inactive"));
  await expect(listCodexAppServerThreads({ runnerWebSocketManager: {} as never, backendId }))
    .rejects.toThrow("runner_ws_inactive");
  expect(mockRunCodexRpcSession).not.toHaveBeenCalled();
});

it("rejects an unavailable Agent backend without raw RPC", async () => {
  mockListAgentSessions.mockResolvedValue(null);
  await expect(listCodexAppServerThreads({ runnerWebSocketManager: {} as never, backendId: "codex" }))
    .rejects.toThrow("unavailable");
  expect(mockRunCodexRpcSession).not.toHaveBeenCalled();
});

it("keeps the server-reported sourceKind and normalizes acp to appServer", async () => {
  mockListAgentSessions.mockResolvedValue({
    sessions: [
      { sessionRef: { backendId: "codex", nativeSessionId: "codex-cli" }, updatedAt: "2026-08-22T03:00:00.000Z", sourceKind: "cli" },
      { sessionRef: { backendId: "codex", nativeSessionId: "codex-acp" }, updatedAt: "2026-08-22T02:00:00.000Z", sourceKind: "acp" },
      { sessionRef: { backendId: "claude", nativeSessionId: "claude-1" }, updatedAt: "2026-08-22T01:00:00.000Z", sourceKind: "cli" },
      { sessionRef: { backendId: "codex", nativeSessionId: "sub-1" }, updatedAt: "2026-08-22T00:30:00.000Z", sourceKind: "cli", isSubagent: true },
    ],
  });

  const result = await listCodexAppServerThreads({
    cwd: "/workspace",
    runnerWebSocketManager: {} as never,
    backendId: "all",
    sourceKinds: ["cli", "vscode", "appServer", "exec"],
  });

  // "cli"はそのまま、"acp"はappServerへ正規化、subagentはメイン一覧から除外
  expect(result.data.map((item) => ({ threadId: item.threadId, sourceKind: item.sourceKind }))).toEqual([
    { threadId: "codex-cli", sourceKind: "cli" },
    { threadId: "codex-acp", sourceKind: "appServer" },
    { threadId: "claude-1", sourceKind: "cli" },
  ]);
});

it("requests subagents from the server when subAgent source kinds are included", async () => {
  mockListAgentSessions.mockResolvedValue({ sessions: [] });

  await listCodexAppServerThreads({
    cwd: "/workspace",
    runnerWebSocketManager: {} as never,
    backendId: "all",
    sourceKinds: ["subAgent", "subAgentReview"],
  });

  expect(mockListAgentSessions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ includeSubagents: true }), undefined);
});

it("maps the server-reported isActive to a threadStatusType per listing entry", async () => {
  mockListAgentSessions.mockResolvedValue({
    sessions: [
      {
        sessionRef: { backendId: "codex", nativeSessionId: "sub-running" },
        updatedAt: "2026-08-28T03:00:00.000Z",
        sourceKind: "cli",
        isSubagent: true,
        isActive: true,
      },
      {
        sessionRef: { backendId: "codex", nativeSessionId: "sub-idle" },
        updatedAt: "2026-08-28T02:00:00.000Z",
        sourceKind: "cli",
        isSubagent: true,
      },
    ],
  });

  const result = await listCodexAppServerThreads({
    cwd: "/workspace",
    runnerWebSocketManager: {} as never,
    backendId: "all",
    sourceKinds: ["subAgent"],
  });

  // threadStatusTypeを欠落させると常に"unknown"になり実行中カウントが構造的に0になる
  expect(result.data.map((item) => ({ threadId: item.threadId, threadStatusType: item.threadStatusType }))).toEqual([
    { threadId: "sub-running", threadStatusType: "active" },
    { threadId: "sub-idle", threadStatusType: "idle" },
  ]);
});

it("maps a provider-neutral active run to a running thread", async () => {
  mockReadAgentHistory.mockResolvedValue({
    items: [],
    activeRun: {
      runId: "run-1",
      state: "running",
      startedAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
      waitingForAction: false,
    },
  });

  const result = await readCodexAppServerThread({
    wsUrl: "ws://runner",
    threadId: "thread-1",
    runnerWebSocketManager: {} as never,
    backendId: "claude",
  });

  expect(result).toMatchObject({
    sessionState: "running",
    threadStatusType: "active",
    waitingOnApproval: false,
    latestTurnStatus: "running",
    hasRunningTurn: true,
    runningTurn: {
      status: "running",
      summary: "agent turn running",
      startedAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
    },
  });
  expect(mockRunCodexRpcSession).not.toHaveBeenCalled();
});

it("maps a provider-neutral pending action to approval-waiting live state", async () => {
  mockReadAgentHistory.mockResolvedValue({
    items: [],
    activeRun: {
      runId: "run-1",
      state: "running",
      startedAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
      waitingForAction: true,
    },
  });

  const result = await readCodexAppServerThread({
    wsUrl: "ws://runner",
    threadId: "thread-1",
    runnerWebSocketManager: {} as never,
    backendId: "claude",
  });

  expect(result).toMatchObject({
    sessionState: "waiting_on_approval",
    threadStatusType: "active",
    waitingOnApproval: true,
    latestTurnStatus: "waiting_on_approval",
    hasRunningTurn: true,
    runningTurn: {
      status: "waiting_approval",
      summary: "approval required",
    },
  });
});

it("maps provider-neutral history without an active run to completed idle state", async () => {
  mockReadAgentHistory.mockResolvedValue({ items: [], activeRun: null });

  const result = await readCodexAppServerThread({
    wsUrl: "ws://runner",
    threadId: "thread-1",
    runnerWebSocketManager: {} as never,
    backendId: "claude",
  });

  expect(result).toMatchObject({
    sessionState: "completed",
    threadStatusType: "idle",
    waitingOnApproval: false,
    latestTurnStatus: "completed",
    hasRunningTurn: false,
    runningTurn: null,
  });
});

it("reads metadata without replaying saved turns", async () => {
  const rpc = jest.fn(async (method: string) => {
    if (method === "thread/read") return { thread: { id: "thread-1", status: "idle" } };
    throw new Error(method);
  });
  mockRunCodexRpcSession.mockImplementation(async (options) => options.run(rpc as any));

  const result = await readCodexAppServerThread({ wsUrl: "ws://runner", threadId: "thread-1" });

  expect(rpc).toHaveBeenNthCalledWith(1, "thread/read", {
    threadId: "thread-1",
    includeTurns: false,
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(result.messages).toEqual([]);
});

it("resumes a not-loaded thread without returning all turns", async () => {
  const rpc = jest.fn(async (method: string) => {
    if (method === "thread/read") throw new Error("thread not loaded: thread-1");
    if (method === "thread/resume") return {
      thread: { id: "thread-1", status: "idle" },
      initialTurnsPage: { data: [], nextCursor: null },
    };
    throw new Error(method);
  });
  mockRunCodexRpcSession.mockImplementation(async (options) => options.run(rpc as any));

  await readCodexAppServerThread({ wsUrl: "ws://runner", threadId: "thread-1" });

  expect(rpc).toHaveBeenCalledWith("thread/resume", {
    threadId: "thread-1",
    excludeTurns: true,
  });
  expect(rpc).not.toHaveBeenCalledWith("thread/turns/list", expect.anything());
});

it("keeps active state without loading turns", async () => {
  const rpc = jest.fn().mockResolvedValue({
    thread: { id: "thread-1", status: "active", updatedAt: "2026-07-01T00:00:00Z" },
  });
  mockRunCodexRpcSession.mockImplementation(async (options) => options.run(rpc as any));

  const result = await readCodexAppServerThread({ wsUrl: "ws://runner", threadId: "thread-1" });

  expect(result.hasRunningTurn).toBe(true);
  expect(result.runningTurn?.summary).toBe("応答生成中");
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('normalizes batch pages with the same summary, cursor, title and partial error contract', async () => {
  const summary = { contextUsage: { usedPct: 20 }, modelRef: 'native', reasoningEffort: 'high', lastReadAt: 'read' };
  jest.mocked(listAgentSessionsBatch).mockResolvedValue([{ cwd: '/workspace', payload: { sessions: [{
    sessionRef: { backendId: 'codex', nativeSessionId: 'one' }, title: 'shared', sourceKind: 'cli',
    canonicalCwd: '/workspace', lastReadAt: 'read', summary,
  }], cursor: 'next', errors: [{ backendId: 'claude', code: 'backend_unavailable' }] } }]);
  const [group] = await listCodexAppServerThreadsBatch({ cwds: ['/workspace'], limit: 5, runnerWebSocketManager: {} as never });
  expect(group.result).toMatchObject({ nextCursor: 'next', partialErrors: [{ backendId: 'claude' }],
    data: [{ backendId: 'codex', threadId: 'one', preview: 'shared', lastReadAt: 'read', summary }] });
  expect(mockListAgentSessions).not.toHaveBeenCalled();
});

it('keeps a failed batch group as an error without raw RPC', async () => {
  const error = new Error('batch failed');
  jest.mocked(listAgentSessionsBatch).mockResolvedValue([{ cwd: '/workspace', error }]);
  const [group] = await listCodexAppServerThreadsBatch({ cwds: ['/workspace'], runnerWebSocketManager: {} as never });
  expect(group.error).toBe(error);
  expect(group.result).toBeUndefined();
  expect(mockListAgentSessions).not.toHaveBeenCalled();
  expect(mockRunCodexRpcSession).not.toHaveBeenCalled();
});
