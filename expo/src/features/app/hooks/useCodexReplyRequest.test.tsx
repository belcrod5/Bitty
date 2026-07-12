import { renderHook } from "@testing-library/react-native";

import { useCodexReplyRequest } from "./useCodexReplyRequest";

const mockStartCodexAppServerTurn = jest.fn();

jest.mock("../../codex/codexAppServerClient", () => ({
  startCodexAppServerTurn: (...args: unknown[]) => mockStartCodexAppServerTurn(...args),
  enqueueRunnerCodexTurn: jest.fn(async () => ({ queued: false })),
  isCodexAppServerTurnInterruptedError: (error: unknown) => Boolean(
    error && typeof error === "object" && (error as { isInterrupted?: boolean }).isInterrupted
  ),
  deriveCodexSessionStateFromSnapshot: jest.fn(() => null),
}));

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
  mockStartCodexAppServerTurn.mockReset();
});

test("success settle marks finalUiSettled and skips the redundant finally rewrite", async () => {
  mockStartCodexAppServerTurn.mockImplementation(() => ({
    promise: Promise.resolve({
      reply: "hello response",
      threadId: "thread-1",
      turnId: "turn-1",
    }),
  }));
  const { options, panelWrites } = createOptions();
  const { result } = await renderHook(() => useCodexReplyRequest(options as never));

  await result.current.sendReplyRequest("hi there");

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
  mockStartCodexAppServerTurn.mockImplementation(() => ({
    promise: Promise.reject(Object.assign(new Error("turn interrupted"), { isInterrupted: true })),
  }));
  const { options, panelWrites } = createOptions();
  const { result } = await renderHook(() => useCodexReplyRequest(options as never));

  await result.current.sendReplyRequest("hi there");

  // 中断時は settle 書き込みが無いため、finally が isResponding:false を確定書き込みする。
  const finallyWrites = panelWrites.filter(isFinallyWrite);
  expect(finallyWrites).toHaveLength(1);
  expect(finallyWrites[0].options?.isResponding).toBe(false);
  const respondingFalseWrites = panelWrites.filter((call) => call.options?.isResponding === false);
  expect(respondingFalseWrites).toHaveLength(1);
});
