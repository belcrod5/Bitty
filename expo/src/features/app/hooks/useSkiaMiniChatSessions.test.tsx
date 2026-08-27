import React, { type PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react-native";
import type { DirectorySessionTreeState } from "../components/AppDrawer";
import { useConversation } from "../contexts/ConversationContext";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import {
  mutatePersistedSettings,
  readPersistedSettingsField,
} from "../utils/persistedSettingsFile";
import {
  fetchSkiaBoard,
  fetchSkiaBoardSessionSummaries,
  importSkiaBoard,
  postSkiaBoardOps,
  syncSkiaBoardIngestDirectories,
} from "../utils/skiaBoardRunnerApi";
import { applySkiaBoardOpsLocally } from "../utils/skiaBoardRunnerOps";
import type { LlmSessionHistoryEntry } from "./useLlmSessionExplorer";
import {
  formatSkiaMiniChatUpdatedAt,
  useSkiaMiniChatSessions,
} from "./useSkiaMiniChatSessions";
import { IDLE_DIRECTORY_SESSION_SYNC } from "../types/directorySessions";
import { SkiaBoardProvider, useSkiaBoard } from "../contexts/SkiaBoardContext";
import type { SkiaBoardCard, SkiaBoardState } from "../utils/skiaBoardState";

jest.mock("../contexts/ConversationContext", () => ({
  useConversation: jest.fn(),
}));
jest.mock("../contexts/PanelRuntimeControllerContext", () => ({
  usePanelRuntimeController: jest.fn(),
}));
jest.mock("../contexts/PanelRuntimeStoreContext", () => ({
  usePanelRuntimeStore: jest.fn(),
}));
jest.mock("../contexts/ChatScreenContext", () => ({
  useChatScreen: () => ({ runnerUrl: "http://runner", runnerToken: "runner-token" }),
}));
const mockWsEmitter: { handlers: Array<(message: { payload?: unknown }) => void> } = {
  handlers: [],
};
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => ({
    subscribe: (_filter: unknown, handler: (message: { payload?: unknown }) => void) => {
      mockWsEmitter.handlers.push(handler);
      return () => {};
    },
    subscribeSnapshot: jest.fn(() => () => {}),
    getSnapshot: () => ({ connectionState: "idle", generation: 0, connected: false }),
  }),
}));
// 端末ローカル保存はファイルIOをモックし、フィールドの読み書きだけ検証する。
jest.mock("../utils/persistedSettingsFile", () => ({
  SKIA_BOARD_STATE_FIELD: "skiaBoardState",
  SKIA_BOARD_CARD_TEXT_SCALE_FIELD: "skiaBoardCardTextScale",
  SKIA_BOARD_RUNNER_CACHE_FIELD: "skiaBoardRunnerCache",
  readPersistedSettingsField: jest.fn(),
  mutatePersistedSettings: jest.fn(),
}));
// ランナーAPIはインメモリのフェイクランナーで置き換える(op適用は実ロジックを共有)。
jest.mock("../utils/skiaBoardRunnerApi", () => ({
  fetchSkiaBoard: jest.fn(),
  fetchSkiaBoardSessionSummaries: jest.fn(),
  importSkiaBoard: jest.fn(),
  postSkiaBoardOps: jest.fn(),
  syncSkiaBoardIngestDirectories: jest.fn(),
}));

const mockUseConversation = jest.mocked(useConversation);
const mockUsePanelRuntimeController = jest.mocked(usePanelRuntimeController);
const mockUsePanelRuntimeStore = jest.mocked(usePanelRuntimeStore);
const mockReadPersistedSettingsField = jest.mocked(readPersistedSettingsField);
const mockMutatePersistedSettings = jest.mocked(mutatePersistedSettings);
const mockFetchSkiaBoard = jest.mocked(fetchSkiaBoard);
const mockImportSkiaBoard = jest.mocked(importSkiaBoard);
const mockPostSkiaBoardOps = jest.mocked(postSkiaBoardOps);
const mockSyncSkiaBoardIngestDirectories = jest.mocked(syncSkiaBoardIngestDirectories);
const mockFetchSkiaBoardSessionSummaries = jest.mocked(fetchSkiaBoardSessionSummaries);
const workspaceDirectory = {
  id: "workspace",
  path: "/workspace",
  displayName: "Workspace",
  markerColor: "none" as const,
};

// mutatePersistedSettingsへ書かれた端末ローカル設定を取り出す。
let persistedFile: Record<string, unknown> = {};

// フェイクランナー: ボード正本とrevisionを持ち、opは実ロジックで適用する。
let runnerStore: { initialized: boolean; revision: number; board: SkiaBoardState | null };

function runnerSnapshot() {
  return {
    initialized: runnerStore.initialized,
    revision: runnerStore.revision,
    board: runnerStore.board,
  };
}

function boardOf(cards: SkiaBoardCard[], extra: Partial<SkiaBoardState> = {}): SkiaBoardState {
  return {
    cards,
    sections: [],
    excludedSessionIds: [],
    ingestedUpdatedAtMs: 0,
    cardTextScale: 1,
    ...extra,
  };
}

function seedRunnerBoard(cards: SkiaBoardCard[], extra: Partial<SkiaBoardState> = {}) {
  runnerStore = { initialized: true, revision: 1, board: boardOf(cards, extra) };
}

function sessionCard(sessionId: string, col: number, row: number): SkiaBoardCard {
  return { kind: "session", sessionId, col, row };
}

beforeEach(() => {
  jest.clearAllMocks();
  persistedFile = {};
  mockWsEmitter.handlers = [];
  runnerStore = { initialized: false, revision: 0, board: null };
  mockReadPersistedSettingsField.mockImplementation(async (field: string) => persistedFile[field]);
  mockMutatePersistedSettings.mockImplementation(async (mutate) => {
    persistedFile = mutate(persistedFile);
  });
  mockFetchSkiaBoard.mockImplementation(async () => runnerSnapshot());
  mockSyncSkiaBoardIngestDirectories.mockResolvedValue({ ingestDirectories: [] });
  mockFetchSkiaBoardSessionSummaries.mockResolvedValue([]);
  mockImportSkiaBoard.mockImplementation(async (_auth, { board }) => {
    if (runnerStore.initialized) {
      return { status: "already_initialized", snapshot: runnerSnapshot() };
    }
    runnerStore = {
      initialized: true,
      revision: runnerStore.revision + 1,
      board: boardOf([], {}), // 下で全量置換
    };
    runnerStore.board = { ...boardOf([]), ...(board as SkiaBoardState) };
    return { status: "ok", snapshot: runnerSnapshot() };
  });
  mockPostSkiaBoardOps.mockImplementation(async (_auth, { baseRevision, ops }) => {
    if (!runnerStore.initialized) {
      return { status: "not_initialized", snapshot: runnerSnapshot() };
    }
    if (baseRevision !== runnerStore.revision) {
      return { status: "conflict", snapshot: runnerSnapshot() };
    }
    const next = applySkiaBoardOpsLocally(runnerStore.board as SkiaBoardState, ops as never);
    if (next !== runnerStore.board) {
      runnerStore = { ...runnerStore, revision: runnerStore.revision + 1, board: next };
    }
    return { status: "ok", snapshot: runnerSnapshot() };
  });
  mockUsePanelRuntimeController.mockReturnValue({
    clearPanelSnapshot: jest.fn(),
    hydratePanelFromSessionHistory: jest.fn().mockResolvedValue("applied"),
  } as unknown as ReturnType<typeof usePanelRuntimeController>);
  mockUsePanelRuntimeStore.mockReturnValue({
    getSnapshot: (panelId: string) => {
      const sessionId = panelId.replace("skia_mini_preview_", "");
      return {
        selectedSessionId: sessionId,
        conversationMessages: [{ content: `Last message ${sessionId.replace("session-", "")}` }],
      };
    },
    getKnownPanelIds: () => [],
  } as unknown as ReturnType<typeof usePanelRuntimeStore>);
});

function session(index: number): LlmSessionHistoryEntry {
  return {
    backendId: "codex",
    sessionId: `session-${index}`,
    parentSessionId: "",
    directory: "/workspace",
    updatedAt: `2026-06-${String(index).padStart(2, "0")}T00:00:00.000Z`,
    lastReadAt: "",
    source: "appserver",
    cwd: "/workspace",
    firstUserMessage: `Title ${index}`,
    agentRole: "",
    agentDisplayName: "",
    contextUsedPct: null,
    modelRef: "",
    reasoningEffort: "",
  };
}

function tree(entries: LlmSessionHistoryEntry[]): DirectorySessionTreeState {
  return {
    loading: false,
    refreshing: false,
    loadingMore: false,
    loaded: true,
    fetchedAtMs: 0,
    error: "",
    latestSessionId: "",
    nextCursor: "",
    hasMore: false,
    entries,
    childrenByParentId: {},
  };
}

function mockConversation(entries: LlmSessionHistoryEntry[], overrides: Record<string, unknown> = {}) {
  mockUseConversation.mockReturnValue({
    registeredDirectories: [workspaceDirectory],
    directorySessionsById: {
      workspace: tree(entries),
    },
    sessionTitleOverridesById: {},
    sessionMarkerColorsById: {},
    formatSessionUpdatedAt: (value: string) => value,
    directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
    ensureRegisteredDirectorySessions: jest.fn().mockResolvedValue(undefined),
    loadSessionChildrenBatch: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReturnType<typeof useConversation>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

function BoardWrapper({ children }: PropsWithChildren) {
  return <SkiaBoardProvider>{children}</SkiaBoardProvider>;
}

describe("useSkiaMiniChatSessions", () => {
  it("formats recent updates in minutes without a seconds label", () => {
    const now = new Date("2026-06-23T00:01:30.000Z").getTime();
    // 秒表示はラベルが毎秒変わりカードの再レンダリングを誘発するため分単位に丸める。
    expect(formatSkiaMiniChatUpdatedAt("2026-06-23T00:01:18.000Z", now)).toBe("1分未満");
    expect(formatSkiaMiniChatUpdatedAt("2026-06-23T00:00:00.000Z", now)).toBe("1分前");
    expect(formatSkiaMiniChatUpdatedAt("2026-06-22T23:00:00.000Z", now)).toBe("1時間前");
  });

  it("keeps item identity across minute ticks while card content is unchanged", async () => {
    jest.useFakeTimers();
    try {
      seedRunnerBoard([
        sessionCard("session-1", 0, 0),
        sessionCard("session-2", 1, 0),
        sessionCard("session-3", 0, 1),
      ]);
      mockConversation(Array.from({ length: 3 }, (_, index) => session(index + 1)));
      const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
      await flush();

      const itemsBefore = result.current.items;
      expect(itemsBefore.length).toBeGreaterThan(0);
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });

      // ラベル(n日前)が変わらない限り、tickでitems(配列と要素)のidentityは保たれる。
      expect(result.current.items).toBe(itemsBefore);
    } finally {
      jest.useRealTimers();
    }
  });

  it("imports the legacy local board to the runner on first connect", async () => {
    // ランナー未初期化+ローカル保存あり → 初回接続時にimportで引き継ぐ。
    persistedFile.skiaBoardState = {
      cards: [8, 7, 6, 5, 4, 3].map((index, position) => ({
        sessionId: `session-${index}`,
        col: position % 2,
        row: Math.floor(position / 2),
      })),
      excludedSessionIds: [],
      ingestedUpdatedAtMs: new Date(session(8).updatedAt).getTime(),
    };
    const ensureRegisteredDirectorySessions = jest.fn().mockResolvedValue(undefined);
    mockConversation(
      Array.from({ length: 8 }, (_, index) => session(index + 1)),
      {
        sessionTitleOverridesById: { "session-8": "Pinned title" },
        sessionMarkerColorsById: { "session-8": "green" },
        ensureRegisteredDirectorySessions,
      }
    );

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(ensureRegisteredDirectorySessions).toHaveBeenCalledTimes(1);
    expect(mockImportSkiaBoard).toHaveBeenCalledTimes(1);
    expect(runnerStore.initialized).toBe(true);
    expect(result.current.directorySync.phase).toBe("idle");
    expect(result.current.sessions).toHaveLength(6);
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual([
      "session-8",
      "session-7",
      "session-6",
      "session-5",
      "session-4",
      "session-3",
    ]);
    expect(result.current.sessions.map((item) => [item.col, item.row])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 2],
      [1, 2],
    ]);
    expect(result.current.sessions[0]).toMatchObject({
      panelId: "skia_mini_preview_session-8",
      title: "Pinned title",
      directory: "/workspace",
      source: "appserver",
      directoryName: "Workspace",
      lastMessageContent: "Last message 8",
      markerColor: "green",
      updatedAtLabel: expect.any(String),
    });
    // ランナー正本が読み取り専用キャッシュとして保存される。
    const cache = persistedFile.skiaBoardRunnerCache as { board: { cards: unknown[] } };
    expect(cache.board.cards).toHaveLength(6);
  });

  it("uses one bounded Unicode display title for hydration and the board card", async () => {
    const firstUserMessage = `  調査  ${"🙂".repeat(10_000)}  完了  `;
    const candidate = { ...session(1), firstUserMessage };
    const hydratePanelFromSessionHistory = jest.fn().mockResolvedValue("applied");
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory,
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    seedRunnerBoard([sessionCard("session-1", 0, 0)]);
    mockConversation([candidate]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    const displayTitle = result.current.sessions[0].title;
    expect(Array.from(displayTitle)).toHaveLength(200);
    expect(displayTitle.endsWith("🙂…")).toBe(true);
    expect(hydratePanelFromSessionHistory).toHaveBeenCalledWith(expect.objectContaining({
      title: displayTitle,
    }));
    expect(candidate.firstUserMessage).toBe(firstUserMessage);
  });

  it("projects unread, activity, and cached subagent counts onto cards", async () => {
    const parent = { ...session(1), lastReadAt: "2026-05-01T00:00:00.000Z" };
    const childState = {
      loading: false,
      loaded: true,
      error: "",
      entries: [
        { ...session(2), sessionId: "child-running", parentSessionId: parent.sessionId, threadStatusType: "active" as const },
        { ...session(3), sessionId: "child-done", parentSessionId: parent.sessionId, threadStatusType: "idle" as const },
      ],
    };
    mockUsePanelRuntimeStore.mockReturnValue({
      getSnapshot: () => ({
        selectedSessionId: parent.sessionId,
        isResponding: true,
        runtimeStatus: "tool_running",
        runtimeStatusDetail: "tool start: web_search",
        runtimeActivityTrail: ["thinking", "reading", "web"],
        conversationMessages: [{
          role: "assistant",
          content: "searching",
          llmStatus: "tool_running",
          llmStatusDetail: "tool start: file_edit",
        }],
      }),
      getKnownPanelIds: () => [],
    } as unknown as ReturnType<typeof usePanelRuntimeStore>);
    seedRunnerBoard([sessionCard(parent.sessionId, 0, 0)]);
    mockConversation([parent], {
      directorySessionsById: {
        workspace: {
          ...tree([parent]),
          childrenByParentId: { [parent.sessionId]: childState },
        },
      },
    });

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(result.current.sessions[0]).toMatchObject({
      unread: true,
      activityTrail: [
        { kind: "thinking", active: false },
        { kind: "reading", active: false },
        { kind: "web", active: true },
      ],
      subagentLoading: false,
      subagentRunningCount: 1,
      subagentTotalCount: 2,
    });
  });

  it("prefers the shared post-message runtime thinking status over stale message activity", async () => {
    const parent = session(1);
    mockUsePanelRuntimeStore.mockReturnValue({
      getSnapshot: () => ({
        selectedSessionId: parent.sessionId,
        isResponding: true,
        runtimeStatus: "model_processing",
        runtimeStatusDetail: "agent message completed",
        runtimeActivityTrail: ["web", "thinking"],
        conversationMessages: [{
          role: "assistant",
          content: "intermediate answer",
          llmStatus: "tool_running",
          llmStatusDetail: "tool start: web_search",
        }],
      }),
      getKnownPanelIds: () => [],
    } as unknown as ReturnType<typeof usePanelRuntimeStore>);
    seedRunnerBoard([sessionCard(parent.sessionId, 0, 0)]);
    mockConversation([parent], {
      directorySessionsById: {
        workspace: {
          ...tree([parent]),
          childrenByParentId: {
            [parent.sessionId]: { loading: false, loaded: true, error: "", entries: [] },
          },
        },
      },
    });

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(result.current.sessions[0].activityTrail).toEqual([
      { kind: "web", active: false },
      { kind: "thinking", active: true },
    ]);
  });

  it("marks every retained activity as completed when the turn is idle", async () => {
    const parent = session(1);
    mockUsePanelRuntimeStore.mockReturnValue({
      getSnapshot: () => ({
        selectedSessionId: parent.sessionId,
        isResponding: false,
        runtimeActivityTrail: ["reading", "writing", "web", "thinking"],
        conversationMessages: [],
      }),
      getKnownPanelIds: () => [],
    } as unknown as ReturnType<typeof usePanelRuntimeStore>);
    seedRunnerBoard([sessionCard(parent.sessionId, 0, 0)]);
    mockConversation([parent]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(result.current.sessions[0].activityTrail).toEqual([
      { kind: "reading", active: false },
      { kind: "writing", active: false },
      { kind: "web", active: false },
      { kind: "thinking", active: false },
    ]);
  });

  it("requests missing child trees once per directory", async () => {
    const loadSessionChildrenBatch = jest.fn().mockResolvedValue(undefined);
    seedRunnerBoard([
      sessionCard("session-2", 0, 0),
      sessionCard("session-1", 1, 0),
    ]);
    mockConversation([session(2), session(1)], { loadSessionChildrenBatch });

    await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(loadSessionChildrenBatch).toHaveBeenCalledTimes(1);
    expect(loadSessionChildrenBatch).toHaveBeenCalledWith(
      ["session-2", "session-1"],
      "/workspace"
    );
  });

  it("restores runner card positions instead of re-initializing", async () => {
    seedRunnerBoard([
      { kind: "session", sessionId: "session-2", col: 1.5, row: 2.25 },
      sessionCard("session-1", 0, 0),
    ]);
    mockConversation([session(2), session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(mockImportSkiaBoard).not.toHaveBeenCalled();
    expect(result.current.sessions.map((item) => [item.sessionId, item.col, item.row])).toEqual([
      ["session-2", 1.5, 2.25],
      ["session-1", 0, 0],
    ]);
  });

  it("derives a directory shortcut name instead of restoring its legacy snapshot", async () => {
    // 旧ローカル保存のnameフィールドはimport時のパースで落ち、表示名は都度導出される。
    persistedFile.skiaBoardState = {
      cards: [{
        kind: "directory",
        directory: "/workspace/projects/bitty",
        name: "Bitty",
        col: 1.5,
        row: 2.25,
      }],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    };
    mockConversation([]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(result.current.items).toEqual([{
      kind: "directory",
      cardId: "directory:/workspace/projects/bitty",
      directory: "/workspace/projects/bitty",
      name: "bitty",
      col: 1.5,
      row: 2.25,
    }]);
  });

  it("adds, recognizes, and removes a directory through runner ops", async () => {
    mockConversation([]);
    const { result } = await renderHook(() => useSkiaBoard(), { wrapper: BoardWrapper });
    await flush();

    await act(async () => {
      result.current.addDirectory({ directory: "/workspace/projects/bitty", name: "Bitty" });
    });
    await flush();

    expect(result.current.hasDirectory("/workspace/projects/bitty")).toBe(true);
    // 未初期化ランナーへの最初の編集はimportとして初期化される。
    expect(runnerStore.initialized).toBe(true);
    expect(runnerStore.board?.cards).toEqual([{
      kind: "directory",
      directory: "/workspace/projects/bitty",
      col: 0,
      row: 0,
    }]);

    await act(async () => {
      result.current.removeDirectory("/workspace/projects/bitty");
    });
    await flush();

    expect(result.current.hasDirectory("/workspace/projects/bitty")).toBe(false);
    expect(runnerStore.board?.cards).toEqual([]);
  });

  it("loads the runner board even when local bootstrap reads fail", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockReadPersistedSettingsField.mockRejectedValue(new Error("read failed"));
    seedRunnerBoard([
      sessionCard("session-2", 0, 0),
      sessionCard("session-1", 1, 0),
    ]);
    mockConversation([session(2), session(1)]);

    const { result } = await renderHook(() => ({
      board: useSkiaBoard(),
      preview: useSkiaMiniChatSessions(),
    }), { wrapper: BoardWrapper });
    await flush();

    expect(result.current.board.loaded).toBe(true);
    expect(result.current.preview.sessions.map((item) => item.sessionId)).toEqual([
      "session-2",
      "session-1",
    ]);

    await act(async () => {
      result.current.board.removeSession("session-2");
    });
    await flush();
    expect(result.current.preview.sessions.map((item) => item.sessionId)).toEqual(["session-1"]);
    expect(runnerStore.board?.excludedSessionIds).toEqual(["session-2"]);
    warnSpy.mockRestore();
  });

  it("resends queued ops after a network failure recovers", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    seedRunnerBoard([sessionCard("session-9", 0, 0)]);
    mockConversation([session(2), session(9)]);

    const { result } = await renderHook(() => useSkiaBoard(), { wrapper: BoardWrapper });
    await flush();

    mockPostSkiaBoardOps.mockRejectedValueOnce(new Error("network down"));
    await act(async () => {
      result.current.addSession("session-2");
    });
    await flush();
    // 送信は失敗したが、楽観反映は維持され、ランナーは未変更。
    expect(result.current.hasSession("session-2")).toBe(true);
    expect(runnerStore.board?.cards.map((card) => (card.kind === "session" ? card.sessionId : ""))).toEqual(["session-9"]);

    // 次の操作で保留opごと再送される。
    await act(async () => {
      result.current.moveCard("session:session-9", 2, 2);
    });
    await flush();

    const cards = runnerStore.board?.cards || [];
    expect(cards.map((card) => (card.kind === "session" ? card.sessionId : ""))).toEqual([
      "session-9",
      "session-2",
    ]);
    expect(cards[0]).toMatchObject({ col: 2, row: 2 });
    // 手動追加カードには候補由来の出所情報が付く。
    expect(cards[1]).toMatchObject({ directory: "/workspace", backendId: "codex" });
    warnSpy.mockRestore();
  });

  it("keeps removed sessions excluded and applies the exclusion on the runner", async () => {
    seedRunnerBoard([
      sessionCard("session-2", 0, 0),
      sessionCard("session-1", 1, 0),
    ]);
    mockConversation([session(2), session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();
    expect(result.current.sessions).toHaveLength(2);

    await act(async () => {
      result.current.removeBoardSession("session-2");
    });
    await flush();

    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["session-1"]);
    expect(runnerStore.board?.excludedSessionIds).toEqual(["session-2"]);
    expect(runnerStore.board?.cards.map((card) => (card.kind === "session" ? card.sessionId : ""))).toEqual(["session-1"]);
  });

  it("applies moved and tidied card positions on the runner", async () => {
    seedRunnerBoard([
      sessionCard("session-2", 0, 0),
      sessionCard("session-1", 1, 0),
    ]);
    mockConversation([session(2), session(1)]);
    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    await act(async () => {
      result.current.moveBoardCard("session:session-2", 2.5, 3.5);
    });
    await flush();
    expect(runnerStore.board?.cards.find((card) => card.kind === "session" && card.sessionId === "session-2")).toMatchObject({
      col: 2.5,
      row: 3.5,
    });

    await act(async () => {
      result.current.tidyBoard();
    });
    await flush();
    expect(runnerStore.board?.cards.map((card) => [card.col, card.row])).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it("tidies visible cards without gaps and keeps hidden cards after them", async () => {
    seedRunnerBoard([
      { kind: "session", sessionId: "session-2", col: 3, row: 3 },
      { kind: "session", sessionId: "session-9", col: 4, row: 4 },
      { kind: "session", sessionId: "session-1", col: 5, row: 5 },
    ], { ingestedUpdatedAtMs: new Date(session(9).updatedAt).getTime() });
    mockConversation([session(2), session(1)]);
    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    await act(async () => {
      result.current.tidyBoard();
    });
    await flush();

    const cards = (runnerStore.board?.cards || []) as Array<{ sessionId?: string; col: number; row: number }>;
    expect(cards.map((card) => [card.sessionId, card.col, card.row])).toEqual([
      ["session-2", 0, 0],
      ["session-1", 1, 0],
      ["session-9", 0, 1],
    ]);
    expect(result.current.sessions.map((item) => [item.sessionId, item.col, item.row])).toEqual([
      ["session-2", 0, 0],
      ["session-1", 1, 0],
    ]);
  });

  it("persists card text scale as a device-local setting", async () => {
    seedRunnerBoard([sessionCard("session-1", 0, 0)]);
    mockConversation([session(1)]);
    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    await act(async () => {
      result.current.setBoardCardTextScale(1.1);
    });
    await flush();

    expect(result.current.cardTextScale).toBe(1.1);
    // 文字倍率はランナー共有ボードではなく端末ローカル設定として保存する。
    expect(persistedFile.skiaBoardCardTextScale).toBe(1.1);
    expect(runnerStore.board?.cardTextScale).toBe(1);
  });

  it("settles failed panel hydration separately from directory sync", async () => {
    const clearPanelSnapshot = jest.fn();
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot,
      hydratePanelFromSessionHistory: jest.fn(async ({ sessionId }) => (
        sessionId === "session-1" ? "failed" : "applied"
      )),
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    seedRunnerBoard([
      sessionCard("session-2", 0, 0),
      sessionCard("session-1", 1, 0),
    ]);
    mockConversation([session(2), session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(result.current.hydratingPanelCount).toBe(0);
    expect(result.current.panelHydrationErrorCount).toBe(1);
    expect(clearPanelSnapshot).toHaveBeenCalledWith("skia_mini_preview_session-1");
    expect(result.current.directorySync.phase).toBe("idle");
  });

  it("skips hydration when the panel snapshot already holds the fresh session", async () => {
    const hydratePanelFromSessionHistory = jest.fn().mockResolvedValue("applied");
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory,
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    mockUsePanelRuntimeStore.mockReturnValue({
      getSnapshot: (panelId: string) => (
        panelId === "skia_mini_preview_session-1"
          ? {
            selectedSessionId: "session-1",
            selectedSessionUpdatedAt: session(1).updatedAt,
            isResponding: false,
            isHydrating: false,
            conversationMessages: [{ content: "kept" }],
          }
          : { selectedSessionId: "", conversationMessages: [] }
      ),
      getKnownPanelIds: () => [],
    } as unknown as ReturnType<typeof usePanelRuntimeStore>);
    seedRunnerBoard([sessionCard("session-1", 0, 0)]);
    mockConversation([session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(hydratePanelFromSessionHistory).not.toHaveBeenCalled();
    expect(result.current.hydratingPanelCount).toBe(0);
    expect(result.current.sessions[0].lastMessageContent).toBe("kept");
  });

  it("skips hydration while the assigned session is live-responding", async () => {
    const hydratePanelFromSessionHistory = jest.fn().mockResolvedValue("applied");
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory,
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    mockUsePanelRuntimeStore.mockReturnValue({
      getSnapshot: (panelId: string) => (
        panelId === "skia_mini_preview_session-2"
          ? {
            selectedSessionId: "session-2",
            selectedSessionUpdatedAt: session(1).updatedAt,
            isResponding: true,
            isHydrating: false,
            conversationMessages: [{ content: "live" }],
          }
          : { selectedSessionId: "", conversationMessages: [] }
      ),
      getKnownPanelIds: () => [],
    } as unknown as ReturnType<typeof usePanelRuntimeStore>);
    seedRunnerBoard([sessionCard("session-2", 0, 0)]);
    mockConversation([session(2)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(hydratePanelFromSessionHistory).not.toHaveBeenCalled();
    expect(result.current.hydratingPanelCount).toBe(0);
  });

  it("shows out-of-window session cards via direct summaries", async () => {
    // ドロワーの取得ウィンドウ(candidates)に無いカードでも、カードの出所情報から
    // サマリを直接取得して表示する(5件ページング依存の解消)。
    seedRunnerBoard([
      sessionCard("session-1", 0, 0),
      { kind: "session", sessionId: "session-99", directory: "/workspace", backendId: "codex", col: 1, row: 0 },
    ]);
    mockFetchSkiaBoardSessionSummaries.mockResolvedValue([{
      sessionId: "session-99",
      directory: "/workspace",
      cwd: "/workspace",
      updatedAt: "2026-06-20T00:00:00.000Z",
      lastReadAt: "",
      source: "cli",
      firstUserMessage: "ウィンドウ外セッション",
      parentSessionId: "",
      contextUsage: { usedPct: 42.4 },
      modelRef: "codex-model",
      reasoningEffort: "medium",
    }]);
    mockConversation([session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();
    // サマリ取得→反映は次のeffectサイクルになるためもう一周流す。
    await flush();

    expect(mockFetchSkiaBoardSessionSummaries).toHaveBeenCalledWith(
      { runnerUrl: "http://runner", runnerToken: "runner-token" },
      { directory: "/workspace", sessionIds: ["session-99"] }
    );
    const summarySession = result.current.sessions.find((item) => item.sessionId === "session-99");
    expect(summarySession).toMatchObject({
      title: "ウィンドウ外セッション",
      directory: "/workspace",
      directoryName: "Workspace",
      backendId: "codex",
      unread: true,
      col: 1,
      row: 0,
    });
    // ウィンドウ内のセッションも従来どおり表示される。
    expect(result.current.sessions.map((item) => item.sessionId).sort()).toEqual([
      "session-1",
      "session-99",
    ]);
  });

  it("prefers the card backendId over the summary fallback", async () => {
    seedRunnerBoard([
      { kind: "session", sessionId: "session-77", directory: "/workspace", backendId: "claude", col: 0, row: 0 },
    ]);
    mockFetchSkiaBoardSessionSummaries.mockResolvedValue([{
      sessionId: "session-77",
      directory: "/workspace",
      cwd: "/workspace",
      updatedAt: "2026-06-20T00:00:00.000Z",
      lastReadAt: "2026-06-21T00:00:00.000Z",
      source: "cli",
      firstUserMessage: "別バックエンドのセッション",
      parentSessionId: "",
      contextUsage: null,
      modelRef: "",
      reasoningEffort: "",
    }]);
    mockConversation([]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();
    await flush();

    expect(result.current.sessions[0]).toMatchObject({
      sessionId: "session-77",
      backendId: "claude",
      unread: false,
    });
  });

  it("does not fetch summaries when every board card is inside the window", async () => {
    seedRunnerBoard([sessionCard("session-1", 0, 0)]);
    mockConversation([session(1)]);

    await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(mockFetchSkiaBoardSessionSummaries).not.toHaveBeenCalled();
  });

  it("keeps cards without origin info hidden outside the window", async () => {
    // 出所情報(directory)の無い旧カードは、従来どおり位置だけ保持して非表示。
    seedRunnerBoard([
      sessionCard("session-1", 0, 0),
      sessionCard("session-99", 1, 0),
    ]);
    mockConversation([session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(mockFetchSkiaBoardSessionSummaries).not.toHaveBeenCalled();
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["session-1"]);
  });

  it("offers the legacy board even when the runner is already initialized", async () => {
    // ランナーが自動生成で先に初期化されていても引き継ぎを一度は試み、
    // 受理判定(未編集ingestなら上書き/それ以外は現状維持)はサーバーに任せる。
    persistedFile.skiaBoardState = {
      cards: [{ sessionId: "legacy-session", col: 0, row: 0 }],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    };
    seedRunnerBoard([sessionCard("session-1", 0, 0)]);
    mockConversation([session(1)]);

    const { result } = await renderHook(() => useSkiaBoard(), { wrapper: BoardWrapper });
    await flush();

    expect(mockImportSkiaBoard).toHaveBeenCalledTimes(1);
    // フェイクランナーは初期化済みなので409相当: サーバー正本が表示される。
    expect(result.current.hasSession("session-1")).toBe(true);
    expect(result.current.hasSession("legacy-session")).toBe(false);
  });

  it("syncs registered directories to the runner once per content", async () => {
    seedRunnerBoard([sessionCard("session-1", 0, 0)]);
    mockConversation([session(1)]);

    const { rerender } = await renderHook(() => useSkiaBoard(), { wrapper: BoardWrapper });
    await flush();

    expect(mockSyncSkiaBoardIngestDirectories).toHaveBeenCalledTimes(1);
    expect(mockSyncSkiaBoardIngestDirectories.mock.calls[0][1]).toEqual({
      directories: ["/workspace"],
    });

    // 同一内容の再レンダリングでは再送しない。
    await rerender(undefined as never);
    await flush();
    expect(mockSyncSkiaBoardIngestDirectories).toHaveBeenCalledTimes(1);
  });

  it("retries the legacy import after a transient failure", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    persistedFile.skiaBoardState = {
      cards: [{ sessionId: "session-1", col: 0, row: 0 }],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: 0,
    };
    const workingImport = mockImportSkiaBoard.getMockImplementation()!;
    mockImportSkiaBoard.mockRejectedValue(new Error("network down"));
    mockConversation([session(1)]);

    const { result } = await renderHook(() => useSkiaBoard(), { wrapper: BoardWrapper });
    await flush();

    // importが失敗する間はランナー未初期化のまま、表示はローカルのボードを維持。
    expect(runnerStore.initialized).toBe(false);
    expect(result.current.state?.cards).toHaveLength(1);

    // ネットワーク復旧後のトリガ(WS通知)で引き継ぎが再試行される(恒久スキップしない)。
    mockImportSkiaBoard.mockImplementation(workingImport);
    await act(async () => {
      mockWsEmitter.handlers.forEach((handler) => handler({ payload: { revision: 99 } }));
    });
    await flush();

    expect(runnerStore.initialized).toBe(true);
    expect(runnerStore.board?.cards).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("ignores a stale refresh snapshot that would roll back a confirmed edit", async () => {
    seedRunnerBoard([sessionCard("session-1", 0, 0)]);
    mockConversation([session(1)]);
    const { result } = await renderHook(() => useSkiaBoard(), { wrapper: BoardWrapper });
    await flush();

    // 遅いGETが古いスナップショットを返す状況を作る。
    const stale = deferred<ReturnType<typeof runnerSnapshot>>();
    const staleSnapshot = runnerSnapshot();
    mockFetchSkiaBoard.mockImplementationOnce(() => stale.promise as never);
    await act(async () => {
      mockWsEmitter.handlers.forEach((handler) => handler({ payload: { revision: 2 } }));
    });

    // GET保留中に編集が確定してrevisionが進む。
    await act(async () => {
      result.current.moveCard("session:session-1", 3, 3);
    });
    await flush();
    expect(runnerStore.revision).toBe(2);

    // 遅れて届いた古いスナップショットは表示もrevisionも巻き戻さない。
    await act(async () => {
      stale.resolve(staleSnapshot);
    });
    await flush();
    expect(result.current.state?.cards[0]).toMatchObject({ col: 3, row: 3 });

    // 次のopが古いbaseRevisionでconflictにならない。
    await act(async () => {
      result.current.moveCard("session:session-1", 4, 4);
    });
    await flush();
    expect(runnerStore.revision).toBe(3);
    expect(runnerStore.board?.cards[0]).toMatchObject({ col: 4, row: 4 });
  });

  it("ignores a failed hydration from an obsolete candidate generation", async () => {
    const oldHydration = deferred<"failed">();
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory: jest.fn(({ sessionId }) => (
        sessionId === "session-1" ? oldHydration.promise : Promise.resolve("applied")
      )),
    } as unknown as ReturnType<typeof usePanelRuntimeController>);

    seedRunnerBoard([
      sessionCard("session-1", 0, 0),
      sessionCard("session-2", 1, 0),
    ]);
    mockConversation([session(1)]);
    const { result, rerender } = await renderHook(
      (_candidate: LlmSessionHistoryEntry) => useSkiaMiniChatSessions(),
      { initialProps: session(1), wrapper: BoardWrapper }
    );
    await flush();

    mockConversation([session(2)]);
    await rerender(session(2));
    await act(async () => {
      await Promise.resolve();
      oldHydration.resolve("failed");
      await Promise.resolve();
    });

    expect(result.current.hydratingPanelCount).toBe(0);
    expect(result.current.panelHydrationErrorCount).toBe(0);
    expect(result.current.sessions.map((item) => item.sessionId)).toContain("session-2");
  });
});
