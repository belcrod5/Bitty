import { act, renderHook } from "@testing-library/react-native";
import { useCodexRelayObserverStartController } from "./useCodexRelayObserverStartController";
import { codexItemMessageId } from "../utils/codexItemMessageId";
import { resolvePanelConversationAfterHydration } from "../utils/panelHydrationFreshness";
import { startCodexAppServerTurnRelayObserver } from "../../codex/codexAppServerClient";
import type { ConversationMessage } from "../types/appTypes";

jest.mock("../../codex/codexAppServerClient", () => ({
  deriveCodexSessionStateFromSnapshot: jest.fn(() => ({
    sessionState: "running",
    threadStatusType: "active",
  })),
  startCodexAppServerTurnRelayObserver: jest.fn(),
}));

const mockStartRelayObserver = jest.mocked(startCodexAppServerTurnRelayObserver);

function message(partial: Partial<ConversationMessage> & Pick<ConversationMessage, "id" | "role">): ConversationMessage {
  return { content: "", ...partial };
}

function createHarness(initialConversation: ConversationMessage[]) {
  let sessionConversation = initialConversation;
  let capturedObserverOptions: any = null;
  const completedCalls: Array<{ messageId: string; text: string }> = [];

  mockStartRelayObserver.mockImplementation(((observerOptions: any) => {
    capturedObserverOptions = observerOptions;
    return { close: jest.fn() };
  }) as any);

  const options = {
    parseOptionalSessionId: (raw: unknown) => String(raw || "").trim(),
    parseLlmDirectory: (raw: unknown) => String(raw || "").trim(),
    normalizedLlmDirectoryForRequest: () => "/workspace",
    codexRelayObserverRef: { current: null as { threadId: string; panelId?: string; close: () => void } | null },
    codexRelayObserverReplyByThreadRef: { current: {} as Record<string, string> },
    codexRelayObserverStartedAtMsByThreadRef: { current: {} as Record<string, number> },
    llmRequestStartedAtRef: { current: 0 },
    reply: "",
    codexWsUrl: "ws://127.0.0.1:8788/codex",
    codexWsToken: "",
    logSessionDiag: jest.fn(),
    waitingApprovalResumePendingSessionIdRef: { current: "" },
    setWaitingApprovalResumeStatusText: jest.fn(),
    finishWaitingApprovalResumeAttempt: jest.fn(() => false),
    clearCodexRelayObserverForMiss: jest.fn(),
    applyAssistantReply: (text: string) => text,
    buildConversationMessage: (
      role: "user" | "assistant",
      content: string,
      extra: Record<string, unknown> = {}
    ) => ({ id: "built", role, content, ...extra } as ConversationMessage),
    getPanelConversationMessagesForCodexRef: { current: () => [] as ConversationMessage[] },
    setPanelConversationMessagesForCodexRef: { current: jest.fn() },
    getActiveConversationMessagesForCodex: () => [] as ConversationMessage[],
    setActiveConversationMessagesForCodex: jest.fn(),
    getSessionConversationMessagesForCodex: () => sessionConversation,
    setSessionConversationMessagesForCodex: (_sessionId: string, messages: ConversationMessage[]) => {
      sessionConversation = messages;
    },
    rememberSessionRuntimeStatus: jest.fn(),
    finalizeSessionRuntimeAfterRelayLoss: jest.fn(),
    closeCodexRelayObserver: jest.fn(),
    onApprovalRequest: jest.fn(),
    onAssistantTurnCompleted: (params: { messageId: string; text: string }) => {
      completedCalls.push({ messageId: params.messageId, text: params.text });
    },
  };

  return {
    options,
    completedCalls,
    getObserverOptions: () => capturedObserverOptions,
    getSessionConversation: () => sessionConversation,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStartRelayObserver.mockReset();
});

describe("useCodexRelayObserverStartController message ids", () => {
  test("multi-item turns keep a thread/read-compatible TTS target across rehydration", async () => {
    const threadId = "thread-1";
    // 走行中ターンの復元直後: thread/read由来の安定IDを持つ会話が表示されている。
    const restoredInProgressAssistantId = codexItemMessageId(threadId, "item-2");
    const harness = createHarness([
      message({ id: codexItemMessageId(threadId, "item-1"), role: "user", content: "question" }),
      message({ id: restoredInProgressAssistantId, role: "assistant", content: "partial" }),
    ]);
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));

    await act(async () => {
      result.current.startCodexRelayObserverForSession(threadId, {
        reason: "session_restored_running_turn",
        directory: "/workspace",
        startedAtMs: Date.now(),
      });
    });
    const observerOptions = harness.getObserverOptions();
    expect(observerOptions).not.toBeNull();

    // ライブ通知のitem.idはraw Responses API id (msg_…)。
    await act(async () => {
      observerOptions.onAgentMessageCompleted("partial done", { itemId: "msg_aaa" });
      observerOptions.onAgentMessageCompleted("second message", { itemId: "msg_bbb" });
      observerOptions.onTurnCompleted();
    });

    // 1つ目のitemは表示中バブルのIDを引き継ぎ、2つ目以降もcodexItemMessageIdで発行される。
    const conversation = harness.getSessionConversation();
    expect(conversation.map((item) => item.id)).toEqual([
      codexItemMessageId(threadId, "item-1"),
      restoredInProgressAssistantId,
      codexItemMessageId(threadId, "msg_bbb"),
    ]);
    // 完了時のTTSターゲットは最後のagentMessageのID。
    expect(harness.completedCalls).toHaveLength(1);
    const ttsTargetId = harness.completedCalls[0].messageId;
    expect(ttsTargetId).toBe(codexItemMessageId(threadId, "msg_bbb"));

    // その後の再ハイドレーションでは復元IDが合成連番(item-N)になるが、
    // 正規化本文の照合でTTSターゲットが復元側IDへリマップされて生存する。
    const rehydrated = resolvePanelConversationAfterHydration({
      runtime: null,
      requestStartedAtMsAtHydrationStart: null,
      restoredConversation: [
        message({ id: codexItemMessageId(threadId, "item-1"), role: "user", content: "question" }),
        message({ id: codexItemMessageId(threadId, "item-2"), role: "assistant", content: "partial done" }),
        message({ id: codexItemMessageId(threadId, "item-3"), role: "assistant", content: "second message  \n" }),
      ],
      restoredHasRunningTurn: false,
      restoredThreadStatusType: "idle",
      restoredUpdatedAtMs: Date.now(),
      restoredMessageCount: 3,
      panelConversation: conversation,
      ttsPlaybackMessageId: ttsTargetId,
      nowMs: Date.now(),
    });
    expect(rehydrated.ttsPlaybackMessageId).toBe(codexItemMessageId(threadId, "item-3"));
  });
});
