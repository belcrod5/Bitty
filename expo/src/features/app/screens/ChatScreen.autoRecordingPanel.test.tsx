import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Alert } from "react-native";
import { ChatScreen } from "./ChatScreen";

const mockStartAutoRecordingMode = jest.fn();
const mockLogSessionDiag = jest.fn();
const mockLoadOlderSessionHistory = jest.fn();
const mockCodexScheduleProps: { current: Record<string, any> | null } = { current: null };
const mockLocationScheduleProps: { current: Record<string, any> | null } = { current: null };
const mockLegendListProps: { current: Record<string, any> | null } = { current: null };
const mockAddSkiaBoardFile = jest.fn();
const mockRemoveSkiaBoardFile = jest.fn();
const mockHasSkiaBoardFile = jest.fn(() => false);
const mockMarkFileUnavailable = jest.fn();
const mockUseWorkspaceFileMutations = jest.fn((_params: unknown) => ({
  renameTarget: null,
  requestRename: jest.fn(),
  cancelRename: jest.fn(),
  renameFile: jest.fn(),
  renameFileTarget: jest.fn(),
  deleteFile: jest.fn(),
}));

jest.mock("@legendapp/list", () => {
  const ReactModule = jest.requireActual<typeof React>("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    LegendList: ReactModule.forwardRef((props: Record<string, any>, _ref) => {
      mockLegendListProps.current = props;
      return ReactModule.createElement(View, { testID: "legend-list" });
    }),
  };
});

jest.mock("@expo/vector-icons", () => {
  const ReactModule = jest.requireActual<typeof React>("react");
  const { Text: ReactNativeText } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    Ionicons: ({ name }: { name: string }) => (
      ReactModule.createElement(ReactNativeText, null, name)
    ),
  };
});

jest.mock("react-native-keyboard-controller", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return { KeyboardAvoidingView: View };
});

jest.mock("react-native-webview", () => ({ WebView: () => null }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => {}) }));
jest.mock("../../faceTracking/iosFaceTrackingClient", () => ({
  isIosFaceTrackingAvailable: () => false,
}));

jest.mock("../components/ChatContextUsageMenu", () => ({ ChatContextUsageMenu: () => null }));
jest.mock("../components/CodexStatusSummaryMenu", () => ({ CodexStatusSummaryMenu: () => null }));
jest.mock("../components/CommandExecutionRow", () => ({ CommandExecutionRow: () => null }));
jest.mock("../components/BouncingDotsIndicator", () => ({ BouncingDotsIndicator: () => null }));
jest.mock("../components/MarkdownText", () => {
  const ReactModule = jest.requireActual<typeof React>("react");
  const { TouchableOpacity } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    MarkdownText: ({ onLocalFileLinkPress }: {
      onLocalFileLinkPress?: (path: string) => void;
    }) => ReactModule.createElement(TouchableOpacity, {
      testID: "local-file-link",
      onPress: () => onLocalFileLinkPress?.("/external/tasks/today.checklist"),
    }),
  };
});
jest.mock("../components/PixelRobotIndicator", () => ({ PixelRobotIndicator: () => null }));
jest.mock("../components/SlashCommandSelectMenu", () => ({ SlashCommandSelectMenu: () => null }));
jest.mock("../components/TtsWaveformPlayer", () => ({ TtsWaveformPlayer: () => null }));
jest.mock("../components/YouTubeVideoList", () => ({ YouTubeVideoList: () => null }));
jest.mock("../components/GitDiffPanel", () => ({ GitDiffPanel: () => null }));
jest.mock("../components/RunnerMediaViewer", () => ({ RunnerMediaViewer: () => null }));
jest.mock("../components/WorkspaceFileRenameDialog", () => ({ WorkspaceFileRenameDialog: () => null }));
jest.mock("../components/ChatSessionSubagentList", () => ({ ChatSessionSubagentList: () => null }));
jest.mock("../../runnerWs/RunnerWsConnectionStatus", () => ({ RunnerWsConnectionStatus: () => null }));
jest.mock("../../locationSchedules/LocationScheduleSettings", () => ({
  LocationScheduleSettings: (props: Record<string, any>) => {
    mockLocationScheduleProps.current = props;
    return null;
  },
}));
jest.mock("../../codexSchedules/CodexScheduleSettings", () => ({
  CodexScheduleSettings: (props: Record<string, any>) => {
    mockCodexScheduleProps.current = props;
    return null;
  },
}));

jest.mock("../hooks/useWorkspaceFileMutations", () => ({
  useWorkspaceFileMutations: (params: unknown) => mockUseWorkspaceFileMutations(params),
}));

jest.mock("../contexts/SkiaBoardContext", () => ({
  useSkiaBoard: () => ({
    addFile: mockAddSkiaBoardFile,
    removeFile: mockRemoveSkiaBoardFile,
    hasFile: mockHasSkiaBoardFile,
    markFileUnavailable: mockMarkFileUnavailable,
    loaded: true,
  }),
}));

jest.mock("../contexts/AppShellContext", () => ({
  useAppShell: () => ({ openDrawer: jest.fn() }),
}));

jest.mock("../contexts/AppSettingsContext", () => ({
  useAppSettings: () => ({
    selectedModelLabel: "Claude Sonnet",
    reasoningEffort: "high",
    modelOptions: [
      {
        selectionKey: "codex::gpt-5.6-sol",
        backendId: "codex",
        modelId: "gpt-5.6-sol",
        label: "ChatGPT 5.6 Sol",
        supportsReasoningEffort: true,
        changeWithinSession: true,
        supportsScheduling: true,
      },
      {
        selectionKey: "claude::sonnet",
        backendId: "claude",
        modelId: "sonnet",
        label: "Claude Sonnet",
        supportsReasoningEffort: false,
        changeWithinSession: false,
        supportsScheduling: false,
      },
    ],
    llmBackend: "claude",
    modelRef: "sonnet",
    codexWsUrl: "ws://runner.test",
    thinkOptions: ["high"],
    selectModel: jest.fn(),
    selectThinkOption: jest.fn(),
  }),
}));

jest.mock("../contexts/PanelRuntimeStoreContext", () => ({
  usePanelRuntimeStore: () => ({
    getSnapshot: (panelId: string) => ({
      panelId,
      selectedSessionId: "session-1",
      selectedDirectoryPath: "/workspace",
      selectedDirectoryDisplayName: "Workspace",
      selectedSessionTitle: "Session",
      selectedSessionUpdatedAt: "",
      selectedSessionMarkerColor: "none",
      selectedThreadStatusType: "idle",
      backendId: "codex",
      modelRef: "gpt-5.6-sol",
      reasoningEffort: "high",
      contextUsedPct: 0,
      isResponding: false,
      inheritedConversationMessages: [],
      conversationMessages: [{ id: "message-1", role: "assistant", content: "hello" }],
    }),
  }),
}));

jest.mock("../contexts/PanelRuntimeControllerContext", () => ({
  usePanelRuntimeController: () => ({
    startNewPanelSession: jest.fn(),
    updatePanelSettings: jest.fn(),
    hydratePanelFromSessionHistory: jest.fn(async () => "applied"),
  }),
}));

jest.mock("../contexts/YouTubePlayerContext", () => ({
  useYouTubePlayer: () => ({
    activeYouTubeQueuePositionLabel: "",
    youtubeVideoMetaById: {},
    conversationInlineAnchorMessageId: "",
    showFloatingYouTubePlayer: false,
    setYoutubeInlineAnchor: jest.fn(),
    youtubePlayerVideoId: "",
    youtubeEmbedHtml: "",
    youtubeWebViewRef: { current: null },
    youtubePlayerSession: "",
    youtubeEmbedOrigin: "",
    handleYouTubeWebViewMessage: jest.fn(),
    openYouTubeVideo: jest.fn(),
    formatYouTubePublishedDate: jest.fn(),
    formatYouTubeViewCount: jest.fn(),
    updateYouTubeInlineLayoutFromAnchor: jest.fn(),
    streamReplyYouTubeVideos: [],
    youtubePlayerMessageId: "",
    streamReplyYouTubeVideoIds: [],
    showYouTubeOverlayPlayer: false,
    youtubeFloatingAnimatedPosition: null,
    markYouTubeFloatingControlInteraction: jest.fn(),
    youtubeFloatingInteractionMode: "",
    youtubeFloatingPanResponder: { panHandlers: {} },
    closeYouTubePlayer: jest.fn(),
  }),
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
  useDirectoryGitChangedFiles: () => ({
    branchName: "main",
    branches: [],
    stagedFiles: [],
    unstagedFiles: [],
    loading: false,
    error: "",
    behindCount: 0,
    refresh: jest.fn(),
  }),
}));

jest.mock("../contexts/ChatComposerContext", () => ({
  useChatComposer: () => ({
    composerWaveformVisible: false,
    autoWaveformAnimationEnabled: false,
    waveformDotGif: 0,
    autoSpeechDetected: false,
    composerDirectSttVisible: false,
    directNativeSttPreviewText: "",
    chatComposerInputRef: { current: null },
    showComposerFullscreenToggle: false,
    openComposerFullscreen: jest.fn(),
    setComposerInputFocused: jest.fn(),
    isDirectNativeSttProvider: false,
    directNativeSttEnabled: false,
    autoRecordingEnabled: false,
    manualRecording: false,
    faceTrackingEnabled: false,
    faceTrackingLooking: true,
    canStopLlmTurn: false,
    stopDirectNativeStt: jest.fn(),
    stopAutoRecordingMode: jest.fn(),
    stopRecording: jest.fn(),
    stopLlmTurn: jest.fn(),
    startDirectNativeStt: jest.fn(),
    startAutoRecordingMode: mockStartAutoRecordingMode,
    setFaceTrackingEnabledWithRef: jest.fn(),
    faceTrackingRunning: false,
    setSlashCommandSelectOpen: jest.fn(),
    slashCommandOptions: [],
    onSelectSlashCommand: jest.fn(),
  }),
}));

jest.mock("../contexts/ChatVisualContext", () => ({
  useChatVisual: () => ({
    isRobotAnimating: false,
    pixelRobotImage: 0,
    pixelRobotImageStatic: 0,
    chatContextUsedPct: 0,
    chatContextRingTrackColor: "#000",
    chatContextRingProgressColor: "#000",
    formatElapsedHhMmSs: () => "00:00",
    llmStatusVisual: () => ({ text: "#000", background: "#fff", border: "#000" }),
    llmStatusLabel: () => "",
    resolvePixelStatusIconKey: () => "idle",
    buildSttMetaChips: () => [],
    ttsPlaybackMessageId: "",
    isTtsPlaybackActive: false,
    ttsSegmentProgress: {},
    pixelStatusAnimations: {},
    llmElapsedLiveMs: 0,
    error: "",
    chatBottomToast: null,
    chatBottomToastAnimRef: { current: null },
  }),
}));

jest.mock("../contexts/ChatScreenContext", () => ({
  useChatScreen: () => ({
    approvalDialogPending: false,
    setChatScreenLayout: jest.fn(),
    setChatViewportHeight: jest.fn(),
    handleChatScroll: jest.fn(),
    chatContentRef: { current: null },
    onChatTouchStart: jest.fn(),
    onChatTouchEnd: jest.fn(),
    runnerUrl: "http://runner.test",
    runnerToken: "runner-token",
    runnerRouteSelection: { selectedRoute: "local" },
    isCodexCompactRunning: () => false,
    sanitizeTextForTts: (text: string) => text,
    handleAssistantAudioButtonPress: jest.fn(),
    sessionHistoryPagingById: {},
    loadOlderSessionHistory: mockLoadOlderSessionHistory,
  }),
}));

jest.mock("../contexts/ConversationContext", () => ({
  useConversation: () => ({
    conversationMessages: [],
    llmSessionRestoreLoading: false,
    llmSessionRestoreError: "",
    selectedSessionExecutionFact: null,
    selectedThreadStatusType: "idle",
    hasSelectedDirectory: true,
    selectedDirectoryDisplayName: "Workspace",
    selectedSessionMarkerColor: "none",
    selectedSessionTitle: "Session",
    selectedDirectoryPath: "/workspace",
    transcript: "",
    canSend: true,
    replyLoading: false,
    sttLoading: false,
    startNewSession: jest.fn(),
    markSelectedSessionUnread: jest.fn(),
    reloadSelectedSession: jest.fn(),
    renameSelectedDirectory: jest.fn(),
    renameSelectedSessionTitle: jest.fn(),
    selectSelectedSessionMarkerColor: jest.fn(),
    removeSelectedDirectory: jest.fn(),
    renameDirectoryForPath: jest.fn(),
    renameSessionTitleForSession: jest.fn(),
    selectSessionMarkerColorForSession: jest.fn(),
    removeDirectoryForPath: jest.fn(),
    registeredDirectories: [],
    directorySessionsById: {},
    sessionTitleOverridesById: {},
    formatSessionUpdatedAt: jest.fn(),
    loadSessionChildren: jest.fn(),
    openSessionHistoryEntry: jest.fn(),
    markSessionRead: jest.fn(),
    markSessionUnread: jest.fn(),
    showChatBottomToast: jest.fn(),
    setTranscript: jest.fn(),
    sendReplyTranscript: jest.fn(),
    sendReplyRequestForPanelWithTranscript: jest.fn(),
    sendReplyTranscriptForPanel: jest.fn(),
    cancelReplyRequestForPanel: jest.fn(),
    cancelCodexQueuedTurnForMessage: jest.fn(),
    logSessionDiag: mockLogSessionDiag,
    selectedLlmSessionId: "session-1",
  }),
}));

describe("ChatScreen auto recording panel target", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCodexScheduleProps.current = null;
    mockLocationScheduleProps.current = null;
  });

  it("passes the current panel ID from a panel runtime view", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);

    await fireEvent.press(screen.getByText("mic"));

    expect(mockStartAutoRecordingMode).toHaveBeenCalledWith("panel-a");
    await screen.unmount();
  });

  it("keeps the no-argument behavior for a non-panel view", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" />);

    await fireEvent.press(screen.getByText("mic"));

    expect(mockStartAutoRecordingMode).toHaveBeenCalledWith(undefined);
    await screen.unmount();
  });

  it("keeps Codex-only schedule models when the active chat uses Claude", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" />);

    await fireEvent.press(screen.getByText("Workspace"));

    const expectedModels = [{ value: "gpt-5.6-sol", label: "ChatGPT 5.6 Sol" }];
    expect(mockCodexScheduleProps.current).toMatchObject({
      currentModelRef: "gpt-5.6-sol",
      modelOptions: expectedModels,
    });
    expect(mockLocationScheduleProps.current).toMatchObject({
      currentModelRef: "gpt-5.6-sol",
      modelOptions: expectedModels,
    });
    await screen.unmount();
  });

  it("marks board files unavailable through the shared mutation callback", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    const mutationParams = mockUseWorkspaceFileMutations.mock.calls[0]?.[0] as {
      onPathRemoved?: (target: { path: string; name: string }) => void;
    };

    mutationParams.onPathRemoved?.({ path: "docs/guide.md", name: "guide.md" });

    expect(mockMarkFileUnavailable).toHaveBeenCalledWith("/workspace", "docs/guide.md");
    await screen.unmount();
  });

  it("adds and removes an external chat file link with its owning root", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    const message = mockLegendListProps.current?.data?.[0];
    const row = await render(mockLegendListProps.current?.renderItem?.({ item: message, index: 0 }));

    await fireEvent.press(row.getByTestId("local-file-link"));
    const menuCall = alertSpy.mock.calls.find((call) => call[0] === "today.checklist");
    const actions = (menuCall?.[2] || []) as Array<{ text: string; onPress?: () => void }>;
    actions.find((action) => action.text === "Skiaボードへ追加")?.onPress?.();

    expect(mockHasSkiaBoardFile).toHaveBeenCalledWith(
      "/external/tasks",
      "/external/tasks/today.checklist",
    );
    expect(mockAddSkiaBoardFile).toHaveBeenCalledWith({
      rootDir: "/external/tasks",
      path: "/external/tasks/today.checklist",
      name: "today.checklist",
    });

    mockHasSkiaBoardFile.mockReturnValueOnce(true);
    await fireEvent.press(row.getByTestId("local-file-link"));
    const menuCalls = alertSpy.mock.calls.filter((call) => call[0] === "today.checklist");
    const removeActions = (menuCalls[menuCalls.length - 1]?.[2] || []) as Array<{
      text: string;
      onPress?: () => void;
    }>;
    removeActions.find((action) => action.text === "Skiaボードから除外")?.onPress?.();
    expect(mockRemoveSkiaBoardFile).toHaveBeenCalledWith(
      "/external/tasks",
      "/external/tasks/today.checklist",
    );

    alertSpy.mockRestore();
    await row.unmount();
    await screen.unmount();
  });

  it("loads older history only after the user interacts with the list", async () => {
    jest.useFakeTimers();
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    mockLegendListProps.current?.onStartReached?.();
    expect(mockLoadOlderSessionHistory).not.toHaveBeenCalled();

    mockLegendListProps.current?.onTouchStart?.();
    mockLegendListProps.current?.onStartReached?.();
    expect(mockLoadOlderSessionHistory).toHaveBeenCalledWith({
      backendId: "codex",
      sessionId: "session-1",
      directory: "/workspace",
    });

    await screen.unmount();
    jest.useRealTimers();
  });
});
