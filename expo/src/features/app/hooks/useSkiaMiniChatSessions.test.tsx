import { renderHook } from "@testing-library/react-native";
import type { DirectorySessionTreeState } from "../components/AppDrawer";
import { useConversation } from "../contexts/ConversationContext";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import type { LlmSessionHistoryEntry } from "./useLlmSessionExplorer";
import {
  formatSkiaMiniChatUpdatedAt,
  useSkiaMiniChatSessions,
} from "./useSkiaMiniChatSessions";

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

describe("useSkiaMiniChatSessions", () => {
  it("formats recent updates in seconds and minutes", () => {
    const now = new Date("2026-06-23T00:01:30.000Z").getTime();
    expect(formatSkiaMiniChatUpdatedAt("2026-06-23T00:01:18.000Z", now)).toBe("12秒前");
    expect(formatSkiaMiniChatUpdatedAt("2026-06-23T00:00:00.000Z", now)).toBe("1分前");
  });

  it("refreshes registered sessions and returns only the latest six", async () => {
    const refreshRegisteredDirectorySessions = jest.fn().mockResolvedValue(undefined);
    mockUseConversation.mockReturnValue({
      registeredDirectories: [
        { id: "workspace", path: "/workspace", displayName: "Workspace", markerColor: "none" },
      ],
      directorySessionsById: {
        workspace: tree(Array.from({ length: 8 }, (_, index) => session(index + 1))),
      },
      sessionTitleOverridesById: { "session-8": "Pinned title" },
      sessionMarkerColorsById: { "session-8": "green" },
      formatSessionUpdatedAt: (value: string) => `formatted:${value}`,
      refreshRegisteredDirectorySessions,
    } as unknown as ReturnType<typeof useConversation>);

    const { result } = await renderHook(() => useSkiaMiniChatSessions());

    expect(refreshRegisteredDirectorySessions).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
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

  it("does not refresh again when the context callback identity changes", async () => {
    const firstRefresh = jest.fn().mockResolvedValue(undefined);
    const nextRefresh = jest.fn().mockResolvedValue(undefined);
    const { rerender } = await renderHook((refresh: () => Promise<void>) => {
      mockUseConversation.mockReturnValue({
        registeredDirectories: [],
        directorySessionsById: {},
        sessionTitleOverridesById: {},
        sessionMarkerColorsById: {},
        formatSessionUpdatedAt: (value: string) => value,
        refreshRegisteredDirectorySessions: refresh,
      } as unknown as ReturnType<typeof useConversation>);
      return useSkiaMiniChatSessions();
    }, { initialProps: firstRefresh });

    await rerender(nextRefresh);

    expect(firstRefresh).toHaveBeenCalledTimes(1);
    expect(nextRefresh).not.toHaveBeenCalled();
  });
});
