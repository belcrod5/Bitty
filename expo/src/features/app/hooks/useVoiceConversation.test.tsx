import { getVoiceControl } from "../../appControl/voiceControl";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react-native";
import { Alert, AppState, type AppStateStatus } from "react-native";
import { randomUUID } from "expo-crypto";
import { useVoiceConversation } from "./useVoiceConversation";
import type { VoiceContextStats } from "../types/appTypes";

jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "11111111-2222-4333-8444-555555555555") }));

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
  contextUsagePercent: null,
  unsummarizedMessageCount: 0,
  memoryCharacterCount: 0,
};

beforeEach(() => {
  mockSnapshot = { connected: true, generation: 1 };
  handlers.clear();
  jest.clearAllMocks();
  jest.mocked(randomUUID).mockReturnValue(operationId);
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return {
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats },
    };
    if (op === "voice.history") return { op: "voice.history.result", payload: {
      logicalConversationId: conversationId, messages: [],
    } };
    if (op === "turn.start") return {
      channel: "agent", op: "turn.accepted", operationId,
      payload: { logicalConversationId: conversationId, clientOperationId: operationId, status: "accepted",
        ...initialStats },
    };
    throw new Error(`unexpected ${op}`);
  });
});

afterEach(() => cleanup());

test("old Runner estimates cannot masquerade as measurements or hide memory stats", async () => {
  mockManager.request.mockResolvedValue({ op: "voice.open.result", payload: {
    logicalConversationId: conversationId, contextMode: "self_context_array",
    estimatedContextUsagePercent: 89, unsummarizedMessageCount: 6, memoryCharacterCount: 123,
  } });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.contextStats).toEqual({ contextUsagePercent: null,
    unsummarizedMessageCount: 6, memoryCharacterCount: 123 });
});

test("new input keeps the last measurement through acknowledgement and replaces it on completion", async () => {
  let acknowledge!: (value: unknown) => void;
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return { op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array",
      ...initialStats, contextUsagePercent: 42,
    } };
    if (op === "voice.history") return { op: "voice.history.result", payload: {
      logicalConversationId: conversationId, messages: [],
    } };
    return new Promise((resolve) => { acknowledge = resolve; });
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.contextStats?.contextUsagePercent).toBe(42));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("new input", jest.fn()); });
  void sent.catch(() => {});
  expect(result.current.contextStats?.contextUsagePercent).toBe(42);
  expect(result.current.turnStatus).toBe("sending");
  await act(async () => { acknowledge({ op: "turn.accepted", payload: {
    logicalConversationId: conversationId, clientOperationId: operationId, status: "accepted",
    ...initialStats, contextUsagePercent: 42,
  } }); });
  expect(result.current.turnStatus).toBe("accepted");
  expect(result.current.contextStats?.contextUsagePercent).toBe(42);
  await act(async () => { handlers.get("voice.turn.completed")?.({ payload: {
    logicalConversationId: conversationId, clientOperationId: operationId, text: "reply",
    ...initialStats, contextUsagePercent: 55,
  } }); await sent; });
  expect(result.current.contextStats?.contextUsagePercent).toBe(55);
});

test("loads persisted voice history through Runner", async () => {
  const request = mockManager.request.getMockImplementation();
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "voice.history"
    ? Promise.resolve({ op: "voice.history.result", payload: { logicalConversationId: conversationId,
      messages: [{ role: "user", text: "以前の発話", clientOperationId: operationId, at: "2026-09-27T03:04:05.000Z" },
        { role: "assistant", text: "以前の返答", clientOperationId: operationId }] } })
    : request?.(message));
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.refreshHistory(); });
  expect(result.current.history.map(({ text }) => text)).toEqual(["以前の発話", "以前の返答"]);
  expect(result.current.taskChecklistOverview).toBeNull();
  expect(result.current.history.map(({ at }) => at)).toEqual(["2026-09-27T03:04:05.000Z", undefined]);
});

test("uses the selected orchestrator's managed session counts", async () => {
  mockManager.request.mockImplementation(async ({ op, payload }: { op: string; payload?: { orchestratorId?: string } }) => {
    if (op !== "voice.open") throw new Error(`unexpected ${op}`);
    return { op: "voice.open.result", payload: { logicalConversationId: conversationId,
      contextMode: "self_context_array", ...initialStats,
      subagentRunningCount: payload?.orchestratorId === "other" ? 1 : 0,
      subagentTotalCount: payload?.orchestratorId === "other" ? 2 : 0 } };
  });
  let selected = "other";
  const onCompleted = jest.fn();
  const { result, rerender } = await renderHook(() =>
    useVoiceConversation(onCompleted, undefined, undefined, selected));
  await waitFor(() => expect(result.current.contextStats).toMatchObject({
    subagentRunningCount: 1, subagentTotalCount: 2,
  }));
  selected = "main";
  await rerender(undefined);
  await waitFor(() => expect(result.current.contextStats).toMatchObject({
    subagentRunningCount: 0, subagentTotalCount: 0,
  }));
});

test("an older history response cannot replace a newer one", async () => {
  const request = mockManager.request.getMockImplementation();
  const pending: ((response: unknown) => void)[] = [];
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "voice.history"
    ? new Promise((resolve) => pending.push(resolve)) : request?.(message));
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { pending.shift()?.({ op: "voice.history.result", payload: {
    logicalConversationId: conversationId, messages: [],
  } }); });
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = result.current.refreshHistory();
    second = result.current.refreshHistory();
  });
  await act(async () => {
    pending[1]({ op: "voice.history.result", payload: { logicalConversationId: conversationId,
      messages: [{ role: "user", text: "new", clientOperationId: operationId }],
      taskChecklist: { status: "present", markdown: "- [ ] new" } } });
    await second;
  });
  await act(async () => {
    pending[0]({ op: "voice.history.result", payload: { logicalConversationId: conversationId,
      messages: [{ role: "user", text: "old", clientOperationId: operationId }],
      taskChecklist: { status: "present", markdown: "- [ ] old" } } });
    await first;
  });
  expect(result.current.history[0].text).toBe("new");
  expect(result.current.taskChecklist).toEqual({ status: "present", markdown: "- [ ] new" });
});

test("main distinguishes missing and unavailable task checklists", async () => {
  const request = mockManager.request.getMockImplementation();
  let status = "missing";
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "voice.history"
    ? Promise.resolve({ op: "voice.history.result", payload: { logicalConversationId: conversationId,
      messages: [], taskChecklist: { status } } }) : request?.(message));
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.refreshHistory(); });
  expect(result.current.taskChecklist).toEqual({ status: "missing" });
  status = "unavailable";
  await act(async () => { await result.current.refreshHistory(); });
  expect(result.current.taskChecklist).toEqual({ status: "unavailable" });
});

test.each(["main", "other"])("%s completion consent uses its offered source hash and refreshes the decision", async (orchestratorId) => {
  const request = mockManager.request.getMockImplementation();
  let offered = true;
  mockManager.request.mockImplementation((message: { op: string }) => {
    if (message.op === "voice.history") return Promise.resolve({ op: "voice.history.result",
      payload: { logicalConversationId: conversationId, messages: [],
        taskChecklist: { status: "present", markdown: "- [x] 完了\n" },
        taskChecklistCompletion: offered ? { sourceHash: "a".repeat(64), version: "b".repeat(64) } : null } });
    if (message.op === "voice.task-checklist.complete.respond") {
      offered = false;
      return Promise.resolve({ op: "voice.task-checklist.complete.respond.result", payload: { accepted: true } });
    }
    return request?.(message);
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn(), undefined, undefined, orchestratorId));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.refreshHistory(); });
  expect(result.current.taskChecklistCompletion).toEqual({ sourceHash: "a".repeat(64), version: "b".repeat(64) });
  await act(async () => { await result.current.respondToChecklistCompletion("a".repeat(64), "b".repeat(64), "keep"); });
  expect(mockManager.request).toHaveBeenCalledWith({ channel: "agent",
    op: "voice.task-checklist.complete.respond", payload: { orchestratorId,
      sourceHash: "a".repeat(64), version: "b".repeat(64), decision: "keep" } });
  expect(result.current.taskChecklistCompletion).toBeNull();
});

test.each(["main", "other"])("a checklist notice reloads only the matching %s conversation", async (orchestratorId) => {
  const request = mockManager.request.getMockImplementation();
  let markdown: string | null = "- [ ] 確認";
  let overview: { status: "pending" | "unavailable" } | { status: "present"; markdown: string } = { status: "pending" };
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "voice.history"
    ? Promise.resolve({ op: "voice.history.result", payload: { logicalConversationId: conversationId,
      messages: [], taskChecklist: markdown === null ? { status: "unavailable" }
        : { status: "present", markdown }, taskChecklistOverview: overview } }) : request?.(message));
  const { result } = await renderHook(() => useVoiceConversation(jest.fn(), undefined, undefined, orchestratorId));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => { await result.current.refreshHistory(); });
  expect(result.current.taskChecklist).toEqual({ status: "present", markdown: "- [ ] 確認" });
  expect(result.current.taskChecklistOverview).toEqual({ status: "pending" });
  markdown = "- [x] 確認";
  overview = { status: "present", markdown: "- [x] 確認済み" };
  await act(async () => { handlers.get("voice.task-checklist.changed")?.({ payload: {
    orchestratorId: orchestratorId === "main" ? "other" : "main", logicalConversationId: conversationId,
  } }); });
  expect(result.current.taskChecklist).toEqual({ status: "present", markdown: "- [ ] 確認" });
  await act(async () => { handlers.get("voice.task-checklist.changed")?.({ payload: {
    orchestratorId, logicalConversationId: "another-conversation",
  } }); });
  expect(result.current.taskChecklist).toEqual({ status: "present", markdown: "- [ ] 確認" });
  await act(async () => { handlers.get("voice.task-checklist.changed")?.({ payload: {
    orchestratorId, logicalConversationId: conversationId,
  } }); });
  await waitFor(() => expect(result.current.taskChecklist).toEqual({ status: "present", markdown: "- [x] 確認" }));
  expect(result.current.taskChecklistOverview).toEqual({ status: "present", markdown: "- [x] 確認済み" });
  markdown = null;
  overview = { status: "unavailable" };
  await act(async () => { handlers.get("voice.task-checklist.changed")?.({ payload: {
    orchestratorId, logicalConversationId: conversationId,
  } }); });
  await waitFor(() => expect(result.current.taskChecklist).toEqual({ status: "unavailable" }));
  expect(result.current.taskChecklistOverview).toEqual({ status: "unavailable" });
});

test("a previous conversation's delayed checklist cannot reappear after a new voice.open", async () => {
  const nextConversationId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  let resolveOldHistory!: (response: unknown) => void;
  mockManager.request.mockImplementation(({ op }: { op: string }) => {
    if (op === "voice.open") return Promise.resolve({ op: "voice.open.result", payload: {
      logicalConversationId: mockSnapshot.generation === 1 ? conversationId : nextConversationId,
      contextMode: "self_context_array", ...initialStats,
    } });
    if (op === "voice.history") return mockSnapshot.generation === 1
      ? new Promise((resolve) => { resolveOldHistory = resolve; })
      : Promise.resolve({ op: "voice.history.result", payload: {
        logicalConversationId: nextConversationId, messages: [],
        taskChecklist: { status: "present", markdown: "new conversation" },
      } });
    throw new Error(`unexpected ${op}`);
  });
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let oldHistory!: Promise<void>;
  await act(async () => { oldHistory = result.current.refreshHistory(); });
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await waitFor(() => expect(result.current.logicalConversationId).toBe(nextConversationId));
  await act(async () => { await result.current.refreshHistory(); });
  await act(async () => {
    resolveOldHistory({ op: "voice.history.result", payload: { logicalConversationId: conversationId,
      messages: [], taskChecklist: { status: "present", markdown: "old conversation" } } });
    await oldHistory;
  });
  expect(result.current.taskChecklist).toEqual({ status: "present", markdown: "new conversation" });
});

test("shows the submitted user message before acknowledgement and streamed replies", async () => {
  const request = mockManager.request.getMockImplementation();
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "turn.start"
    ? new Promise(() => {}) : request?.(message));
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("  質問  ", jest.fn()); });
  void sent.catch(() => {});
  expect(result.current.turnStatus).toBe("sending");
  expect(result.current.history).toEqual([{ role: "user", text: "質問", clientOperationId: operationId,
    at: expect.any(String) }]);
  expect(result.current.reply).toBeNull();
  await act(async () => handlers.get("voice.turn.delta")?.({ payload: {
    logicalConversationId: conversationId, clientOperationId: operationId, delta: "返答中",
  } }));
  expect(result.current.history[0].text).toBe("質問");
  expect(result.current.reply?.text).toBe("返答中");
});

test("a history snapshot taken before sending cannot erase a completed local turn", async () => {
  const request = mockManager.request.getMockImplementation();
  let resolveHistory!: (message: unknown) => void;
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "voice.history"
    ? new Promise((resolve) => { resolveHistory = resolve; }) : request?.(message));
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let history!: Promise<void>;
  let resolveSnapshot!: (message: unknown) => void;
  let sent!: Promise<void>;
  await act(async () => {
    history = result.current.refreshHistory();
    resolveSnapshot = resolveHistory;
    sent = result.current.sendTranscript("質問", jest.fn());
  });
  await act(async () => {
    handlers.get("voice.turn.completed")?.({ payload: {
      clientOperationId: operationId, text: "返答", outputTokens: 12, completedOrdinal: 1,
    } });
    await sent;
    resolveSnapshot({ op: "voice.history.result", payload: { logicalConversationId: conversationId, messages: [] } });
    await history;
  });
  expect(result.current.history.map(({ role, text }) => ({ role, text }))).toEqual([
    { role: "user", text: "質問" }, { role: "assistant", text: "返答" },
  ]);
  expect(result.current.history[1]).toMatchObject({ outputTokens: 12, completedOrdinal: 1 });
});

test("keeps consecutive local turns and replaces each message with its persisted version once", async () => {
  const secondId = "22222222-2222-4333-8444-555555555555";
  jest.mocked(randomUUID).mockReturnValueOnce(operationId).mockReturnValueOnce(secondId);
  const request = mockManager.request.getMockImplementation();
  let messages: unknown[] = [];
  mockManager.request.mockImplementation((message: { op: string; operationId?: string }) => {
    if (message.op === "voice.history") return Promise.resolve({ op: "voice.history.result",
      payload: { logicalConversationId: conversationId, messages } });
    if (message.op === "turn.start") return Promise.resolve({ op: "turn.accepted",
      payload: { clientOperationId: message.operationId, status: "accepted" } });
    return request?.(message);
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => { first = result.current.sendTranscript("最初の質問", jest.fn()); });
  await act(async () => {
    handlers.get("voice.turn.completed")?.({ payload: { clientOperationId: operationId, text: "最初の返答" } });
    await first;
    second = result.current.sendTranscript("次の質問", jest.fn());
  });
  expect(result.current.reply).toBeNull();
  expect(result.current.history.map(({ text }) => text)).toEqual(["最初の質問", "最初の返答", "次の質問"]);
  messages = [
    { role: "user", text: "保存済みの質問", clientOperationId: operationId, at: "2026-10-15T01:02:03Z" },
    { role: "assistant", text: "最初の返答", clientOperationId: operationId },
  ];
  await act(async () => { await result.current.refreshHistory(); });
  expect(result.current.history.map(({ text }) => text)).toEqual(["保存済みの質問", "最初の返答", "次の質問"]);
  expect(result.current.history[0].at).toBe("2026-10-15T01:02:03Z");
  await act(async () => {
    handlers.get("voice.turn.completed")?.({ payload: { clientOperationId: secondId, text: "次の返答" } });
    await second;
  });
  messages = [...messages,
    { role: "user", text: "次の質問", clientOperationId: secondId },
    { role: "assistant", text: "次の返答", clientOperationId: secondId }];
  await act(async () => { await result.current.refreshHistory(); await result.current.refreshHistory(); });
  expect(result.current.history.map(({ text }) => text)).toEqual(["保存済みの質問", "最初の返答", "次の質問", "次の返答"]);
});

test("does not duplicate a completed reply when persisted history arrives before its event", async () => {
  const request = mockManager.request.getMockImplementation();
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "voice.history"
    ? Promise.resolve({ op: "voice.history.result", payload: { logicalConversationId: conversationId, messages: [
      { role: "user", text: "質問", clientOperationId: operationId },
      { role: "assistant", text: "保存済みの返答", clientOperationId: operationId },
    ] } }) : request?.(message));
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("質問", jest.fn()); });
  await act(async () => { await result.current.refreshHistory(); });
  await act(async () => {
    handlers.get("voice.turn.completed")?.({ payload: { clientOperationId: operationId, text: "保存済みの返答" } });
    await sent;
  });
  expect(result.current.history.map(({ text }) => text)).toEqual(["質問", "保存済みの返答"]);
});

test("removes an unaccepted message only after Runner explicitly rejects the send", async () => {
  const request = mockManager.request.getMockImplementation();
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "turn.start"
    ? Promise.resolve({ op: "error", payload: { code: "session_busy", message: "送信拒否" } }) : request?.(message));
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  const onAccepted = jest.fn();
  await act(async () => {
    await expect(result.current.sendTranscript("未送信", onAccepted)).rejects.toThrow("送信拒否");
  });
  expect(result.current.history).toEqual([]);
  expect(result.current.turnStatus).toBe("failed");
  expect(onAccepted).not.toHaveBeenCalled();
});

test("loads the user history when restoring a running turn without input text", async () => {
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return { op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", clientOperationId: operationId,
      status: "running", ...initialStats,
    } };
    if (op === "voice.status") return { op: "voice.status.result", payload: {
      clientOperationId: operationId, status: "running", partialText: "返答中", ...initialStats,
    } };
    if (op === "voice.history") return { op: "voice.history.result", payload: {
      logicalConversationId: conversationId,
      messages: [{ role: "user", text: "復元された質問", clientOperationId: operationId }],
    } };
    throw new Error(`unexpected ${op}`);
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.history[0]?.text).toBe("復元された質問"));
  expect(result.current.reply?.text).toBe("返答中");
  expect(result.current.turnStatus).toBe("running");
});

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
      orchestratorId: "main",
      logicalConversationId: conversationId,
      clientOperationId: operationId,
      input: { blocks: [{ type: "text", text: "こんにちは" }] },
    },
  }, { timeoutMs: 30_000 });

  await act(async () => handlers.get("voice.turn.completed")?.({
    channel: "agent", op: "voice.turn.completed",
    payload: { logicalConversationId: conversationId, clientOperationId: operationId, text: "返答",
      completedOrdinal: 2,
      contextUsagePercent: 12, unsummarizedMessageCount: 2, memoryCharacterCount: 30 },
  }));
  await sent;
  expect(settled).toBe(true);
  expect(result.current.reply).toEqual({ text: "返答", operationId, completedOrdinal: 2 });
  expect(onCompleted).toHaveBeenCalledTimes(1);
  expect(onCompleted).toHaveBeenCalledWith("返答", operationId);
  expect(result.current.contextStats).toEqual({
    contextUsagePercent: 12, unsummarizedMessageCount: 2, memoryCharacterCount: 30,
  });
});

test("holds the same operation while reset confirmation is answered", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  let starts = 0;
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return { op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats,
      ...(mockSnapshot.generation > 1 ? { clientOperationId: operationId, inputText: "境界の発話",
        status: "confirmation_required", resetConfirmation: { parentGeneration: 2, turnSeq: 12, required: false } } : {}),
    } };
    if (op === "voice.status") return { op: "error", payload: { code: "not_found" } };
    if (op === "voice.session-reset.respond") return { op: "voice.session-reset.respond.result", payload: { accepted: true } };
    if (op === "turn.start" && starts++ === 0) return { op: "turn.accepted", payload: {
      logicalConversationId: conversationId, clientOperationId: operationId,
      status: "confirmation_required", ...initialStats,
      resetConfirmation: { parentGeneration: 2, turnSeq: 12, required: false },
    } };
    if (op === "turn.start") return { op: "turn.accepted", payload: {
      logicalConversationId: conversationId, clientOperationId: operationId, status: "accepted", ...initialStats,
    } };
    throw new Error(`unexpected ${op}`);
  });
  const onAccepted = jest.fn();
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("境界の発話", onAccepted); await Promise.resolve(); });
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  expect(onAccepted).not.toHaveBeenCalled();
  mockSnapshot = { connected: true, generation: 2 };
  await act(async () => { rerender({}); await Promise.resolve(); });
  await waitFor(() => expect(mockManager.request).toHaveBeenCalledWith(expect.objectContaining({ op: "voice.status" })));
  expect(alert).toHaveBeenCalledTimes(1);
  await act(async () => { alert.mock.calls[0][2]?.[1]?.onPress?.(); });
  await waitFor(() => expect(result.current.turnStatus).toBe("accepted"));
  const startsSent = mockManager.request.mock.calls.filter(([message]) => message.op === "turn.start");
  expect(startsSent).toHaveLength(2);
  expect(startsSent[0][0]).toEqual(startsSent[1][0]);
  expect(mockManager.request).toHaveBeenCalledWith({ channel: "agent", op: "voice.session-reset.respond",
    operationId, payload: { orchestratorId: "main", logicalConversationId: conversationId,
      clientOperationId: operationId, parentGeneration: 2, turnSeq: 12, decision: "reset" } },
  { timeoutMs: 30_000 });
  expect(mockManager.request.mock.calls.filter(([message]) => message.op === "voice.session-reset.respond")).toHaveLength(1);
  expect(onAccepted).toHaveBeenCalledTimes(1);
  await act(async () => handlers.get("voice.turn.completed")?.({ payload: {
    logicalConversationId: conversationId, clientOperationId: operationId, text: "返答", ...initialStats,
  } }));
  await sent;
  alert.mockRestore();
});

test("a stale reset alert cannot send a decision after the operation settles", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return { op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats,
    } };
    if (op === "turn.start") return { op: "turn.accepted", payload: {
      logicalConversationId: conversationId, clientOperationId: operationId,
      status: "confirmation_required", ...initialStats,
      resetConfirmation: { parentGeneration: 2, turnSeq: 12, required: false },
    } };
    throw new Error(`unexpected ${op}`);
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("境界の発話", jest.fn()); await Promise.resolve(); });
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  await act(async () => handlers.get("voice.turn.completed")?.({ payload: {
    logicalConversationId: conversationId, clientOperationId: operationId, text: "別端末で完了", ...initialStats,
  } }));
  await act(async () => { alert.mock.calls[0][2]?.[1]?.onPress?.(); await sent; });
  expect(mockManager.request.mock.calls.some(([message]) => message.op === "voice.session-reset.respond")).toBe(false);
  alert.mockRestore();
});

test("streams only the matching voice reply and reconciles it with the completed text", async () => {
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("こんにちは", jest.fn()); await Promise.resolve(); });

  await act(async () => handlers.get("voice.turn.delta")?.({
    channel: "agent", op: "voice.turn.delta", operationId,
    payload: { logicalConversationId: "another-conversation", clientOperationId: operationId, delta: "wrong" },
  }));
  expect(result.current.reply).toBeNull();

  await act(async () => handlers.get("voice.turn.delta")?.({
    channel: "agent", op: "voice.turn.delta", operationId,
    payload: { logicalConversationId: conversationId, clientOperationId: operationId, delta: "ストリーム" },
  }));
  await act(async () => handlers.get("voice.turn.delta")?.({
    channel: "agent", op: "voice.turn.delta", operationId,
    payload: { logicalConversationId: conversationId, clientOperationId: operationId, delta: "表示" },
  }));
  expect(result.current.reply).toEqual({ text: "ストリーム表示", operationId });

  await act(async () => handlers.get("voice.turn.completed")?.({
    channel: "agent", op: "voice.turn.completed", operationId,
    payload: { logicalConversationId: conversationId, clientOperationId: operationId, text: "確定した返答", ...initialStats },
  }));
  await sent;
  expect(result.current.reply).toEqual({ text: "確定した返答", operationId });
});

test("stopping a voice turn interrupts the matching operation and ignores its late result", async () => {
  const request = mockManager.request.getMockImplementation();
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "voice.turn.interrupt"
    ? Promise.resolve({ op: "voice.turn.interrupt.result", payload: { status: "interrupted", code: "voice_cancelled" } })
    : request?.(message));
  const onCompleted = jest.fn();
  const { result } = await renderHook(() => useVoiceConversation(onCompleted));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("long story", jest.fn()); await Promise.resolve(); });
  expect(result.current.turnStatus).toBe("accepted");
  await act(async () => result.current.interrupt());
  await sent;
  expect(mockManager.request).toHaveBeenCalledWith({
    channel: "agent", op: "voice.turn.interrupt", operationId,
    payload: { orchestratorId: "main", logicalConversationId: conversationId, clientOperationId: operationId },
  }, { timeoutMs: 30_000 });
  await act(async () => handlers.get("voice.turn.completed")?.({
    channel: "agent", op: "voice.turn.completed",
    payload: { clientOperationId: operationId, status: "completed", text: "late reply" },
  }));
  expect(result.current.turnStatus).toBe("idle");
  expect(result.current.history.map(({ text }) => text)).toEqual(["long story"]);
  expect(result.current.reply).toBeNull();
  expect(onCompleted).not.toHaveBeenCalled();
});
test("an unknown operation remains interruptible after reopening", async () => {
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return { op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", clientOperationId: operationId,
      status: "unknown", ...initialStats,
    } };
    if (op === "voice.status") return { op: "voice.status.result", payload: {
      clientOperationId: operationId, status: "unknown", ...initialStats,
    } };
    if (op === "voice.turn.interrupt") return { op: "voice.turn.interrupt.result", payload: { status: "interrupted" } };
    throw new Error(`unexpected ${op}`);
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.turnStatus).toBe("running");
  expect(result.current.error).toBe("前の返答を確認できません。");
  await act(async () => result.current.interrupt());
  expect(mockManager.request).toHaveBeenCalledWith(expect.objectContaining({ op: "voice.turn.interrupt",
    payload: expect.objectContaining({ clientOperationId: operationId }) }), { timeoutMs: 30_000 });
  expect(mockManager.request.mock.calls.filter(([request]) => request.op === "turn.start")).toHaveLength(0);
});

test("stopping during the reset alert ignores its late answer", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const original = mockManager.request.getMockImplementation();
  mockManager.request.mockImplementation(async (message: { op: string }) => {
    if (message.op === "turn.start") return { op: "turn.accepted", payload: { clientOperationId: operationId,
      status: "confirmation_required", resetConfirmation: { parentGeneration: 0, turnSeq: 12 } } };
    if (message.op === "voice.turn.interrupt") return { op: "voice.turn.interrupt.result" };
    return original?.(message);
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("held", jest.fn()); });
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  await act(async () => result.current.interrupt());
  await sent;
  await act(async () => { alert.mock.calls[0][2]?.[1]?.onPress?.(); });
  expect(mockManager.request.mock.calls.filter(([request]) => request.op === "voice.session-reset.respond")).toHaveLength(0);
  expect(mockManager.request.mock.calls.filter(([request]) => request.op === "turn.start")).toHaveLength(1);
  expect(result.current.turnStatus).toBe("idle");
  alert.mockRestore();
});

test("reopening after an intentional voice interruption is ready for recording", async () => {
  mockManager.request.mockResolvedValue({ op: "voice.open.result", payload: {
    logicalConversationId: conversationId, contextMode: "self_context_array",
    clientOperationId: operationId, status: "interrupted", code: "voice_cancelled", ...initialStats,
  } });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.turnStatus).toBe("idle");
  expect(result.current.logicalConversationId).toBe(conversationId);
  expect(result.current.error).toBe("");
});

test("retries voice interruption once after a connection failure", async () => {
  const request = mockManager.request.getMockImplementation();
  let attempts = 0;
  mockManager.request.mockImplementation((message: { op: string }) => {
    if (message.op !== "voice.turn.interrupt") return request?.(message);
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error("runner_ws_disconnected"))
      : Promise.resolve({ op: "voice.turn.interrupt.result" });
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("long story", jest.fn()); await Promise.resolve(); });
  await act(async () => result.current.interrupt());
  await sent;
  await waitFor(() => expect(attempts).toBe(2));
  expect(mockManager.connect).toHaveBeenCalledTimes(2);
});

test("attaches the accepted voice job once and skips full-text synthesis on completion", async () => {
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return { channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats } };
    if (op === "turn.start") return { channel: "agent", op: "turn.accepted",
      payload: { clientOperationId: operationId, status: "accepted", jobId: "voice-job", ...initialStats } };
    throw new Error(`unexpected ${op}`);
  });
  const onCompleted = jest.fn();
  const onJob = jest.fn();
  const settings = { speedScale: 1.2 };
  const { result } = await renderHook(() => useVoiceConversation(onCompleted, onJob, settings));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("hello", jest.fn()); await Promise.resolve(); });
  expect(mockManager.request).toHaveBeenCalledWith(expect.objectContaining({
    op: "turn.start", payload: expect.objectContaining({ tts: settings }),
  }), { timeoutMs: 30_000 });
  expect(onJob).toHaveBeenCalledTimes(1);
  expect(onJob).toHaveBeenCalledWith("voice-job", operationId);
  await act(async () => handlers.get("voice.turn.completed")?.({ channel: "agent", op: "voice.turn.completed",
    payload: { clientOperationId: operationId, status: "completed", text: "Hello.", jobId: "voice-job", ...initialStats } }));
  await sent;
  expect(onJob).toHaveBeenCalledTimes(1);
  expect(onCompleted).not.toHaveBeenCalled();
});

test("drops the prior reply and local history when message clear rotates the conversation ID", async () => {
  const nextConversationId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "turn.start") return { op: "turn.accepted", payload: {
      clientOperationId: operationId, status: "completed", text: "old reply",
    } };
    if (op !== "voice.open") throw new Error(`unexpected ${op}`);
    return { op: "voice.open.result", payload: {
      logicalConversationId: mockSnapshot.generation === 1 ? conversationId : nextConversationId,
      contextMode: "self_context_array", ...initialStats,
      ...(mockSnapshot.generation === 1 ? { clientOperationId: operationId, status: "completed", text: "old reply" } : {}),
    } };
  });
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.reply?.text).toBe("old reply"));
  await act(async () => { await result.current.sendTranscript("old question", jest.fn()); });
  expect(result.current.history.map(({ text }) => text)).toEqual(["old question", "old reply"]);
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await waitFor(() => expect(result.current.reply).toBeNull());
  await waitFor(() => expect(result.current.logicalConversationId).toBe(nextConversationId));
  expect(result.current.turnStatus).toBe("idle");
  expect(result.current.history).toEqual([]);
});

test.each(["turn_failed", "マイクエラー"])("message clear resets the previous conversation's %s", async (message) => {
  const nextConversationId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    const logicalConversationId = mockSnapshot.generation === 1 ? conversationId : nextConversationId;
    if (op === "voice.history") return { op: "voice.history.result", payload: { logicalConversationId, messages: [] } };
    return { op: "voice.open.result", payload: {
      logicalConversationId, contextMode: "self_context_array", ...initialStats,
      ...(mockSnapshot.generation === 1 ? { clientOperationId: operationId, status: "failed", code: "turn_failed" } : {}),
    } };
  });
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  expect(result.current.turnStatus).toBe("failed");
  await act(async () => { result.current.setError(message); });
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  expect(result.current.logicalConversationId).toBe(nextConversationId);
  expect(result.current.ready).toBe(true);
  expect(result.current.turnStatus).toBe("idle");
  expect(result.current.error).toBe("");
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
  expect(result.current.history.map(({ text }) => text)).toEqual(["確定発話"]);
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await act(async () => { await sent; });

  const turnStarts = mockManager.request.mock.calls.filter(([message]) => message.op === "turn.start");
  expect(turnStarts).toHaveLength(2);
  expect(turnStarts[0][0]).toEqual(turnStarts[1][0]);
  expect(result.current.history.map(({ text }) => text)).toEqual(["確定発話", "保存済み"]);
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
        contextUsagePercent: 25, unsummarizedMessageCount: 4, memoryCharacterCount: 120 },
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
    contextUsagePercent: 25, unsummarizedMessageCount: 4, memoryCharacterCount: 120,
  });
  expect(mockManager.request.mock.calls.filter(([message]) => message.op === "turn.start")).toHaveLength(1);
});

test("recovers accumulated streaming text from voice status after reconnect", async () => {
  mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
    if (op === "voice.open") return {
      channel: "agent", op: "voice.open.result",
      payload: mockSnapshot.generation === 1
        ? { logicalConversationId: conversationId, contextMode: "self_context_array", ...initialStats }
        : { logicalConversationId: conversationId, contextMode: "self_context_array",
          clientOperationId: operationId, status: "running", partialText: "接続前再接続後", ...initialStats },
    };
    if (op === "turn.start") return { channel: "agent", op: "turn.accepted",
      payload: { logicalConversationId: conversationId, clientOperationId: operationId,
        status: "accepted", ...initialStats } };
    if (op === "voice.status") return { channel: "agent", op: "voice.status.result",
      payload: { logicalConversationId: conversationId, clientOperationId: operationId,
        status: "running", partialText: "接続前再接続後", ...initialStats } };
    throw new Error(`unexpected ${op}`);
  });
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let sent!: Promise<void>;
  await act(async () => { sent = result.current.sendTranscript("質問", jest.fn()); await Promise.resolve(); });
  await act(async () => handlers.get("voice.turn.delta")?.({
    channel: "agent", op: "voice.turn.delta", operationId,
    payload: { logicalConversationId: conversationId, clientOperationId: operationId, delta: "接続前" },
  }));

  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);

  await waitFor(() => expect(result.current.reply?.text).toBe("接続前再接続後"));
  expect(result.current.turnStatus).toBe("running");
  await act(async () => handlers.get("voice.turn.completed")?.({
    channel: "agent", op: "voice.turn.completed", operationId,
    payload: { logicalConversationId: conversationId, clientOperationId: operationId,
      text: "確定本文", ...initialStats },
  }));
  await sent;
  expect(result.current.reply?.text).toBe("確定本文");
});

test("restores the latest completed reply without automatic playback", async () => {
  mockManager.request.mockImplementation(async () => ({
    channel: "agent", op: "voice.open.result",
    payload: {
      logicalConversationId: conversationId,
      contextMode: "self_context_array",
      clientOperationId: operationId,
      status: "completed",
      text: "保存済みの返答",
      outputTokens: mockSnapshot.generation === 1 ? 24 : 25,
    },
  }));
  const onCompleted = jest.fn();
  const { result, rerender } = await renderHook(() => useVoiceConversation(onCompleted));
  await waitFor(() => expect(result.current.reply?.text).toBe("保存済みの返答"));
  expect(result.current.reply?.outputTokens).toBe(24);
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await waitFor(() => expect(result.current.reply?.outputTokens).toBe(25));
  expect(mockManager.request.mock.calls.filter(([message]) => message.op === "voice.open")).toHaveLength(2);
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
    if (op === "voice.history") return Promise.resolve({ op: "voice.history.result", payload: {
      logicalConversationId: conversationId, messages: [],
    } });
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
  expect(result.current.history.map(({ text }) => text)).toEqual(["確定発話"]);
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
      contextUsagePercent: 8, unsummarizedMessageCount: 0, memoryCharacterCount: 25 },
  }));
  await sent;
  expect(result.current.contextStats).toEqual({
    contextUsagePercent: null, unsummarizedMessageCount: 0, memoryCharacterCount: 25,
  });
  currentStats = { contextUsagePercent: 9, unsummarizedMessageCount: 0, memoryCharacterCount: 40 };
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
        contextUsagePercent: 30, unsummarizedMessageCount, memoryCharacterCount: 10 },
    }));
    const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.contextStats?.unsummarizedMessageCount).toBe(22);
    expect(mockManager.request.mock.calls.filter(([message]) => message.op === "voice.open")).toHaveLength(1);

    unsummarizedMessageCount = 20;
    await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
    expect(result.current.contextStats?.unsummarizedMessageCount).toBe(20);
    expect(mockManager.request.mock.calls.filter(([message]) => message.op === "voice.open")).toHaveLength(2);
    await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
    expect(mockManager.request.mock.calls.filter(([message]) => message.op === "voice.open")).toHaveLength(4);
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
            contextUsagePercent: 20, unsummarizedMessageCount: 22, memoryCharacterCount: 10 },
        });
      }
      return Promise.resolve({
        channel: "agent", op: "turn.accepted", operationId,
        payload: { logicalConversationId: conversationId, clientOperationId: operationId,
          status: "accepted", contextUsagePercent: 22,
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
        text: "新しい返答", contextUsagePercent: 24,
        unsummarizedMessageCount: 2, memoryCharacterCount: 50 },
    }));
    await sent;
    expect(result.current.reply?.text).toBe("新しい返答");

    await act(async () => resolveOldOpen({
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array",
        clientOperationId: "older-turn", status: "completed", text: "古い返答",
        contextUsagePercent: 90, unsummarizedMessageCount: 22, memoryCharacterCount: 1 },
    }));
    expect(result.current.reply?.text).toBe("新しい返答");
    expect(result.current.contextStats).toEqual({
      contextUsagePercent: 24, unsummarizedMessageCount: 2, memoryCharacterCount: 50,
    });
  } finally {
    cleanup();
    jest.useRealTimers();
  }
});

test("ignores an old open response after the connection generation changes", async () => {
  let resolveFirst!: (message: unknown) => void;
  let opens = 0;
  mockManager.request.mockImplementation(({ op }: { op: string }) => {
    if (op === "voice.history") return Promise.resolve({ op: "voice.history.result", payload: {
      logicalConversationId: conversationId, messages: [],
    } });
    opens += 1;
    if (opens === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return Promise.resolve({
      channel: "agent", op: "voice.open.result",
      payload: { logicalConversationId: conversationId, contextMode: "self_context_array",
        contextUsagePercent: 10, unsummarizedMessageCount: 0, memoryCharacterCount: 99 },
    });
  });
  const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
  await act(async () => { await Promise.resolve(); });
  mockSnapshot = { connected: true, generation: 2 };
  await rerender(undefined);
  await act(async () => resolveFirst({
    channel: "agent", op: "voice.open.result",
    payload: { logicalConversationId: conversationId, contextMode: "self_context_array",
      contextUsagePercent: 90, unsummarizedMessageCount: 20, memoryCharacterCount: 1 },
  }));
  await waitFor(() => expect(result.current.contextStats?.memoryCharacterCount).toBe(99));
  expect(opens).toBe(2);
  expect(result.current.contextStats?.contextUsagePercent).toBe(10);
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
  expect(mockManager.request.mock.calls.filter(([message]) => message.op === "voice.open")).toHaveLength(1);
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
      contextUsagePercent: 7, unsummarizedMessageCount: 1, memoryCharacterCount: 30,
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

test("orchestrator input captures its own trusted origin outside the transcript", async () => {
  const origin = { clientInstanceId: "device", connectionGeneration: "generation", surfaceId: "voice-screen", ownerGeneration: 4,
    target: { kind: "orchestrator" as const, orchestratorId: "main" } };
  const capture = jest.spyOn(getVoiceControl(mockManager as unknown as RunnerWebSocketManager), "origin").mockReturnValue(origin);
  try {
    const hook = await renderHook(() => useVoiceConversation(jest.fn()));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    let sending!: Promise<void>;
    await act(async () => { sending = hook.result.current.sendTranscript("相談", jest.fn()); });
    const request = mockManager.request.mock.calls.find(([message]) => message.op === "turn.start")![0] as unknown as { payload: Record<string, unknown> };
    expect(request.payload.appControlOrigin).toEqual(origin);
    expect(request.payload.input).toEqual({ blocks: [{ type: "text", text: "相談" }] });
    expect(capture).toHaveBeenCalledWith(undefined, origin.target);
    await act(async () => { handlers.get("voice.turn.completed")?.({ payload: {
      logicalConversationId: conversationId, clientOperationId: operationId, text: "reply", ...initialStats,
    } }); await sending; });
    await hook.unmount();
  } finally { capture.mockRestore(); }
});

test.each(["failed", "preflight_failed", "interrupted", "running", "completed"])(
  "loads persisted history on initial %s independently of the last turn outcome", async (status) => {
    AppState.currentState = "active";
    mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
      if (op === "voice.history") return { op: "voice.history.result", payload: {
        logicalConversationId: conversationId, messages: [
          { role: "user", text: "以前の発話", clientOperationId: "previous" },
          { role: "assistant", text: "以前の返答", clientOperationId: "previous" },
        ],
      } };
      return { op: op === "voice.open" ? "voice.open.result" : "voice.status.result", payload: {
        logicalConversationId: conversationId, contextMode: "self_context_array",
        clientOperationId: operationId, status, code: "turn_failed", text: "返答",
        inputText: "処理中の発話", ...initialStats,
      } };
    });
    const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
    await waitFor(() => expect(result.current.history.slice(0, 2).map(({ text }) => text))
      .toEqual(["以前の発話", "以前の返答"]));
    expect(result.current.ready).toBe(true);
    expect(result.current.turnStatus).toBe(status === "running" || status === "completed" ? status : "failed");
  },
);

test("a persisted failure settles the turn, refreshes history, and allows the next submission", async () => {
  const original = mockManager.request.getMockImplementation();
  let messages = [{ role: "user", text: "以前の発話", clientOperationId: "previous" }];
  mockManager.request.mockImplementation((message: { op: string }) => message.op === "voice.history"
    ? Promise.resolve({ op: "voice.history.result", payload: { logicalConversationId: conversationId, messages } })
    : original?.(message));
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.history[0]?.text).toBe("以前の発話"));
  let first!: Promise<void>;
  await act(async () => { first = result.current.sendTranscript("失敗する発話", jest.fn()); });
  messages = [...messages, { role: "user", text: "保存された発話", clientOperationId: operationId }];
  await act(async () => {
    handlers.get("voice.turn.failed")?.({ payload: {
      logicalConversationId: conversationId, clientOperationId: operationId,
      status: "failed", code: "turn_failed",
    } });
    await first;
  });
  await waitFor(() => expect(result.current.history.map(({ text }) => text))
    .toEqual(["以前の発話", "保存された発話"]));
  expect(result.current.ready).toBe(true);
  expect(result.current.turnStatus).toBe("failed");
  jest.mocked(randomUUID).mockReturnValue("22222222-3333-4444-8555-666666666666");
  let second!: Promise<void>;
  await act(async () => { second = result.current.sendTranscript("次の発話", jest.fn()); });
  void second.catch(() => {});
  expect(result.current.turnStatus).toBe("accepted");
  expect(result.current.error).toBe("");
  expect(mockManager.request.mock.calls.filter(([message]) => message.op === "turn.start")).toHaveLength(2);
});

test("polling and reconnect do not replay old failures over a new interaction", async () => {
  jest.useFakeTimers();
  try {
    let status = "failed";
    let currentOperationId = operationId;
    let historyText = "最初の失敗した発話";
    mockManager.request.mockImplementation(async ({ op }: { op: string }) => {
      if (op === "voice.history") return { op: "voice.history.result", payload: {
        logicalConversationId: conversationId,
        messages: [{ role: "user", text: historyText, clientOperationId: currentOperationId }],
      } };
      return { op: "voice.open.result", payload: {
        logicalConversationId: conversationId, contextMode: "self_context_array",
        clientOperationId: currentOperationId, status, code: "turn_failed", text: "外部送信の返答", ...initialStats,
      } };
    });
    const { result, rerender } = await renderHook(() => useVoiceConversation(jest.fn()));
    expect(result.current.error).toBe("turn_failed");
    await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
    expect(result.current.error).toBe("turn_failed");
    await act(async () => { result.current.setError(""); await jest.advanceTimersByTimeAsync(15000); });
    expect(result.current.error).toBe("");
    await act(async () => { result.current.setError("新しいマイクエラー"); });
    mockSnapshot = { connected: true, generation: 2 };
    await rerender(undefined);
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBe("新しいマイクエラー");
    currentOperationId = "22222222-3333-4444-8555-666666666666";
    historyText = "外部送信で再び失敗した発話";
    await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
    expect(result.current.turnStatus).toBe("failed");
    expect(result.current.history[0]?.text).toBe("外部送信で再び失敗した発話");
    expect(result.current.error).toBe("turn_failed");
    currentOperationId = "33333333-4444-4555-8666-777777777777";
    status = "completed";
    await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
    expect(result.current.reply?.text).toBe("外部送信の返答");
    expect(result.current.turnStatus).toBe("completed");
    expect(result.current.error).toBe("");
    await act(async () => { result.current.setError("別のマイクエラー"); await jest.advanceTimersByTimeAsync(15000); });
    expect(result.current.error).toBe("別のマイクエラー");
  } finally {
    cleanup();
    jest.useRealTimers();
  }
});

test("foreground refreshes history after a failed turn without a new submission", async () => {
  let foreground!: (state: AppStateStatus) => void;
  jest.mocked(AppState.addEventListener).mockImplementation((_event, callback) => {
    foreground = callback;
    return { remove: jest.fn() };
  });
  const original = mockManager.request.getMockImplementation();
  let text = "復帰前の履歴";
  mockManager.request.mockImplementation((message: { op: string }) => {
    if (message.op === "voice.history") return Promise.resolve({ op: "voice.history.result", payload: {
      logicalConversationId: conversationId,
      messages: [{ role: "user", text, clientOperationId: operationId }],
    } });
    if (message.op === "voice.open") return Promise.resolve({ op: "voice.open.result", payload: {
      logicalConversationId: conversationId, contextMode: "self_context_array", clientOperationId: operationId,
      status: "failed", code: "turn_failed", ...initialStats,
    } });
    return original?.(message);
  });
  const { result } = await renderHook(() => useVoiceConversation(jest.fn()));
  await waitFor(() => expect(result.current.history[0]?.text).toBe("復帰前の履歴"));
  text = "復帰後の履歴";
  await act(async () => { foreground("active"); });
  expect(result.current.history[0]?.text).toBe("復帰後の履歴");
  expect(result.current.turnStatus).toBe("failed");
  expect(mockManager.request.mock.calls.filter(([message]) => message.op === "turn.start")).toHaveLength(0);
});
