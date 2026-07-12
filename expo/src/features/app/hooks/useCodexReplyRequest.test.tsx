import { act, renderHook } from "@testing-library/react-native";
import { useCodexReplyRequest } from "./useCodexReplyRequest";
import { startCodexAppServerTurn } from "../../codex/codexAppServerClient";

jest.mock("../../codex/codexAppServerClient", () => ({
  deriveCodexSessionStateFromSnapshot: jest.fn(() => null),
  enqueueRunnerCodexTurn: jest.fn(async () => ({ queued: false })),
  isCodexAppServerTurnInterruptedError: jest.fn(() => false),
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
    setPanelConversationMessages: (
      panelId: string,
      messages: StoredMessage[],
      writeOptions?: Record<string, unknown>
    ) => {
      store[panelId] = messages;
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
  };

  return {
    options,
    store,
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

async function startRequest(harness: ReturnType<typeof createHarness>) {
  const { result } = await renderHook(() => useCodexReplyRequest(harness.options as any));
  let sendPromise: Promise<void> = Promise.resolve();
  await act(async () => {
    sendPromise = result.current.sendReplyRequest("hello", { panelId: "panel-1" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(harness.getTurnOptions()).not.toBeNull();
  return { result, sendPromise };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useCodexReplyRequest onAgentMessageCompleted", () => {
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
