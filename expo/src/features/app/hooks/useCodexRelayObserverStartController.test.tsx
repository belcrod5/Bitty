import { act, renderHook } from "@testing-library/react-native";
import { useCodexRelayObserverStartController } from "./useCodexRelayObserverStartController";
import { codexItemMessageId } from "../utils/codexItemMessageId";
import {
  preserveTtsPlaybackMessageOnRestore,
  resolvePanelConversationAfterHydration,
} from "../utils/panelHydrationFreshness";
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
    codexRelayWatermarkByThreadRef: { current: {} as Record<string, { relayId: string; seq: number }> },
    onRelayWatermarkGap: jest.fn(),
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

describe("useCodexRelayObserverStartController relay loss recovery", () => {
  async function startObserver(reason: string) {
    const harness = createHarness([]);
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));
    await act(async () => {
      result.current.startCodexRelayObserverForSession("thread-1", {
        reason,
        directory: "/workspace",
        startedAtMs: Date.now(),
      });
    });
    return harness;
  }

  test("resume_miss on a session runtime observer routes into the relay-loss recovery", async () => {
    const harness = await startObserver("session_restored_running_turn");

    await act(async () => {
      harness.getObserverOptions().onLog({ stage: "relay_observer_resume_miss" });
    });

    expect(harness.options.finalizeSessionRuntimeAfterRelayLoss).toHaveBeenCalledWith(
      "thread-1",
      expect.any(String)
    );
    expect(harness.options.clearCodexRelayObserverForMiss).toHaveBeenCalledWith("thread-1", "/workspace");
  });

  test("relay_closed on a session runtime observer routes into the same recovery and closes the observer", async () => {
    const harness = await startObserver("session_restored_running_turn");

    await act(async () => {
      harness.getObserverOptions().onLog({ stage: "relay_observer_relay_closed" });
    });

    expect(harness.options.finalizeSessionRuntimeAfterRelayLoss).toHaveBeenCalledWith(
      "thread-1",
      expect.any(String)
    );
    expect(harness.options.closeCodexRelayObserver).toHaveBeenCalledWith("relay_closed");
  });

  test("relay_closed on a queue turn observer keeps waiting for reconnection", async () => {
    const harness = await startObserver("codex_queue_turn");

    await act(async () => {
      harness.getObserverOptions().onLog({ stage: "relay_observer_relay_closed" });
    });

    expect(harness.options.finalizeSessionRuntimeAfterRelayLoss).not.toHaveBeenCalled();
    expect(harness.options.closeCodexRelayObserver).not.toHaveBeenCalled();
  });
});

describe("useCodexRelayObserverStartController relay watermark", () => {
  test("resolves resumeFromSeq and resumeFromRelayId from the watermark when unspecified", async () => {
    const harness = createHarness([]);
    harness.options.codexRelayWatermarkByThreadRef.current["thread-1"] = {
      relayId: "relay-a",
      seq: 42,
    };
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));

    await act(async () => {
      result.current.startCodexRelayObserverForSession("thread-1", {
        reason: "session_restored_running_turn",
        directory: "/workspace",
        startedAtMs: Date.now(),
      });
    });

    const observerOptions = harness.getObserverOptions();
    expect(observerOptions.resumeFromSeq).toBe(42);
    expect(observerOptions.resumeFromRelayId).toBe("relay-a");
  });

  test("explicit resumeFromSeq wins over the watermark", async () => {
    const harness = createHarness([]);
    harness.options.codexRelayWatermarkByThreadRef.current["thread-1"] = {
      relayId: "relay-a",
      seq: 42,
    };
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));

    await act(async () => {
      result.current.startCodexRelayObserverForSession("thread-1", {
        reason: "session_restored_running_turn",
        directory: "/workspace",
        startedAtMs: Date.now(),
        resumeFromSeq: 7,
      });
    });

    const observerOptions = harness.getObserverOptions();
    expect(observerOptions.resumeFromSeq).toBe(7);
    expect(observerOptions.resumeFromRelayId).toBe("");
  });

  test("onRelaySeqAdvance updates the watermark monotonically", async () => {
    const harness = createHarness([]);
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));

    await act(async () => {
      result.current.startCodexRelayObserverForSession("thread-1", {
        reason: "session_restored_running_turn",
        directory: "/workspace",
        startedAtMs: Date.now(),
      });
    });
    const observerOptions = harness.getObserverOptions();

    await act(async () => {
      observerOptions.onRelaySeqAdvance({ threadId: "thread-1", relayId: "relay-a", seq: 10 });
    });
    expect(harness.options.codexRelayWatermarkByThreadRef.current["thread-1"]).toEqual({
      relayId: "relay-a",
      seq: 10,
    });

    // 後退はしない(単調増加)。relayIdは既知の値を保持する。
    await act(async () => {
      observerOptions.onRelaySeqAdvance({ threadId: "thread-1", relayId: "", seq: 3 });
    });
    expect(harness.options.codexRelayWatermarkByThreadRef.current["thread-1"]).toEqual({
      relayId: "relay-a",
      seq: 10,
    });
    expect(harness.options.onRelayWatermarkGap).not.toHaveBeenCalled();
  });

  test("onRelayReset overwrites the watermark and requests one HTTP gap resync", async () => {
    const harness = createHarness([]);
    harness.options.codexRelayWatermarkByThreadRef.current["thread-1"] = {
      relayId: "relay-old",
      seq: 200,
    };
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));

    await act(async () => {
      result.current.startCodexRelayObserverForSession("thread-1", {
        reason: "session_restored_running_turn",
        directory: "/workspace",
        startedAtMs: Date.now(),
      });
    });
    const observerOptions = harness.getObserverOptions();

    await act(async () => {
      observerOptions.onRelayReset({ threadId: "thread-1", relayId: "relay-new", seq: 50 });
    });
    expect(harness.options.codexRelayWatermarkByThreadRef.current["thread-1"]).toEqual({
      relayId: "relay-new",
      seq: 50,
    });
    expect(harness.options.onRelayWatermarkGap).toHaveBeenCalledTimes(1);
    expect(harness.options.onRelayWatermarkGap).toHaveBeenCalledWith("thread-1");
  });
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
    // 再生中はpreserveTtsPlaybackMessageOnRestoreがターゲットIDを維持して生存する。
    const preserved = preserveTtsPlaybackMessageOnRestore({
      restoredConversation: [
        message({ id: codexItemMessageId(threadId, "item-1"), role: "user", content: "question" }),
        message({ id: codexItemMessageId(threadId, "item-2"), role: "assistant", content: "partial done" }),
        message({ id: codexItemMessageId(threadId, "item-3"), role: "assistant", content: "second message  \n" }),
      ],
      currentConversation: conversation,
      ttsPlaybackMessageId: ttsTargetId,
    });
    const rehydrated = resolvePanelConversationAfterHydration({
      runtime: null,
      requestStartedAtMsAtHydrationStart: null,
      restoredConversation: preserved,
      restoredHasRunningTurn: false,
      restoredThreadStatusType: "idle",
      restoredUpdatedAtMs: Date.now(),
      restoredMessageCount: 3,
      panelConversation: conversation,
      ttsPlaybackMessageId: ttsTargetId,
      nowMs: Date.now(),
    });
    expect(rehydrated.conversationMessages.some((item) => item.id === ttsTargetId)).toBe(true);
    expect(rehydrated.ttsPlaybackMessageId).toBe(ttsTargetId);
  });
});
