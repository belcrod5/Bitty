import { act, renderHook } from "@testing-library/react-native";
import type { DirectorySessionTreeState } from "../components/AppDrawer";
import { useConversation } from "../contexts/ConversationContext";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import type { LlmSessionHistoryEntry } from "./useLlmSessionExplorer";
import {
  formatSkiaMiniChatUpdatedAt,
  useSkiaMiniChatSessions,
} from "./useSkiaMiniChatSessions";
import { IDLE_DIRECTORY_SESSION_SYNC } from "../types/directorySessions";

jest.mock("../contexts/ConversationContext", () => ({
  useConversation: jest.fn(),
}));
jest.mock("../contexts/PanelRuntimeControllerContext", () => ({
  usePanelRuntimeController: jest.fn(),
}));
jest.mock("../contexts/PanelRuntimeStoreContext", () => ({
  usePanelRuntimeStore: jest.fn(),
}));

const mockUseConversation = jest.mocked(useConversation);
const mockUsePanelRuntimeController = jest.mocked(usePanelRuntimeController);
const mockUsePanelRuntimeStore = jest.mocked(usePanelRuntimeStore);
const workspaceDirectory = {
  id: "workspace",
  path: "/workspace",
  displayName: "Workspace",
  markerColor: "none" as const,
};

beforeEach(() => {
  mockUsePanelRuntimeController.mockReturnValue({
    clearPanelSnapshot: jest.fn(),
    hydratePanelFromSessionHistory: jest.fn().mockResolvedValue("applied"),
  } as unknown as ReturnType<typeof usePanelRuntimeController>);
  mockUsePanelRuntimeStore.mockReturnValue({
    getSnapshot: (panelId: string) => {
      const index = Number(panelId.split("_").pop() || 0);
      const sessionIndex = 9 - index;
      return {
        selectedSessionId: `session-${sessionIndex}`,
        conversationMessages: [{ content: `Last message ${sessionIndex}` }],
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("useSkiaMiniChatSessions", () => {
  it("formats recent updates in seconds and minutes", () => {
    const now = new Date("2026-06-23T00:01:30.000Z").getTime();
    expect(formatSkiaMiniChatUpdatedAt("2026-06-23T00:01:18.000Z", now)).toBe("12秒前");
    expect(formatSkiaMiniChatUpdatedAt("2026-06-23T00:00:00.000Z", now)).toBe("1分前");
  });

  it("ensures registered sessions and returns only the latest six", async () => {
    const ensureRegisteredDirectorySessions = jest.fn().mockResolvedValue(undefined);
    mockUseConversation.mockReturnValue({
      registeredDirectories: [workspaceDirectory],
      directorySessionsById: {
        workspace: tree(Array.from({ length: 8 }, (_, index) => session(index + 1))),
      },
      sessionTitleOverridesById: { "session-8": "Pinned title" },
      sessionMarkerColorsById: { "session-8": "green" },
      formatSessionUpdatedAt: (value: string) => `formatted:${value}`,
      directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
      ensureRegisteredDirectorySessions,
    } as unknown as ReturnType<typeof useConversation>);

    const { result } = await renderHook(() => useSkiaMiniChatSessions());

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
    expect(result.current.sessions[0]).toMatchObject({
      title: "Pinned title",
      directoryName: "Workspace",
      lastMessageContent: "Last message 8",
      markerColor: "green",
      updatedAtLabel: expect.any(String),
    });
  });

  it("delegates callback identity changes to the shared controller", async () => {
    const firstEnsure = jest.fn().mockResolvedValue(undefined);
    const nextEnsure = jest.fn().mockResolvedValue(undefined);
    const { rerender } = await renderHook((ensure: () => Promise<void>) => {
      mockUseConversation.mockReturnValue({
        registeredDirectories: [],
        directorySessionsById: {},
        sessionTitleOverridesById: {},
        sessionMarkerColorsById: {},
        formatSessionUpdatedAt: (value: string) => value,
        directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
        ensureRegisteredDirectorySessions: ensure,
      } as unknown as ReturnType<typeof useConversation>);
      return useSkiaMiniChatSessions();
    }, { initialProps: firstEnsure });

    await rerender(nextEnsure);

    expect(firstEnsure).toHaveBeenCalledTimes(1);
    expect(nextEnsure).toHaveBeenCalledTimes(1);
  });

  it("settles failed panel hydration separately from directory sync", async () => {
    const clearPanelSnapshot = jest.fn();
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot,
      hydratePanelFromSessionHistory: jest.fn(async ({ sessionId }) => (
        sessionId === "session-1" ? "failed" : "applied"
      )),
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    mockUseConversation.mockReturnValue({
      registeredDirectories: [workspaceDirectory],
      directorySessionsById: {
        workspace: tree([session(2), session(1)]),
      },
      sessionTitleOverridesById: {},
      sessionMarkerColorsById: {},
      formatSessionUpdatedAt: (value: string) => value,
      directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
      ensureRegisteredDirectorySessions: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useConversation>);

    const { result } = await renderHook(() => useSkiaMiniChatSessions());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.hydratingPanelCount).toBe(0);
    expect(result.current.panelHydrationErrorCount).toBe(1);
    expect(clearPanelSnapshot).toHaveBeenCalledWith("skia_mini_preview_2");
    expect(result.current.directorySync.phase).toBe("idle");
  });

  it("rehydrates the panel session from history when opening the popup", async () => {
    const hydratePanelFromSessionHistory = jest.fn().mockResolvedValue("applied");
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory,
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    mockUseConversation.mockReturnValue({
      registeredDirectories: [workspaceDirectory],
      directorySessionsById: {
        workspace: tree([session(8)]),
      },
      sessionTitleOverridesById: { "session-8": "Pinned title" },
      sessionMarkerColorsById: {},
      formatSessionUpdatedAt: (value: string) => value,
      directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
      ensureRegisteredDirectorySessions: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useConversation>);

    const { result } = await renderHook(() => useSkiaMiniChatSessions());
    hydratePanelFromSessionHistory.mockClear();

    await act(async () => {
      result.current.refreshPanelSessionForPopup("skia_mini_preview_1");
    });

    expect(hydratePanelFromSessionHistory).toHaveBeenCalledWith(expect.objectContaining({
      panelId: "skia_mini_preview_1",
      sessionId: "session-8",
      directory: "/workspace",
      title: "Pinned title",
    }));
  });

  it("keeps a live responding panel untouched when opening the popup", async () => {
    const hydratePanelFromSessionHistory = jest.fn().mockResolvedValue("applied");
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory,
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    mockUsePanelRuntimeStore.mockReturnValue({
      getSnapshot: () => ({
        selectedSessionId: "session-8",
        conversationMessages: [],
        isResponding: true,
      }),
      getKnownPanelIds: () => [],
    } as unknown as ReturnType<typeof usePanelRuntimeStore>);
    mockUseConversation.mockReturnValue({
      registeredDirectories: [workspaceDirectory],
      directorySessionsById: {
        workspace: tree([session(8)]),
      },
      sessionTitleOverridesById: {},
      sessionMarkerColorsById: {},
      formatSessionUpdatedAt: (value: string) => value,
      directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
      ensureRegisteredDirectorySessions: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useConversation>);

    const { result } = await renderHook(() => useSkiaMiniChatSessions());
    hydratePanelFromSessionHistory.mockClear();

    await act(async () => {
      result.current.refreshPanelSessionForPopup("skia_mini_preview_1");
    });

    expect(hydratePanelFromSessionHistory).not.toHaveBeenCalled();
  });

  it("ignores a popup refresh for a panel without a session candidate", async () => {
    const hydratePanelFromSessionHistory = jest.fn().mockResolvedValue("applied");
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory,
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    mockUseConversation.mockReturnValue({
      registeredDirectories: [],
      directorySessionsById: {},
      sessionTitleOverridesById: {},
      sessionMarkerColorsById: {},
      formatSessionUpdatedAt: (value: string) => value,
      directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
      ensureRegisteredDirectorySessions: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useConversation>);

    const { result } = await renderHook(() => useSkiaMiniChatSessions());
    hydratePanelFromSessionHistory.mockClear();

    await act(async () => {
      result.current.refreshPanelSessionForPopup("skia_mini_preview_1");
    });

    expect(hydratePanelFromSessionHistory).not.toHaveBeenCalled();
  });

  it("ignores a failed hydration from an obsolete candidate generation", async () => {
    const oldHydration = deferred<"failed">();
    const clearPanelSnapshot = jest.fn();
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot,
      hydratePanelFromSessionHistory: jest.fn(({ sessionId }) => (
        sessionId === "session-1" ? oldHydration.promise : Promise.resolve("applied")
      )),
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    const ensureRegisteredDirectorySessions = jest.fn().mockResolvedValue(undefined);

    const { result, rerender } = await renderHook((candidate: LlmSessionHistoryEntry) => {
      mockUseConversation.mockReturnValue({
        registeredDirectories: [workspaceDirectory],
        directorySessionsById: {
          workspace: tree([candidate]),
        },
        sessionTitleOverridesById: {},
        sessionMarkerColorsById: {},
        formatSessionUpdatedAt: (value: string) => value,
        directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
        ensureRegisteredDirectorySessions,
      } as unknown as ReturnType<typeof useConversation>);
      return useSkiaMiniChatSessions();
    }, { initialProps: session(1) });

    await rerender(session(2));
    await act(async () => {
      await Promise.resolve();
      oldHydration.resolve("failed");
      await Promise.resolve();
    });

    expect(result.current.hydratingPanelCount).toBe(0);
    expect(result.current.panelHydrationErrorCount).toBe(0);
    expect(clearPanelSnapshot).not.toHaveBeenCalledWith("skia_mini_preview_1");
    expect(result.current.sessions[0].sessionId).toBe("session-2");
  });
});
