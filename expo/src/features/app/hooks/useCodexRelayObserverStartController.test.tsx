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
    onRuntimeStatus: jest.fn(),
    ensureRuntimeRequestForRelay: jest.fn(),
    onSessionStreamBoundary: jest.fn(),
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

  test("reports replayed item completion as a non-delta session boundary", async () => {
    const harness = await startObserver("session_restored_running_turn");

    await act(async () => {
      harness.getObserverOptions().onEvent("item/completed", { item: { type: "agentMessage" } });
    });

    expect(harness.options.onSessionStreamBoundary).toHaveBeenCalledWith("thread-1");
  });

  test("projects replayed real Codex item starts into the shared runtime status", async () => {
    const harness = await startObserver("session_restored_running_turn");

    await act(async () => {
      harness.getObserverOptions().onEvent("item/started", {
        item: { type: "webSearch", query: "latest news" },
      });
    });

    expect(harness.options.onRuntimeStatus).toHaveBeenCalledWith(
      "thread-1",
      "tool_running",
      "tool start: web_search"
    );

    await act(async () => {
      harness.getObserverOptions().onEvent("item/started", {
        item: { type: "dynamicToolCall", toolName: "brave_search", arguments: { query: "latest news" } },
      });
    });
    expect(harness.options.onRuntimeStatus).toHaveBeenLastCalledWith(
      "thread-1",
      "tool_running",
      "tool start: brave_search"
    );

    await act(async () => {
      harness.getObserverOptions().onEvent("item/completed", {
        item: { type: "webSearch", query: "latest news" },
      });
    });
    expect(harness.options.onRuntimeStatus).toHaveBeenLastCalledWith(
      "thread-1",
      "model_processing",
      "webSearch completed"
    );
  });

  test("registers restored running turns at the relay attachment boundary", async () => {
    const harness = createHarness([]);
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));

    await act(async () => {
      result.current.startCodexRelayObserverForSession("thread-1", {
        reason: "session_restored_running_turn",
        directory: "/workspace",
        startedAtMs: 1234,
      });
    });

    expect(harness.options.ensureRuntimeRequestForRelay).toHaveBeenCalledWith({
      sessionId: "thread-1",
      sourcePanelId: undefined,
      startedAtMs: 1234,
      reason: "session_restored_running_turn",
    });
  });

  test("passes restored backend ownership to the provider-neutral observer", async () => {
    const harness = createHarness([]);
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));

    await act(async () => {
      result.current.startCodexRelayObserverForSession("thread-1", {
        reason: "session_restored_running_turn",
        directory: "/workspace",
        agentBackendId: "claude",
      });
    });

    expect(harness.getObserverOptions()).toMatchObject({
      threadId: "thread-1",
      backendId: "claude",
      preferNeutralAgent: true,
    });
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

  test("projects a restored failed turn as an error instead of normal completion", async () => {
    const harness = await startObserver("session_restored_running_turn");

    await act(async () => {
      harness.getObserverOptions().onTurnCompleted({
        outcome: "failed",
        error: { message: "backend failed" },
      });
    });

    expect(harness.options.onRuntimeStatus).toHaveBeenCalledWith("thread-1", "error", "backend failed");
    expect(harness.getSessionConversation().at(-1)).toMatchObject({
      role: "assistant",
      llmStatus: "error",
      llmStatusDetail: "backend failed",
    });
    expect(harness.completedCalls).toEqual([]);
    expect(harness.options.closeCodexRelayObserver).toHaveBeenCalledWith("turn_failed");
  });

  test("projects a restored interrupted turn distinctly from completion", async () => {
    const harness = await startObserver("session_restored_running_turn");

    await act(async () => {
      harness.getObserverOptions().onTurnCompleted({ outcome: "interrupted" });
    });

    expect(harness.options.onRuntimeStatus).toHaveBeenCalledWith("thread-1", "error", "turn interrupted");
    expect(harness.completedCalls).toEqual([]);
    expect(harness.options.closeCodexRelayObserver).toHaveBeenCalledWith("turn_interrupted");
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

  test("ignoreWatermark resumes from seq 0 even when a watermark exists", async () => {
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
        ignoreWatermark: true,
      });
    });

    // 承認待ち再開など: pending approvalはseq≦watermarkだとサーバーが再送しないため、
    // watermarkを使わずseq=0(現行turn補正)でreplayさせる。
    const observerOptions = harness.getObserverOptions();
    expect(observerOptions.resumeFromSeq).toBe(0);
    expect(observerOptions.resumeFromRelayId).toBe("");
  });

  test("a watermark without relayId is not used for resume (falls back to seq 0)", async () => {
    const harness = createHarness([]);
    harness.options.codexRelayWatermarkByThreadRef.current["thread-1"] = {
      relayId: "",
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

    // relayId不明のwatermarkはrelay作り直し照合が素通りになる(無音欠落リスク)ため使わない。
    const observerOptions = harness.getObserverOptions();
    expect(observerOptions.resumeFromSeq).toBe(0);
    expect(observerOptions.resumeFromRelayId).toBe("");
  });

  test("onRelaySeqAdvance with a different relayId replaces the seq instead of taking max", async () => {
    const harness = createHarness([]);
    harness.options.codexRelayWatermarkByThreadRef.current["thread-1"] = {
      relayId: "relay-a",
      seq: 200,
    };
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));

    await act(async () => {
      result.current.startCodexRelayObserverForSession("thread-1", {
        reason: "session_restored_running_turn",
        directory: "/workspace",
        startedAtMs: Date.now(),
        ignoreWatermark: true,
      });
    });
    const observerOptions = harness.getObserverOptions();

    // 別relayのseqは独立カウンタなので、maxではなく置き換える(古い大seqが残ると無音欠落)。
    await act(async () => {
      observerOptions.onRelaySeqAdvance({ threadId: "thread-1", relayId: "relay-b", seq: 50 });
    });
    expect(harness.options.codexRelayWatermarkByThreadRef.current["thread-1"]).toEqual({
      relayId: "relay-b",
      seq: 50,
    });
  });

  test("first relayId on a relayId-less watermark also replaces the seq", async () => {
    const harness = createHarness([]);
    // relayId未確定のままobserverがcloseした残留watermark(replay中にturn/completed等)。
    harness.options.codexRelayWatermarkByThreadRef.current["thread-1"] = {
      relayId: "",
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

    // 旧seq(別relayのカウンタかもしれない)をmaxで残すと、次回resumeで後退reset→
    // 不要なgapマーカーが1回発生する。relayId初確定時もseqは置き換える。
    await act(async () => {
      observerOptions.onRelaySeqAdvance({ threadId: "thread-1", relayId: "relay-a", seq: 50 });
    });
    expect(harness.options.codexRelayWatermarkByThreadRef.current["thread-1"]).toEqual({
      relayId: "relay-a",
      seq: 50,
    });
  });

  test("onRelayReset with latestSeq 0 updates the watermark without requesting a gap resync", async () => {
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

    // 新relayのlatestSeq=0は「まだ何も流れていない」= 欠落ゼロ確定。
    // relay完了TTL(60秒)明けの新turnごとに全文fetchが走るのを防ぐ。
    await act(async () => {
      observerOptions.onRelayReset({ threadId: "thread-1", relayId: "relay-new", seq: 0 });
    });
    expect(harness.options.codexRelayWatermarkByThreadRef.current["thread-1"]).toEqual({
      relayId: "relay-new",
      seq: 0,
    });
    expect(harness.options.onRelayWatermarkGap).not.toHaveBeenCalled();
  });

  test("resume_miss clears the watermark for the thread", async () => {
    const harness = createHarness([]);
    harness.options.codexRelayWatermarkByThreadRef.current["thread-1"] = {
      relayId: "relay-a",
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

    // eventLogトリム起因のresume_missは同じwatermarkで再attachしても再びmissする
    // (恒久ループ)ため、watermarkを破棄して次回はseq=0へ落とす。
    await act(async () => {
      harness.getObserverOptions().onLog({ stage: "relay_observer_resume_miss" });
    });
    expect(harness.options.codexRelayWatermarkByThreadRef.current["thread-1"]).toBeUndefined();
  });
});

describe("useCodexRelayObserverStartController message ids", () => {
  test("returns shared runtime to thinking after an intermediate agent message completes", async () => {
    const harness = createHarness([]);
    const { result } = await renderHook(() => useCodexRelayObserverStartController(harness.options as any));
    await act(async () => {
      result.current.startCodexRelayObserverForSession("thread-1", {
        reason: "session_restored_running_turn",
        directory: "/workspace",
        startedAtMs: Date.now(),
      });
      harness.getObserverOptions().onAgentMessageCompleted("intermediate answer", { itemId: "msg_aaa" });
    });

    expect(harness.options.onRuntimeStatus).toHaveBeenLastCalledWith(
      "thread-1",
      "model_processing",
      "agent message completed"
    );
    expect(harness.getSessionConversation()).toEqual([
      expect.objectContaining({ content: "intermediate answer", llmStatus: "model_generating" }),
    ]);
  });

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
