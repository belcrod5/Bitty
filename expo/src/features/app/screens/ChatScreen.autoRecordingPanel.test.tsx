import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import { ChatScreen } from "./ChatScreen";

const mockStartAutoRecordingMode = jest.fn();
const mockLogSessionDiag = jest.fn();
const mockLoadOlderSessionHistory = jest.fn();
const mockCodexScheduleProps: { current: Record<string, any> | null } = { current: null };
const mockLocationScheduleProps: { current: Record<string, any> | null } = { current: null };
const mockLegendListProps: { current: Record<string, any> | null } = { current: null };
const mockScrollToEnd = jest.fn();
const mockScrollToIndex = jest.fn();
const mockScrollToOffset = jest.fn();
const mockScrollItemIntoView = jest.fn();
const mockAddSkiaBoardFile = jest.fn();
const mockRemoveSkiaBoardFile = jest.fn();
const mockHasSkiaBoardFile = jest.fn(() => false);
const mockMarkFileUnavailable = jest.fn();
const mockRenameBoardFile = jest.fn();
const mockMarkSessionRead = jest.fn();
const mockMarkSessionUnread = jest.fn();
const mockHydratePanelFromSessionHistory = jest.fn(async () => "applied");
const mockChatSessionSubagentProps: { current: Record<string, any> | null } = { current: null };
let mockPanelBackendId = "codex";
let mockRunnerUrl = "http://runner.test";
let mockPanelConversationMessages: Array<{ id: string; role: "user" | "assistant"; content: string }> = [];
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
    LegendList: ReactModule.forwardRef((props: Record<string, any>, ref) => {
      mockLegendListProps.current = props;
      ReactModule.useImperativeHandle(ref, () => ({
        scrollToEnd: mockScrollToEnd,
        scrollToIndex: mockScrollToIndex,
        scrollToOffset: mockScrollToOffset,
        scrollItemIntoView: mockScrollItemIntoView,
      }));
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
jest.mock("../components/ChatSessionSubagentList", () => ({
  ChatSessionSubagentList: (props: Record<string, any>) => {
    mockChatSessionSubagentProps.current = props;
    return null;
  },
}));
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
    renameFile: mockRenameBoardFile,
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
        supportsScheduling: true,
      },
      {
        selectionKey: "claude::sonnet",
        backendId: "claude",
        modelId: "sonnet",
        label: "Claude Sonnet",
        supportsReasoningEffort: false,
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
      backendId: mockPanelBackendId,
      modelRef: "gpt-5.6-sol",
      reasoningEffort: "high",
      contextUsedPct: 0,
      isResponding: false,
      inheritedConversationMessages: [],
      conversationMessages: mockPanelConversationMessages,
    }),
  }),
}));

jest.mock("../contexts/PanelRuntimeControllerContext", () => ({
  usePanelRuntimeController: () => ({
    startNewPanelSession: jest.fn(),
    updatePanelSettings: jest.fn(),
    hydratePanelFromSessionHistory: mockHydratePanelFromSessionHistory,
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
    runnerUrl: mockRunnerUrl,
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
    markSessionRead: mockMarkSessionRead,
    markSessionUnread: mockMarkSessionUnread,
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
    mockChatSessionSubagentProps.current = null;
    mockPanelBackendId = "codex";
    mockRunnerUrl = "http://runner.test";
    mockPanelConversationMessages = [{ id: "message-1", role: "assistant", content: "hello" }];
  });

  it("passes the current panel ID from a panel runtime view", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);

    await fireEvent.press(screen.getByText("mic"));

    expect(mockStartAutoRecordingMode).toHaveBeenCalledWith("panel-a");
    await fireEvent.press(screen.getByText("Workspace"));
    expect(mockCodexScheduleProps.current?.currentThreadId).toBe("session-1");
    await screen.unmount();
  });

  it("keeps the no-argument behavior for a non-panel view", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" />);

    await fireEvent.press(screen.getByText("mic"));

    expect(mockStartAutoRecordingMode).toHaveBeenCalledWith(undefined);
    await screen.unmount();
  });

  it("disables panel send when the runner URL cannot produce a WebSocket endpoint", async () => {
    mockRunnerUrl = "invalid";
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);

    await fireEvent.changeText(screen.getByPlaceholderText("メッセージを入力"), "hello");

    expect(screen.getByTestId("chat-composer-action")).toBeDisabled();
    await screen.unmount();
  });

  it("keeps Codex-only schedule models when the active chat uses Claude", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" />);

    await fireEvent.press(screen.getByText("Workspace"));

    const expectedModels = [{ value: "gpt-5.6-sol", label: "ChatGPT 5.6 Sol" }];
    expect(mockCodexScheduleProps.current).toMatchObject({
      currentModelRef: "gpt-5.6-sol",
      currentThreadId: "",
      modelOptions: expectedModels,
    });
    expect(mockLocationScheduleProps.current).toMatchObject({
      currentModelRef: "gpt-5.6-sol",
      modelOptions: expectedModels,
    });
    await screen.unmount();
  });

  it("does not duplicate board mutation callbacks in the screen", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    const mutationParams = mockUseWorkspaceFileMutations.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mutationParams.onPathRenamed).toBeUndefined();
    expect(mutationParams.onPathDeleted).toBeUndefined();
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

  it("wires the scroll controls to the shared chat list", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    const visibleMessage = mockLegendListProps.current?.data?.[0];
    mockLegendListProps.current?.onViewableItemsChanged?.({
      viewableItems: [{ item: visibleMessage, index: 0, isViewable: true }],
      changed: [],
    });
    mockScrollToOffset.mockClear();
    mockScrollToEnd.mockClear();

    await fireEvent.press(screen.getByLabelText("前のユーザーメッセージまでスクロール"));
    expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });

    await fireEvent.press(screen.getByLabelText("チャットの末尾までスクロール"));
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true }));
    await screen.unmount();
  });

  it("advances through previous user messages on consecutive presses", async () => {
    mockPanelConversationMessages = [
      { id: "user-1", role: "user", content: "first" },
      { id: "assistant-1", role: "assistant", content: "reply" },
      { id: "user-2", role: "user", content: "second" },
      { id: "assistant-2", role: "assistant", content: "reply" },
      { id: "user-3", role: "user", content: "third" },
      { id: "assistant-3", role: "assistant", content: "reply" },
    ];
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    mockLegendListProps.current?.onViewableItemsChanged?.({
      viewableItems: [{ item: mockPanelConversationMessages[5], index: 5, isViewable: true }],
      changed: [],
    });
    mockScrollToIndex.mockClear();

    await fireEvent.press(screen.getByLabelText("前のユーザーメッセージまでスクロール"));
    mockLegendListProps.current?.onScroll?.({
      nativeEvent: {
        contentOffset: { y: 200 },
        contentSize: { height: 700 },
        layoutMeasurement: { height: 200 },
      },
    });
    mockLegendListProps.current?.onViewableItemsChanged?.({
      viewableItems: [{ item: mockPanelConversationMessages[5], index: 5, isViewable: true }],
      changed: [],
    });
    await fireEvent.press(screen.getByLabelText("前のユーザーメッセージまでスクロール"));

    expect(mockScrollToIndex.mock.calls).toEqual([
      [{ index: 4, animated: true, viewPosition: 0 }],
      [{ index: 2, animated: true, viewPosition: 0 }],
    ]);
    await screen.unmount();
  });

  it("accepts normal viewability updates after the navigation target becomes visible", async () => {
    mockPanelConversationMessages = [
      { id: "user-1", role: "user", content: "first" },
      { id: "assistant-1", role: "assistant", content: "reply" },
      { id: "user-2", role: "user", content: "second" },
      { id: "assistant-2", role: "assistant", content: "reply" },
      { id: "user-3", role: "user", content: "third" },
      { id: "assistant-3", role: "assistant", content: "reply" },
    ];
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    mockLegendListProps.current?.onViewableItemsChanged?.({
      viewableItems: [{ item: mockPanelConversationMessages[5], index: 5, isViewable: true }],
      changed: [],
    });
    await fireEvent.press(screen.getByLabelText("前のユーザーメッセージまでスクロール"));
    mockLegendListProps.current?.onViewableItemsChanged?.({
      viewableItems: [{ item: mockPanelConversationMessages[4], index: 4, isViewable: true }],
      changed: [],
    });
    mockLegendListProps.current?.onScroll?.({
      nativeEvent: {
        contentOffset: { y: 200 },
        contentSize: { height: 700 },
        layoutMeasurement: { height: 200 },
      },
    });
    mockLegendListProps.current?.onViewableItemsChanged?.({
      viewableItems: [{ item: mockPanelConversationMessages[1], index: 1, isViewable: true }],
      changed: [],
    });
    mockScrollToIndex.mockClear();

    await fireEvent.press(screen.getByLabelText("前のユーザーメッセージまでスクロール"));

    expect(mockScrollToIndex).toHaveBeenCalledWith({ index: 0, animated: true, viewPosition: 0 });
    await screen.unmount();
  });

  it("keeps auto-scroll paused while an upward jump is leaving the bottom", async () => {
    jest.useFakeTimers();
    mockPanelConversationMessages = [
      { id: "user-1", role: "user", content: "first" },
      { id: "assistant-1", role: "assistant", content: "reply" },
    ];
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    mockLegendListProps.current?.onViewableItemsChanged?.({
      viewableItems: [{ item: mockPanelConversationMessages[1], index: 1, isViewable: true }],
      changed: [],
    });
    await fireEvent.press(screen.getByLabelText("前のユーザーメッセージまでスクロール"));
    mockScrollToEnd.mockClear();

    mockLegendListProps.current?.onScroll?.({
      nativeEvent: {
        contentOffset: { y: 400 },
        contentSize: { height: 600 },
        layoutMeasurement: { height: 200 },
      },
    });
    mockLegendListProps.current?.onContentSizeChange?.(0, 700);
    mockLegendListProps.current?.onScroll?.({
      nativeEvent: {
        contentOffset: { y: 200 },
        contentSize: { height: 700 },
        layoutMeasurement: { height: 200 },
      },
    });
    mockLegendListProps.current?.onContentSizeChange?.(0, 800);
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    expect(mockScrollToEnd).not.toHaveBeenCalled();
    await screen.unmount();
    jest.useRealTimers();
  });

  it("resumes auto-scroll when the bottom control is pressed", async () => {
    jest.useFakeTimers();
    mockPanelConversationMessages = [
      { id: "user-1", role: "user", content: "first" },
      { id: "assistant-1", role: "assistant", content: "reply" },
    ];
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    mockLegendListProps.current?.onViewableItemsChanged?.({
      viewableItems: [{ item: mockPanelConversationMessages[1], index: 1, isViewable: true }],
      changed: [],
    });
    await fireEvent.press(screen.getByLabelText("前のユーザーメッセージまでスクロール"));
    mockScrollToEnd.mockClear();

    await fireEvent.press(screen.getByLabelText("チャットの末尾までスクロール"));
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true });

    mockScrollToEnd.mockClear();
    mockLegendListProps.current?.onContentSizeChange?.(0, 700);
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true });
    await screen.unmount();
    jest.useRealTimers();
  });

  it("marks a hydrated Claude subagent read with its Backend identity", async () => {
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    await fireEvent.press(screen.getByText("Workspace"));

    await act(async () => {
      await mockChatSessionSubagentProps.current?.openSessionHistoryEntry?.({
        backendId: "claude",
        sessionId: "shared-session",
        source: "cli",
        directory: "/workspace",
      });
    });

    await waitFor(() => expect(mockMarkSessionRead).toHaveBeenCalledWith(
      "shared-session",
      "cli",
      "/workspace",
      "claude",
    ));
    await screen.unmount();
  });

  it("marks the visible Claude panel unread without targeting same-id Codex", async () => {
    mockPanelBackendId = "claude";
    const screen = await render(<ChatScreen mode="mini_board_popup" panelId="panel-a" />);
    const message = mockLegendListProps.current?.data?.[0];
    const row = await render(mockLegendListProps.current?.renderItem?.({ item: message, index: 0 }));

    await fireEvent.press(row.getByLabelText("セッションを未読にする"));

    expect(mockMarkSessionUnread).toHaveBeenCalledWith({
      backendId: "claude",
      sessionId: "session-1",
      source: "all",
      directory: "/workspace",
    });
    await row.unmount();
    await screen.unmount();
  });
});
