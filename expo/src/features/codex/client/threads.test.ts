import { runCodexRpcSession } from "./rpcSession";
import { listCodexAppServerThreads, readCodexAppServerThread } from "./threads";
import { listAgentSessions } from "../../agent/client";

jest.mock("./rpcSession", () => ({
  ...jest.requireActual("./rpcSession"),
  runCodexRpcSession: jest.fn(),
}));
jest.mock("../../agent/client", () => ({
  ALL_BACKENDS_SCOPE: "all",
  listAgentSessions: jest.fn(),
  readAgentHistory: jest.fn(),
}));

const mockRunCodexRpcSession = jest.mocked(runCodexRpcSession);
const mockListAgentSessions = jest.mocked(listAgentSessions);

beforeEach(() => {
  mockRunCodexRpcSession.mockReset();
  mockListAgentSessions.mockReset();
});

it("maps an all-backends listing per entry backend and surfaces partial errors", async () => {
  mockListAgentSessions.mockResolvedValue({
    sessions: [
      {
        sessionRef: { backendId: "claude", nativeSessionId: "claude-1" },
        canonicalCwd: "/workspace",
        updatedAt: "2026-08-22T03:00:00.000Z",
        title: "claude session",
        modelId: "sonnet",
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
    wsUrl: "ws://runner",
    cwd: "/workspace",
    runnerWebSocketManager: {} as never,
    backendId: "all",
    rawFallbackBackendId: "codex",
  });

  expect(mockListAgentSessions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ backendId: "all" }));
  // 既定sourceKinds(メイン系のみ)はサーバー側でsubagentを除外してからページングさせる
  expect(mockListAgentSessions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ includeSubagents: false }));
  expect(result.data.map((item) => ({ backendId: item.backendId, threadId: item.threadId, modelProvider: item.modelProvider }))).toEqual([
    { backendId: "claude", threadId: "claude-1", modelProvider: "claude" },
    { backendId: "codex", threadId: "codex-1", modelProvider: "codex" },
  ]);
  expect(result.partialErrors).toEqual([{ backendId: "other", code: "backend_unavailable", message: "down" }]);
  expect(mockRunCodexRpcSession).not.toHaveBeenCalled();
});

it("falls back to the raw codex listing when the all-backends scope fails while the runner WS is ready", async () => {
  mockListAgentSessions.mockRejectedValue(new Error("agent channel unavailable"));
  mockRunCodexRpcSession.mockImplementation(async (options) => options.run(jest.fn(async () => ({
    data: [],
    nextCursor: "",
    backwardsCursor: "",
  })) as never));

  const result = await listCodexAppServerThreads({
    wsUrl: "ws://runner",
    cwd: "/workspace",
    runnerWebSocketManager: { getSnapshot: () => ({ connectionState: "ready", generation: 1 }) } as never,
    backendId: "all",
    rawFallbackBackendId: "codex",
  });

  expect(mockRunCodexRpcSession).toHaveBeenCalledTimes(1);
  expect(result.data).toEqual([]);
});

it("does not degrade the all-backends listing to raw codex while the runner WS is not ready", async () => {
  // raw退行を許すとCodexのみの一覧が「完全な成功」としてキャッシュされ、
  // 非Codexセッションが欠落したまま固定される(起動直後の実機症状)。
  mockListAgentSessions.mockRejectedValue(new Error("runner_ws_inactive"));

  await expect(listCodexAppServerThreads({
    wsUrl: "ws://runner",
    cwd: "/workspace",
    runnerWebSocketManager: { getSnapshot: () => ({ connectionState: "connecting", generation: 1 }) } as never,
    backendId: "all",
    rawFallbackBackendId: "codex",
  })).rejects.toThrow("runner_ws_inactive");
  expect(mockRunCodexRpcSession).not.toHaveBeenCalled();
});

it("still degrades a codex-scoped listing to raw when the runner WS is not ready", async () => {
  // 単一Codexスコープのraw退行は同じCodexデータ源への退行で欠落を生まない。
  mockListAgentSessions.mockRejectedValue(new Error("runner_ws_inactive"));
  mockRunCodexRpcSession.mockImplementation(async (options) => options.run(jest.fn(async () => ({
    data: [],
    nextCursor: "",
    backwardsCursor: "",
  })) as never));

  const result = await listCodexAppServerThreads({
    wsUrl: "ws://runner",
    cwd: "/workspace",
    runnerWebSocketManager: { getSnapshot: () => ({ connectionState: "connecting", generation: 1 }) } as never,
    backendId: "codex",
    rawFallbackBackendId: "codex",
  });

  expect(mockRunCodexRpcSession).toHaveBeenCalledTimes(1);
  expect(result.data).toEqual([]);
});

it("requests subagents from the server when subAgent source kinds are included", async () => {
  mockListAgentSessions.mockResolvedValue({ sessions: [] });

  await listCodexAppServerThreads({
    wsUrl: "ws://runner",
    cwd: "/workspace",
    runnerWebSocketManager: {} as never,
    backendId: "all",
    rawFallbackBackendId: "codex",
    sourceKinds: ["subAgent", "subAgentReview"],
  });

  expect(mockListAgentSessions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ includeSubagents: true }));
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
