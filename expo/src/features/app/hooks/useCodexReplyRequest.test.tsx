import { act, renderHook } from "@testing-library/react-native";
import { useCodexReplyRequest } from "./useCodexReplyRequest";
import { codexItemMessageId } from "../utils/codexItemMessageId";
import {
  deriveCodexSessionStateFromSnapshot,
  startCodexAppServerTurn,
} from "../../codex/codexAppServerClient";

jest.mock("../../codex/codexAppServerClient", () => ({
  deriveCodexSessionStateFromSnapshot: jest.fn(() => null),
  isCodexAppServerTurnInterruptedError: (error: unknown) => Boolean(
    error && typeof error === "object" && (error as { isInterrupted?: boolean }).isInterrupted
  ),
  startCodexAppServerTurn: jest.fn(),
}));

const mockStartCodexAppServerTurn = jest.mocked(startCodexAppServerTurn);

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  llmStatus?: string;
  llmStatusDetail?: string;
  youtubeVideoIds?: string[];
};

type WriteCall = {
  messages: StoredMessage[];
  options?: Record<string, unknown>;
};

function createHarness() {
  const store: Record<string, StoredMessage[]> = {};
  const sessionStore: Record<string, StoredMessage[]> = {};
  const writeCalls: WriteCall[] = [];
  let capturedTurnOptions: any = null;
  let resolveTurn: (result: unknown) => void = () => {};
  let rejectTurn: (error: unknown) => void = () => {};

  mockStartCodexAppServerTurn.mockImplementation(((turnOptions: any) => {
    capturedTurnOptions = turnOptions;
    const promise = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    return { promise, interrupt: jest.fn() };
  }) as any);

  let nextMessageSeq = 0;
  const options = {
    transcript: "",
    codexWsUrl: "ws://127.0.0.1:8788/runner-ws",
    codexWsToken: "",
    modelRef: "",
    reasoningEffort: "medium",
    codexApprovalPolicy: "never",
    autoSpeakAfterReply: false,
    conversationMessagesRef: { current: [] },
    replyLoadingRef: { current: false },
    streamSocketRef: { current: null },
    streamAudioWaveformBarsRef: { current: [] },
    streamTtsSuppressedRef: { current: false },
    llmRequestStartedAtRef: { current: 0 },
    setTranscript: jest.fn(),
    setReply: jest.fn(),
    setReplyLoadingWithRef: jest.fn(),
    setError: jest.fn(),
    setReplyDebug: jest.fn(),
    setStreamMode: jest.fn(),
    setStreamLlmNativeDeltaCount: jest.fn(),
    setStreamLlmPseudoDeltaCount: jest.fn(),
    setStreamFirstNativeDeltaOffsetMs: jest.fn(),
    resetStreamLlmDeltas: jest.fn(),
    resetStreamLlmProgress: jest.fn(),
    resetStreamSegments: jest.fn(),
    setStreamWaveformPreview: jest.fn(),
    setTtsPlaybackMessageIdWithRef: jest.fn(),
    setStreamReplyYouTubeVideoIdsWithRef: jest.fn(),
    clearStreamAudioQueue: jest.fn(),
    runSlashCommand: jest.fn(async () => false),
    prepareChatForOutgoingMessageWindow: jest.fn(),
    setConversationMessagesWithLimit: (messages: StoredMessage[]) => messages,
    buildConversationMessage: (
      role: "user" | "assistant",
      content: string,
      extra: Record<string, unknown> = {}
    ): StoredMessage => {
      nextMessageSeq += 1;
      return {
        id: String(extra.id || `msg-${nextMessageSeq}`),
        role,
        content,
        ...extra,
      } as StoredMessage;
    },
    setHistory: jest.fn(),
    createHistoryEntry: jest.fn(),
    getPanelConversationMessages: (panelId: string) => store[panelId] || [],
    getSessionConversationMessages: (sessionId: string) => sessionStore[sessionId] || [],
    setPanelConversationMessages: (
      panelId: string,
      messages: StoredMessage[],
      writeOptions?: Record<string, unknown>
    ) => {
      store[panelId] = messages;
      const sessionId = String(writeOptions?.sessionId || "").trim();
      if (sessionId) sessionStore[sessionId] = messages;
      writeCalls.push({ messages, options: writeOptions });
    },
    normalizedLlmDirectoryForRequest: () => "",
    syncLlmConversationSessionId: jest.fn(() => false),
    handleApprovalRequest: jest.fn(() => "approve_once"),
    setSelectedThreadStatusType: jest.fn(),
    appendLlmDelta: jest.fn(),
    applyAssistantReply: (raw: string) => raw,
    updateLlmStatus: jest.fn(),
    startLlmRequest: jest.fn(),
    finishLlmRequest: jest.fn(),
    parseContextUsageUsedPct: () => 42,
    fetchRunnerSessionContextUsedPct: jest.fn(async () => null),
    extractYouTubeVideoIds: (text: string) => (
      Array.from(String(text || "").matchAll(/yt:(\w+)/g)).map((match) => match[1])
    ),
    stripYouTubeTags: (text: string) => text,
    fetchYouTubeVideoMetadata: jest.fn(async () => {}),
    synthesizeSpeechStream: jest.fn(async () => {}),
    playUiSfx: jest.fn(),
    logAuto: jest.fn(),
    logSessionDiag: jest.fn(),
    uploadCodexWsPreflightLog: jest.fn(async () => "ok"),
    trimForInline: (value: string) => value,
    reportError: jest.fn(),
    onSessionStreamBoundary: jest.fn(),
  };

  return {
    options,
    store,
    sessionStore,
    writeCalls,
    getTurnOptions: () => capturedTurnOptions,
    resolveTurn: (result: unknown) => resolveTurn(result),
    rejectTurn: (error: unknown) => rejectTurn(error),
    panelMessages: (panelId: string) => store[panelId] || [],
    assistantMessageByItemId: (panelId: string, itemId: string) => (
      (store[panelId] || []).find((message) => (
        message.role === "assistant" && message.id.endsWith(`-${itemId}`)
      ))
    ),
  };
}

async function startRequest(
  harness: ReturnType<typeof createHarness>,
  sessionSnapshot?: { sessionId?: string; threadId?: string }
) {
  const { result } = await renderHook(() => useCodexReplyRequest(harness.options as any));
  let sendPromise: Promise<unknown> = Promise.resolve();
  await act(async () => {
    sendPromise = result.current.sendReplyRequest("hello", { panelId: "panel-1", sessionSnapshot });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(harness.getTurnOptions()).not.toBeNull();
  return { result, sendPromise };
}

function ref<T>(current: T) {
  return { current };
}

type PanelWriteCall = {
  panelId: string;
  messages: Array<{ id: string; role: string; content: string }>;
  options?: {
    isResponding?: boolean;
    clearRespondingRequestStartedAtMs?: number | null;
  };
};

function createOptions() {
  const panelWrites: PanelWriteCall[] = [];
  let messageSeq = 0;
  const options = {
    transcript: "",
    codexWsUrl: "ws://127.0.0.1:8788/codex",
    codexWsToken: "",
    modelRef: "gpt-5",
    reasoningEffort: "medium" as const,
    codexApprovalPolicy: "untrusted" as never,
    autoSpeakAfterReply: false,
    conversationMessagesRef: ref<never[]>([]),
    replyLoadingRef: ref(false),
    streamSocketRef: ref<WebSocket | null>(null),
    streamAudioWaveformBarsRef: ref<number[][]>([]),
    streamTtsSuppressedRef: ref(false),
    llmRequestStartedAtRef: ref(0),
    setTranscript: jest.fn(),
    setReply: jest.fn(),
    setReplyLoadingWithRef: jest.fn(),
    setError: jest.fn(),
    setReplyDebug: jest.fn(),
    setStreamMode: jest.fn(),
    setStreamLlmNativeDeltaCount: jest.fn(),
    setStreamLlmPseudoDeltaCount: jest.fn(),
    setStreamFirstNativeDeltaOffsetMs: jest.fn(),
    resetStreamLlmDeltas: jest.fn(),
    resetStreamLlmProgress: jest.fn(),
    resetStreamSegments: jest.fn(),
    setStreamWaveformPreview: jest.fn(),
    setTtsPlaybackMessageIdWithRef: jest.fn(),
    setStreamReplyYouTubeVideoIdsWithRef: jest.fn(),
    clearStreamAudioQueue: jest.fn(),
    runSlashCommand: jest.fn(async () => false),
    prepareChatForOutgoingMessageWindow: jest.fn(),
    setConversationMessagesWithLimit: jest.fn((messages: never[]) => messages),
    buildConversationMessage: jest.fn((role: "user" | "assistant", content: string, extra?: Record<string, unknown>) => {
      messageSeq += 1;
      return {
        id: String(extra?.id || `${role}-${messageSeq}`),
        role,
        content,
        ...extra,
      };
    }),
    setHistory: jest.fn(),
    createHistoryEntry: jest.fn((params: { transcript: string; reply: string }) => params),
    getPanelConversationMessages: jest.fn(() => (
      panelWrites.length > 0 ? panelWrites[panelWrites.length - 1].messages : []
    )),
    setPanelConversationMessages: jest.fn((panelId: string, messages: PanelWriteCall["messages"], writeOptions?: PanelWriteCall["options"]) => {
      panelWrites.push({ panelId, messages, options: writeOptions });
    }),
    normalizedLlmDirectoryForRequest: jest.fn(() => ""),
    syncLlmConversationSessionId: jest.fn(() => false),
    handleApprovalRequest: jest.fn(),
    setSelectedThreadStatusType: jest.fn(),
    appendLlmDelta: jest.fn(),
    applyAssistantReply: jest.fn((raw: string) => raw),
    updateLlmStatus: jest.fn(),
    startLlmRequest: jest.fn(),
    finishLlmRequest: jest.fn(),
    parseContextUsageUsedPct: jest.fn(() => null),
    fetchRunnerSessionContextUsedPct: jest.fn(async () => null),
    extractYouTubeVideoIds: jest.fn(() => []),
    stripYouTubeTags: jest.fn((text: string) => text),
    fetchYouTubeVideoMetadata: jest.fn(async () => {}),
    synthesizeSpeechStream: jest.fn(async () => {}),
    playUiSfx: jest.fn(),
    logAuto: jest.fn(),
    logSessionDiag: jest.fn(),
    uploadCodexWsPreflightLog: jest.fn(async () => "ok"),
    trimForInline: jest.fn((value: string) => value),
    reportError: jest.fn(),
  };
  return { options, panelWrites };
}

function isFinallyWrite(call: PanelWriteCall) {
  return Number.isFinite(Number(call.options?.clearRespondingRequestStartedAtMs));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStartCodexAppServerTurn.mockReset();
});

describe("useCodexReplyRequest onAgentMessageCompleted", () => {
  test("keeps the request Backend on the foreground completion", async () => {
    const harness = createHarness();
    const onLlmMessageCompleted = jest.fn();
    (harness.options as any).onLlmMessageCompleted = onLlmMessageCompleted;
    const { result } = await renderHook(() => useCodexReplyRequest(harness.options as any));
    let sendPromise: Promise<unknown> = Promise.resolve();

    await act(async () => {
      sendPromise = result.current.sendReplyRequest("hello", {
        panelId: "panel-1",
        sessionSnapshot: {
          backendId: "claude",
          threadId: "claude-session",
          modelRef: "sonnet",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      harness.resolveTurn({
        threadId: "claude-session",
        turnId: "turn-1",
        reply: "done",
        contextUsage: null,
      });
      await sendPromise;
    });

    expect(onLlmMessageCompleted).toHaveBeenCalledWith(expect.objectContaining({
      backendId: "claude",
      sessionId: "claude-session",
    }));
  });

  test("reports item completion as a non-delta session boundary", async () => {
    const harness = createHarness();
    const { sendPromise } = await startRequest(harness);

    await act(async () => {
      harness.getTurnOptions().onThreadIdResolved("thread-1");
      harness.getTurnOptions().onEvent("item/completed", { item: { type: "agentMessage" } });
    });

    expect(harness.options.onSessionStreamBoundary).toHaveBeenCalledWith("thread-1");
    await act(async () => {
      harness.resolveTurn({ threadId: "thread-1", turnId: "turn-1", reply: "done", contextUsage: null });
      await sendPromise;
    });
  });

  test("marks the panel session materialized when the first turn resolves a native ID", async () => {
    const harness = createHarness();
    const { sendPromise } = await startRequest(harness, { sessionId: "local-draft" });

    await act(async () => {
      harness.getTurnOptions().onThreadIdResolved("thread-1");
    });

    expect(harness.writeCalls[harness.writeCalls.length - 1]?.options).toMatchObject({
      sessionId: "thread-1",
      sessionMaterialized: true,
      adoptFromSessionId: "local-draft",
    });
    expect(harness.sessionStore["thread-1"].some((message) => message.content === "hello")).toBe(true);
    await act(async () => {
      harness.resolveTurn({ threadId: "thread-1", turnId: "turn-1", reply: "done", contextUsage: null });
      await sendPromise;
    });
  });

  test("routes the first approval after native ID adoption to the native session", async () => {
    const harness = createHarness();
    const onApprovalRequestResolved = jest.fn();
    (harness.options as any).onApprovalRequestResolved = onApprovalRequestResolved;
    const { sendPromise } = await startRequest(harness, { sessionId: "local-draft" });

    const approvalRequest = {
      requestId: "approval-1",
      approvalKey: "approval-1",
      threadId: "native-thread",
      turnId: "turn-1",
      command: "WebFetch",
      args: [],
    };
    await act(async () => {
      harness.getTurnOptions().onThreadIdResolved("native-thread");
      await harness.getTurnOptions().onApprovalRequest(approvalRequest);
      harness.getTurnOptions().onApprovalRequestResolved(approvalRequest);
    });

    expect(harness.options.handleApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      sessionInfo: expect.objectContaining({ sessionId: "native-thread" }),
    }));
    expect(onApprovalRequestResolved).toHaveBeenCalledWith(expect.objectContaining({
      sessionInfo: expect.objectContaining({ sessionId: "native-thread" }),
    }));
    expect(harness.options.handleApprovalRequest).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionInfo: expect.objectContaining({ sessionId: "local-draft" }),
    }));

    await act(async () => {
      harness.resolveTurn({ threadId: "native-thread", turnId: "turn-1", reply: "done", contextUsage: null });
      await sendPromise;
    });
  });

  test("projects real Codex item starts into the shared runtime status", async () => {
    const harness = createHarness();
    const updateConversationRuntimeRequest = jest.fn();
    (harness.options as any).updateConversationRuntimeRequest = updateConversationRuntimeRequest;
    const { sendPromise } = await startRequest(harness);

    const cases = [
      [{ type: "commandExecution", commandActions: [{ type: "read", command: "cat README" }] }, "tool start: read_file"],
      [{ type: "fileChange", changes: [] }, "tool start: file_edit"],
      [{ type: "webSearch", query: "latest news" }, "tool start: web_search"],
      [{ type: "dynamicToolCall", toolName: "brave_search", arguments: { query: "latest news" } }, "tool start: brave_search"],
    ] as const;
    await act(async () => {
      harness.getTurnOptions().onThreadIdResolved("thread-1");
      for (const [item] of cases) {
        harness.getTurnOptions().onEvent("item/started", { item });
      }
    });

    for (const [, statusDetail] of cases) {
      expect(updateConversationRuntimeRequest).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "thread-1",
        lifecycle: "active",
        status: "tool_running",
        statusDetail,
      }));
    }
    expect(harness.writeCalls[harness.writeCalls.length - 1]?.options).toMatchObject({ isResponding: true });

    await act(async () => {
      harness.getTurnOptions().onEvent("item/completed", {
        item: { type: "webSearch", query: "latest news" },
      });
    });
    expect(updateConversationRuntimeRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      lifecycle: "active",
      status: "model_processing",
      statusDetail: "webSearch completed",
    }));

    await act(async () => {
      harness.resolveTurn({ threadId: "thread-1", turnId: "turn-1", reply: "done", contextUsage: null });
      await sendPromise;
    });
  });

  test("settles the agentMessage bubble as completed while the turn keeps running", async () => {
    const harness = createHarness();
    const { sendPromise } = await startRequest(harness);

    await act(async () => {
      harness.getTurnOptions().onAgentMessageCompleted("final answer", { itemId: "item-1" });
    });

    const message = harness.assistantMessageByItemId("panel-1", "item-1");
    expect(message).toBeDefined();
    expect(message?.content).toBe("final answer");
    expect(message?.llmStatus).toBe("completed");
    const lastWrite = harness.writeCalls[harness.writeCalls.length - 1];
    expect(lastWrite.options).toMatchObject({
      isResponding: true,
      selectedThreadStatusType: "active",
    });

    await act(async () => {
      harness.resolveTurn({
        threadId: "thread-1",
        turnId: "turn-1",
        reply: "final answer",
        contextUsage: null,
      });
      await sendPromise;
    });
  });

  test("turn error does not downgrade already-completed bubbles", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness();
    const { sendPromise } = await startRequest(harness);

    await act(async () => {
      harness.getTurnOptions().onAgentMessageCompleted("first done", { itemId: "item-1" });
      harness.getTurnOptions().onDelta("second in progr", { itemId: "item-2" });
    });

    await act(async () => {
      harness.rejectTurn(new Error("boom"));
      await sendPromise;
    });

    const completedMessage = harness.assistantMessageByItemId("panel-1", "item-1");
    expect(completedMessage?.llmStatus).toBe("completed");
    expect(completedMessage?.content).toBe("first done");
    const liveMessage = harness.assistantMessageByItemId("panel-1", "item-2");
    expect(liveMessage?.llmStatus).toBe("error");
    consoleErrorSpy.mockRestore();
  });

  test("mints deterministic item-based message ids once the thread id is resolved", async () => {
    const harness = createHarness();
    const { sendPromise } = await startRequest(harness);

    // ライブ通知のitem.idはraw Responses API id (msg_… / call_…)。
    await act(async () => {
      harness.getTurnOptions().onThreadIdResolved("thread-1");
      harness.getTurnOptions().onAgentMessageCompleted("stable reply", { itemId: "msg_0483" });
      harness.getTurnOptions().onEvent("item/started", {
        item: { type: "commandExecution", id: "call_1", command: "npm test", status: "inProgress" },
      });
    });

    // 同一itemはライブ経路間で同一IDにupsertされる(codexItemMessageId契約)。
    const agentMessage = harness.panelMessages("panel-1")
      .find((message) => message.id === codexItemMessageId("thread-1", "msg_0483"));
    expect(agentMessage?.content).toBe("stable reply");
    const commandMessage = harness.panelMessages("panel-1")
      .find((message) => message.id === codexItemMessageId("thread-1", "call_1"));
    expect(commandMessage).toBeDefined();

    await act(async () => {
      harness.resolveTurn({
        threadId: "thread-1",
        turnId: "turn-1",
        reply: "stable reply",
        contextUsage: null,
      });
      await sendPromise;
    });
  });

  test("final settle keeps per-message youtube ids instead of re-assigning combined ids", async () => {
    const harness = createHarness();
    const { sendPromise } = await startRequest(harness);

    await act(async () => {
      harness.getTurnOptions().onAgentMessageCompleted("first yt:aaa", { itemId: "item-1" });
      harness.getTurnOptions().onAgentMessageCompleted("second yt:bbb", { itemId: "item-2" });
    });

    await act(async () => {
      harness.resolveTurn({
        threadId: "thread-1",
        turnId: "turn-1",
        reply: "first yt:aaa\n\nsecond yt:bbb",
        contextUsage: null,
      });
      await sendPromise;
    });

    const firstMessage = harness.assistantMessageByItemId("panel-1", "item-1");
    const secondMessage = harness.assistantMessageByItemId("panel-1", "item-2");
    expect(firstMessage?.youtubeVideoIds).toEqual(["aaa"]);
    expect(secondMessage?.youtubeVideoIds).toEqual(["bbb"]);
    expect(firstMessage?.llmStatus).toBe("completed");
    expect(secondMessage?.llmStatus).toBe("completed");
    const lastWrite = harness.writeCalls[harness.writeCalls.length - 1];
    expect(lastWrite.options).toMatchObject({ isResponding: false });
  });
});

describe("useCodexReplyRequest session isolation", () => {
  test("keeps concurrent streams isolated when one shared panel switches sessions", async () => {
    const { options } = createOptions();
    const sessions: Record<string, PanelWriteCall["messages"]> = {
      "session-a": [{ id: "a-history", role: "assistant", content: "history a" }],
      "session-b": [{ id: "b-history", role: "assistant", content: "history b" }],
    };
    let displayedSessionId = "session-a";
    let panelMessages = sessions[displayedSessionId];
    const turns: Array<{ options: any }> = [];
    mockStartCodexAppServerTurn.mockImplementation(((turnOptions: any) => {
      turns.push({ options: turnOptions });
      return { promise: new Promise(() => {}), interrupt: jest.fn() };
    }) as any);
    (options as any).getPanelConversationMessages = () => panelMessages;
    (options as any).getSessionConversationMessages = (sessionId: string) => sessions[sessionId] || [];
    (options as any).setPanelConversationMessages = (
      _panelId: string,
      messages: PanelWriteCall["messages"],
      writeOptions?: { sessionId?: string }
    ) => {
      const sessionId = String(writeOptions?.sessionId || "").trim();
      if (sessionId) sessions[sessionId] = messages;
      if (!sessionId || sessionId === displayedSessionId) panelMessages = messages;
    };
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    await act(async () => {
      void result.current.sendReplyRequest("question a", {
        panelId: "shared-panel",
        sessionSnapshot: { threadId: "session-a" },
      });
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    displayedSessionId = "session-b";
    panelMessages = sessions[displayedSessionId];
    await act(async () => {
      void result.current.sendReplyRequest("question b", {
        panelId: "shared-panel",
        sessionSnapshot: { threadId: "session-b" },
      });
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });

    await act(async () => {
      turns[0].options.onDelta("answer a", { itemId: "item-a" });
      turns[1].options.onDelta("answer b", { itemId: "item-b" });
    });

    expect(sessions["session-a"].map((message) => message.content)).toEqual([
      "history a",
      "question a",
      "answer a",
    ]);
    expect(sessions["session-b"].map((message) => message.content)).toEqual([
      "history b",
      "question b",
      "answer b",
    ]);
    expect(panelMessages.map((message) => message.content)).toEqual([
      "history b",
      "question b",
      "answer b",
    ]);
  });
});

describe("useCodexReplyRequest finalUiSettled", () => {
  test("success settle marks finalUiSettled and skips the redundant finally rewrite", async () => {
    mockStartCodexAppServerTurn.mockImplementation((() => ({
      promise: Promise.resolve({
        reply: "hello response",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    })) as any);
    const { options, panelWrites } = createOptions();
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    await act(async () => {
      await result.current.sendReplyRequest("hi there");
    });

    const respondingFalseWrites = panelWrites.filter((call) => call.options?.isResponding === false);
    // settle書き込み(isResponding:false)は1回だけで、finallyの冗長書き込みは走らない。
    expect(respondingFalseWrites).toHaveLength(1);
    expect(panelWrites.some(isFinallyWrite)).toBe(false);
    const settledMessages = respondingFalseWrites[0].messages;
    expect(settledMessages[settledMessages.length - 1]).toMatchObject({
      role: "assistant",
      content: "hello response",
    });
  });

  test("interrupted turn leaves finalUiSettled unset so finally persists isResponding:false", async () => {
    mockStartCodexAppServerTurn.mockImplementation((() => ({
      promise: Promise.reject(Object.assign(new Error("turn interrupted"), { isInterrupted: true })),
    })) as any);
    const { options, panelWrites } = createOptions();
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    await act(async () => {
      await result.current.sendReplyRequest("hi there");
    });

    // 中断時は settle 書き込みが無いため、finally が isResponding:false を確定書き込みする。
    const finallyWrites = panelWrites.filter(isFinallyWrite);
    expect(finallyWrites).toHaveLength(1);
    expect(finallyWrites[0].options?.isResponding).toBe(false);
    const respondingFalseWrites = panelWrites.filter((call) => call.options?.isResponding === false);
    expect(respondingFalseWrites).toHaveLength(1);
  });
});

describe("useCodexReplyRequest send gate liveness", () => {
  test("releases the thread gate and interrupts a turn with no recent progress", async () => {
    jest.useFakeTimers();
    try {
      const { options } = createOptions();
      const turnSessions: Array<{ interrupt: jest.Mock }> = [];
      mockStartCodexAppServerTurn.mockImplementation((() => {
        const session = {
          promise: new Promise(() => {}),
          interrupt: jest.fn(async () => {}),
        };
        turnSessions.push(session);
        return session;
      }) as any);
      const updateConversationRuntimeRequest = jest.fn();
      (options as any).updateConversationRuntimeRequest = updateConversationRuntimeRequest;
      const { result } = await renderHook(() => useCodexReplyRequest(options as never));
      const send = async (text: string) => {
        await act(async () => {
          void result.current.sendReplyRequest(text, {
            panelId: "panel-1",
            sessionSnapshot: { threadId: "thread-1" },
          });
          for (let i = 0; i < 6; i += 1) await Promise.resolve();
        });
      };

      await send("first message");
      expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(1);

      // A live (recent-progress) turn keeps blocking the thread.
      await send("second message");
      expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(1);
      expect(turnSessions[0].interrupt).not.toHaveBeenCalled();

      // No progress events for longer than the staleness window: the next send
      // interrupts the stale turn, reports it, and goes through.
      jest.advanceTimersByTime(5 * 60_000 + 1_000);
      await send("third message");
      expect(turnSessions[0].interrupt).toHaveBeenCalledTimes(1);
      expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(2);
      expect(updateConversationRuntimeRequest).toHaveBeenCalledWith(expect.objectContaining({
        lifecycle: "error",
        sessionId: "thread-1",
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  test("does not expire a turn that is waiting on an approval", async () => {
    jest.useFakeTimers();
    try {
      const { options } = createOptions();
      const turnSessions: Array<{ interrupt: jest.Mock; turnOptions: any }> = [];
      mockStartCodexAppServerTurn.mockImplementation(((turnOptions: any) => {
        const session = {
          promise: new Promise(() => {}),
          interrupt: jest.fn(async () => {}),
          turnOptions,
        };
        turnSessions.push(session);
        return session;
      }) as any);
      const { result } = await renderHook(() => useCodexReplyRequest(options as never));
      const send = async (text: string) => {
        await act(async () => {
          void result.current.sendReplyRequest(text, {
            panelId: "panel-1",
            sessionSnapshot: { threadId: "thread-1" },
          });
          for (let i = 0; i < 6; i += 1) await Promise.resolve();
        });
      };

      await send("first message");
      expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(1);
      jest.mocked(deriveCodexSessionStateFromSnapshot).mockReturnValueOnce({
        sessionState: "waiting_on_approval",
        threadStatusType: "active",
      } as never);
      await act(async () => {
        turnSessions[0].turnOptions.onEvent("thread/status/changed", {
          threadId: "thread-1",
          status: { type: "waitingOnApproval" },
        });
      });

      jest.advanceTimersByTime(30 * 60_000);
      await send("second message");
      expect(turnSessions[0].interrupt).not.toHaveBeenCalled();
      expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("delayed settle of an expired turn does not wipe the replacement turn's in-flight state", async () => {
    jest.useFakeTimers();
    try {
      const { options } = createOptions();
      const turnSessions: Array<{
        interrupt: jest.Mock;
        turnOptions: any;
        reject: (error: unknown) => void;
      }> = [];
      mockStartCodexAppServerTurn.mockImplementation(((turnOptions: any) => {
        let reject: (error: unknown) => void = () => {};
        const promise = new Promise((_resolve, promiseReject) => {
          reject = promiseReject;
        });
        const session = { promise, interrupt: jest.fn(async () => {}), turnOptions, reject };
        turnSessions.push(session);
        return session;
      }) as any);
      const { result } = await renderHook(() => useCodexReplyRequest(options as never));
      const send = async (text: string) => {
        await act(async () => {
          void result.current.sendReplyRequest(text, {
            panelId: "panel-1",
            sessionSnapshot: { threadId: "thread-1" },
          });
          for (let i = 0; i < 6; i += 1) await Promise.resolve();
        });
      };

      // Turn A goes silent past the staleness window; the next send expires it
      // (its interrupt settles only later) and starts turn B on the same thread.
      await send("first message");
      jest.advanceTimersByTime(5 * 60_000 + 1_000);
      await send("second message");
      expect(turnSessions[0].interrupt).toHaveBeenCalledTimes(1);
      expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(2);

      // Turn B is now waiting on an approval.
      jest.mocked(deriveCodexSessionStateFromSnapshot).mockReturnValueOnce({
        sessionState: "waiting_on_approval",
        threadStatusType: "active",
      } as never);
      await act(async () => {
        turnSessions[1].turnOptions.onEvent("thread/status/changed", {
          threadId: "thread-1",
          status: { type: "waitingOnApproval" },
        });
      });

      // Turn A's interrupt finally lands: the delayed interrupted settle must not
      // delete turn B's in-flight state (it carries the approval-wait protection).
      await act(async () => {
        turnSessions[0].reject(Object.assign(new Error("turn interrupted"), { isInterrupted: true }));
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });

      jest.advanceTimersByTime(30 * 60_000);
      await send("third message");
      expect(turnSessions[1].interrupt).not.toHaveBeenCalled();
      expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("useCodexReplyRequest send acceptance contract", () => {
  test("dispatches accepted sends directly to the provider-neutral turn facade", async () => {
    const { options } = createOptions();
    (options as { transcript: string }).transcript = "hello world";
    mockStartCodexAppServerTurn.mockImplementation((() => ({
      promise: new Promise(() => {}),
      interrupt: jest.fn(),
    })) as any);
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    await act(async () => {
      void result.current.sendReplyRequest(undefined, {
        panelId: "panel-1",
        sessionSnapshot: { threadId: "thread-1" },
      });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(1);
    expect(options.setTranscript).toHaveBeenCalledWith("");
  });

  test("server-queued turns release the send gate while retaining each run observer through completion", async () => {
    const { options, panelWrites } = createOptions();
    const runtimeUpdates = jest.fn();
    (options as any).updateConversationRuntimeRequest = runtimeUpdates;
    const turns: Array<{
      options: any;
      resolve: (value: unknown) => void;
    }> = [];
    mockStartCodexAppServerTurn.mockImplementation(((turnOptions: any) => {
      let resolve = (_value: unknown) => {};
      const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
      turns.push({ options: turnOptions, resolve });
      return { promise, interrupt: jest.fn() };
    }) as any);
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    let firstSend: Promise<unknown> = Promise.resolve();
    await act(async () => {
      firstSend = result.current.sendReplyRequest("first message", {
        panelId: "panel-1",
        sessionSnapshot: { threadId: "thread-1" },
      });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      turns[0].options.onTurnAccepted?.({
        runId: "run-1",
        queued: true,
      });
    });

    let secondSend: Promise<unknown> = Promise.resolve();
    await act(async () => {
      secondSend = result.current.sendReplyRequest("second message", {
        panelId: "panel-1",
        sessionSnapshot: { threadId: "thread-1" },
      });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(2);

    await act(async () => {
      turns[0].options.onDelta?.("first reply", { itemId: "item-1" });
      turns[0].resolve({ threadId: "thread-1", turnId: "turn-1", reply: "first reply", contextUsage: null });
      await firstSend;
    });
    expect(options.applyAssistantReply).toHaveBeenCalledWith("first reply");
    expect(runtimeUpdates).toHaveBeenLastCalledWith(expect.objectContaining({
      requestSeq: 1,
      lifecycle: "completed",
      status: "completed",
    }));

    await act(async () => {
      turns[1].options.onTurnAccepted?.({ runId: "run-2", queued: true });
      turns[1].options.onDelta?.("second reply", { itemId: "item-2" });
      turns[1].resolve({ threadId: "thread-1", turnId: "turn-2", reply: "second reply", contextUsage: null });
      await secondSend;
    });
    expect(options.applyAssistantReply).toHaveBeenCalledWith("second reply");
    expect(runtimeUpdates).toHaveBeenLastCalledWith(expect.objectContaining({
      requestSeq: 2,
      lifecycle: "completed",
      status: "completed",
    }));
    expect(panelWrites.at(-1)?.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "first message" },
      { role: "user", content: "second message" },
      { role: "assistant", content: "first reply" },
      { role: "assistant", content: "second reply" },
    ]);
  });

  test("panel cancel interrupts every accepted compact-time run", async () => {
    const { options } = createOptions();
    const turns: Array<{
      options: any;
      reject: (error: unknown) => void;
      interrupt: jest.Mock;
    }> = [];
    mockStartCodexAppServerTurn.mockImplementation(((turnOptions: any) => {
      let reject = (_error: unknown) => {};
      const promise = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
      const interrupt = jest.fn(async () => {});
      turns.push({ options: turnOptions, reject, interrupt });
      return { promise, interrupt };
    }) as any);
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    let firstSend: Promise<unknown> = Promise.resolve();
    await act(async () => {
      firstSend = result.current.sendReplyRequest("first message", {
        panelId: "panel-1",
        sessionSnapshot: { threadId: "thread-1" },
      });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
      turns[0].options.onTurnAccepted?.({ runId: "run-1", queued: true });
    });

    let secondSend: Promise<unknown> = Promise.resolve();
    await act(async () => {
      secondSend = result.current.sendReplyRequest("second message", {
        panelId: "panel-1",
        sessionSnapshot: { threadId: "thread-1" },
      });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
      turns[1].options.onTurnAccepted?.({ runId: "run-2", queued: true });
    });

    await act(async () => {
      await expect(result.current.cancelReplyRequest({ panelId: "panel-1" })).resolves.toBe(true);
    });
    expect(turns.map((turn) => turn.interrupt.mock.calls.length)).toEqual([1, 1]);

    await act(async () => {
      const interrupted = Object.assign(new Error("turn interrupted"), { isInterrupted: true });
      turns[0].reject(interrupted);
      turns[1].reject(interrupted);
      await Promise.all([firstSend, secondSend]);
    });
  });

  test("gate-blocked send keeps the composer and reports the rejection", async () => {
    const { options } = createOptions();
    mockStartCodexAppServerTurn.mockImplementation((() => ({
      promise: new Promise(() => {}),
      interrupt: jest.fn(),
    })) as any);
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    await act(async () => {
      void result.current.sendReplyRequest("first message", {
        panelId: "panel-1",
        sessionSnapshot: { threadId: "thread-1" },
      });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(mockStartCodexAppServerTurn).toHaveBeenCalledTimes(1);

    (options as { transcript: string }).transcript = "second message";
    await act(async () => {
      // ブロックされた送信は入力を消さず、拒否理由を返す(サイレントskip禁止)。
      await expect(result.current.sendReplyRequest(undefined, {
        panelId: "panel-1",
        sessionSnapshot: { threadId: "thread-1" },
      })).resolves.toEqual({ rejected: "active_request" });
    });
    expect(options.setTranscript).not.toHaveBeenCalled();
  });

  test("missing codex ws url send keeps the composer and reports the rejection", async () => {
    const { options } = createOptions();
    (options as { transcript: string; codexWsUrl: string }).codexWsUrl = "";
    (options as { transcript: string }).transcript = "hello";
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    await act(async () => {
      await expect(result.current.sendReplyRequest(undefined, {
        panelId: "panel-1",
        sessionSnapshot: { threadId: "thread-1" },
      })).resolves.toEqual({ rejected: "missing_codex_ws_url" });
    });
    expect(options.setTranscript).not.toHaveBeenCalled();
    expect(mockStartCodexAppServerTurn).not.toHaveBeenCalled();
  });

  test("rejects a model whose backend does not match the saved session backend", async () => {
    const { options } = createOptions();
    Object.assign(options, {
      transcript: "hello",
      llmBackend: "claude",
      modelRef: "sonnet",
      modelOptions: [
        { modelId: "gpt-5.6-sol", backendId: "codex" },
        { modelId: "sonnet", backendId: "claude" },
      ],
    });
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    await act(async () => {
      await expect(result.current.sendReplyRequest(undefined, {
        panelId: "panel-1",
        sessionSnapshot: { backendId: "codex", threadId: "thread-1", modelRef: "sonnet" },
      })).resolves.toEqual({ rejected: "model_backend_mismatch" });
    });
    expect(options.setTranscript).not.toHaveBeenCalled();
    expect(mockStartCodexAppServerTurn).not.toHaveBeenCalled();
  });

  test("sends the selected model when resuming within the same backend", async () => {
    const { options } = createOptions();
    Object.assign(options, {
      transcript: "hello",
      llmBackend: "claude",
      modelRef: "sonnet",
      modelOptions: [{
        modelId: "sonnet",
        backendId: "claude",
        supportsReasoningEffort: false,
      }],
    });
    mockStartCodexAppServerTurn.mockImplementationOnce(((turnOptions: any) => ({
      promise: Promise.resolve({ threadId: turnOptions.threadId, turnId: "turn-1", reply: "done", contextUsage: null }),
      interrupt: jest.fn(),
    })) as never);
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    await act(async () => {
      await result.current.sendReplyRequest(undefined, {
        panelId: "panel-1",
        sessionSnapshot: { backendId: "claude", threadId: "thread-1", modelRef: "sonnet", reasoningEffort: "high" },
      });
    });

    expect(mockStartCodexAppServerTurn).toHaveBeenCalledWith(expect.objectContaining({
      backendId: "claude",
      threadId: "thread-1",
      model: "sonnet",
      effort: undefined,
    }));
  });

  test("resumeでもadvertise済みeffortはturn単位で送られcatalog外はclampされる", async () => {
    const claudeModelOption = {
      modelId: "sonnet",
      backendId: "claude",
      supportsReasoningEffort: true,
      effortOptions: ["low", "medium", "high", "xhigh", "max"],
    };
    {
      const { options } = createOptions();
      Object.assign(options, {
        transcript: "hello",
        llmBackend: "claude",
        modelRef: "sonnet",
        modelOptions: [claudeModelOption],
      });
      mockStartCodexAppServerTurn.mockImplementationOnce(((turnOptions: any) => ({
        promise: Promise.resolve({ threadId: turnOptions.threadId, turnId: "turn-1", reply: "done", contextUsage: null }),
        interrupt: jest.fn(),
      })) as never);
      const { result } = await renderHook(() => useCodexReplyRequest(options as never));
      await act(async () => {
        await result.current.sendReplyRequest(undefined, {
          panelId: "panel-1",
          sessionSnapshot: { backendId: "claude", threadId: "thread-1", modelRef: "sonnet", reasoningEffort: "xhigh" },
        });
      });
      expect(mockStartCodexAppServerTurn).toHaveBeenCalledWith(expect.objectContaining({
        backendId: "claude",
        threadId: "thread-1",
        model: "sonnet",
        effort: "xhigh",
      }));
    }
    {
      const { options } = createOptions();
      Object.assign(options, {
        transcript: "hello",
        llmBackend: "claude",
        modelRef: "sonnet",
        modelOptions: [claudeModelOption],
      });
      mockStartCodexAppServerTurn.mockImplementationOnce(((turnOptions: any) => ({
        promise: Promise.resolve({ threadId: turnOptions.threadId, turnId: "turn-2", reply: "done", contextUsage: null }),
        interrupt: jest.fn(),
      })) as never);
      const { result } = await renderHook(() => useCodexReplyRequest(options as never));
      await act(async () => {
        await result.current.sendReplyRequest(undefined, {
          panelId: "panel-1",
          sessionSnapshot: { backendId: "claude", threadId: "thread-1", modelRef: "sonnet", reasoningEffort: "ultra" },
        });
      });
      expect(mockStartCodexAppServerTurn).toHaveBeenLastCalledWith(expect.objectContaining({
        backendId: "claude",
        effort: undefined,
      }));
    }
  });

  test.each([
    ["codex", "gpt-5"],
    ["claude", "sonnet"],
  ])("%s materialized session dispatches through the provider-neutral turn facade", async (backendId, modelRef) => {
    const { options } = createOptions();
    Object.assign(options, {
      transcript: "hello",
      llmBackend: backendId,
      modelRef,
      modelOptions: [{
        modelId: modelRef,
        backendId,
        supportsReasoningEffort: false,
      }],
    });
    mockStartCodexAppServerTurn.mockImplementationOnce(((turnOptions: any) => ({
      promise: Promise.resolve({ threadId: turnOptions.threadId, turnId: "turn-1", reply: "done", contextUsage: null }),
      interrupt: jest.fn(),
    })) as never);
    const { result } = await renderHook(() => useCodexReplyRequest(options as never));

    await act(async () => {
      await result.current.sendReplyRequest(undefined, {
        panelId: "panel-1",
        sessionSnapshot: { backendId, threadId: "thread-1", modelRef },
      });
    });

    expect(mockStartCodexAppServerTurn).toHaveBeenCalledWith(expect.objectContaining({
      backendId,
      threadId: "thread-1",
    }));
  });
});
