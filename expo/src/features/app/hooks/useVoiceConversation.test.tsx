import { act, cleanup, renderHook, waitFor } from "@testing-library/react-native";
import { useVoiceConversation } from "./useVoiceConversation";
import type { VoiceContextStats } from "../types/appTypes";

jest.mock("expo-crypto", () => ({ randomUUID: () => "11111111-2222-4333-8444-555555555555" }));

let mockSnapshot = { connected: true, generation: 1 };
const handlers = new Map<string, (message: unknown) => void>();
const mockManager = {
  connect: jest.fn(async () => undefined),
  getSnapshot: jest.fn(() => mockSnapshot),
  request: jest.fn(),
  subscribe: jest.fn(({ op }: { op: string }, handler: (message: unknown) => void) => {
    handlers.set(op, handler);
    return () => handlers.delete(op);
  }),
};

jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => mockManager,
  useRunnerWebSocketSnapshot: () => mockSnapshot,
}));

const conversationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const operationId = "11111111-2222-4333-8444-555555555555";
const initialStats = {
  estimatedContextUsagePercent: null,
  unsummarizedMessageCount: 0,
  memoryCharacterCount: 0,
};

beforeEach(() => {
  mockSnapshot = { connected: true, generation: 1 };
  handlers.clear();
  jest.clearAllMocks();
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return {
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats },
    };
    if (op === "turn.start") return {
      channel: "agent", op: "turn.accepted", operationId,
      payload: { logicalConversationId: conversationId, clientOperationId: operationId, status: "accepted",
        ...initialStats },
    };
    throw new Error(`unexpected ${op}`);
  });
});

afterEach(() => cleanup());

test("sends one final text block and reads aloud only after a completed turn", async () => {
  const onCompleted = jest.fn();
  const onAccepted = jest.fn();
  const { result } = await renderHook(() => useVoiceConversation(onCompleted));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.contextStats).toEqual(initialStats);

  let sent!: Promise<void>;
  await act(async () => {
    sent = result.current.sendTranscript("  こんにちは  ", onAccepted);
    await Promise.resolve();
  });
  expect(onAccepted).toHaveBeenCalledTimes(1);
  expect(result.current.turnStatus).toBe("accepted");
  let settled = false;
  void sent.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mockManager.request).toHaveBeenCalledWith({
    channel: "agent",
    op: "turn.start",
    operationId,
    payload: {
      backendId: "codex",
      logicalConversationId: conversationId,
      clientOperationId: operationId,
      input: { blocks: [{ type: "text", text: "こんにちは" }] },
    },
  }, { timeoutMs: 30_000 });

  await act(async () => handlers.get("voice.turn.completed")?.({
    channel: "agent", op: "voice.turn.completed",
    payload: { logicalConversationId: conversationId, clientOperationId: operationId, text: "返答",
      estimatedContextUsagePercent: 12, unsummarizedMessageCount: 2, memoryCharacterCount: 30 },
  }));
  await sent;
  expect(settled).toBe(true);
  expect(result.current.reply).toEqual({ text: "返答", operationId });
  expect(onCompleted).toHaveBeenCalledTimes(1);
  expect(onCompleted).toHaveBeenCalledWith("返答", operationId);
  expect(result.current.contextStats).toEqual({
    estimatedContextUsagePercent: 12, unsummarizedMessageCount: 2, memoryCharacterCount: 30,
  });
});

test("drops the prior reply when message clear rotates the conversation ID", async () => {
  const nextConversationId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op !== "voice.open") throw new Error(`unexpected ${op}`);
    return { op: "voice.open.result", payload: {
      logicalConversationId: mockSnapshot.generation === 1 ? conversationId : nextConversationId,
      contextMode: "self_context_array", ...initialStats,
      ...(mockSnapshot.generation === 1 ? { clientOperationId: operationId, status: "completed", text: "old reply" } : {}),
    } };
  });
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.reply?.text).toBe("old reply"));
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await waitFor(() => expect(result.current.reply).toBeNull());
  expect(result.current.turnStatus).toBe("idle");
});

test("checks status and resends the same operation only after not_found", async () => {
  let starts = 0;
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return {
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array" },
    };
    if (op === "turn.start") {
      starts += 1;
      if (starts === 1) throw new Error("runner_ws_disconnected");
      return { channel: "agent", op: "turn.accepted",
        payload: { clientOperationId: operationId, status: "completed", text: "保存済み" } };
    }
    if (op === "voice.status") return { channel: "agent", op: "error", payload: { code: "not_found" } };
    throw new Error(`unexpected ${op}`);
  });
  const onAccepted = jest.fn();
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));

  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("確定発話", onAccepted); await Promise.resolve(); });
  await waitFor(() => expect(result.current.turnStatus).toBe("sending"));
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await act(async () => { await sent; });

  const turnStarts = mockManager.request.mock.calls.filter(([message]) => message.op === "turn.start");
  expect(turnStarts).toHaveLength(2);
  expect(turnStarts[0][0]).toEqual(turnStarts[1][0]);
  expect(onAccepted).toHaveBeenCalledTimes(1);
});

test("recovers a completed turn after reconnect without regenerating it", async () => {
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return {
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array" },
    };
    if (op === "turn.start") throw new Error("runner_ws_disconnected");
    if (op === "voice.status") return {
      channel: "agent", op: "voice.status.result",
      payload: { logicalConversationId: conversationId, clientOperationId: operationId,
        status: "completed", text: "回収した返答",
        estimatedContextUsagePercent: 25, unsummarizedMessageCount: 4, memoryCharacterCount: 120 },
    };
    throw new Error(`unexpected ${op}`);
  });
  const onCompleted = jest.fn();
  const onAccepted = jest.fn();
  const { result, rerender } = await renderHook(() => useVoiceConversation(onCompleted));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("確定発話", onAccepted); await Promise.resolve(); });
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await act(async () => { await sent; });
  expect(result.current.reply?.text).toBe("回収した返答");
  expect(onAccepted).toHaveBeenCalledTimes(1);
  expect(onCompleted).toHaveBeenCalledTimes(1);
  expect(result.current.contextStats).toEqual({
    estimatedContextUsagePercent: 25, unsummarizedMessageCount: 4, memoryCharacterCount: 120,
  });
  expect(mockManager.request.mock.calls.filter(([message]) => message.op === "turn.start")).toHaveLength(1);
});

test("restores the latest completed reply without automatic playback", async () => {
  mockManager.request.mockResolvedValue({
    channel: "agent", op: "voice.open.result",
    payload: {
      logicalConversationId: conversationId,
      contextMode: "self_context_array",
      clientOperationId: operationId,
      status: "completed",
      text: "保存済みの返答",
    },
  });
  const onCompleted = jest.fn();
  const { result } = await renderHook(() => useVoiceConversation(onCompleted));
  await waitFor(() => expect(result.current.reply?.text).toBe("保存済みの返答"));
  expect(onCompleted).not.toHaveBeenCalled();
});

test("uses a saved completed result returned by a duplicate turn.start", async () => {
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return {
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array" },
    };
    return {
      channel: "agent", op: "turn.accepted",
      payload: { logicalConversationId: conversationId, clientOperationId: operationId, status: "completed", text: "保存済み" },
    };
  });
  const onCompleted = jest.fn();
  const onAccepted = jest.fn();
  const { result } = await renderHook(() => useVoiceConversation(onCompleted));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.sendTranscript("確定発話", onAccepted); });
  expect(result.current.reply?.text).toBe("保存済み");
  expect(onAccepted).toHaveBeenCalledTimes(1);
  expect(onCompleted).toHaveBeenCalledWith("保存済み", operationId);
});

test("a persisted failure arriving before turn.accepted still acknowledges STT", async () => {
  let resolveStart!: (message: unknown) => void;
  mockManager.request.mockImplementation(({ op }: { op: string }) => {
    if (op === "voice.open") return Promise.resolve({
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array" },
    });
    return new Promise((resolve) => { resolveStart = resolve; });
  });
  const onAccepted = jest.fn();
  const onCompleted = jest.fn();
  const { result } = await renderHook(() => useVoiceConversation(onCompleted));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("確定発話", onAccepted); await Promise.resolve(); });
  await act(async () => handlers.get("voice.turn.failed")?.({
    channel: "agent", op: "voice.turn.failed",
    payload: { logicalConversationId: conversationId, clientOperationId: operationId,
      status: "preflight_failed", code: "summary_failed" },
  }));
  await sent;
  expect(onAccepted).toHaveBeenCalledTimes(1);
  expect(result.current.turnStatus).toBe("failed");
  expect(onCompleted).not.toHaveBeenCalled();
  resolveStart({ channel: "agent", op: "turn.accepted", payload: { clientOperationId: operationId } });
  await waitFor(() => expect(result.current.turnStatus).toBe("failed"));
});

test("updates voice-only stats on failure and reconnect", async () => {
  let currentStats: VoiceContextStats = initialStats;
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return {
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array",
        ...currentStats },
    };
    return {
      channel: "agent", op: "turn.accepted",
      payload: { logicalConversationId: conversationId, clientOperationId: operationId,
        status: "accepted", ...currentStats },
    };
  });
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.contextStats).toEqual(initialStats));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("確定発話", jest.fn()); await Promise.resolve(); });
  await act(async () => handlers.get("voice.turn.failed")?.({
    channel: "agent", op: "voice.turn.failed",
    payload: { logicalConversationId: conversationId, clientOperationId: operationId,
      status: "failed", code: "model_failed",
      estimatedContextUsagePercent: 8, unsummarizedMessageCount: 0, memoryCharacterCount: 25 },
  }));
  await sent;
  expect(result.current.contextStats).toEqual({
    estimatedContextUsagePercent: 8, unsummarizedMessageCount: 0, memoryCharacterCount: 25,
  });
  currentStats = { estimatedContextUsagePercent: 9, unsummarizedMessageCount: 0, memoryCharacterCount: 40 };
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await waitFor(() => expect(result.current.contextStats).toEqual(currentStats));
});

test("refreshes a pending summary and keeps checking for a conversation reset", async () => {
  jest.useFakeTimers();
  try {
    let unsummarizedMessageCount = 22;
    mockManager.request.mockImplementation(async () => ({
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array",
        estimatedContextUsagePercent: 30, unsummarizedMessageCount, memoryCharacterCount: 10 },
    }));
    const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.contextStats?.unsummarizedMessageCount).toBe(22);
    expect(mockManager.request).toHaveBeenCalledTimes(1);

    unsummarizedMessageCount = 20;
    await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
    expect(result.current.contextStats?.unsummarizedMessageCount).toBe(20);
    expect(mockManager.request).toHaveBeenCalledTimes(2);
    await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
    expect(mockManager.request).toHaveBeenCalledTimes(4);
  } finally {
    cleanup();
    jest.useRealTimers();
  }
});

test("does not overwrite a newer completed turn with an older idle open response", async () => {
  jest.useFakeTimers();
  try {
    let resolveOldOpen!: (message: unknown) => void;
    let opens = 0;
    mockManager.request.mockImplementation(({ op }: { op: string }) => {
      if (op === "voice.open") {
        opens += 1;
        if (opens === 2) return new Promise((resolve) => { resolveOldOpen = resolve; });
        return Promise.resolve({
          channel: "agent", op: "voice.open.result",
          payload: { logicalConversationId: conversationId, contextMode: "self_context_array",
            estimatedContextUsagePercent: 20, unsummarizedMessageCount: 22, memoryCharacterCount: 10 },
        });
      }
      return Promise.resolve({
        channel: "agent", op: "turn.accepted", operationId,
        payload: { logicalConversationId: conversationId, clientOperationId: operationId,
          status: "accepted", estimatedContextUsagePercent: 22,
          unsummarizedMessageCount: 22, memoryCharacterCount: 10 },
      });
    });
    const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
    expect(opens).toBe(2);

    let sent!: Promise<void>;
    await act(async () => {
      sent = result.current.sendTranscript("新しい発話", jest.fn());
      await Promise.resolve();
    });
    await act(async () => handlers.get("voice.turn.completed")?.({
      channel: "agent", op: "voice.turn.completed",
      payload: { logicalConversationId: conversationId, clientOperationId: operationId,
        text: "新しい返答", estimatedContextUsagePercent: 24,
        unsummarizedMessageCount: 2, memoryCharacterCount: 50 },
    }));
    await sent;
    expect(result.current.reply?.text).toBe("新しい返答");

    await act(async () => resolveOldOpen({
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array",
        clientOperationId: "older-turn", status: "completed", text: "古い返答",
        estimatedContextUsagePercent: 90, unsummarizedMessageCount: 22, memoryCharacterCount: 1 },
    }));
    expect(result.current.reply?.text).toBe("新しい返答");
    expect(result.current.contextStats).toEqual({
      estimatedContextUsagePercent: 24, unsummarizedMessageCount: 2, memoryCharacterCount: 50,
    });
  } finally {
    cleanup();
    jest.useRealTimers();
  }
});

test("ignores an old open response after the connection generation changes", async () => {
  let resolveFirst!: (message: unknown) => void;
  let opens = 0;
  mockManager.request.mockImplementation(() => {
    opens += 1;
    if (opens === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return Promise.resolve({
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array",
        estimatedContextUsagePercent: 10, unsummarizedMessageCount: 0, memoryCharacterCount: 99 },
    });
  });
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  await act(async () => { await Promise.resolve(); });
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await act(async () => resolveFirst({
    channel: "agent", op: "voice.open.result",
    payload: { logicalConversationId: conversationId, contextMode: "self_context_array",
      estimatedContextUsagePercent: 90, unsummarizedMessageCount: 20, memoryCharacterCount: 1 },
  }));
  await waitFor(() => expect(result.current.contextStats?.memoryCharacterCount).toBe(99));
  expect(opens).toBe(2);
  expect(result.current.contextStats?.estimatedContextUsagePercent).toBe(10);
});

test("does not update state or retry after unmounting with an open request in flight", async () => {
  let resolveOpen!: (message: unknown) => void;
  mockManager.request.mockImplementation(() => new Promise((resolve) => { resolveOpen = resolve; }));
  const { unmount } = await renderHook(() => useVoiceConversation(jest.fn()));
  await act(async () => { await Promise.resolve(); });
  await unmount();
  await act(async () => resolveOpen({
    channel: "agent", op: "voice.open.result",
    payload: { logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats },
  }));
  expect(mockManager.request).toHaveBeenCalledTimes(1);
  expect(handlers.size).toBe(0);
});

test("reopening a running turn waits for status before enabling recording", async () => {
  let resolveStatus!: (message: unknown) => void;
  mockManager.request.mockImplementation(({ op }: { op: string }) => {
    if (op === "voice.open") return Promise.resolve({ op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", clientOperationId: operationId,
      status: "running", ...initialStats,
    } });
    if (op === "voice.status") return new Promise((resolve) => { resolveStatus = resolve; });
    throw new Error(`unexpected ${op}`);
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(mockManager.request.mock.calls.some(([message]) => message.op === "voice.status")).toBe(true));
  expect(result.current.ready).toBe(false);
  expect(result.current.turnStatus).toBe("sending");
  await act(async () => resolveStatus({ op: "voice.status.result", payload: {
    logicalConversationId: conversationId, clientOperationId: operationId, status: "running", ...initialStats,
  } }));
  expect(result.current.ready).toBe(true);
  expect(result.current.turnStatus).toBe("running");
});

test("failed status lookup on reopen keeps recording disabled and retries", async () => {
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return { op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", clientOperationId: operationId,
      status: "accepted", ...initialStats,
    } };
    if (op === "voice.status") throw new Error("status unavailable");
    throw new Error(`unexpected ${op}`);
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.error).toBe("status unavailable"));
  expect(result.current.ready).toBe(false);
  expect(result.current.turnStatus).toBe("sending");
});

test("retries a failed initial open while the socket remains connected", async () => {
  jest.useFakeTimers();
  try {
    let opens = 0;
    mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
      if (op !== "voice.open") throw new Error(`unexpected ${op}`);
      opens += 1;
      if (opens === 1) throw new Error("open unavailable");
      return { op: "voice.open.result", payload: {
        logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats,
      } };
    });
    const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.ready).toBe(false);
    expect(result.current.error).toBe("open unavailable");
    expect(opens).toBe(1);

    await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBe("");
    expect(result.current.contextStats).toEqual(initialStats);
    expect(opens).toBe(2);
    await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
    expect(opens).toBe(4);
  } finally {
    cleanup();
    jest.useRealTimers();
  }
});

test.each(["response", "rejection"])("a completed turn during reopen status %s still validates the session", async (outcome) => {
  let finishStatus!: () => void;
  mockManager.request.mockImplementation(({ op }: { op: string }) => {
    if (op === "voice.open") return Promise.resolve({ op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", clientOperationId: operationId,
      status: "running", ...initialStats,
    } });
    if (op === "voice.status") return new Promise((resolve, reject) => {
      finishStatus = () => outcome === "response"
        ? resolve({ op: "voice.status.result", payload: {
          logicalConversationId: conversationId, clientOperationId: operationId, status: "running", ...initialStats,
        } })
        : reject(new Error("status unavailable"));
    });
    throw new Error(`unexpected ${op}`);
  });
  const onCompleted = jest.fn();
  const { result } = await renderHook(() => useVoiceConversation(onCompleted));
  await waitFor(() => expect(mockManager.request.mock.calls.some(([message]) => message.op === "voice.status")).toBe(true));
  expect(result.current.ready).toBe(false);
  await act(async () => handlers.get("voice.turn.completed")?.({
    channel: "agent", op: "voice.turn.completed", payload: {
      logicalConversationId: conversationId, clientOperationId: operationId, text: "再接続中の返答",
      estimatedContextUsagePercent: 7, unsummarizedMessageCount: 1, memoryCharacterCount: 30,
    },
  }));
  await act(async () => finishStatus());
  expect(result.current.ready).toBe(true);
  expect(result.current.turnStatus).toBe("completed");
  expect(result.current.reply?.text).toBe("再接続中の返答");
  expect(result.current.contextStats?.memoryCharacterCount).toBe(30);
  expect(result.current.error).toBe("");
  expect(onCompleted).not.toHaveBeenCalled();
});

test("voice approval is answered through the existing approval callback", async () => {
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return { op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats,
    } };
    if (op === "turn.start") return { op: "turn.accepted", payload: { clientOperationId: operationId, status: "accepted" } };
    if (op === "voice.approval.decision") return { op: "voice.approval.decision.result", payload: { requestId: "approval-1" } };
    throw new Error(`unexpected ${op}`);
  });
  const onApprovalRequest = jest.fn(async () => "approve_once" as const);
  const onApprovalResolved = jest.fn();
  const { result } = await renderHook(() => useVoiceConversation(jest.fn(), onApprovalRequest, onApprovalResolved));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { void result.current.sendTranscript("run", jest.fn()).catch(() => undefined); await Promise.resolve(); });
  await act(async () => handlers.get("voice.approval.request")?.({
    channel: "agent", op: "voice.approval.request", operationId,
    payload: { requestId: "approval-1", method: "item/commandExecution/requestApproval",
      threadId: "thread", turnId: "turn", params: { command: "echo", args: ["hello"] } },
  }));
  await waitFor(() => expect(onApprovalResolved).toHaveBeenCalledTimes(1));
  expect(onApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
    command: "echo", requestId: "approval-1", threadId: "thread",
  }));
  expect(mockManager.request).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.approval.decision", operationId, payload: { requestId: "approval-1", decision: "accept" },
  }), { timeoutMs: 30_000 });
});

test("closing the voice screen cancels a pending approval", async () => {
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return { op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats,
    } };
    if (op === "turn.start") return { op: "turn.accepted", payload: { clientOperationId: operationId, status: "accepted" } };
    if (op === "voice.approval.decision") return { op: "voice.approval.decision.result" };
    throw new Error(`unexpected ${op}`);
  });
  const onApprovalRequest = jest.fn(() => new Promise<"approve_once">(() => undefined));
  const onApprovalResolved = jest.fn();
  const { result, unmount } = await renderHook(() => useVoiceConversation(jest.fn(), onApprovalRequest, onApprovalResolved));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { void result.current.sendTranscript("run", jest.fn()).catch(() => undefined); await Promise.resolve(); });
  await act(async () => handlers.get("voice.approval.request")?.({
    channel: "agent", op: "voice.approval.request", operationId,
    payload: { requestId: "approval-close", method: "item/commandExecution/requestApproval",
      threadId: "thread", turnId: "turn", params: { command: "echo" } },
  }));
  await waitFor(() => expect(onApprovalRequest).toHaveBeenCalledTimes(1));
  await unmount();
  expect(onApprovalResolved).toHaveBeenCalledTimes(1);
  expect(mockManager.request).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.approval.decision", operationId,
    payload: { requestId: "approval-close", decision: "cancel" },
  }));
});
