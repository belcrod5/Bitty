import { act, render } from "@testing-library/react-native";
import { MiniBoardScreen } from "./MiniBoardScreen";
import { useConversation } from "../contexts/ConversationContext";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import { IDLE_DIRECTORY_SESSION_SYNC } from "../types/directorySessions";
import type { DirectorySessionTreeState } from "../types/directorySessions";
import type { LlmSessionHistoryEntry } from "../hooks/useLlmSessionExplorer";

jest.mock("./ChatScreen", () => {
  const ReactModule = require("react");
  const { Text } = require("react-native");
  return {
    ChatScreen: ({ panelId }: { panelId: string }) =>
      ReactModule.createElement(Text, null, `mock-chat-${panelId}`),
  };
});
jest.mock("../components/MiniBoardChatPreviewSkeleton", () => {
  const ReactModule = require("react");
  const { Text } = require("react-native");
  return {
    MiniBoardChatPreviewSkeleton: () => ReactModule.createElement(Text, null, "mock-skeleton"),
  };
});
jest.mock("../components/PopupChatOverlay", () => ({
  PopupChatOverlay: () => null,
}));
jest.mock("../components/CodexStatusSummaryMenu", () => ({
  CodexStatusSummaryMenu: () => null,
}));
jest.mock("../../runnerWs/RunnerWsConnectionStatus", () => ({
  RunnerWsConnectionStatus: () => null,
}));
jest.mock("../contexts/AppShellContext", () => ({
  useAppShell: () => ({ openDrawer: jest.fn() }),
}));
jest.mock("../contexts/ChatScreenContext", () => ({
  useChatScreen: () => ({ runnerRouteSelection: { selectedRoute: null } }),
}));
jest.mock("../contexts/ChatDiagnosticsContext", () => ({
  useChatDiagnostics: () => ({
    codexCliStatusText: "",
    codexCliStatusFetchedAtMs: 0,
    codexCliStatusLoading: false,
    codexAuthProfileId: "",
    codexAuthProfiles: [],
    codexAuthProfilesLoading: false,
    codexAuthSwitching: false,
    codexAuthSwitchError: "",
    refreshCodexCliStatus: jest.fn(),
    loadCodexAuthProfiles: jest.fn(),
    switchCodexAuthProfile: jest.fn(),
  }),
}));
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

function session(index: number): LlmSessionHistoryEntry {
  return {
    sessionId: `session-${index}`,
    parentSessionId: "",
    directory: "/workspace",
    updatedAt: `2026-08-${String(index).padStart(2, "0")}T00:00:00.000Z`,
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

function conversationValue(directorySessionsById: Record<string, DirectorySessionTreeState>) {
  return {
    registeredDirectories: [workspaceDirectory],
    directorySessionsById,
    directorySessionSync: IDLE_DIRECTORY_SESSION_SYNC,
    sessionMarkerColorsById: {},
    ensureRegisteredDirectorySessions: jest.fn().mockResolvedValue(undefined),
    refreshRegisteredDirectorySessions: jest.fn().mockResolvedValue(undefined),
    showChatBottomToast: jest.fn(),
    markSessionRead: jest.fn(),
    logSessionDiag: jest.fn(),
  } as unknown as ReturnType<typeof useConversation>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("MiniBoardScreen panel hydration status", () => {
  it("keeps loading while hydration is in flight and applies the result after an effect rerun", async () => {
    // 共有ストアのsnapshotを模擬(hydrate開始でapplyPanelHydrationStart相当を書き込む)
    const snapshotsByPanel: Record<string, unknown> = {};
    mockUsePanelRuntimeStore.mockReturnValue({
      getSnapshot: (panelId: string) => (
        snapshotsByPanel[panelId] || { panelId, selectedSessionId: "", conversationMessages: [] }
      ),
      getKnownPanelIds: () => [],
    } as unknown as ReturnType<typeof usePanelRuntimeStore>);
    const hydration = deferred<"applied">();
    const hydratePanelFromSessionHistory = jest.fn((params: { panelId: string; sessionId: string; updatedAt?: string }) => {
      snapshotsByPanel[params.panelId] = {
        panelId: params.panelId,
        selectedSessionId: params.sessionId,
        selectedSessionUpdatedAt: params.updatedAt || "",
        isHydrating: true,
        isResponding: false,
        conversationMessages: [],
      };
      return hydration.promise;
    });
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      copyPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory,
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    mockUseConversation.mockReturnValue(conversationValue({ workspace: tree([session(1)]) }));

    const { getByText, queryByText, rerender } = await render(<MiniBoardScreen />);
    await act(async () => {
      await Promise.resolve();
    });

    // 初回: hydrate発行済み・進行中 → スケルトン表示
    expect(hydratePanelFromSessionHistory).toHaveBeenCalledTimes(1);
    expect(getByText("mock-skeleton")).toBeTruthy();
    expect(queryByText("mock-chat-mini_preview_1")).toBeNull();

    // 同一候補のままdirectorySessionsByIdの参照だけ変わりeffectが再実行されても、
    // hydrate進行中(isHydrating)のsnapshotでreadyへ早期遷移しないこと
    // (readyにするとタップ時に未完成snapshotがポップアップへコピーされ固着する)
    mockUseConversation.mockReturnValue(conversationValue({ workspace: tree([session(1)]) }));
    await rerender(<MiniBoardScreen />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydratePanelFromSessionHistory).toHaveBeenCalledTimes(1);
    expect(queryByText("mock-chat-mini_preview_1")).toBeNull();
    expect(getByText("mock-skeleton")).toBeTruthy();

    // hydrate完了(旧effect runはキャンセル済み)でも結果が反映されreadyになること
    snapshotsByPanel["mini_preview_1"] = {
      panelId: "mini_preview_1",
      selectedSessionId: "session-1",
      selectedSessionUpdatedAt: session(1).updatedAt,
      isHydrating: false,
      isResponding: false,
      conversationMessages: [{ id: "m1", role: "assistant", content: "hello" }],
    };
    await act(async () => {
      hydration.resolve("applied");
      await Promise.resolve();
    });
    expect(getByText("mock-chat-mini_preview_1")).toBeTruthy();
    expect(queryByText("mock-skeleton")).toBeNull();
  });

  it("marks a settled fresh snapshot ready without re-hydrating (reentry)", async () => {
    const snapshotsByPanel: Record<string, unknown> = {
      mini_preview_1: {
        panelId: "mini_preview_1",
        selectedSessionId: "session-1",
        selectedSessionUpdatedAt: session(1).updatedAt,
        isHydrating: false,
        isResponding: false,
        conversationMessages: [{ id: "m1", role: "assistant", content: "hello" }],
      },
    };
    mockUsePanelRuntimeStore.mockReturnValue({
      getSnapshot: (panelId: string) => (
        snapshotsByPanel[panelId] || { panelId, selectedSessionId: "", conversationMessages: [] }
      ),
      getKnownPanelIds: () => [],
    } as unknown as ReturnType<typeof usePanelRuntimeStore>);
    const hydratePanelFromSessionHistory = jest.fn().mockResolvedValue("applied");
    mockUsePanelRuntimeController.mockReturnValue({
      clearPanelSnapshot: jest.fn(),
      copyPanelSnapshot: jest.fn(),
      hydratePanelFromSessionHistory,
    } as unknown as ReturnType<typeof usePanelRuntimeController>);
    mockUseConversation.mockReturnValue(conversationValue({ workspace: tree([session(1)]) }));

    const { getByText } = await render(<MiniBoardScreen />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(hydratePanelFromSessionHistory).not.toHaveBeenCalled();
    expect(getByText("mock-chat-mini_preview_1")).toBeTruthy();
  });
});
