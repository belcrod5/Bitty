import { act, renderHook } from "@testing-library/react-native";
import type { Dispatch, SetStateAction } from "react";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";
import { buildPanelRuntimeSnapshot } from "../utils/panelRuntimeSnapshot";
import { usePanelConversationWriteController } from "./usePanelConversationWriteController";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";

function message(partial: Partial<ConversationMessage> & Pick<ConversationMessage, "id" | "role">): ConversationMessage {
  return { content: "", ...partial };
}

function emptySnapshot(panelId: string): PanelRuntimeSnapshot {
  return {
    panelId,
    selectedSessionId: "",
    selectedDirectoryPath: "",
    selectedDirectoryDisplayName: "",
    selectedSessionTitle: "",
    selectedSessionUpdatedAt: "",
    selectedSessionMarkerColor: "none",
    selectedThreadStatusType: "unknown",
    modelRef: "",
    reasoningEffort: "",
    contextUsedPct: null,
    isResponding: false,
    inheritedConversationMessages: [],
    conversationMessages: [],
  };
}

function panelEntry(
  panelId: string,
  sessionId: string,
  conversationMessages: ConversationMessage[]
): PanelRuntimeEntry {
  return {
    sessionId,
    snapshot: buildPanelRuntimeSnapshot({
      panelId,
      base: emptySnapshot(panelId),
      patch: { selectedSessionId: sessionId, conversationMessages },
      isCompactRunning: () => false,
    }),
  };
}

function createHarness(params: {
  visibleSessionId?: string;
  entries?: Record<string, PanelRuntimeEntry>;
  runtimes?: Record<string, {
    sessionId: string;
    conversationMessages: ConversationMessage[];
    contextUsedPct: number | null;
    isResponding: boolean;
    selectedThreadStatusType: string;
  }>;
}) {
  let entries: Record<string, PanelRuntimeEntry> = params.entries || {};
  const runtimeBySessionId: Record<string, {
    sessionId: string;
    conversationMessages: ConversationMessage[];
    contextUsedPct: number | null;
    isResponding: boolean;
    selectedThreadStatusType: string;
  }> = { ...params.runtimes };
  const setVisibleConversationMessages = jest.fn();
  const setVisibleReplyLoading = jest.fn();
  const setVisibleThreadStatusType = jest.fn();
  const setVisibleContextUsedPct = jest.fn();
  const setPanelRuntimeEntriesById: Dispatch<SetStateAction<Record<string, PanelRuntimeEntry>>> = (updater) => {
    entries = typeof updater === "function" ? updater(entries) : updater;
  };
  const options = {
    resolvePanelSnapshotForDisplay: (panelId: string) => entries[panelId]?.snapshot || emptySnapshot(panelId),
    createPanelRuntimeSnapshot: (
      panelId: string,
      base: PanelRuntimeSnapshot,
      patch?: Parameters<typeof buildPanelRuntimeSnapshot>[0]["patch"]
    ) => buildPanelRuntimeSnapshot({ panelId, base, patch, isCompactRunning: () => false }),
    getConversationRuntimeSnapshot: ((sessionId: string) => runtimeBySessionId[sessionId] || null) as any,
    upsertConversationRuntimeSnapshot: jest.fn((input: {
      sessionId: string;
      conversationMessages: ConversationMessage[];
      contextUsedPct: number | null;
      isResponding: boolean;
      selectedThreadStatusType: string;
    }) => {
      runtimeBySessionId[input.sessionId] = { ...input };
      return input;
    }),
    setPanelRuntimeEntriesById,
    getVisibleSessionId: () => params.visibleSessionId || "",
    setVisibleConversationMessages,
    setVisibleReplyLoading,
    setVisibleThreadStatusType,
    setVisibleContextUsedPct,
    logSessionDiag: jest.fn(),
  };
  return {
    options,
    setVisibleConversationMessages,
    setVisibleReplyLoading,
    setVisibleThreadStatusType,
    setVisibleContextUsedPct,
    getEntries: () => entries,
    getRuntime: (sessionId: string) => runtimeBySessionId[sessionId],
  };
}

const baseConversation = [
  message({ id: "u1", role: "user", content: "こんにちは" }),
  message({ id: "a1", role: "assistant", content: "どうしましたか" }),
];

const compactConversation = [
  ...baseConversation,
  message({ id: "u2", role: "user", content: "/compact" }),
  message({
    id: "a2",
    role: "assistant",
    content: "コンテキスト圧縮中です。完了まで待ってください。",
    llmStatusDetail: "slash command running: /compact",
  }),
];

describe("usePanelConversationWriteController", () => {
  test("表示中セッションへのパネル書込はアクティブ会話stateへ伝播する(/compact開始メッセージ回帰)", async () => {
    const harness = createHarness({
      visibleSessionId: "session-1",
      entries: { panel_1: panelEntry("panel_1", "session-1", baseConversation) },
    });
    const { result } = await renderHook(() => usePanelConversationWriteController(harness.options));

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        isResponding: true,
        sessionId: "session-1",
      });
    });

    expect(harness.setVisibleConversationMessages).toHaveBeenCalledTimes(1);
    const propagated = harness.setVisibleConversationMessages.mock.calls[0][0] as ConversationMessage[];
    expect(propagated.map((item) => item.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(propagated[3].content).toBe("コンテキスト圧縮中です。完了まで待ってください。");
    expect(harness.setVisibleReplyLoading).toHaveBeenCalledWith(true);
    expect(harness.setVisibleThreadStatusType).toHaveBeenCalledWith("active");
    expect(harness.getRuntime("session-1")?.conversationMessages.map((item) => item.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
    expect(
      harness.getEntries().panel_1.snapshot.conversationMessages.map((item) => item.id)
    ).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("表示中でないセッションへの書込はアクティブ会話stateへ触れない", async () => {
    const harness = createHarness({
      visibleSessionId: "other-session",
      entries: { panel_1: panelEntry("panel_1", "session-1", baseConversation) },
    });
    const { result } = await renderHook(() => usePanelConversationWriteController(harness.options));

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        isResponding: true,
        sessionId: "session-1",
      });
    });

    expect(harness.setVisibleConversationMessages).not.toHaveBeenCalled();
    expect(harness.setVisibleReplyLoading).not.toHaveBeenCalled();
    expect(harness.setVisibleThreadStatusType).not.toHaveBeenCalled();
    expect(harness.getRuntime("session-1")?.conversationMessages).toHaveLength(4);
    expect(harness.getEntries().panel_1.snapshot.conversationMessages).toHaveLength(4);
  });

  test("表示中コンテキスト率はcontextUsedPct明示時のみ更新する", async () => {
    const harness = createHarness({
      visibleSessionId: "session-1",
      entries: { panel_1: panelEntry("panel_1", "session-1", baseConversation) },
    });
    const { result } = await renderHook(() => usePanelConversationWriteController(harness.options));

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        isResponding: true,
        sessionId: "session-1",
      });
    });
    expect(harness.setVisibleContextUsedPct).not.toHaveBeenCalled();

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        isResponding: false,
        sessionId: "session-1",
        contextUsedPct: 42,
      });
    });
    expect(harness.setVisibleContextUsedPct).toHaveBeenCalledTimes(1);
    expect(harness.setVisibleContextUsedPct).toHaveBeenCalledWith(42);
  });

  test("別セッションへ切替済みのパネルには遅延書込を投影しない", async () => {
    const harness = createHarness({
      visibleSessionId: "session-b",
      entries: { panel_1: panelEntry("panel_1", "session-a", baseConversation) },
    });
    const { result } = await renderHook(() => usePanelConversationWriteController(harness.options));

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        isResponding: true,
        sessionId: "session-b",
      });
    });

    // source panelはsession不一致ガードにより据え置き。
    expect(harness.getEntries().panel_1.snapshot.selectedSessionId).toBe("session-a");
    expect(harness.getEntries().panel_1.snapshot.conversationMessages).toHaveLength(2);
    // 書込対象セッションのruntimeだけを更新し、切替後の表示stateには触れない。
    expect(harness.getRuntime("session-b")?.conversationMessages).toHaveLength(4);
    expect(harness.setVisibleConversationMessages).not.toHaveBeenCalled();
  });

  test("clear済みの共有パネルを遅延セッション書込が再取得しない", async () => {
    const harness = createHarness({
      visibleSessionId: "session-a",
      entries: {
        panel_1: {
          sessionId: "",
          snapshot: emptySnapshot("panel_1"),
        },
      },
    });
    const { result } = await renderHook(() => usePanelConversationWriteController(harness.options));

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        isResponding: true,
        sessionId: "session-a",
      });
    });

    expect(harness.getRuntime("session-a")?.conversationMessages).toHaveLength(4);
    expect(harness.getEntries().panel_1.snapshot.selectedSessionId).toBe("");
    expect(harness.getEntries().panel_1.snapshot.conversationMessages).toHaveLength(0);
    expect(harness.setVisibleConversationMessages).not.toHaveBeenCalled();
  });

  test("別セッションへの遅延書込は対象runtimeのcontext/statusを保持する", async () => {
    const sourceEntry = panelEntry("panel_1", "session-b", baseConversation);
    sourceEntry.snapshot.contextUsedPct = 88;
    sourceEntry.snapshot.isResponding = true;
    sourceEntry.snapshot.selectedThreadStatusType = "waiting_approval";
    const harness = createHarness({
      visibleSessionId: "session-a",
      entries: { panel_1: sourceEntry },
      runtimes: {
        "session-a": {
          sessionId: "session-a",
          conversationMessages: baseConversation,
          contextUsedPct: 12,
          isResponding: false,
          selectedThreadStatusType: "idle",
        },
      },
    });
    const { result } = await renderHook(() => usePanelConversationWriteController(harness.options));

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        sessionId: "session-a",
      });
    });

    expect(harness.getRuntime("session-a")).toMatchObject({
      contextUsedPct: 12,
      isResponding: false,
      selectedThreadStatusType: "idle",
    });
    expect(harness.getEntries().panel_1.snapshot.selectedSessionId).toBe("session-b");
    expect(harness.setVisibleConversationMessages).not.toHaveBeenCalled();
  });

  test("同一セッションを表示している他パネルにも書込が同期される", async () => {
    const harness = createHarness({
      visibleSessionId: "",
      entries: {
        panel_1: panelEntry("panel_1", "session-1", baseConversation),
        panel_2: panelEntry("panel_2", "session-1", baseConversation),
        panel_3: panelEntry("panel_3", "session-9", baseConversation),
      },
    });
    const { result } = await renderHook(() => usePanelConversationWriteController(harness.options));

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        isResponding: true,
        sessionId: "session-1",
      });
    });

    expect(harness.getEntries().panel_2.snapshot.conversationMessages).toHaveLength(4);
    expect(harness.getEntries().panel_3.snapshot.conversationMessages).toHaveLength(2);
  });

  test("初回turnでnative session IDを採用した時点でmaterializedを確定する", async () => {
    const draftEntry = panelEntry("panel_1", "local-draft", baseConversation);
    draftEntry.snapshot.sessionMaterialized = false;
    const harness = createHarness({
      visibleSessionId: "",
      entries: { panel_1: draftEntry },
    });
    const { result } = await renderHook(() => usePanelConversationWriteController(harness.options));

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        isResponding: true,
        sessionId: "native-thread",
        sessionMaterialized: true,
        adoptFromSessionId: "local-draft",
      });
    });

    expect(harness.getEntries().panel_1).toMatchObject({
      sessionId: "native-thread",
      snapshot: {
        selectedSessionId: "native-thread",
        sessionMaterialized: true,
      },
    });
  });

  test("native session ID採用時もパネルのbackendId/modelRefを保持する", async () => {
    const draftEntry = panelEntry("panel_1", "local-draft", baseConversation);
    draftEntry.snapshot.sessionMaterialized = false;
    draftEntry.snapshot.backendId = "claude";
    draftEntry.snapshot.modelRef = "sonnet";
    const harness = createHarness({
      visibleSessionId: "",
      entries: { panel_1: draftEntry },
    });
    const { result } = await renderHook(() => usePanelConversationWriteController(harness.options));

    await act(async () => {
      result.current.setPanelConversationMessagesForCodex("panel_1", compactConversation, {
        isResponding: true,
        sessionId: "0f0e0d0c-1b1a-4c4d-8e8f-000000000001",
        sessionMaterialized: true,
        adoptFromSessionId: "local-draft",
      });
    });

    expect(harness.getEntries().panel_1.snapshot).toMatchObject({
      selectedSessionId: "0f0e0d0c-1b1a-4c4d-8e8f-000000000001",
      sessionMaterialized: true,
      backendId: "claude",
      modelRef: "sonnet",
    });
  });
});
