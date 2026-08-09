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
import type { LlmSessionHistoryEntry } from "./useLlmSessionExplorer";
import {
  formatSkiaMiniChatUpdatedAt,
  useSkiaMiniChatSessions,
} from "./useSkiaMiniChatSessions";
import { IDLE_DIRECTORY_SESSION_SYNC } from "../types/directorySessions";
import { SkiaBoardProvider } from "../contexts/SkiaBoardContext";

jest.mock("../contexts/ConversationContext", () => ({
  useConversation: jest.fn(),
}));
jest.mock("../contexts/PanelRuntimeControllerContext", () => ({
  usePanelRuntimeController: jest.fn(),
}));
jest.mock("../contexts/PanelRuntimeStoreContext", () => ({
  usePanelRuntimeStore: jest.fn(),
}));
// 端末ローカル保存はファイルIOをモックし、ボードステートの読み書きだけ検証する。
jest.mock("../utils/persistedSettingsFile", () => ({
  SKIA_BOARD_STATE_FIELD: "skiaBoardState",
  readPersistedSettingsField: jest.fn(),
  mutatePersistedSettings: jest.fn(),
}));

const mockUseConversation = jest.mocked(useConversation);
const mockUsePanelRuntimeController = jest.mocked(usePanelRuntimeController);
const mockUsePanelRuntimeStore = jest.mocked(usePanelRuntimeStore);
const mockReadPersistedSettingsField = jest.mocked(readPersistedSettingsField);
const mockMutatePersistedSettings = jest.mocked(mutatePersistedSettings);
const workspaceDirectory = {
  id: "workspace",
  path: "/workspace",
  displayName: "Workspace",
  markerColor: "none" as const,
};

// mutatePersistedSettingsへ書かれたボードステートを取り出す。
let persistedFile: Record<string, unknown> = {};

beforeEach(() => {
  jest.clearAllMocks();
  persistedFile = {};
  mockReadPersistedSettingsField.mockImplementation(async (field: string) => persistedFile[field]);
  mockMutatePersistedSettings.mockImplementation(async (mutate) => {
    persistedFile = mutate(persistedFile);
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
    await Promise.resolve();
    await Promise.resolve();
  });
}

function BoardWrapper({ children }: PropsWithChildren) {
  return <SkiaBoardProvider>{children}</SkiaBoardProvider>;
}

describe("useSkiaMiniChatSessions", () => {
  it("formats recent updates in seconds and minutes", () => {
    const now = new Date("2026-06-23T00:01:30.000Z").getTime();
    expect(formatSkiaMiniChatUpdatedAt("2026-06-23T00:01:18.000Z", now)).toBe("12秒前");
    expect(formatSkiaMiniChatUpdatedAt("2026-06-23T00:00:00.000Z", now)).toBe("1分前");
  });

  it("initializes the board with the latest six sessions on a grid", async () => {
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
    // 初期配置は2列グリッド。
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
    // 初期化されたボードステートが永続化される。
    const savedState = persistedFile.skiaBoardState as { cards: Array<{ sessionId: string }> };
    expect(savedState.cards).toHaveLength(6);
  });

  it("restores persisted card positions instead of re-initializing", async () => {
    persistedFile.skiaBoardState = {
      cards: [
        { sessionId: "session-2", col: 1.5, row: 2.25 },
        { sessionId: "session-1", col: 0, row: 0 },
      ],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: new Date(session(2).updatedAt).getTime(),
    };
    mockConversation([session(2), session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(result.current.sessions.map((item) => [item.sessionId, item.col, item.row])).toEqual([
      ["session-2", 1.5, 2.25],
      ["session-1", 0, 0],
    ]);
  });

  it("stacks only sessions newer than the ingest watermark", async () => {
    persistedFile.skiaBoardState = {
      cards: [{ sessionId: "session-3", col: 0, row: 0 }],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: new Date(session(3).updatedAt).getTime(),
    };
    // session-2 はウォーターマークより古いので流入しない。session-4 は新しいので積み上げ。
    mockConversation([session(4), session(3), session(2)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(result.current.sessions.map((item) => item.sessionId)).toEqual([
      "session-3",
      "session-4",
    ]);
    // 既存カードの位置は動かさず、新カードは空きセルへ。
    expect(result.current.sessions[0]).toMatchObject({ col: 0, row: 0 });
    expect(result.current.sessions[1]).toMatchObject({ col: 1, row: 0 });
  });

  it("stays read-only and skips ingest when the persisted board state fails to load", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockReadPersistedSettingsField.mockRejectedValue(new Error("read failed"));
    mockConversation([session(2), session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    // 読込失敗中に初期化・保存すると保存済みの位置と除外リストが全損するため、
    // ボードは空のまま・書込なしで留まる。
    expect(result.current.sessions).toEqual([]);
    expect(mockMutatePersistedSettings).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not ingest or advance the watermark while directory sync is partially failed", async () => {
    const watermarkMs = new Date(session(3).updatedAt).getTime();
    persistedFile.skiaBoardState = {
      cards: [{ sessionId: "session-3", col: 0, row: 0 }],
      excludedSessionIds: [],
      ingestedUpdatedAtMs: watermarkMs,
    };
    // 一部ディレクトリ失敗中は候補が欠けている可能性があるため取り込まない
    // (取り込むとウォーターマークが復旧前のセッションを追い越して取りこぼす)。
    mockConversation([session(4), session(3)], {
      directorySessionSync: { ...IDLE_DIRECTORY_SESSION_SYNC, phase: "partial_error" },
    });

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["session-3"]);
    const savedState = persistedFile.skiaBoardState as {
      cards: Array<{ sessionId: string }>;
      ingestedUpdatedAtMs: number;
    };
    expect(savedState.cards.map((card) => card.sessionId)).toEqual(["session-3"]);
    expect(savedState.ingestedUpdatedAtMs).toBe(watermarkMs);
  });

  it("retries persisting after a failed write on the next state change", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockMutatePersistedSettings.mockRejectedValueOnce(new Error("write failed"));
    mockConversation([session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();
    // 初回書込は失敗し、ファイルには何も残らない。
    expect(persistedFile.skiaBoardState).toBeUndefined();

    await act(async () => {
      result.current.moveBoardCard("session:session-1", 2, 2);
    });
    await flush();

    // 次のステート変化で失敗分も含めて保存し直す。
    const savedState = persistedFile.skiaBoardState as {
      cards: Array<{ sessionId: string; col: number; row: number }>;
    };
    expect(savedState.cards).toEqual([{
      kind: "session",
      sessionId: "session-1",
      col: 2,
      row: 2,
    }]);
    warnSpy.mockRestore();
  });

  it("keeps removed sessions excluded from re-stacking and persists the exclusion", async () => {
    mockConversation([session(2), session(1)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();
    expect(result.current.sessions).toHaveLength(2);

    await act(async () => {
      result.current.removeBoardSession("session-2");
    });
    await flush();

    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["session-1"]);
    const savedState = persistedFile.skiaBoardState as {
      cards: Array<{ sessionId: string }>;
      excludedSessionIds: string[];
    };
    expect(savedState.excludedSessionIds).toEqual(["session-2"]);
    expect(savedState.cards.map((card) => card.sessionId)).toEqual(["session-1"]);
  });

  it("persists moved and tidied card positions", async () => {
    mockConversation([session(2), session(1)]);
    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    await act(async () => {
      result.current.moveBoardCard("session:session-2", 2.5, 3.5);
    });
    await flush();
    let savedState = persistedFile.skiaBoardState as { cards: Array<{ sessionId: string; col: number; row: number }> };
    expect(savedState.cards.find((card) => card.sessionId === "session-2")).toMatchObject({
      col: 2.5,
      row: 3.5,
    });

    await act(async () => {
      result.current.tidyBoard();
    });
    await flush();
    savedState = persistedFile.skiaBoardState as { cards: Array<{ sessionId: string; col: number; row: number }> };
    expect(savedState.cards.map((card) => [card.col, card.row])).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it("settles failed panel hydration separately from directory sync", async () => {
    const clearPanelSnapshot = jest.fn();
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot,
      hydratePanelFromSessionHistory: jest.fn(async ({ sessionId }) => (
        sessionId === "session-1" ? "failed" : "applied"
      )),
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
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
    mockConversation([session(2)]);

    const { result } = await renderHook(() => useSkiaMiniChatSessions(), { wrapper: BoardWrapper });
    await flush();

    expect(hydratePanelFromSessionHistory).not.toHaveBeenCalled();
    expect(result.current.hydratingPanelCount).toBe(0);
  });

  it("ignores a failed hydration from an obsolete candidate generation", async () => {
    const oldHydration = deferred<"failed">();
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory: jest.fn(({ sessionId }) => (
        sessionId === "session-1" ? oldHydration.promise : Promise.resolve("applied")
      )),
    } as unknown as ReturnType<typeof usePanelRuntimeController>);

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
