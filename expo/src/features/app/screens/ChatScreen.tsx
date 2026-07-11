import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  View,
} from "react-native";
import { LegendList, type LegendListRef } from "@legendapp/list";
import { Ionicons } from "@expo/vector-icons";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { WebView } from "react-native-webview";
import { isIosFaceTrackingAvailable } from "../../faceTracking/iosFaceTrackingClient";
import type { ConversationMessage } from "../types/appTypes";
import type { DirectoryMarkerColor } from "../components/AppDrawer";
import { styles } from "../styles";
import { useAppShell } from "../contexts/AppShellContext";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useConversation } from "../contexts/ConversationContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { useYouTubePlayer } from "../contexts/YouTubePlayerContext";
import {
  useChatDiagnostics,
  useDirectoryGitChangedFiles,
} from "../contexts/ChatDiagnosticsContext";
import { useChatComposer } from "../contexts/ChatComposerContext";
import { useChatVisual } from "../contexts/ChatVisualContext";
import { useChatScreen } from "../contexts/ChatScreenContext";
import { ChatContextUsageMenu } from "../components/ChatContextUsageMenu";
import { CodexStatusSummaryMenu } from "../components/CodexStatusSummaryMenu";
import { CommandExecutionRow } from "../components/CommandExecutionRow";
import { BouncingDotsIndicator } from "../components/BouncingDotsIndicator";
import { MarkdownText } from "../components/MarkdownText";
import { PixelRobotIndicator } from "../components/PixelRobotIndicator";
import { SlashCommandSelectMenu } from "../components/SlashCommandSelectMenu";
import { TtsWaveformPlayer } from "../components/TtsWaveformPlayer";
import { YouTubeVideoList } from "../components/YouTubeVideoList";
import { GitDiffPanel } from "../components/GitDiffPanel";
import { RunnerMediaViewer } from "../components/RunnerMediaViewer";
import { WorkspaceFileRenameDialog } from "../components/WorkspaceFileRenameDialog";
import { ChatSessionSubagentList } from "../components/ChatSessionSubagentList";
import { useWorkspaceFileMutations } from "../hooks/useWorkspaceFileMutations";
import { RunnerWsConnectionStatus, type RunnerWsDataSyncStatus } from "../../runnerWs/RunnerWsConnectionStatus";
import { modelRefLabelForDisplay, normalizeModelRef, type ReasoningEffort } from "../utils/settingsParsers";
import { countGitChangedFiles } from "../utils/gitChangedFiles";
import {
  normalizeRunnerPath,
  openRunnerFileContextMenu,
  type RunnerMediaFile,
} from "../utils/runnerFileContextMenu";
import { formatRelativeUpdatedAt } from "../utils/formatting";
import { deriveSessionExecutionStatusType } from "../utils/sessionExecutionStatus";

type ChatFooterSelectTarget = "model" | "think";
type DirectoryMenuMode = "actions" | "rename_directory" | "edit_session_title" | "select_marker";
type ChatScreenMode = "mini_board" | "mini_board_popup";
type ChatScreenProps = {
  mode?: ChatScreenMode;
  panelId?: string;
  miniBoardCycleId?: string;
  onTogglePopupPresentation?: () => void;
  onMinimizePopupChat?: () => void;
  onPopupHeaderDragMove?: (offsetY: number) => void;
  onPopupHeaderDragEnd?: (offsetY: number, velocityY: number) => void;
  showPopupMessagesSkeleton?: boolean;
};
type OptionalSizeCacheLegendListRef = LegendListRef & {
  clearCaches?: (options?: { mode?: "sizes" }) => void;
};
type ChatScrollDiagnosticState = {
  contentHeight: number;
  viewportHeight: number;
  contentSizeHeight: number;
};

const LEGACY_MAIN_PANEL_ID = "main";

function normalizeChatPanelId(panelIdRaw: unknown) {
  const panelId = String(panelIdRaw || "").trim();
  if (!panelId || panelId === LEGACY_MAIN_PANEL_ID) return "";
  return panelId;
}

function isPanelScopedChatView(mode: ChatScreenMode, panelIdRaw: unknown) {
  const panelId = normalizeChatPanelId(panelIdRaw);
  return (mode === "mini_board" || mode === "mini_board_popup") && !!panelId;
}

const CHAT_ESTIMATED_ITEM_SIZE = 120;
const CHAT_INITIAL_SCROLL_SETTLE_MS = 350;
const CHAT_BOTTOM_SETTLE_RETRY_DELAYS_MS = [96, 220] as const;
const CHAT_BOTTOM_RESUME_THRESHOLD_PX = 4;
const DIRECTORY_MARKER_OPTIONS: { value: DirectoryMarkerColor; label: string; color: string }[] = [
  { value: "gray", label: "灰", color: "#94a3b8" },
  { value: "red", label: "赤", color: "#dc2626" },
  { value: "yellow", label: "黄", color: "#eab308" },
  { value: "green", label: "緑", color: "#16a34a" },
  { value: "black", label: "黒", color: "#111827" },
  { value: "none", label: "なし", color: "transparent" },
];

function markerColorToDotHex(color: DirectoryMarkerColor) {
  if (color === "gray") return "#94a3b8";
  if (color === "red") return "#dc2626";
  if (color === "yellow") return "#eab308";
  if (color === "green") return "#16a34a";
  if (color === "black") return "#111827";
  return "";
}

function formatMessageTimestampLabel(atRaw: unknown) {
  const raw = String(atRaw || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return "";
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hour = String(parsed.getHours()).padStart(2, "0");
  const minute = String(parsed.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function getMessageTimeValue(atRaw: unknown) {
  const time = new Date(String(atRaw || "")).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function ChatScreen({
  mode = "mini_board_popup",
  panelId: panelIdRaw = "",
  miniBoardCycleId = "",
  onTogglePopupPresentation,
  onMinimizePopupChat,
  onPopupHeaderDragMove,
  onPopupHeaderDragEnd,
  showPopupMessagesSkeleton = false,
}: ChatScreenProps) {
  const panelId = normalizeChatPanelId(panelIdRaw);
  const isMiniBoardPreviewMode = mode === "mini_board";
  const isMiniBoardPopupMode = mode === "mini_board_popup";
  const isMiniBoardMode = isMiniBoardPreviewMode || isMiniBoardPopupMode;
  const isPanelRuntimeView = isPanelScopedChatView(mode, panelId);
  const { getSnapshot } = usePanelRuntimeStore();
  const {
    startNewPanelSession,
    updatePanelSettings,
    hydratePanelFromSessionHistory,
  } = usePanelRuntimeController();
  const { openDrawer } = useAppShell();
  const {
    selectedModelLabel,
    reasoningEffort,
    modelOptions,
    modelRef,
    codexWsUrl,
    thinkOptions,
    selectModel,
    selectThinkOption,
  } = useAppSettings();
  const {
    activeYouTubeQueuePositionLabel,
    youtubeVideoMetaById,
    conversationInlineAnchorMessageId,
    showFloatingYouTubePlayer,
    setYoutubeInlineAnchor,
    youtubePlayerVideoId,
    youtubeEmbedHtml,
    youtubeWebViewRef,
    youtubePlayerSession,
    youtubeEmbedOrigin,
    handleYouTubeWebViewMessage,
    openYouTubeVideo,
    formatYouTubePublishedDate,
    formatYouTubeViewCount,
    updateYouTubeInlineLayoutFromAnchor,
    streamReplyYouTubeVideos,
    youtubePlayerMessageId,
    streamReplyYouTubeVideoIds,
    showYouTubeOverlayPlayer,
    youtubeFloatingAnimatedPosition,
    markYouTubeFloatingControlInteraction,
    youtubeFloatingInteractionMode,
    youtubeFloatingPanResponder,
    closeYouTubePlayer,
  } = useYouTubePlayer();
  const {
    isRobotAnimating,
    pixelRobotImage,
    pixelRobotImageStatic,
    chatContextUsedPct,
    chatContextRingTrackColor,
    chatContextRingProgressColor,
    formatElapsedHhMmSs,
    llmStatusVisual,
    llmStatusLabel,
    resolvePixelStatusIconKey,
    buildSttMetaChips,
    ttsPlaybackMessageId,
    isTtsPlaybackActive,
    ttsSegmentProgress,
    pixelStatusAnimations,
    llmElapsedLiveMs,
    isStreamWaveformPlaybackActive,
    stopWaveformPlayback,
    error,
    chatBottomToast,
    chatBottomToastAnimRef,
  } = useChatVisual();
  const {
    codexCliStatusText,
    codexCliStatusFetchedAtMs,
    codexCliStatusLoading,
    codexAuthProfileId,
    codexAuthProfiles,
    codexAuthProfilesLoading,
    codexAuthSwitching,
    codexAuthSwitchError,
    refreshCodexCliStatus: onRefreshCodexCliStatus,
    loadCodexAuthProfiles: onLoadCodexAuthProfiles,
    switchCodexAuthProfile: onSwitchCodexAuthProfile,
  } = useChatDiagnostics();
  const {
    composerWaveformVisible,
    autoWaveformAnimationEnabled,
    waveformDotGif,
    autoSpeechDetected,
    composerDirectSttVisible,
    directNativeSttPreviewText,
    chatComposerInputRef,
    showComposerFullscreenToggle,
    openComposerFullscreen,
    setComposerInputFocused,
    isDirectNativeSttProvider,
    directNativeSttEnabled,
    autoRecordingEnabled,
    manualRecording,
    faceTrackingEnabled,
    faceTrackingLooking,
    canStopLlmTurn,
    stopDirectNativeStt,
    stopAutoRecordingMode,
    stopRecording,
    stopLlmTurn,
    startDirectNativeStt,
    startAutoRecordingMode,
    setFaceTrackingEnabledWithRef,
    faceTrackingRunning,
    setSlashCommandSelectOpen,
    slashCommandOptions,
    onSelectSlashCommand,
  } = useChatComposer();
  const {
    approvalDialogPending,
    setChatScreenLayout,
    setChatViewportHeight,
    handleChatScroll,
    chatContentRef,
    onChatTouchStart,
    onChatTouchEnd,
    runnerUrl,
    runnerToken,
    runnerRouteSelection,
    isCodexCompactRunning,
    sanitizeTextForTts,
    handleAssistantAudioButtonPress,
  } = useChatScreen();
  const popupHeaderDragStartPageYRef = useRef<number | null>(null);
  const popupHeaderPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gestureState) => (
      isMiniBoardPopupMode
      && (!!onPopupHeaderDragEnd || !!onMinimizePopupChat)
      && gestureState.dy > 12
      && gestureState.dy > Math.abs(gestureState.dx) * 1.2
    ),
    onPanResponderGrant: (event) => {
      popupHeaderDragStartPageYRef.current = Number(event.nativeEvent.pageY || 0);
      onPopupHeaderDragMove?.(0);
    },
    onPanResponderMove: (event, gestureState) => {
      const startPageY = popupHeaderDragStartPageYRef.current;
      const offsetY = startPageY === null
        ? gestureState.dy
        : Number(event.nativeEvent.pageY || startPageY) - startPageY;
      onPopupHeaderDragMove?.(Math.max(0, offsetY));
    },
    onPanResponderRelease: (event, gestureState) => {
      const startPageY = popupHeaderDragStartPageYRef.current;
      const offsetY = Math.max(0, startPageY === null
        ? gestureState.dy
        : Number(event.nativeEvent.pageY || startPageY) - startPageY);
      popupHeaderDragStartPageYRef.current = null;
      if (onPopupHeaderDragEnd) {
        onPopupHeaderDragEnd(offsetY, gestureState.vy);
      } else if (isMiniBoardPopupMode && onMinimizePopupChat && (offsetY > 44 || gestureState.vy > 0.6)) {
        onMinimizePopupChat();
      }
    },
    onPanResponderTerminate: () => {
      popupHeaderDragStartPageYRef.current = null;
      onPopupHeaderDragEnd?.(0, 0);
    },
    onPanResponderTerminationRequest: () => true,
  }), [isMiniBoardPopupMode, onMinimizePopupChat, onPopupHeaderDragEnd, onPopupHeaderDragMove]);
  const {
    conversationMessages,
    llmSessionRestoreLoading,
    llmSessionRestoreError,
    selectedSessionExecutionFact,
    selectedThreadStatusType,
    hasSelectedDirectory,
    selectedDirectoryDisplayName,
    selectedSessionMarkerColor,
    selectedSessionTitle,
    selectedDirectoryPath,
    transcript,
    canSend,
    replyLoading,
    sttLoading,
    startNewSession,
    markSelectedSessionUnread,
    reloadSelectedSession,
    renameSelectedDirectory,
    renameSelectedSessionTitle,
    selectSelectedSessionMarkerColor,
    removeSelectedDirectory,
    renameDirectoryForPath,
    renameSessionTitleForSession,
    selectSessionMarkerColorForSession,
    removeDirectoryForPath,
    registeredDirectories,
    directorySessionsById,
    sessionTitleOverridesById,
    formatSessionUpdatedAt,
    loadSessionChildren,
    openSessionHistoryEntry,
    markSessionRead,
    markSessionUnread,
    showChatBottomToast,
    setTranscript,
    sendReplyTranscript,
    sendReplyRequestForPanelWithTranscript,
    sendReplyTranscriptForPanel,
    cancelReplyRequestForPanel,
    cancelCodexQueuedTurnForMessage,
    logSessionDiag,
    selectedLlmSessionId,
  } = useConversation();
  const panelSnapshot = getSnapshot(panelId);
  const miniSourceMessages = panelSnapshot.conversationMessages;
  const miniInheritedSourceMessages = panelSnapshot.inheritedConversationMessages;
  const miniSourceDirectoryDisplayName = panelSnapshot.selectedDirectoryDisplayName;
  const miniSourceSessionTitle = panelSnapshot.selectedSessionTitle;
  const miniSourceSessionUpdatedAt = panelSnapshot.selectedSessionUpdatedAt;
  const miniSourceSessionMarkerColor = panelSnapshot.selectedSessionMarkerColor;
  const panelContextUsedPct = panelSnapshot.contextUsedPct !== null &&
    typeof panelSnapshot.contextUsedPct !== "undefined" &&
    Number.isFinite(Number(panelSnapshot.contextUsedPct))
    ? Math.max(0, Math.min(100, Math.round(Number(panelSnapshot.contextUsedPct))))
    : null;
  const panelHydrating = Boolean(panelSnapshot.isHydrating);
  const panelReplyLoading = Boolean(panelSnapshot.isResponding);
  const replyLoadingForView = isPanelRuntimeView ? panelReplyLoading : replyLoading;
  const codexCompactRunningForView = isCodexCompactRunning(
    isPanelRuntimeView ? panelSnapshot.selectedSessionId : selectedLlmSessionId
  );
  const canStopLlmTurnForView = (isPanelRuntimeView ? panelReplyLoading : canStopLlmTurn) && !codexCompactRunningForView;
  const llmSessionRestoreLoadingForView = isPanelRuntimeView ? panelHydrating : llmSessionRestoreLoading;
  const selectedThreadStatusTypeForView = isPanelRuntimeView
    ? deriveSessionExecutionStatusType({
      threadStatusType: panelSnapshot.selectedThreadStatusType,
      isResponding: panelReplyLoading,
      isCompactRunning: codexCompactRunningForView,
    })
    : (String(selectedThreadStatusType || "unknown").trim() || "unknown");
  const modelRefForView = isPanelRuntimeView
    ? (String(panelSnapshot.modelRef || "").trim() || modelRef)
    : modelRef;
  const normalizedModelRefForView = normalizeModelRef(modelRefForView) || modelRefForView;
  const reasoningEffortForView = isPanelRuntimeView
    ? (String(panelSnapshot.reasoningEffort || "").trim() || reasoningEffort)
    : reasoningEffort;
  const selectedModelLabelForView = useMemo(() => {
    if (!isPanelRuntimeView) return selectedModelLabel || modelRefLabelForDisplay(modelRefForView, modelOptions);
    return modelRefLabelForDisplay(modelRefForView, modelOptions);
  }, [isPanelRuntimeView, modelOptions, modelRefForView, selectedModelLabel]);
  const chatContextUsedPctForView = isPanelRuntimeView ? panelContextUsedPct : chatContextUsedPct;
  const chatContextPctTextForView = chatContextUsedPctForView === null ? "--" : String(chatContextUsedPctForView);
  const chatContextRingProgressForView = chatContextUsedPctForView === null
    ? 0
    : Math.max(0, Math.min(1, chatContextUsedPctForView / 100));
  const isPanelSnapshotView = isPanelRuntimeView;
  const hasSelectedDirectoryForView = isPanelSnapshotView
    ? Boolean(String(panelSnapshot.selectedSessionId || panelSnapshot.selectedDirectoryPath || "").trim())
    : hasSelectedDirectory;
  const selectedDirectoryDisplayNameForView = isPanelSnapshotView
    ? (miniSourceDirectoryDisplayName || selectedDirectoryDisplayName)
    : selectedDirectoryDisplayName;
  const selectedSessionTitleForView = isPanelSnapshotView
    ? (miniSourceSessionTitle || selectedSessionTitle)
    : selectedSessionTitle;
  const selectedSessionMarkerColorForView = isPanelRuntimeView
    ? miniSourceSessionMarkerColor
    : selectedSessionMarkerColor;
  const ttsPlaybackMessageIdForView = isPanelRuntimeView
    ? String(panelSnapshot.ttsPlaybackMessageId || "").trim()
    : ttsPlaybackMessageId;
  const showActiveSessionStreamReplyArtifacts = !isPanelRuntimeView;
  const errorForView = isPanelRuntimeView ? "" : error;
  const selectedDirectoryPathForView = isPanelSnapshotView
    ? (String(panelSnapshot.selectedDirectoryPath || "").trim() || selectedDirectoryPath)
    : selectedDirectoryPath;
  const selectedSessionIdForView = isPanelSnapshotView
    ? String(panelSnapshot.selectedSessionId || "").trim()
    : String(selectedLlmSessionId || "").trim();
  const openSessionHistoryEntryForView = useCallback((params: {
    sessionId: string;
    source: Parameters<typeof openSessionHistoryEntry>[0]["source"];
    directory: string;
  }) => {
    if (!isPanelRuntimeView) {
      openSessionHistoryEntry(params);
      return;
    }
    const sessionId = String(params.sessionId || "").trim();
    const directory = String(params.directory || "").trim();
    if (!sessionId || !directory) return;
    const diagnosticCycleId = `chat-subagent-${Date.now().toString(36)}`;
    void hydratePanelFromSessionHistory({
      panelId,
      sessionId,
      directory,
      source: params.source,
      diagnosticCycleId,
    }).then((result) => {
      if (result === "superseded") return;
      if (result === "failed") {
        showChatBottomToast("assistant", "サブエージェントのセッションを読み込めませんでした。");
        return;
      }
      markSessionRead(sessionId, params.source, directory);
    }).catch((error) => {
      showChatBottomToast(
        "assistant",
        `サブエージェントのセッション読込に失敗しました: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, [
    hydratePanelFromSessionHistory,
    isPanelRuntimeView,
    markSessionRead,
    openSessionHistoryEntry,
    panelId,
    showChatBottomToast,
  ]);
  const gitChangedFiles = useDirectoryGitChangedFiles(selectedDirectoryPathForView);
  const startNewSessionForView = useCallback(() => {
    if (isPanelRuntimeView) {
      startNewPanelSession({
        panelId,
        directory: selectedDirectoryPathForView,
      });
      return;
    }
    startNewSession({ directory: selectedDirectoryPathForView });
  }, [isPanelRuntimeView, panelId, selectedDirectoryPathForView, startNewPanelSession, startNewSession]);
  const allConversationMessagesForView = isPanelSnapshotView
    ? [...miniInheritedSourceMessages, ...miniSourceMessages]
    : conversationMessages;
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false);
  const [directoryMenuMode, setDirectoryMenuMode] = useState<DirectoryMenuMode>("actions");
  const [directoryRenameInput, setDirectoryRenameInput] = useState("");
  const [directorySessionTitleInput, setDirectorySessionTitleInput] = useState("");
  const [popupComposerFullscreenOpen, setPopupComposerFullscreenOpen] = useState(false);
  const [popupSlashCommandSelectOpen, setPopupSlashCommandSelectOpen] = useState(false);
  const [footerSelectOpen, setFooterSelectOpen] = useState<ChatFooterSelectTarget | null>(null);
  const [footerSelectAnchor, setFooterSelectAnchor] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [executionNowTick, setExecutionNowTick] = useState(0);
  const [gitDiffPanelOpen, setGitDiffPanelOpen] = useState(false);
  const [runnerMedia, setRunnerMedia] = useState<RunnerMediaFile | null>(null);
  const modelSelectTriggerRef = useRef<View | null>(null);
  const thinkSelectTriggerRef = useRef<View | null>(null);
  const embeddedChatListRef = useRef<LegendListRef | null>(null);
  const popupChatListRef = useRef<LegendListRef | null>(null);
  const didInitialScrollRef = useRef(false);
  const initialSettlingRef = useRef(false);
  const bottomScrollRafRefs = useRef<ReturnType<typeof requestAnimationFrame>[]>([]);
  const bottomScrollTimeoutRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
  const initialSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAtBottomRef = useRef(true);
  const chatAutoScrollPausedRef = useRef(false);
  const chatScrollDragActiveRef = useRef(false);
  const lastChatCacheKeyRef = useRef("");
  const settledChatCacheVersionRef = useRef(0);
  const lastConversationMessageForViewRef = useRef<ConversationMessage | null>(null);
  const lastConversationMessageIndexForViewRef = useRef(-1);
  const chatScrollDiagnosticRef = useRef<ChatScrollDiagnosticState>({
    contentHeight: 0,
    viewportHeight: 0,
    contentSizeHeight: 0,
  });
  const previousMessageCountRef = useRef(0);
  const popupComposerFullscreenInputRef = useRef<TextInput | null>(null);
  const [panelTranscript, setPanelTranscript] = useState("");
  const [panelComposerFocused, setPanelComposerFocused] = useState(false);
  const [chatViewportSize, setChatViewportSize] = useState({ width: 0, height: 0 });
  const [popupChatViewportSize, setPopupChatViewportSize] = useState({ width: 0, height: 0 });
  const [chatListCacheVersion, setChatListCacheVersion] = useState(0);
  const miniBoardMountLoggedRef = useRef(false);
  const miniBoardPrevSessionIdRef = useRef("");
  const usesPanelComposerState = isMiniBoardPopupMode && !!panelId;
  const transcriptForView = usesPanelComposerState ? panelTranscript : transcript;
  const setTranscriptForView = useCallback((nextText: string) => {
    if (usesPanelComposerState) {
      setPanelTranscript(nextText);
      return;
    }
    setTranscript(nextText);
  }, [setTranscript, usesPanelComposerState]);
  const hasComposerTextForView = useMemo(() => !!transcriptForView.trim(), [transcriptForView]);
  const showComposerFullscreenToggleForView = usesPanelComposerState
    ? panelComposerFocused
    : showComposerFullscreenToggle;
  const baseCanSendForView = usesPanelComposerState
    ? hasComposerTextForView && !replyLoadingForView && !llmSessionRestoreLoadingForView && !!String(codexWsUrl || "").trim()
    : canSend;
  const canSendForView = codexCompactRunningForView
    ? hasComposerTextForView && !llmSessionRestoreLoadingForView && !!String(codexWsUrl || "").trim()
    : baseCanSendForView;
  const selectedSessionExecutionFactForView = useMemo(() => {
    if (!isMiniBoardMode) return selectedSessionExecutionFact;
    const panelSessionId = String(panelSnapshot.selectedSessionId || "").trim();
    const factSessionId = String(selectedSessionExecutionFact?.sessionId || "").trim();
    if (!panelSessionId || !factSessionId || panelSessionId !== factSessionId) return null;
    return selectedSessionExecutionFact;
  }, [isMiniBoardMode, panelSnapshot.selectedSessionId, selectedSessionExecutionFact]);

  const miniMessages = useMemo(
    () => miniSourceMessages
      .filter((message) => String(message.content || "").trim().length > 0)
      .slice(-8),
    [miniSourceMessages]
  );
  const miniBoardLastSourceMessage = miniSourceMessages.length > 0
    ? miniSourceMessages[miniSourceMessages.length - 1]
    : null;
  const miniBoardLastSourceMessagePreview = String(miniBoardLastSourceMessage?.content || "").slice(0, 80);
  const miniBoardSnapshotLogKey = isMiniBoardMode
    ? [
      miniBoardCycleId,
      panelId,
      mode,
      panelSnapshot.selectedSessionId,
      panelSnapshot.selectedDirectoryPath,
      panelSnapshot.modelRef,
      panelSnapshot.reasoningEffort,
      panelSnapshot.isResponding ? "responding" : "idle",
      panelHydrating ? "hydrating" : "ready",
      miniSourceMessages.length,
      miniBoardLastSourceMessage?.id || "",
      miniBoardLastSourceMessage?.role || "",
      String(miniBoardLastSourceMessage?.content || "").length,
      miniBoardLastSourceMessagePreview,
    ].join("|")
    : "";
  const conversationMessagesForView = allConversationMessagesForView;
  const showMessagesSkeletonForView = isMiniBoardPopupMode && (showPopupMessagesSkeleton || panelHydrating);
  const connectionDataSync = useMemo<RunnerWsDataSyncStatus>(() => {
    const selectedSessionIdForSync = isPanelSnapshotView
      ? String(panelSnapshot.selectedSessionId || "").trim()
      : String(selectedLlmSessionId || "").trim();
    const lastMessage = conversationMessagesForView[conversationMessagesForView.length - 1] ?? null;
    const messageCount = conversationMessagesForView.length;
    const lastUpdatedAtMs = getMessageTimeValue(lastMessage?.at);
    const totalCount = selectedSessionIdForSync || messageCount > 0 ? 1 : 0;
    if (llmSessionRestoreLoadingForView) {
      return {
        status: "loading",
        label: "取得中",
        detail: selectedSessionIdForSync ? "選択セッション取得中" : "セッション取得中",
        totalCount,
        loadingCount: 1,
        staleCount: 0,
        errorCount: 0,
        lastUpdatedAtMs,
      };
    }
    const restoreError = isPanelSnapshotView ? "" : String(llmSessionRestoreError || "").trim();
    if (restoreError) {
      return {
        status: "error",
        label: "取得失敗",
        detail: restoreError,
        totalCount,
        loadingCount: 0,
        staleCount: 0,
        errorCount: 1,
        lastUpdatedAtMs,
      };
    }
    if (!hasSelectedDirectoryForView) {
      return {
        status: "unknown",
        label: "同期不明",
        detail: "ディレクトリ未選択",
        totalCount: 0,
        loadingCount: 0,
        staleCount: 0,
        errorCount: 0,
        lastUpdatedAtMs,
      };
    }
    if (selectedSessionIdForSync && messageCount <= 0) {
      return {
        status: "stale",
        label: "未取得",
        detail: "会話データなし",
        totalCount: 1,
        loadingCount: 0,
        staleCount: 1,
        errorCount: 0,
        lastUpdatedAtMs,
      };
    }
    if (!selectedSessionIdForSync && messageCount <= 0) {
      return {
        status: "unknown",
        label: "同期不明",
        detail: "新規チャット",
        totalCount: 0,
        loadingCount: 0,
        staleCount: 0,
        errorCount: 0,
        lastUpdatedAtMs,
      };
    }
    return {
      status: "ok",
      label: "表示中",
      detail: `メッセージ${messageCount}件表示中`,
      totalCount: 1,
      loadingCount: 0,
      staleCount: 0,
      errorCount: 0,
      lastUpdatedAtMs,
    };
  }, [
    conversationMessagesForView,
    hasSelectedDirectoryForView,
    isPanelSnapshotView,
    llmSessionRestoreError,
    llmSessionRestoreLoadingForView,
    panelSnapshot.selectedSessionId,
    selectedLlmSessionId,
  ]);
  lastConversationMessageForViewRef.current = conversationMessagesForView[conversationMessagesForView.length - 1] ?? null;
  lastConversationMessageIndexForViewRef.current = conversationMessagesForView.length - 1;
  const chatListRefForView = isMiniBoardPopupMode ? popupChatListRef : embeddedChatListRef;
  const handleChatTouchStartForView = isMiniBoardPopupMode ? undefined : onChatTouchStart;
  const handleChatTouchEndForView = isMiniBoardPopupMode ? undefined : onChatTouchEnd;
  const currentChatViewportSize = isMiniBoardPopupMode ? popupChatViewportSize : chatViewportSize;
  const estimatedChatListSize = currentChatViewportSize.width > 0 && currentChatViewportSize.height > 0
    ? currentChatViewportSize
    : undefined;
  const chatListRenderKey = `${isMiniBoardPopupMode ? "popup" : "full"}-chat-list-${chatListCacheVersion}`;
  const keyboardVerticalOffset = Platform.OS === "ios"
    ? (isMiniBoardPopupMode ? 0 : 6)
    : 0;
  const conversationScrollResetKey = [
    isMiniBoardPopupMode ? "popup" : "full",
    panelId,
    isPanelSnapshotView
      ? String(panelSnapshot.selectedSessionId || "").trim()
      : "",
    selectedDirectoryPathForView,
    selectedSessionTitleForView,
  ].join("|");
  const latestMessageForLayout = conversationMessagesForView[conversationMessagesForView.length - 1] ?? null;
  const chatListLayoutVersion = [
    conversationScrollResetKey,
    conversationMessagesForView.length,
    latestMessageForLayout?.id || "",
    latestMessageForLayout?.role || "",
    String(latestMessageForLayout?.content || "").length,
  ].join("|");
  const clearPendingBottomScrollFrames = useCallback(() => {
    bottomScrollRafRefs.current.forEach((frame) => cancelAnimationFrame(frame));
    bottomScrollRafRefs.current = [];
    bottomScrollTimeoutRefs.current.forEach((timer) => clearTimeout(timer));
    bottomScrollTimeoutRefs.current = [];
  }, []);
  const cancelPendingChatBottomSettling = useCallback(() => {
    initialSettlingRef.current = false;
    if (initialSettleTimerRef.current !== null) {
      clearTimeout(initialSettleTimerRef.current);
      initialSettleTimerRef.current = null;
    }
    clearPendingBottomScrollFrames();
  }, [clearPendingBottomScrollFrames]);
  const pauseChatAutoScrollForInteraction = useCallback(() => {
    chatAutoScrollPausedRef.current = true;
    cancelPendingChatBottomSettling();
  }, [cancelPendingChatBottomSettling]);
  const handleChatTouchEndForAutoScroll = useCallback(() => {
    handleChatTouchEndForView?.();
    if (chatScrollDragActiveRef.current) return;
    if (isAtBottomRef.current) chatAutoScrollPausedRef.current = false;
  }, [handleChatTouchEndForView]);
  const handleChatTouchCancelForAutoScroll = useCallback(() => {
    chatScrollDragActiveRef.current = false;
    handleChatTouchEndForView?.();
    if (isAtBottomRef.current) chatAutoScrollPausedRef.current = false;
  }, [handleChatTouchEndForView]);
  const handleChatScrollInteractionBegin = useCallback(() => {
    chatScrollDragActiveRef.current = true;
    chatAutoScrollPausedRef.current = true;
    cancelPendingChatBottomSettling();
  }, [cancelPendingChatBottomSettling]);
  const handleChatScrollInteractionEnd = useCallback(() => {
    chatScrollDragActiveRef.current = false;
    if (isAtBottomRef.current) chatAutoScrollPausedRef.current = false;
  }, []);
  const queueBottomScrollFrame = useCallback((callback: () => void) => {
    const frame = requestAnimationFrame(() => {
      bottomScrollRafRefs.current = bottomScrollRafRefs.current.filter((queuedFrame) => queuedFrame !== frame);
      callback();
    });
    bottomScrollRafRefs.current.push(frame);
  }, []);
  const queueBottomScrollRetry = useCallback((delayMs: number, callback: () => void) => {
    const timer = setTimeout(() => {
      bottomScrollTimeoutRefs.current = bottomScrollTimeoutRefs.current.filter((queuedTimer) => queuedTimer !== timer);
      callback();
    }, delayMs);
    bottomScrollTimeoutRefs.current.push(timer);
  }, []);
  const scrollChatListToLastMessageTarget = useCallback((animated = false) => {
    const list = chatListRefForView.current;
    if (!list) return;
    const lastMessage = lastConversationMessageForViewRef.current;
    const lastIndex = lastConversationMessageIndexForViewRef.current;
    if (!lastMessage || lastIndex < 0) return;
    try {
      list.scrollItemIntoView({ item: lastMessage, animated });
      return;
    } catch {
      // Fall back to index targeting when item lookup is not available yet.
    }
    try {
      list.scrollToIndex({
        index: lastIndex,
        animated,
        viewPosition: 1,
      });
    } catch {
      list.scrollToEnd({ animated });
    }
  }, [chatListRefForView]);
  const scrollChatListToMeasuredBottom = useCallback((animated = false) => {
    const list = chatListRefForView.current;
    if (!list) return;
    const diagnostic = chatScrollDiagnosticRef.current;
    const contentHeight = Math.max(diagnostic.contentHeight, diagnostic.contentSizeHeight);
    const viewportHeight = diagnostic.viewportHeight || currentChatViewportSize.height;
    if (contentHeight <= 0 || viewportHeight <= 0) return;
    list.scrollToOffset({
      offset: Math.max(0, contentHeight - viewportHeight + 2),
      animated,
    });
  }, [chatListRefForView, currentChatViewportSize.height]);
  const scrollChatListToBottom = useCallback((animated = false) => {
    clearPendingBottomScrollFrames();
    queueBottomScrollFrame(() => {
      chatListRefForView.current?.scrollToEnd({ animated });
      scrollChatListToLastMessageTarget(animated);
      scrollChatListToMeasuredBottom(animated);
    });
  }, [
    chatListRefForView,
    clearPendingBottomScrollFrames,
    queueBottomScrollFrame,
    scrollChatListToLastMessageTarget,
    scrollChatListToMeasuredBottom,
  ]);
  const scrollChatListToBottomSettled = useCallback((animated = false) => {
    clearPendingBottomScrollFrames();
    const scrollToBottomOnNextFrame = (nextAnimated: boolean) => {
      queueBottomScrollFrame(() => {
        if (chatAutoScrollPausedRef.current) return;
        chatListRefForView.current?.scrollToEnd({ animated: nextAnimated });
        scrollChatListToLastMessageTarget(nextAnimated);
        scrollChatListToMeasuredBottom(nextAnimated);
      });
    };
    queueBottomScrollFrame(() => {
      if (chatAutoScrollPausedRef.current) return;
      chatListRefForView.current?.scrollToEnd({ animated });
      scrollChatListToLastMessageTarget(animated);
      scrollChatListToMeasuredBottom(animated);
      queueBottomScrollFrame(() => {
        if (chatAutoScrollPausedRef.current) return;
        chatListRefForView.current?.scrollToEnd({ animated: false });
        scrollChatListToLastMessageTarget(false);
        scrollChatListToMeasuredBottom(false);
        queueBottomScrollFrame(() => {
          if (chatAutoScrollPausedRef.current) return;
          chatListRefForView.current?.scrollToEnd({ animated: false });
          scrollChatListToLastMessageTarget(false);
          scrollChatListToMeasuredBottom(false);
        });
      });
    });
    CHAT_BOTTOM_SETTLE_RETRY_DELAYS_MS.forEach((delayMs) => {
      queueBottomScrollRetry(delayMs, () => {
        scrollToBottomOnNextFrame(false);
      });
    });
  }, [
    chatListRefForView,
    clearPendingBottomScrollFrames,
    queueBottomScrollFrame,
    queueBottomScrollRetry,
    scrollChatListToLastMessageTarget,
    scrollChatListToMeasuredBottom,
  ]);
  const updateChatViewportSizeForView = useCallback((widthRaw: number, heightRaw: number) => {
    const width = Number.isFinite(widthRaw) ? widthRaw : 0;
    const height = Number.isFinite(heightRaw) ? heightRaw : 0;
    const setViewportSize = isMiniBoardPopupMode ? setPopupChatViewportSize : setChatViewportSize;
    setViewportSize((prev) => {
      if (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return prev;
      return { width, height };
    });
    if (!isMiniBoardPopupMode) {
      setChatViewportHeight(height);
    }
  }, [isMiniBoardPopupMode, setChatViewportHeight]);
  const maybeSettleChatListToBottom = useCallback(() => {
    if (chatAutoScrollPausedRef.current) return;
    if (!initialSettlingRef.current) return;
    scrollChatListToBottomSettled(false);
  }, [scrollChatListToBottomSettled]);
  const getConversationMessageItemType = useCallback((message: ConversationMessage) => {
    return message.role === "assistant" ? "assistant" : "user";
  }, []);
  const getEstimatedConversationMessageSize = useCallback((
    _index: number,
    message: ConversationMessage,
    itemType: string | undefined
  ) => {
    const resolvedItemType = itemType || getConversationMessageItemType(message);
    const content = String(message.content || "");
    const len = content.length;
    const lineCount = content.length > 0 ? content.split(/\r\n|\r|\n/).length : 1;
    const codeFenceCount = content.match(/```/g)?.length ?? 0;
    const hasCodeBlock = content.includes("```");
    const hasList = /(^|\n)\s*([-*]|\d+\.)\s+/.test(content);
    const hasTable = /(^|\n)\s*\|.+\|\s*(\n|$)/.test(content);
    const hasMedia = Array.isArray(message.youtubeVideoIds) && message.youtubeVideoIds.length > 0;
    const hasWaveform = Array.isArray(message.ttsWaveform) && message.ttsWaveform.length > 0;
    let size = resolvedItemType === "assistant" ? 120 : 92;
    if (len >= 80) size = resolvedItemType === "assistant" ? 220 : 170;
    if (len >= 300) size = resolvedItemType === "assistant" ? 360 : 260;
    if (len >= 1000) size = resolvedItemType === "assistant" ? 620 : 440;
    if (len >= 2400) size = resolvedItemType === "assistant" ? 920 : 700;
    size = Math.max(size, 72 + lineCount * 24);
    if (hasCodeBlock) size += 160 + codeFenceCount * 32;
    if (hasList) size += Math.min(220, lineCount * 12);
    if (hasTable) size += Math.min(260, lineCount * 16);
    if (hasMedia) size += 240;
    if (hasWaveform && resolvedItemType === "assistant") size += 58;
    return Math.min(size, 1_400);
  }, [getConversationMessageItemType]);
  const handleChatScrollForView = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetY = Number(event?.nativeEvent?.contentOffset?.y || 0);
    const contentHeight = Number(event?.nativeEvent?.contentSize?.height || 0);
    const viewportHeight = Number(event?.nativeEvent?.layoutMeasurement?.height || 0);
    const distanceToBottom = Math.max(0, contentHeight - (offsetY + viewportHeight));
    chatScrollDiagnosticRef.current.contentHeight = contentHeight;
    chatScrollDiagnosticRef.current.viewportHeight = viewportHeight;
    const isAtBottom = distanceToBottom <= CHAT_BOTTOM_RESUME_THRESHOLD_PX;
    isAtBottomRef.current = isAtBottom;
    if (isAtBottom && !chatScrollDragActiveRef.current) chatAutoScrollPausedRef.current = false;
    if (!isMiniBoardPopupMode) {
      handleChatScroll(event);
    }
  }, [handleChatScroll, isMiniBoardPopupMode]);
  const handleChatContentSizeChangeForView = useCallback((_widthRaw: number, heightRaw: number) => {
    const previousHeight = chatScrollDiagnosticRef.current.contentSizeHeight;
    const nextHeight = Number(heightRaw || 0);
    chatScrollDiagnosticRef.current.contentSizeHeight = nextHeight;
    updateYouTubeInlineLayoutFromAnchor();
    if (
      nextHeight > previousHeight &&
      didInitialScrollRef.current &&
      !initialSettlingRef.current &&
      !chatAutoScrollPausedRef.current
    ) {
      scrollChatListToBottom(true);
      return;
    }
    maybeSettleChatListToBottom();
  }, [maybeSettleChatListToBottom, scrollChatListToBottom, updateYouTubeInlineLayoutFromAnchor]);
  const handleChatItemSizeChangedForView = useCallback(() => {
    maybeSettleChatListToBottom();
  }, [maybeSettleChatListToBottom]);
  useEffect(() => {
    if (!isMiniBoardMode) return;
    if (miniBoardMountLoggedRef.current) return;
    miniBoardMountLoggedRef.current = true;
    logSessionDiag("mini_board_chat_screen_first_effect", {
      miniBoardCycleId,
      panelId,
      mode,
      selectedSessionId: panelSnapshot.selectedSessionId,
      selectedDirectoryPath: panelSnapshot.selectedDirectoryPath,
      selectedDirectoryDisplayName: panelSnapshot.selectedDirectoryDisplayName,
      selectedSessionTitle: panelSnapshot.selectedSessionTitle,
      modelRef: panelSnapshot.modelRef,
      reasoningEffort: panelSnapshot.reasoningEffort,
      contextUsedPct: panelSnapshot.contextUsedPct,
      isResponding: panelSnapshot.isResponding,
      messageCount: miniSourceMessages.length,
    }, { throttleMs: 0 });
    return () => {
      logSessionDiag("mini_board_chat_screen_unmounted", {
        miniBoardCycleId,
        panelId,
      }, { throttleMs: 0 });
    };
  }, [
    isMiniBoardMode,
    logSessionDiag,
    miniBoardCycleId,
    miniSourceMessages.length,
    mode,
    panelId,
    panelSnapshot.selectedDirectoryDisplayName,
    panelSnapshot.selectedDirectoryPath,
    panelSnapshot.modelRef,
    panelSnapshot.reasoningEffort,
    panelSnapshot.contextUsedPct,
    panelSnapshot.isResponding,
    panelSnapshot.selectedSessionId,
    panelSnapshot.selectedSessionTitle,
  ]);
  useEffect(() => {
    if (!isMiniBoardMode) return;
    const nextSessionId = String(panelSnapshot.selectedSessionId || "").trim();
    const prevSessionId = String(miniBoardPrevSessionIdRef.current || "").trim();
    if (prevSessionId && prevSessionId !== nextSessionId) {
      logSessionDiag("mini_board_chat_screen_session_changed", {
        miniBoardCycleId,
        panelId,
        prevSessionId,
        nextSessionId,
        selectedDirectoryPath: panelSnapshot.selectedDirectoryPath,
      }, { throttleMs: 0 });
    }
    miniBoardPrevSessionIdRef.current = nextSessionId;
  }, [isMiniBoardMode, logSessionDiag, miniBoardCycleId, panelId, panelSnapshot.selectedDirectoryPath, panelSnapshot.selectedSessionId]);
  useEffect(() => {
    if (!isMiniBoardMode) return;
    logSessionDiag("mini_board_panel_snapshot_applied", {
      miniBoardCycleId,
      panelId,
      selectedSessionId: panelSnapshot.selectedSessionId,
      selectedDirectoryPath: panelSnapshot.selectedDirectoryPath,
      selectedDirectoryDisplayName: panelSnapshot.selectedDirectoryDisplayName,
      selectedSessionTitle: panelSnapshot.selectedSessionTitle,
      modelRef: panelSnapshot.modelRef,
      reasoningEffort: panelSnapshot.reasoningEffort,
      isResponding: panelSnapshot.isResponding,
      messageCount: miniSourceMessages.length,
      lastMessageId: miniBoardLastSourceMessage?.id || "",
      lastMessageRole: miniBoardLastSourceMessage?.role || "",
      lastMessageContentLength: String(miniBoardLastSourceMessage?.content || "").length,
      lastMessagePreview: miniBoardLastSourceMessagePreview,
      miniMessageCount: miniMessages.length,
    }, { throttleMs: 0 });
  }, [
    isMiniBoardMode,
    logSessionDiag,
    miniBoardCycleId,
    miniBoardLastSourceMessage?.id,
    miniBoardLastSourceMessage?.role,
    miniMessages.length,
    miniBoardLastSourceMessagePreview,
    miniBoardSnapshotLogKey,
    miniSourceMessages.length,
    panelId,
    panelSnapshot.selectedDirectoryDisplayName,
    panelSnapshot.selectedDirectoryPath,
    panelSnapshot.modelRef,
    panelSnapshot.reasoningEffort,
    panelSnapshot.isResponding,
    panelSnapshot.selectedSessionId,
    panelSnapshot.selectedSessionTitle,
  ]);
  const sendReplyTranscriptByPanel = useCallback(() => {
    if (!usesPanelComposerState) {
      void sendReplyTranscript();
      return;
    }
    const text = transcriptForView.trim();
    if (!text) return;
    setPanelTranscript("");
    void sendReplyTranscriptForPanel(panelId, text);
  }, [
    panelId,
    sendReplyTranscript,
    sendReplyTranscriptForPanel,
    transcriptForView,
    usesPanelComposerState,
  ]);
  const openComposerFullscreenForView = useCallback(() => {
    if (!isMiniBoardPopupMode) {
      openComposerFullscreen();
      return;
    }
    setComposerInputFocused(false);
    setPopupComposerFullscreenOpen(true);
  }, [isMiniBoardPopupMode, openComposerFullscreen, setComposerInputFocused]);
  const closePopupComposerFullscreen = useCallback(() => {
    setPopupComposerFullscreenOpen(false);
    setTimeout(() => {
      chatComposerInputRef.current?.focus();
    }, 60);
  }, [chatComposerInputRef]);
  const openSlashCommandSelectForView = useCallback(() => {
    if (!isMiniBoardPopupMode) {
      setSlashCommandSelectOpen(true);
      return;
    }
    setPopupSlashCommandSelectOpen(true);
  }, [isMiniBoardPopupMode, setSlashCommandSelectOpen]);
  const closePopupSlashCommandSelect = useCallback(() => {
    setPopupSlashCommandSelectOpen(false);
  }, []);
  const selectPopupSlashCommand = useCallback((command: string) => {
    setPopupSlashCommandSelectOpen(false);
    if (isMiniBoardPopupMode && panelId) {
      logSessionDiag("popup_slash_command_selected", {
        miniBoardCycleId,
        panelId,
        sessionId: String(panelSnapshot.selectedSessionId || "").trim() || undefined,
        directory: String(panelSnapshot.selectedDirectoryPath || "").trim() || undefined,
        command,
      }, { throttleMs: 0 });
      sendReplyRequestForPanelWithTranscript(panelId, command);
      return;
    }
    onSelectSlashCommand(command);
  }, [
    isMiniBoardPopupMode,
    logSessionDiag,
    miniBoardCycleId,
    onSelectSlashCommand,
    panelId,
    panelSnapshot.selectedDirectoryPath,
    panelSnapshot.selectedSessionId,
    sendReplyRequestForPanelWithTranscript,
  ]);
  const selectModelForView = useCallback((nextModelRef: string) => {
    if (isPanelRuntimeView) {
      updatePanelSettings(panelId, { modelRef: nextModelRef });
    } else {
      selectModel(nextModelRef);
    }
    setFooterSelectOpen(null);
  }, [isPanelRuntimeView, panelId, selectModel, updatePanelSettings]);
  const selectThinkOptionForView = useCallback((nextReasoningEffort: ReasoningEffort) => {
    if (isPanelRuntimeView) {
      updatePanelSettings(panelId, { reasoningEffort: nextReasoningEffort });
    } else {
      selectThinkOption(nextReasoningEffort);
    }
    setFooterSelectOpen(null);
  }, [isPanelRuntimeView, panelId, selectThinkOption, updatePanelSettings]);

  useEffect(() => {
    if (!approvalDialogPending) return;
    setFooterSelectOpen(null);
    setDirectoryMenuMode("actions");
    setDirectoryMenuOpen(false);
    setPopupComposerFullscreenOpen(false);
    setPopupSlashCommandSelectOpen(false);
    setSlashCommandSelectOpen(false);
    setGitDiffPanelOpen(false);
    setRunnerMedia(null);
  }, [approvalDialogPending, setSlashCommandSelectOpen]);

  useEffect(() => {
    if (!isMiniBoardPopupMode) return undefined;
    return () => {
      setFooterSelectOpen(null);
      setDirectoryMenuMode("actions");
      setDirectoryMenuOpen(false);
      setPopupComposerFullscreenOpen(false);
      setPopupSlashCommandSelectOpen(false);
      setSlashCommandSelectOpen(false);
    };
  }, [isMiniBoardPopupMode, setSlashCommandSelectOpen]);

  useEffect(() => {
    if (!directoryMenuOpen) return;
    setDirectoryMenuMode("actions");
    setDirectoryRenameInput(String(selectedDirectoryDisplayNameForView || "").trim());
    setDirectorySessionTitleInput(String(selectedSessionTitleForView || "").trim());
  }, [directoryMenuOpen, selectedDirectoryDisplayNameForView, selectedSessionTitleForView]);

  useEffect(() => {
    const timer = setInterval(() => {
      setExecutionNowTick((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    didInitialScrollRef.current = false;
    initialSettlingRef.current = false;
    isAtBottomRef.current = true;
    chatAutoScrollPausedRef.current = false;
    chatScrollDragActiveRef.current = false;
    previousMessageCountRef.current = 0;
    chatScrollDiagnosticRef.current.contentSizeHeight = 0;
    if (initialSettleTimerRef.current !== null) {
      clearTimeout(initialSettleTimerRef.current);
      initialSettleTimerRef.current = null;
    }
    clearPendingBottomScrollFrames();
  }, [clearPendingBottomScrollFrames, conversationScrollResetKey]);
  useEffect(() => {
    const width = Math.round(Number(currentChatViewportSize.width || 0));
    if (width <= 0) return;
    const cacheKey = [
      isMiniBoardPopupMode ? "popup" : "full",
      conversationScrollResetKey,
      width,
    ].join("|");
    if (lastChatCacheKeyRef.current === cacheKey) return;
    lastChatCacheKeyRef.current = cacheKey;
    (chatListRefForView.current as OptionalSizeCacheLegendListRef | null)?.clearCaches?.({ mode: "sizes" });
    setChatListCacheVersion((prev) => prev + 1);
  }, [
    chatListRefForView,
    conversationScrollResetKey,
    currentChatViewportSize.width,
    isMiniBoardPopupMode,
  ]);
  useEffect(() => {
    if (chatListCacheVersion <= 0) return;
    if (settledChatCacheVersionRef.current === chatListCacheVersion) return;
    if (conversationMessagesForView.length <= 0) return;
    settledChatCacheVersionRef.current = chatListCacheVersion;
    initialSettlingRef.current = true;
    isAtBottomRef.current = true;
    scrollChatListToBottomSettled(false);
    if (initialSettleTimerRef.current !== null) {
      clearTimeout(initialSettleTimerRef.current);
    }
    initialSettleTimerRef.current = setTimeout(() => {
      initialSettlingRef.current = false;
      initialSettleTimerRef.current = null;
    }, CHAT_INITIAL_SCROLL_SETTLE_MS);
  }, [
    chatListCacheVersion,
    conversationMessagesForView.length,
    scrollChatListToBottomSettled,
  ]);
  useEffect(() => {
    if (conversationMessagesForView.length <= 0) return;
    if (didInitialScrollRef.current) return;
    didInitialScrollRef.current = true;
    initialSettlingRef.current = true;
    isAtBottomRef.current = true;
    previousMessageCountRef.current = conversationMessagesForView.length;
    scrollChatListToBottomSettled(false);
    if (initialSettleTimerRef.current !== null) {
      clearTimeout(initialSettleTimerRef.current);
    }
    initialSettleTimerRef.current = setTimeout(() => {
      initialSettlingRef.current = false;
      initialSettleTimerRef.current = null;
    }, CHAT_INITIAL_SCROLL_SETTLE_MS);
  }, [conversationMessagesForView.length, conversationScrollResetKey, scrollChatListToBottomSettled]);
  useEffect(() => {
    const currentMessageCount = conversationMessagesForView.length;
    const previousMessageCount = previousMessageCountRef.current;
    const currentLastMessage = conversationMessagesForView[currentMessageCount - 1];
    const currentLastMessageId = currentLastMessage?.id || "";
    previousMessageCountRef.current = currentMessageCount;
    if (!didInitialScrollRef.current) return;
    if (currentMessageCount <= previousMessageCount) return;
    if (!currentLastMessageId) return;
    if (currentLastMessage?.role === "user") {
      isAtBottomRef.current = true;
      chatAutoScrollPausedRef.current = false;
      scrollChatListToBottom(true);
      return;
    }
    if (chatAutoScrollPausedRef.current) return;
    scrollChatListToBottom(true);
  }, [conversationMessagesForView.length, conversationScrollResetKey, scrollChatListToBottom]);
  useEffect(() => () => {
    if (initialSettleTimerRef.current !== null) {
      clearTimeout(initialSettleTimerRef.current);
    }
    clearPendingBottomScrollFrames();
  }, [clearPendingBottomScrollFrames]);
  useEffect(() => {
    if (!popupComposerFullscreenOpen) return;
    const timer = setTimeout(() => {
      popupComposerFullscreenInputRef.current?.focus();
    }, 60);
    return () => clearTimeout(timer);
  }, [popupComposerFullscreenOpen]);
  const getPathLabel = useCallback((pathRaw: unknown) => {
    const normalized = normalizeRunnerPath(pathRaw);
    const fallbackLabel = String(selectedDirectoryDisplayNameForView || "").trim() || "Directory";
    if (!normalized || normalized === ".") return fallbackLabel;
    if (normalized === "/") return "/";
    const parts = normalized.split("/").map((part) => String(part || "").trim()).filter(Boolean).filter((part) => part !== ".");
    return parts[parts.length - 1] || fallbackLabel;
  }, [selectedDirectoryDisplayNameForView]);

  const openGitDiffPanel = useCallback(() => {
    chatComposerInputRef?.current?.blur?.();
    setComposerInputFocused(false);
    setGitDiffPanelOpen(true);
  }, [chatComposerInputRef, setComposerInputFocused]);
  const showInfoToast = useCallback((textRaw: unknown) => {
    const text = String(textRaw || "").trim();
    if (!text) return;
    if (typeof showChatBottomToast === "function") {
      showChatBottomToast("assistant", text);
      return;
    }
    Alert.alert("通知", text);
  }, [showChatBottomToast]);
  const {
    renameTarget: chatFileRenameTarget,
    requestRename: requestChatFileRename,
    cancelRename: cancelChatFileRename,
    renameFile: renameChatFile,
    renameFileTarget: renameChatFileTarget,
    deleteFile: deleteChatFile,
  } = useWorkspaceFileMutations({
    runnerUrl,
    runnerToken,
    rootDirectory: selectedDirectoryPathForView,
    refreshChangedFiles: gitChangedFiles.refresh,
    showInfoToast,
  });
  const openChatFileLinkContextMenu = useCallback((filePathRaw: unknown) => {
    const filePath = normalizeRunnerPath(filePathRaw);
    if (!filePath) return;
    openRunnerFileContextMenu({
      filePathRaw: filePath,
      fileNameRaw: getPathLabel(filePath),
      runnerUrl,
      runnerToken,
      rootDir: selectedDirectoryPathForView,
      allowExecute: true,
      allowMutate: true,
      getPathLabel,
      showInfoToast,
      onOpenMedia: setRunnerMedia,
      onShellScriptStarted: () => {
        setGitDiffPanelOpen(true);
      },
      onRequestRename: requestChatFileRename,
      onRequestDelete: deleteChatFile,
      onRenameFile: renameChatFileTarget,
    });
  }, [
    deleteChatFile,
    getPathLabel,
    renameChatFileTarget,
    requestChatFileRename,
    runnerToken,
    runnerUrl,
    selectedDirectoryPathForView,
    showInfoToast,
  ]);
  const readSelectedMessageText = useCallback((message: ConversationMessage, selectedTextRaw: unknown) => {
    const selectedText = String(selectedTextRaw || "").trim();
    if (!sanitizeTextForTts(selectedText)) return;
    void handleAssistantAudioButtonPress({
      ...message,
      role: "assistant",
      content: selectedText,
    }, {
      panelId: isPanelRuntimeView ? panelId : undefined,
      sessionId: isPanelRuntimeView
        ? (String(panelSnapshot.selectedSessionId || "").trim() || undefined)
        : undefined,
    });
  }, [
    handleAssistantAudioButtonPress,
    isPanelRuntimeView,
    panelId,
    panelSnapshot.selectedSessionId,
    sanitizeTextForTts,
  ]);

  const openFooterSelect = (target: ChatFooterSelectTarget) => {
    const triggerRef = target === "model" ? modelSelectTriggerRef : thinkSelectTriggerRef;
    if (!triggerRef.current || typeof triggerRef.current.measureInWindow !== "function") {
      setFooterSelectOpen(target);
      return;
    }
    triggerRef.current.measureInWindow((x, y, width, height) => {
      setFooterSelectAnchor({
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
      });
      setFooterSelectOpen(target);
    });
  };

  const selectedSessionMarkerLabel = useMemo(() => {
    const found = DIRECTORY_MARKER_OPTIONS.find((item) => item.value === selectedSessionMarkerColorForView);
    return found?.label || "なし";
  }, [selectedSessionMarkerColorForView]);
  const directoryHeaderMarkerColorHex = markerColorToDotHex(selectedSessionMarkerColorForView);
  const actionSessionIdForView = isPanelSnapshotView
    ? String(panelSnapshot.selectedSessionId || "").trim()
    : String(selectedLlmSessionId || "").trim();
  const actionDirectoryPathForView = String(selectedDirectoryPathForView || "").trim();
  const renameDirectoryForView = useCallback((nextDisplayName: string) => {
    if (isPanelSnapshotView) {
      renameDirectoryForPath(actionDirectoryPathForView, nextDisplayName);
      return;
    }
    renameSelectedDirectory(nextDisplayName);
  }, [actionDirectoryPathForView, isPanelSnapshotView, renameDirectoryForPath, renameSelectedDirectory]);
  const renameSessionTitleForView = useCallback((nextTitle: string) => {
    if (isPanelSnapshotView) {
      renameSessionTitleForSession(actionSessionIdForView, nextTitle);
      return;
    }
    renameSelectedSessionTitle(nextTitle);
  }, [actionSessionIdForView, isPanelSnapshotView, renameSelectedSessionTitle, renameSessionTitleForSession]);
  const selectSessionMarkerColorForView = useCallback((nextMarkerColor: DirectoryMarkerColor) => {
    if (isPanelSnapshotView) {
      selectSessionMarkerColorForSession(actionSessionIdForView, nextMarkerColor);
      return;
    }
    selectSelectedSessionMarkerColor(nextMarkerColor);
  }, [actionSessionIdForView, isPanelSnapshotView, selectSelectedSessionMarkerColor, selectSessionMarkerColorForSession]);
  const removeDirectoryForView = useCallback(() => {
    if (isPanelSnapshotView) {
      removeDirectoryForPath(actionDirectoryPathForView);
      return;
    }
    removeSelectedDirectory();
  }, [actionDirectoryPathForView, isPanelSnapshotView, removeDirectoryForPath, removeSelectedDirectory]);
  const markSessionUnreadForView = useCallback(() => {
    if (isPanelSnapshotView) {
      if (!actionSessionIdForView) return;
      markSessionUnread({
        sessionId: actionSessionIdForView,
        source: "all",
        directory: actionDirectoryPathForView,
      });
      return;
    }
    markSelectedSessionUnread();
  }, [
    actionDirectoryPathForView,
    actionSessionIdForView,
    isPanelSnapshotView,
    markSelectedSessionUnread,
    markSessionUnread,
  ]);
  const submitDirectoryRename = () => {
    renameDirectoryForView(String(directoryRenameInput || "").trim());
    setDirectoryMenuMode("actions");
    setDirectoryMenuOpen(false);
  };
  const submitSessionTitleRename = () => {
    renameSessionTitleForView(String(directorySessionTitleInput || "").trim());
    setDirectoryMenuMode("actions");
    setDirectoryMenuOpen(false);
  };

  const executionNowMs = Date.now() + (executionNowTick * 0);
  const executionElapsedLabel = (() => {
    if (replyLoadingForView) {
      const panelRequestStartedAtMs = Number(panelSnapshot.requestStartedAtMs || 0);
      if (isPanelRuntimeView && Number.isFinite(panelRequestStartedAtMs) && panelRequestStartedAtMs > 0) {
        return formatElapsedHhMmSs(Math.max(0, executionNowMs - panelRequestStartedAtMs));
      }
      return formatElapsedHhMmSs(llmElapsedLiveMs);
    }
    const startedAtMs = Number(selectedSessionExecutionFactForView?.startedAtMs || 0);
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return "不明";
    return formatElapsedHhMmSs(Math.max(0, executionNowMs - startedAtMs));
  })();
  const miniBoardUpdatedAtLabel = isMiniBoardPreviewMode
    ? formatRelativeUpdatedAt(miniSourceSessionUpdatedAt, executionNowMs)
    : "";

  const footerSelectEstimatedHeight = (
    (footerSelectOpen === "model" ? modelOptions.length : thinkOptions.length) * 34
  ) + 8;
  const footerSelectTop = Math.max(8, footerSelectAnchor.y - footerSelectEstimatedHeight - 6);
  const gitDiffBranchName = String(gitChangedFiles.branchName || "").trim() || "HEAD";
  const gitDiffBehindCount = Math.max(0, Math.floor(Number(gitChangedFiles.behindCount) || 0));
  const gitDiffAddedCount = countGitChangedFiles(gitChangedFiles.stagedFiles);
  const gitDiffRemovedCount = countGitChangedFiles(gitChangedFiles.unstagedFiles);

  const renderAssistantStatusChip = useCallback((message: ConversationMessage): ReactElement | null => {
    if (message.role === "user") return null;
    const messageStatus = message.llmStatus || "completed";
    if (messageStatus === "completed") return null;
    const messageVisual = llmStatusVisual(messageStatus);
    const messageStatusText = llmStatusLabel(messageStatus);
    const messagePixelIconKey = resolvePixelStatusIconKey(messageStatus, message.llmStatusDetail || "");
    const useBouncingDotsStatus = messagePixelIconKey === "model_generating" || messagePixelIconKey === "model_processing";
    return (
      <View style={styles.chatAssistantMetaRow}>
        {useBouncingDotsStatus ? (
          <View style={styles.chatStatusLottieWrap}>
            <BouncingDotsIndicator />
          </View>
        ) : (
          <View
            style={[
              styles.chatStatusChip,
              { backgroundColor: messageVisual.bg, borderColor: messageVisual.border },
            ]}
          >
            <View style={styles.chatStatusLottieWrap}>
              <Image source={pixelStatusAnimations[messagePixelIconKey]} style={styles.chatStatusLottie} />
            </View>
            <Text style={[styles.chatStatusText, { color: messageVisual.text }]}> {messageStatusText}</Text>
          </View>
        )}
      </View>
    );
  }, [
    llmStatusLabel,
    llmStatusVisual,
    pixelStatusAnimations,
    resolvePixelStatusIconKey,
  ]);

  const renderConversationMessage = ({
    item: message,
    index,
  }: {
    item: ConversationMessage;
    index: number;
  }) => {
    const isUser = message.role === "user";
    const inheritedFromParent = message.inheritedFromParent === true;
    const showSubagentBoundary = (
      !inheritedFromParent
      && index > 0
      && conversationMessagesForView[index - 1]?.inheritedFromParent === true
    );
    const messageSttMetaChips = isUser ? buildSttMetaChips(message.sttMeta) : [];
    const messageYouTubeVideoIds = message.youtubeVideoIds || [];
    const messageYouTubeVideos = messageYouTubeVideoIds.map((videoId: string) => {
      const meta = youtubeVideoMetaById[videoId];
      return {
        videoId,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        channelTitle: String(meta?.channelTitle || "").trim(),
        publishedAt: String(meta?.publishedAt || "").trim(),
        viewCount: Number.isFinite(Number(meta?.viewCount)) ? Number(meta?.viewCount) : null,
      };
    });
    const isActiveMessage = conversationInlineAnchorMessageId === message.id;
    const isMessagePlaybackActive = ttsPlaybackMessageIdForView === message.id && isTtsPlaybackActive;
    const isMessagePlaybackTarget = ttsPlaybackMessageIdForView === message.id;
    const messagePlaybackRingProgress = isMessagePlaybackTarget ? ttsSegmentProgress.playbackRatio : 0;
    const messageStatusRingProgress = isMessagePlaybackTarget ? ttsSegmentProgress.generationRatio : 0;
    const messageTimestampLabel = formatMessageTimestampLabel(message.at);
    const codexQueue = isUser ? message.codexQueue : null;
    const queuedTurnId = String(codexQueue?.queuedTurnId || "").trim();
    const queueStatus = String(codexQueue?.status || "").trim();
    const queueCanCancel = !!queuedTurnId && (queueStatus === "queued" || queueStatus === "waiting_compact");
    return (
      <View style={styles.chatMessageGroup}>
        {showSubagentBoundary ? (
          <View style={styles.chatSubagentBoundary}>
            <View style={styles.chatSubagentBoundaryLine} />
            <Text style={styles.chatSubagentBoundaryText}>サブエージェント開始</Text>
            <View style={styles.chatSubagentBoundaryLine} />
          </View>
        ) : null}
        {message.commandExecution ? (
          <CommandExecutionRow {...message.commandExecution} />
        ) : (
        <View
          style={[
            styles.chatBubble,
            isUser ? styles.chatBubbleUser : styles.chatBubbleAssistant,
            inheritedFromParent ? styles.chatBubbleInheritedFromParent : null,
          ]}
        >
          <Text
            style={[
              styles.chatBubbleLabel,
              isUser ? styles.chatBubbleLabelUser : styles.chatBubbleLabelAssistant,
            ]}
          >
            {isUser ? "YOU" : "ASSISTANT"}
          </Text>
          {message.content ? (
            <MarkdownText
              content={message.content}
              tone={isUser ? "user" : "assistant"}
              textStyle={[
                styles.chatBubbleText,
                isUser ? styles.chatBubbleTextUser : styles.chatBubbleTextAssistant,
              ]}
              onLocalFileLinkPress={openChatFileLinkContextMenu}
              onSelectedTextTtsPress={(selectedText) => readSelectedMessageText(message, selectedText)}
            />
          ) : null}
          {isUser && messageSttMetaChips.length > 0 ? (
            <View style={styles.chatUserMetaRow}>
              {messageSttMetaChips.map((chip: string, chipIndex: number) => (
                <Text key={`${message.id}-stt-${chipIndex}`} style={styles.chatUserMetaChip}>
                  {chip}
                </Text>
              ))}
            </View>
          ) : null}
          {queuedTurnId ? (
            <View style={styles.chatUserQueueRow}>
              <Text style={styles.chatUserQueueText}>
                {queueStatus === "cancelled"
                  ? "queue キャンセル済み"
                  : queueStatus === "running"
                    ? "queue 実行中"
                    : queueStatus === "completed"
                      ? "queue 実行済み"
                      : queueStatus === "failed"
                        ? "queue 失敗"
                        : "queue 追加済み"}
              </Text>
              {queueCanCancel ? (
                <TouchableOpacity
                  style={styles.chatUserQueueCancelButton}
                  onPress={() => {
                    void cancelCodexQueuedTurnForMessage({
                      queuedTurnId,
                      messageId: message.id,
                      panelId: isPanelRuntimeView ? panelId : undefined,
                    });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="queueをキャンセル"
                >
                  <Text style={styles.chatUserQueueCancelButtonText}>キャンセル</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
          {!isUser && messageYouTubeVideos.length > 0 ? (
            <View style={styles.chatSection}>
              <Text style={styles.chatSectionTitle}>YouTube</Text>
              <YouTubeVideoList
                videos={messageYouTubeVideos}
                isVideoActive={(videoId) => isActiveMessage && youtubePlayerVideoId === videoId}
                onOpenVideo={(videoId, queueIndex) => {
                  openYouTubeVideo(videoId, message.id, {
                    queueVideoIds: messageYouTubeVideoIds,
                    queueIndex,
                  });
                }}
                youtubePlayerVideoId={youtubePlayerVideoId}
                youtubePlayerSession={youtubePlayerSession}
                youtubeEmbedHtml={youtubeEmbedHtml}
                youtubeEmbedOrigin={youtubeEmbedOrigin}
                youtubeWebViewRef={youtubeWebViewRef}
                onYouTubeWebViewMessage={handleYouTubeWebViewMessage}
                formatYouTubePublishedDate={formatYouTubePublishedDate}
                formatYouTubeViewCount={formatYouTubeViewCount}
                showFloatingYouTubePlayer={showFloatingYouTubePlayer}
                setYoutubeInlineAnchor={setYoutubeInlineAnchor}
                onUpdateYouTubeInlineLayout={updateYouTubeInlineLayoutFromAnchor}
              />
            </View>
          ) : null}
          {renderAssistantStatusChip(message)}
          {!isUser && message.llmStatusDetail ? (
            <Text style={styles.chatStatusDetailText}>{message.llmStatusDetail}</Text>
          ) : null}
          <View
            style={[
              styles.chatMessageMetaRow,
              isUser ? styles.chatMessageMetaRowUser : styles.chatMessageMetaRowAssistant,
            ]}
          >
            {messageTimestampLabel ? (
              <Text
                style={[
                  styles.chatMessageTimestampText,
                  isUser ? styles.chatMessageTimestampTextUser : styles.chatMessageTimestampTextAssistant,
                ]}
              >
                {messageTimestampLabel}
              </Text>
            ) : null}
            <TouchableOpacity
              style={styles.chatMessageUnreadButton}
              onPress={markSessionUnreadForView}
              accessibilityRole="button"
              accessibilityLabel="セッションを未読にする"
            >
              <Ionicons name="mail-unread-outline" size={13} color="#94a3b8" />
            </TouchableOpacity>
          </View>
        </View>
        )}
        {!isUser && !message.commandExecution ? (
          <TtsWaveformPlayer
            isPlaybackActive={isMessagePlaybackActive}
            playButtonDisabled={!runnerUrl.trim() || !runnerToken.trim() || !sanitizeTextForTts(message.content)}
            playbackRingProgress={messagePlaybackRingProgress}
            statusRingProgress={messageStatusRingProgress}
            onPressPlayStop={() => {
              void handleAssistantAudioButtonPress(message, {
                panelId: isPanelRuntimeView ? panelId : undefined,
                sessionId: isPanelRuntimeView
                  ? (String(panelSnapshot.selectedSessionId || "").trim() || undefined)
                  : undefined,
              });
            }}
          />
        ) : null}
      </View>
    );
  };

  if (isMiniBoardPreviewMode) {
    return (
      <View style={[styles.chatScreen, styles.miniBoardPreviewChatScreen]}>
        {replyLoadingForView ? (
          <View pointerEvents="none" style={styles.miniChatRespondingBadge}>
            <BouncingDotsIndicator dotSize={6} gap={5} jumpHeight={6} />
          </View>
        ) : null}
        <View style={[styles.chatHeader, styles.miniBoardPreviewChatHeader]}>
          <View style={[styles.chatHeaderLeft, styles.miniBoardPreviewChatHeaderLeft]}>
            <View style={[styles.chatDirectoryHeaderButton, styles.miniBoardPreviewChatDirectoryButton]}>
              <View style={[styles.chatDirectoryHeaderPrimaryRow, styles.miniBoardPreviewChatDirectoryPrimaryRow]}>
                {directoryHeaderMarkerColorHex ? (
                  <View
                    style={[
                      styles.chatDirectoryHeaderMarkerDot,
                      styles.miniBoardPreviewChatMarkerDot,
                      { backgroundColor: directoryHeaderMarkerColorHex },
                    ]}
                  />
                ) : null}
                <Text style={[styles.chatDirectoryHeaderButtonText, styles.miniBoardPreviewChatTitle]} numberOfLines={1}>
                  {selectedDirectoryDisplayNameForView || "Directory"}
                </Text>
              </View>
              <Text style={[styles.chatDirectoryHeaderSessionTitleText, styles.miniBoardPreviewChatSubtitle]} numberOfLines={1}>
                {selectedSessionTitleForView || "Session"}
              </Text>
            </View>
          </View>
          <View style={[styles.chatHeaderRight, styles.miniBoardPreviewChatHeaderRight]}>
            <View style={[styles.chatContextWrap, styles.miniBoardPreviewChatContextWrap]}>
              <Text style={[styles.chatContextPctText, styles.miniBoardPreviewChatContextPctText]}>
                {chatContextPctTextForView}%
              </Text>
            </View>
          </View>
        </View>
        <View style={[styles.chatScroll, styles.miniBoardPreviewChatScroll]}>
          <ScrollView
            style={[styles.chatScroll, styles.miniBoardPreviewChatScroll]}
            contentContainerStyle={[styles.chatScrollContent, styles.miniBoardPreviewChatScrollContent]}
            showsVerticalScrollIndicator={false}
            scrollEnabled={isMiniBoardPopupMode}
          >
            {miniMessages.length <= 0 ? (
              <Text style={[styles.chatEmpty, styles.miniBoardPreviewChatEmpty]}>まだ会話がありません。</Text>
            ) : (
              miniMessages.map((message) => (
                <View key={message.id} style={[styles.chatMessageGroup, styles.miniBoardPreviewChatMessageGroup]}>
                  <View style={[styles.chatBubble, styles.miniBoardPreviewChatBubble]}>
                    <MarkdownText
                      content={message.content}
                      tone="assistant"
                      textStyle={[styles.chatBubbleText, styles.miniBoardPreviewChatBubbleText]}
                      onLocalFileLinkPress={openChatFileLinkContextMenu}
                      onSelectedTextTtsPress={(selectedText) => readSelectedMessageText(message, selectedText)}
                    />
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        </View>
        {miniBoardUpdatedAtLabel ? (
          <View pointerEvents="none" style={styles.miniBoardPreviewUpdatedAtBadge}>
            <Text style={styles.miniBoardPreviewUpdatedAtText}>{miniBoardUpdatedAtLabel}</Text>
          </View>
        ) : null}
      </View>
    );
  }

  if (!hasSelectedDirectoryForView) {
    return (
      <View style={styles.chatScreen}>
        <View style={styles.chatHeader} {...popupHeaderPanResponder.panHandlers}>
          <View style={styles.chatHeaderLeft}>
            <TouchableOpacity
              onPress={isMiniBoardPopupMode && onTogglePopupPresentation ? onTogglePopupPresentation : openDrawer}
              accessibilityRole="button"
              accessibilityLabel={isMiniBoardPopupMode ? "ポップアップチャットの表示サイズを切り替え" : "メニューを開く"}
            >
              <PixelRobotIndicator
                active={isRobotAnimating}
                activeSource={pixelRobotImage}
                idleSource={pixelRobotImageStatic}
              />
            </TouchableOpacity>
          </View>
        </View>
        <KeyboardAvoidingView
          style={styles.chatKeyboardAvoiding}
          behavior={Platform.OS === "ios" ? "position" : "height"}
          contentContainerStyle={Platform.OS === "ios" ? styles.chatKeyboardAvoidingContent : undefined}
          automaticOffset={Platform.OS === "ios"}
          keyboardVerticalOffset={keyboardVerticalOffset}
        >
          <View style={styles.chatKeyboardAvoidingBody}>
            <View style={styles.chatSelectionRequiredWrap}>
              <Text style={styles.chatSelectionRequiredTitle}>ディレクトリーを選択してください</Text>
              <Text style={styles.chatSelectionRequiredHint}>
                左メニューから「+ 追加」で登録し、ディレクトリーを選択するとチャットを開始できます。
              </Text>
              <TouchableOpacity style={styles.chatSelectionRequiredButton} onPress={openDrawer}>
                <Text style={styles.chatSelectionRequiredButtonText}>メニューを開く</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    );
  }

  return (
    <View
      style={styles.chatScreen}
      onLayout={(event) => {
        const layout = event.nativeEvent.layout;
        const width = Number(layout?.width || 0);
        const height = Number(layout?.height || 0);
        setChatScreenLayout((prev: { width: number; height: number }) => {
          if (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) {
            return prev;
          }
          return { width, height };
        });
      }}
    >
      <View style={styles.chatHeader} {...popupHeaderPanResponder.panHandlers}>
        <View style={styles.chatHeaderLeft}>
          <TouchableOpacity
            onPress={isMiniBoardPopupMode && onTogglePopupPresentation ? onTogglePopupPresentation : openDrawer}
            accessibilityRole="button"
            accessibilityLabel={isMiniBoardPopupMode ? "ポップアップチャットの表示サイズを切り替え" : "メニューを開く"}
          >
            <PixelRobotIndicator
              active={isRobotAnimating}
              activeSource={pixelRobotImage}
              idleSource={pixelRobotImageStatic}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.chatDirectoryHeaderButton}
            onPress={() => {
              setDirectoryMenuMode("actions");
              setDirectoryMenuOpen(true);
            }}
          >
            <View style={styles.chatDirectoryHeaderPrimaryRow}>
              {directoryHeaderMarkerColorHex ? (
                <View
                  style={[
                    styles.chatDirectoryHeaderMarkerDot,
                    { backgroundColor: directoryHeaderMarkerColorHex },
                  ]}
                />
              ) : null}
              <Text style={styles.chatDirectoryHeaderButtonText} numberOfLines={1}>
                {selectedDirectoryDisplayNameForView}
              </Text>
            </View>
            <Text style={styles.chatDirectoryHeaderSessionTitleText} numberOfLines={1}>
              {selectedSessionTitleForView}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.chatHeaderRight}>
          <TouchableOpacity
            style={styles.gitDiffHeaderButton}
            onPress={openGitDiffPanel}
            accessibilityRole="button"
            accessibilityLabel="Git差分パネルを開く"
          >
            <Text style={styles.gitDiffHeaderBehindText}>{`↓${gitDiffBehindCount}`}</Text>
            <View style={styles.gitDiffHeaderSummary}>
              <Text style={styles.gitDiffHeaderBranchText} numberOfLines={1}>
                {gitDiffBranchName}
              </Text>
              <View style={styles.gitDiffHeaderCountRow}>
                <Text style={styles.gitDiffHeaderButtonPlusText}>{`+${gitDiffAddedCount}`}</Text>
                <Text style={styles.gitDiffHeaderButtonMinusText}>{`-${gitDiffRemovedCount}`}</Text>
              </View>
            </View>
          </TouchableOpacity>
          <View style={styles.chatContextWrap}>
            <ChatContextUsageMenu
              dismissed={approvalDialogPending}
              contextPctText={chatContextPctTextForView}
              directoryPath={selectedDirectoryPathForView}
              progress={chatContextRingProgressForView}
              trackColor={chatContextRingTrackColor}
              progressColor={chatContextRingProgressColor}
              onStartNewSession={startNewSessionForView}
            />
          </View>
        </View>
      </View>
      <KeyboardAvoidingView
        style={styles.chatKeyboardAvoiding}
        behavior={Platform.OS === "ios" ? "position" : "height"}
        contentContainerStyle={Platform.OS === "ios" ? styles.chatKeyboardAvoidingContent : undefined}
        automaticOffset={Platform.OS === "ios"}
        keyboardVerticalOffset={keyboardVerticalOffset}
      >
        <View style={styles.chatKeyboardAvoidingBody}>
        {activeYouTubeQueuePositionLabel ? (
          <Text style={styles.chatYouTubeQueueHint}>YouTube キュー: {activeYouTubeQueuePositionLabel}</Text>
        ) : null}
        <View
          ref={chatContentRef}
          style={styles.chatScroll}
          onLayout={() => {
            updateYouTubeInlineLayoutFromAnchor();
          }}
        >
          {showMessagesSkeletonForView ? (
            <View style={styles.popupMessagesSkeleton}>
              <View style={styles.popupMessagesSkeletonBubbleWide} />
              <View style={styles.popupMessagesSkeletonBubble} />
              <View style={styles.popupMessagesSkeletonBubbleShort} />
            </View>
          ) : (
            <LegendList
              key={chatListRenderKey}
              ref={chatListRefForView}
              style={styles.chatScroll}
              data={conversationMessagesForView}
              renderItem={renderConversationMessage}
              keyExtractor={(message) => message.id}
              estimatedItemSize={CHAT_ESTIMATED_ITEM_SIZE}
              estimatedListSize={estimatedChatListSize}
              extraData={chatListLayoutVersion}
              getItemType={getConversationMessageItemType}
              getEstimatedItemSize={getEstimatedConversationMessageSize}
              suggestEstimatedItemSize={__DEV__}
              waitForInitialLayout
              contentContainerStyle={styles.chatScrollContent}
              keyboardShouldPersistTaps="handled"
              onTouchStart={() => {
                pauseChatAutoScrollForInteraction();
                handleChatTouchStartForView?.();
              }}
              onTouchEnd={handleChatTouchEndForAutoScroll}
              onTouchCancel={handleChatTouchCancelForAutoScroll}
              onScrollBeginDrag={handleChatScrollInteractionBegin}
              onScrollEndDrag={handleChatScrollInteractionEnd}
              onMomentumScrollBegin={handleChatScrollInteractionBegin}
              onMomentumScrollEnd={handleChatScrollInteractionEnd}
              onLayout={(event) => {
                const layout = event.nativeEvent.layout;
                updateChatViewportSizeForView(Number(layout?.width || 0), Number(layout?.height || 0));
              }}
              onScroll={handleChatScrollForView}
              scrollEventThrottle={16}
              onContentSizeChange={handleChatContentSizeChangeForView}
              onItemSizeChanged={handleChatItemSizeChangedForView}
              ListEmptyComponent={conversationMessagesForView.length === 0 && !replyLoadingForView ? (
                <Text style={styles.chatEmpty}>まだ会話がありません。下の入力欄から送信してください。</Text>
              ) : null}
              ListFooterComponent={(
                <>
                  {replyLoadingForView ? (
                    <View style={styles.chatMessageGroup}>
                      <View style={[styles.chatBubble, styles.chatBubbleAssistant]}>
                        <Text style={[styles.chatBubbleLabel, styles.chatBubbleLabelAssistant]}>ASSISTANT</Text>
                        <View style={styles.chatGeneratingInlineStatus}>
                          <BouncingDotsIndicator />
                          <Text style={styles.chatGeneratingElapsedText}>{executionElapsedLabel}</Text>
                        </View>
                        {showActiveSessionStreamReplyArtifacts && streamReplyYouTubeVideos.length > 0 ? (
                          <View style={styles.chatSection}>
                            <Text style={styles.chatSectionTitle}>YouTube (stream)</Text>
                            <YouTubeVideoList
                              videos={streamReplyYouTubeVideos}
                              isVideoActive={(videoId) => youtubePlayerMessageId === "__stream__" && youtubePlayerVideoId === videoId}
                              onOpenVideo={(videoId, queueIndex) => {
                                openYouTubeVideo(videoId, "__stream__", {
                                  queueVideoIds: streamReplyYouTubeVideoIds,
                                  queueIndex,
                                });
                              }}
                              youtubePlayerVideoId={youtubePlayerVideoId}
                              youtubePlayerSession={youtubePlayerSession}
                              youtubeEmbedHtml={youtubeEmbedHtml}
                              youtubeEmbedOrigin={youtubeEmbedOrigin}
                              youtubeWebViewRef={youtubeWebViewRef}
                              onYouTubeWebViewMessage={handleYouTubeWebViewMessage}
                              formatYouTubePublishedDate={formatYouTubePublishedDate}
                              formatYouTubeViewCount={formatYouTubeViewCount}
                              showFloatingYouTubePlayer={showFloatingYouTubePlayer}
                              setYoutubeInlineAnchor={setYoutubeInlineAnchor}
                              onUpdateYouTubeInlineLayout={updateYouTubeInlineLayoutFromAnchor}
                            />
                          </View>
                        ) : null}
                      </View>
                      {showActiveSessionStreamReplyArtifacts ? (
                        <TtsWaveformPlayer
                          isPlaybackActive={isStreamWaveformPlaybackActive}
                          playButtonDisabled={!isTtsPlaybackActive}
                          playbackRingProgress={isStreamWaveformPlaybackActive ? ttsSegmentProgress.playbackRatio : 0}
                          statusRingProgress={ttsPlaybackMessageIdForView === "__stream__" ? ttsSegmentProgress.generationRatio : 0}
                          onPressPlayStop={() => {
                            void stopWaveformPlayback();
                          }}
                        />
                      ) : null}
                    </View>
                  ) : null}
                  {errorForView ? <Text style={styles.errorText}>{errorForView}</Text> : null}
                  <View
                    collapsable={false}
                    style={styles.chatScrollEndSentinel}
                    onLayout={maybeSettleChatListToBottom}
                  />
                </>
              )}
            />
          )}
        </View>
        {llmSessionRestoreLoadingForView ? (
          <View pointerEvents="auto" style={styles.chatSessionRestoreOverlay}>
            <View style={styles.chatSessionRestoreCard}>
              <ActivityIndicator size="large" color="#0f766e" />
              <Text style={styles.chatSessionRestoreText}>セッションを復元中...</Text>
              <TouchableOpacity
                style={styles.chatSessionRestoreReloadButton}
                onPress={reloadSelectedSession}
                accessibilityRole="button"
                accessibilityLabel="セッションを再読み込み"
              >
                <Text style={styles.chatSessionRestoreReloadButtonText}>再読み込み</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        {showYouTubeOverlayPlayer ? (
          <View pointerEvents="box-none" style={styles.youtubeOverlayWrap}>
            <Animated.View
              style={[
                styles.youtubeFloatingContainer,
                {
                  transform: [
                    { translateX: youtubeFloatingAnimatedPosition.x },
                    { translateY: youtubeFloatingAnimatedPosition.y },
                  ],
                },
              ]}
              onTouchStart={markYouTubeFloatingControlInteraction}
              onTouchMove={markYouTubeFloatingControlInteraction}
              onTouchEnd={markYouTubeFloatingControlInteraction}
              onTouchCancel={markYouTubeFloatingControlInteraction}
            >
              <View style={styles.youtubeFloatingPlayer}>
                <WebView
                  ref={youtubeWebViewRef}
                  key={`${youtubePlayerVideoId}:${youtubePlayerSession}`}
                  source={{ html: youtubeEmbedHtml, baseUrl: youtubeEmbedOrigin }}
                  style={styles.youtubeWebView}
                  javaScriptEnabled
                  allowsInlineMediaPlayback
                  mediaPlaybackRequiresUserAction={false}
                  allowsPictureInPictureMediaPlayback
                  allowsFullscreenVideo
                  onMessage={handleYouTubeWebViewMessage}
                />
              </View>
              <View
                pointerEvents={youtubeFloatingInteractionMode === "drag" ? "auto" : "none"}
                style={styles.youtubeFloatingGestureLayer}
                accessibilityRole="adjustable"
                accessibilityLabel="YouTube ミニプレイヤーをドラッグして移動"
                {...youtubeFloatingPanResponder.panHandlers}
              />
              {youtubeFloatingInteractionMode === "control" ? (
                <View pointerEvents="none" style={styles.youtubeFloatingControlOutline} />
              ) : null}
              <TouchableOpacity
                style={styles.youtubeFloatingCloseButton}
                onPress={closeYouTubePlayer}
                accessibilityRole="button"
                accessibilityLabel="YouTube ミニプレイヤーを閉じる"
              >
                <Ionicons name="close" size={14} color="#e2e8f0" />
              </TouchableOpacity>
            </Animated.View>
          </View>
        ) : null}
        {chatBottomToast ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.chatBottomToastWrap,
              {
                opacity: chatBottomToastAnimRef.current,
                transform: [{
                  translateY: chatBottomToastAnimRef.current.interpolate({
                    inputRange: [0, 1],
                    outputRange: [22, 0],
                  }),
                }],
              },
            ]}
          >
            <View
              style={[
                styles.chatBottomToast,
                chatBottomToast.role === "user"
                  ? styles.chatBottomToastUser
                  : styles.chatBottomToastAssistant,
              ]}
            >
              <Text style={styles.chatBottomToastRole}>
                {chatBottomToast.role === "user" ? "YOU" : "ASSISTANT"}
              </Text>
              <Text style={styles.chatBottomToastText}>{chatBottomToast.text}</Text>
            </View>
          </Animated.View>
        ) : null}
        <GitDiffPanel
          visible={gitDiffPanelOpen && !approvalDialogPending}
          runnerUrl={runnerUrl}
          runnerToken={runnerToken}
          selectedDirectoryPath={selectedDirectoryPathForView}
          selectedDirectoryDisplayName={selectedDirectoryDisplayNameForView}
          gitBranchName={gitChangedFiles.branchName}
          gitBranches={gitChangedFiles.branches}
          gitChangedFilesStaged={gitChangedFiles.stagedFiles}
          gitChangedFilesUnstaged={gitChangedFiles.unstagedFiles}
          gitChangedFilesLoading={gitChangedFiles.loading}
          gitChangedFilesError={gitChangedFiles.error}
          onRequestClose={() => setGitDiffPanelOpen(false)}
          onRefreshGitChangedFiles={gitChangedFiles.refresh}
          showInfoToast={showInfoToast}
          onOpenMedia={setRunnerMedia}
          logSessionDiag={logSessionDiag}
        />
        <RunnerMediaViewer
          media={approvalDialogPending ? null : runnerMedia}
          onRequestClose={() => setRunnerMedia(null)}
        />
        <WorkspaceFileRenameDialog
          target={approvalDialogPending ? null : chatFileRenameTarget}
          onCancel={cancelChatFileRename}
          onRename={renameChatFile}
        />
        <View style={styles.chatComposer}>
          <View style={styles.connectionStatusArea}>
            <RunnerWsConnectionStatus
              turnState={replyLoadingForView ? "running" : selectedThreadStatusTypeForView}
              dataSync={connectionDataSync}
              selectedRoute={runnerRouteSelection.selectedRoute}
            />
          </View>
          <View style={styles.chatInputWrapper}>
            {composerWaveformVisible ? (
              <View style={[styles.autoWaveformCard, styles.chatWaveformBox]}>
                {autoWaveformAnimationEnabled ? (
                  <Image
                    source={waveformDotGif}
                    style={[styles.autoWaveformGif, autoSpeechDetected && styles.autoWaveformGifActive]}
                  />
                ) : (
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      backgroundColor: autoSpeechDetected ? "#22c55e" : "#94a3b8",
                      opacity: autoSpeechDetected ? 1 : 0.6,
                    }}
                  />
                )}
              </View>
            ) : composerDirectSttVisible ? (
              <View style={styles.chatDirectSttBox}>
                <Text style={styles.chatDirectSttLabel}>Direct Native STT</Text>
                <Text style={styles.chatDirectSttText}>{directNativeSttPreviewText || "話してください..."}</Text>
              </View>
            ) : (
              <View style={styles.chatComposerInputArea}>
                <TextInput
                  ref={chatComposerInputRef}
                  style={[
                    styles.chatInput,
                    styles.chatComposerInput,
                    showComposerFullscreenToggleForView ? styles.chatComposerInputWithExpandButton : null,
                  ]}
                  value={transcriptForView}
                  onChangeText={setTranscriptForView}
                  placeholder="メッセージを入力"
                  multiline
                  textAlignVertical="top"
                  onFocus={() => {
                    if (usesPanelComposerState) setPanelComposerFocused(true);
                    setComposerInputFocused(true);
                  }}
                  onBlur={() => {
                    if (usesPanelComposerState) setPanelComposerFocused(false);
                    setComposerInputFocused(false);
                  }}
                />
                {showComposerFullscreenToggleForView ? (
                  <TouchableOpacity
                    style={styles.chatComposerExpandButton}
                    onPress={openComposerFullscreenForView}
                    accessibilityRole="button"
                    accessibilityLabel="入力欄を全画面表示"
                  >
                    <Ionicons name="expand-outline" size={16} color="#334155" />
                  </TouchableOpacity>
                ) : null}
              </View>
            )}
            <View style={styles.chatComposerIconRow}>
              {(() => {
                const directModeActive = isDirectNativeSttProvider && directNativeSttEnabled;
                const autoModeActive = autoRecordingEnabled;
                const manualModeActive = !!manualRecording;
                const faceToggleVisible = Platform.OS === "ios";
                const faceToggleActive = faceTrackingEnabled;
                const faceToggleBlocked = faceToggleActive && !faceTrackingLooking;
                const shouldStopRecording = autoModeActive || manualModeActive || directModeActive;
                const shouldStopLlmTurn = !shouldStopRecording && canStopLlmTurnForView;
                const showSendAction = !shouldStopRecording && !shouldStopLlmTurn && hasComposerTextForView;
                const disabled = shouldStopRecording
                  ? false
                  : shouldStopLlmTurn
                    ? false
                    : showSendAction
                      ? !canSendForView
                      : (sttLoading || replyLoadingForView);
                const iconName = (shouldStopRecording || shouldStopLlmTurn)
                  ? "stop"
                  : (showSendAction ? "caret-forward" : "mic");
                const faceIconName = !faceToggleActive ? "eye-outline" : (faceToggleBlocked ? "eye-off" : "eye");
                const onPress = () => {
                  if (shouldStopRecording) {
                    if (directModeActive) {
                      void stopDirectNativeStt();
                    } else if (autoModeActive) {
                      void stopAutoRecordingMode();
                    } else if (manualModeActive) {
                      void stopRecording();
                    }
                    return;
                  }
                  if (shouldStopLlmTurn) {
                    logSessionDiag("chat_stop_llm_pressed", {
                      panelId: String(panelId || "").trim() || undefined,
                      sessionId: isMiniBoardMode
                        ? (String(panelSnapshot.selectedSessionId || "").trim() || undefined)
                        : undefined,
                      directory: isMiniBoardMode
                        ? (String(panelSnapshot.selectedDirectoryPath || "").trim() || undefined)
                        : undefined,
                      route: isPanelRuntimeView ? "cancelReplyRequestForPanel" : "stopLlmTurn",
                    }, { throttleMs: 0 });
                    if (isPanelRuntimeView) {
                      cancelReplyRequestForPanel(panelId);
                      return;
                    }
                    void stopLlmTurn();
                    return;
                  }
                  if (showSendAction) {
                    chatComposerInputRef.current?.blur();
                    sendReplyTranscriptByPanel();
                    return;
                  }
                  if (isDirectNativeSttProvider) {
                    void startDirectNativeStt();
                  } else {
                    void startAutoRecordingMode();
                  }
                };
                const onPressFaceToggle = () => {
                  if (faceToggleActive) {
                    setFaceTrackingEnabledWithRef(false);
                    return;
                  }
                  if (!isIosFaceTrackingAvailable()) {
                    Alert.alert(
                      "Face Tracking unavailable",
                      "iOS Development Build で FaceTrackingModule を含めてビルドしてください。"
                    );
                    return;
                  }
                  setFaceTrackingEnabledWithRef(true);
                };
                return (
                  <>
                    <TouchableOpacity
                      style={[styles.chatIconButton, styles.chatSlashIconButton]}
                      onPress={openSlashCommandSelectForView}
                      accessibilityRole="button"
                      accessibilityLabel="スラッシュコマンドを開く"
                    >
                      <Text style={styles.chatSlashIconText}>/</Text>
                    </TouchableOpacity>
                    {faceToggleVisible ? (
                      <TouchableOpacity
                        style={[
                          styles.chatIconButton,
                          styles.chatFaceTrackIconButton,
                          faceToggleActive && styles.chatFaceTrackIconButtonEnabled,
                          faceToggleBlocked && styles.chatFaceTrackIconButtonBlocked,
                          !faceTrackingRunning && faceToggleActive && styles.chatFaceTrackIconButtonIdle,
                        ]}
                        onPress={onPressFaceToggle}
                        accessibilityRole="button"
                        accessibilityLabel={faceToggleActive ? "Face Trackingをオフ" : "Face Trackingをオン"}
                      >
                        <Ionicons name={faceIconName as keyof typeof Ionicons.glyphMap} size={17} color="#0f172a" />
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={[styles.chatIconButton, styles.chatRecordIconButton, disabled && styles.buttonDisabled]}
                      onPress={onPress}
                      disabled={disabled}
                    >
                      <Ionicons name={iconName as keyof typeof Ionicons.glyphMap} size={18} color="#ffffff" />
                    </TouchableOpacity>
                  </>
                );
              })()}
            </View>
          </View>
        </View>
        <View style={styles.chatFooterSettingsRow}>
          <View pointerEvents="none" style={styles.chatThreadStatusCenter}>
            <Text
              style={styles.chatThreadStatusText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.82}
            >
              {selectedThreadStatusTypeForView}
            </Text>
          </View>
          <View style={styles.chatFooterSettingsInline}>
            <View ref={modelSelectTriggerRef} collapsable={false}>
              <TouchableOpacity
                onPress={() => openFooterSelect("model")}
                accessibilityRole="button"
                accessibilityLabel="モデル選択を開く"
              >
                <Text style={styles.chatFooterSettingsText}>{selectedModelLabelForView}</Text>
              </TouchableOpacity>
            </View>
            <View ref={thinkSelectTriggerRef} collapsable={false}>
              <TouchableOpacity
                onPress={() => openFooterSelect("think")}
                accessibilityRole="button"
                accessibilityLabel="think設定を開く"
              >
                <Text style={styles.chatFooterSettingsText}>{reasoningEffortForView || "-"}</Text>
              </TouchableOpacity>
            </View>
          </View>
          <CodexStatusSummaryMenu
            dismissed={approvalDialogPending}
            statusText={codexCliStatusText}
            statusFetchedAtMs={codexCliStatusFetchedAtMs}
            statusLoading={codexCliStatusLoading}
            authProfileId={codexAuthProfileId}
            authProfiles={codexAuthProfiles}
            authProfilesLoading={codexAuthProfilesLoading}
            authSwitching={codexAuthSwitching}
            authSwitchError={codexAuthSwitchError}
            onRefreshStatus={onRefreshCodexCliStatus}
            onLoadAuthProfiles={onLoadCodexAuthProfiles}
            onSwitchAuthProfile={onSwitchCodexAuthProfile}
          />
        </View>
        <Modal
          visible={popupComposerFullscreenOpen && !approvalDialogPending}
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={closePopupComposerFullscreen}
        >
          <SafeAreaView style={styles.chatComposerFullscreenRoot}>
            <KeyboardAvoidingView
              style={styles.chatComposerFullscreenKeyboardAvoiding}
              behavior={Platform.OS === "ios" ? "padding" : "height"}
              automaticOffset={Platform.OS === "ios"}
            >
              <View style={styles.chatComposerFullscreenHeader}>
                <Text style={styles.chatComposerFullscreenTitle}>Input Editor</Text>
                <TouchableOpacity
                  style={styles.chatComposerFullscreenClose}
                  onPress={closePopupComposerFullscreen}
                  accessibilityRole="button"
                  accessibilityLabel="全画面入力を閉じる"
                >
                  <Ionicons name="contract-outline" size={18} color="#334155" />
                </TouchableOpacity>
              </View>
              <View style={styles.chatComposerFullscreenInputWrap}>
                <TextInput
                  ref={popupComposerFullscreenInputRef}
                  style={styles.chatComposerFullscreenInput}
                  value={transcriptForView}
                  onChangeText={setTranscriptForView}
                  placeholder="メッセージを入力"
                  multiline
                  scrollEnabled
                  textAlignVertical="top"
                  autoCorrect={false}
                  autoCapitalize="none"
                  onFocus={() => {
                    if (usesPanelComposerState) setPanelComposerFocused(true);
                    setComposerInputFocused(true);
                  }}
                  onBlur={() => {
                    if (usesPanelComposerState) setPanelComposerFocused(false);
                    setComposerInputFocused(false);
                  }}
                />
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
        <Modal
          visible={footerSelectOpen !== null && !approvalDialogPending}
          transparent
          animationType="fade"
          onRequestClose={() => setFooterSelectOpen(null)}
        >
          <Pressable style={styles.chatFooterSelectBackdrop} onPress={() => setFooterSelectOpen(null)}>
            <Pressable
              style={[
                styles.chatFooterSelectCard,
                {
                  left: footerSelectAnchor.x,
                  top: footerSelectTop,
                  minWidth: Math.max(120, footerSelectAnchor.width),
                },
              ]}
              onPress={() => {}}
            >
              {footerSelectOpen === "model"
                ? modelOptions.map((item: { label: string; value: string }) => {
                    const selected = item.value === normalizedModelRefForView;
                    return (
                      <TouchableOpacity
                        key={item.value}
                        style={[styles.chatFooterSelectOption, selected && styles.chatFooterSelectOptionSelected]}
                        onPress={() => {
                          selectModelForView(item.value);
                        }}
                      >
                        <Text style={[styles.chatFooterSelectOptionText, selected && styles.chatFooterSelectOptionTextSelected]}>
                          {item.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })
                : thinkOptions.map((item) => {
                    const selected = item === reasoningEffortForView;
                    return (
                      <TouchableOpacity
                        key={item}
                        style={[styles.chatFooterSelectOption, selected && styles.chatFooterSelectOptionSelected]}
                        onPress={() => {
                          selectThinkOptionForView(item);
                        }}
                      >
                        <Text style={[styles.chatFooterSelectOptionText, selected && styles.chatFooterSelectOptionTextSelected]}>
                          {item}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
            </Pressable>
          </Pressable>
        </Modal>
        <Modal
          visible={directoryMenuOpen && !approvalDialogPending}
          transparent
          animationType="fade"
          onRequestClose={() => {
            setDirectoryMenuMode("actions");
            setDirectoryMenuOpen(false);
          }}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              setDirectoryMenuMode("actions");
              setDirectoryMenuOpen(false);
            }}
          >
            <Pressable style={styles.chatDirectoryModalCard} onPress={() => {}}>
              <Text style={styles.chatDirectoryModalTitle}>ディレクトリー</Text>
              <Text style={styles.chatDirectoryMenuPathText} numberOfLines={2}>
                {selectedDirectoryPathForView}
              </Text>
              {directoryMenuMode === "rename_directory" ? (
                <View style={styles.chatDirectoryRenameBlock}>
                  <Text style={styles.chatDirectoryRenameTitle}>名前を編集</Text>
                  <TextInput
                    style={styles.chatDirectoryRenameInput}
                    value={directoryRenameInput}
                    onChangeText={setDirectoryRenameInput}
                    placeholder="表示名を入力"
                    autoCorrect={false}
                    autoCapitalize="none"
                  />
                  <View style={styles.chatDirectoryRenameActions}>
                    <TouchableOpacity style={styles.chatDirectoryRenamePrimaryButton} onPress={submitDirectoryRename}>
                      <Text style={styles.chatDirectoryRenamePrimaryButtonText}>保存</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.chatDirectoryRenameSecondaryButton}
                      onPress={() => {
                        setDirectoryMenuMode("actions");
                        setDirectoryRenameInput(String(selectedDirectoryDisplayNameForView || "").trim());
                      }}
                    >
                      <Text style={styles.chatDirectoryRenameSecondaryButtonText}>戻る</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : directoryMenuMode === "edit_session_title" ? (
                <View style={styles.chatDirectoryRenameBlock}>
                  <Text style={styles.chatDirectoryRenameTitle}>セッションタイトルを編集</Text>
                  <View style={styles.chatDirectoryRenameInputRow}>
                    <TextInput
                      style={[styles.chatDirectoryRenameInput, styles.chatDirectoryRenameInputWithClear]}
                      value={directorySessionTitleInput}
                      onChangeText={setDirectorySessionTitleInput}
                      placeholder="タイトルを入力（空で自動タイトル）"
                      autoCorrect={false}
                      autoCapitalize="none"
                    />
                    {directorySessionTitleInput ? (
                      <TouchableOpacity
                        style={styles.chatDirectoryRenameInputClearButton}
                        onPress={() => setDirectorySessionTitleInput("")}
                        accessibilityRole="button"
                        accessibilityLabel="セッションタイトル入力をクリア"
                      >
                        <Ionicons name="close" size={16} color="#334155" />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <View style={styles.chatDirectoryRenameActions}>
                    <TouchableOpacity style={styles.chatDirectoryRenamePrimaryButton} onPress={submitSessionTitleRename}>
                      <Text style={styles.chatDirectoryRenamePrimaryButtonText}>保存</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.chatDirectoryRenameSecondaryButton}
                      onPress={() => {
                        setDirectoryMenuMode("actions");
                        setDirectorySessionTitleInput(String(selectedSessionTitleForView || "").trim());
                      }}
                    >
                      <Text style={styles.chatDirectoryRenameSecondaryButtonText}>戻る</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : directoryMenuMode === "select_marker" ? (
                <View style={styles.chatDirectoryRenameBlock}>
                  <Text style={styles.chatDirectoryRenameTitle}>ドット色</Text>
                  {DIRECTORY_MARKER_OPTIONS.map((option) => {
                    const selected = option.value === selectedSessionMarkerColorForView;
                    return (
                      <TouchableOpacity
                        key={option.value}
                        style={styles.chatDirectoryMenuOption}
                        onPress={() => {
                          selectSessionMarkerColorForView(option.value);
                          setDirectoryMenuMode("actions");
                          setDirectoryMenuOpen(false);
                        }}
                      >
                        <View style={styles.chatDirectoryMarkerOptionRow}>
                          <View
                            style={[
                              styles.chatDirectoryMarkerOptionDot,
                              option.value === "none"
                                ? styles.chatDirectoryMarkerOptionDotNone
                                : { backgroundColor: option.color },
                            ]}
                          />
                          <Text style={styles.chatDirectoryMenuOptionText}>
                            {selected ? `✓ ${option.label}` : option.label}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                  <TouchableOpacity
                    style={styles.chatDirectoryRenameSecondaryButton}
                    onPress={() => setDirectoryMenuMode("actions")}
                  >
                    <Text style={styles.chatDirectoryRenameSecondaryButtonText}>戻る</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <TouchableOpacity
                    style={styles.chatDirectoryMenuOption}
                    onPress={() => {
                      setDirectoryMenuMode("rename_directory");
                    }}
                  >
                    <Text style={styles.chatDirectoryMenuOptionText}>名前を編集</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.chatDirectoryMenuOption}
                    onPress={() => {
                      setDirectoryMenuMode("edit_session_title");
                    }}
                  >
                    <Text style={styles.chatDirectoryMenuOptionText}>
                      {`セッションタイトル: ${String(selectedSessionTitleForView || "").trim() || "未設定"}`}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.chatDirectoryMenuOption}
                    onPress={() => {
                      setDirectoryMenuMode("select_marker");
                    }}
                  >
                    <Text style={styles.chatDirectoryMenuOptionText}>
                      {`ドット色: ${selectedSessionMarkerLabel}`}
                    </Text>
                  </TouchableOpacity>
                  <ChatSessionSubagentList
                    selectedSessionId={selectedSessionIdForView}
                    selectedDirectoryPath={selectedDirectoryPathForView}
                    registeredDirectories={registeredDirectories}
                    directorySessionsById={directorySessionsById}
                    sessionTitleOverridesById={sessionTitleOverridesById}
                    formatSessionUpdatedAt={formatSessionUpdatedAt}
                    loadSessionChildren={loadSessionChildren}
                    openSessionHistoryEntry={openSessionHistoryEntryForView}
                    onCloseMenu={() => {
                      setDirectoryMenuMode("actions");
                      setDirectoryMenuOpen(false);
                    }}
                  />
                  <TouchableOpacity
                    style={styles.chatDirectoryMenuOption}
                    onPress={() => {
                      setDirectoryMenuOpen(false);
                      Alert.alert("ディレクトリーを非表示にしますか？", selectedDirectoryDisplayNameForView, [
                        { text: "キャンセル", style: "cancel" },
                        {
                          text: "削除",
                          style: "destructive",
                          onPress: removeDirectoryForView,
                        },
                      ]);
                    }}
                  >
                    <Text style={styles.chatDirectoryMenuDangerText}>表示から削除</Text>
                  </TouchableOpacity>
                </>
              )}
            </Pressable>
          </Pressable>
        </Modal>
        </View>
      </KeyboardAvoidingView>
      <SlashCommandSelectMenu
        visible={isMiniBoardPopupMode && popupSlashCommandSelectOpen}
        presentation="inline"
        options={slashCommandOptions}
        onClose={closePopupSlashCommandSelect}
        onSelect={selectPopupSlashCommand}
      />
    </View>
  );
}
