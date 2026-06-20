import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import {
  Alert,
  AppState,
  type ImageSourcePropType,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  SafeAreaView,
  TextInput,
  View,
} from "react-native";
import { Drawer } from "react-native-drawer-layout";
import { Audio } from "expo-av";
import Constants from "expo-constants";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { WebView } from "react-native-webview";
import { styles } from "./styles";
import { AppProviders } from "./AppProviders";
import { AudioLabScreen } from "./components/AudioLabScreen";
import {
  AppDrawer,
  type DirectorySessionTreeState,
  type RegisteredDirectoryEntry,
} from "./components/AppDrawer";
import { AppOverlays } from "./components/AppOverlays";
import { LlmCompletionNotifications } from "./components/LlmCompletionNotifications";
import { PopupChatOverlay } from "./components/PopupChatOverlay";
import type { PopupChatSourceRect } from "./components/popupChatTypes";
import { DebugScreen } from "./screens/DebugScreen";
import { MiniBoardScreen } from "./screens/MiniBoardScreen";
import {
  DEFAULT_STT_PROVIDER,
  type SttProvider,
} from "../stt/sttConfig";
import {
  isIosFaceTrackingAvailable,
  startIosFaceTrackingSession,
  type IosFaceTrackingSession,
} from "../faceTracking/iosFaceTrackingClient";
import { useBufferedClientLogs } from "./hooks/useBufferedClientLogs";
import { useAutoRecordingEngine } from "./hooks/useAutoRecordingEngine";
import { useDirectNativeSttController } from "./hooks/useDirectNativeSttController";
import { useManualRecordingController } from "./hooks/useManualRecordingController";
import { useRecordingTranscriptionController } from "./hooks/useRecordingTranscriptionController";
import { useAutoRecordingStatusHandler } from "./hooks/useAutoRecordingStatusHandler";
import { useAutoWaveformDiagnostics } from "./hooks/useAutoWaveformDiagnostics";
import { useAutoRecordingWatchdog } from "./hooks/useAutoRecordingWatchdog";
import { useAutoRecordingWatchdogResetController } from "./hooks/useAutoRecordingWatchdogResetController";
import { useUiSfxController } from "./hooks/useUiSfxController";
import { useAssistantEventSfxController } from "./hooks/useAssistantEventSfxController";
import { useAutoCaptureCycleRecovery } from "./hooks/useAutoCaptureCycleRecovery";
import { useAutoCaptureCycleCore } from "./hooks/useAutoCaptureCycleCore";
import { useYouTubePlayerController } from "./hooks/useYouTubePlayerController";
import { useYouTubePlayerDisplay } from "./hooks/useYouTubePlayerDisplay";
import { useTtsVoiceCatalog } from "./hooks/useTtsVoiceCatalog";
import { useAudioLabPlaybackMonitoring } from "./hooks/useAudioLabPlaybackMonitoring";
import { useAudioLabLoggingController } from "./hooks/useAudioLabLoggingController";
import { useAudioLabPlaybackController } from "./hooks/useAudioLabPlaybackController";
import { useAudioLabProbeController } from "./hooks/useAudioLabProbeController";
import { useAutoWaveformStateController } from "./hooks/useAutoWaveformStateController";
import { useAudioSettingsInputController } from "./hooks/useAudioSettingsInputController";
import { useChatDerivedState } from "./hooks/useChatDerivedState";
import { useChatBottomToast } from "./hooks/useChatBottomToast";
import { useAutoPendingUserController } from "./hooks/useAutoPendingUserController";
import { useLlmRequestStatus } from "./hooks/useLlmRequestStatus";
import { useCodexReplyRequest } from "./hooks/useCodexReplyRequest";
import { useLlmTraceStateController } from "./hooks/useLlmTraceStateController";
import { useAppDrawerSessionController } from "./hooks/useAppDrawerSessionController";
import { useDirectorySessionTreeController } from "./hooks/useDirectorySessionTreeController";
import { useSessionMarkReadController } from "./hooks/useSessionMarkReadController";
import { useSessionRestoreTransitionController } from "./hooks/useSessionRestoreTransitionController";
import { useSessionStartupRecoveryController } from "./hooks/useSessionStartupRecoveryController";
import { useSessionSwitchQueuedSendController } from "./hooks/useSessionSwitchQueuedSendController";
import { useSessionSwitchQuiesceController } from "./hooks/useSessionSwitchQuiesceController";
import { useWaitingApprovalResumeController } from "./hooks/useWaitingApprovalResumeController";
import { useWaitingApprovalResumeActionController } from "./hooks/useWaitingApprovalResumeActionController";
import { useAppSettingsPersistenceController } from "./hooks/useAppSettingsPersistenceController";
import { useApprovalRequestController } from "./hooks/useApprovalRequestController";
import { useCodexRelayObserverLifecycleController } from "./hooks/useCodexRelayObserverLifecycleController";
import { useCodexRelayObserverStartController } from "./hooks/useCodexRelayObserverStartController";
import { useCodexStatusAuthController } from "./hooks/useCodexStatusAuthController";
import { useCodexStatusRefreshEffects } from "./hooks/useCodexStatusRefreshEffects";
import { useGitChangedFilesController } from "./hooks/useGitChangedFilesController";
import { useLlmRuntimeLimitsController } from "./hooks/useLlmRuntimeLimitsController";
import { useSlashCompactCommandController } from "./hooks/useSlashCompactCommandController";
import { useSlashCommandController } from "./hooks/useSlashCommandController";
import { useSlashCommandResultAppender } from "./hooks/useSlashCommandResultAppender";
import { useSlashStatusCommandController } from "./hooks/useSlashStatusCommandController";
import { useSendReplyRequestController } from "./hooks/useSendReplyRequestController";
import { useSynthesizeSpeechStreamController } from "./hooks/useSynthesizeSpeechStreamController";
import { useStopTtsPlaybackController } from "./hooks/useStopTtsPlaybackController";
import { useEnqueueStreamAudioController } from "./hooks/useEnqueueStreamAudioController";
import { useProcessStreamAudioQueueController } from "./hooks/useProcessStreamAudioQueueController";
import { usePrepareTtsPlaybackSessionController } from "./hooks/usePrepareTtsPlaybackSessionController";
import { usePlayPreparedStreamAudioController } from "./hooks/usePlayPreparedStreamAudioController";
import { usePlayTtsAudioController } from "./hooks/usePlayTtsAudioController";
import { useAttachTtsSoundStatusHandlerController } from "./hooks/useAttachTtsSoundStatusHandlerController";
import { useSynthesizeSpeechController } from "./hooks/useSynthesizeSpeechController";
import { useTtsPlaybackStateController } from "./hooks/useTtsPlaybackStateController";
import { useTtsPlaybackWatchdogController } from "./hooks/useTtsPlaybackWatchdogController";
import { useReplyAudioFlowController } from "./hooks/useReplyAudioFlowController";
import { useAudioInputRouteController } from "./hooks/useAudioInputRouteController";
import { useRecordingDeviceController } from "./hooks/useRecordingDeviceController";
import { useFaceTrackingStateController } from "./hooks/useFaceTrackingStateController";
import { useAppContextActions } from "./hooks/useAppContextActions";
import { useConversationMessageWindowController } from "./hooks/useConversationMessageWindowController";
import {
  isConversationRuntimeRequestResponding,
  useConversationRuntimeStoreController,
} from "./hooks/useConversationRuntimeStoreController";
import {
  usePanelNewSessionController,
  type PanelRuntimeEntry,
} from "./hooks/usePanelNewSessionController";
import { deriveSessionExecutionStatusType } from "./utils/sessionExecutionStatus";
import {
  appendAssistantEventMessageToMessages,
  useConversationMessageBuilders,
} from "./hooks/useConversationMessageBuilders";
import { useAppStateAutoRecoveryController } from "./hooks/useAppStateAutoRecoveryController";
import { useCodexWsDiagnosticsController } from "./hooks/useCodexWsDiagnosticsController";
import { useAppUnmountCleanupController } from "./hooks/useAppUnmountCleanupController";
import {
  useAppSettingsContextValue,
  useAppShellContextValue,
  useAudioLabContextValue,
  useChatComposerContextValue,
  useChatDiagnosticsContextValue,
  useChatScreenContextValue,
  useChatVisualContextValue,
  useConversationContextValue,
  useDebugConversationContextValue,
  useDebugRuntimeContextValue,
  useDebugSpeechContextValue,
  useYouTubePlayerContextValue,
} from "./hooks/useAppProviderValues";
import {
  useLlmSessionExplorer,
  type LlmSessionSource,
  type RunnerSessionMessagesResult,
} from "./hooks/useLlmSessionExplorer";
import {
  cancelRunnerCodexQueuedTurn,
  readCodexAppServerThread,
} from "../codex/codexAppServerClient";
import type {
  AppScreen,
  AudioModeSwitchOptions,
  AutoClientLogEntry,
  CodexAuthProfilesSnapshot,
  CodexCliStatusSnapshot,
  ConversationMessage,
  GitChangedFilesDirectoryState,
  HistoryEntry,
  LlmBackend,
  LlmDeltaEntry,
  LlmProgressEntry,
  LlmSessionMessage,
  LlmRuntimeLimitsSnapshot,
  PersistedDirectoryUiState,
  SelectSpecificLlmSessionOptions,
  SessionRuntimeStatus,
  SessionSwitchQueuedSend,
  SlashCommandName,
  SttMessageMeta,
  StreamAudioQueueItem,
  StreamSegment,
  ToolAutoApprovalMap,
  ToolCallEntry,
  TtsDebugStats,
  TtsPlaybackTarget,
  TtsUiStatus,
  UiSfxKey,
  YouTubeVideoMeta,
} from "./types/appTypes";
import type {
  PanelRuntimeSnapshot,
  PanelRuntimeStoreContextValue,
} from "./contexts/PanelRuntimeStoreContext";
import type { PanelRuntimeControllerContextValue } from "./contexts/PanelRuntimeControllerContext";
import type { ApprovalRequest } from "../codex/approvalFlow";
import {
  buildEmptyWaveform as buildEmptyWaveformBars,
  normalizeMetering,
} from "./utils/waveform";
import {
  extractYouTubeVideoIds,
  formatYouTubePublishedDate,
  formatYouTubeViewCount,
  stripYouTubeTags,
} from "./utils/youtube";
import {
  formatElapsedHhMmSs,
  buildSttMetaChips,
  formatElapsedMmSs,
  formatSessionUpdatedAt,
  parseContextUsageUsedPct,
} from "./utils/formatting";
import { isRunnerWsUrl } from "../runnerWs/llmAdapter";
import {
  buildAutoClientLogSessionId,
  isAirPodsInputName,
  isBackgroundAudioSessionError,
  isRecorderNotPreparedError,
  isRecordingNotAllowedError,
} from "./utils/audioSession";
import {
  buildRecordingOptions,
  clampRecordingChannels,
  clampRecordingProgressUpdateIntervalMs,
  clampTtsSpeed,
  DEFAULT_RECORDING_QUALITY_PRESET,
  DEFAULT_SELECTED_VOICE_IDS,
  DEFAULT_TTS_PROVIDER,
  DEFAULT_TTS_SPEED,
  parseRecordingQualityPreset,
  parseTtsSpeed,
  recordingTuningFromPreset,
  type RecordingQualityPreset,
  type RecordingTuning,
  type SelectedVoiceIdByProvider,
  type TtsProvider,
} from "./utils/audioConfig";
import {
  isLlmActiveStatus,
  liveLlmStatusPrefix,
  llmStatusLabel,
  llmStatusVisual,
  sanitizeTextForTts,
  toInlineSummary,
  trimForInline,
} from "./utils/statusText";
import { liveLlmStatusDetail } from "./utils/liveLlmStatusDetail";
import {
  adoptRestoredSessionDirectory,
  buildRestoredSessionState,
  mergeLocalCompactSlashMessages,
} from "./utils/sessionRestore";
import {
  createSessionRestorePerfContext,
  logSessionRestoreError,
  finalizeSessionRestoreReadAndLog,
  logSessionRestoreMessagesHydrated,
  logSessionRestoreStart,
  logSessionRestoreStateApplyQueued,
  logSessionRestoreThreadReadDone,
  markSessionRestoreThreadReadStarted,
} from "./utils/sessionRestorePerf";
import {
  applySessionRestoreConversationState,
  scheduleSessionRestoreUiSettle,
} from "./utils/sessionRestoreUi";
import {
  summarizeExecutionReasonFromStatus,
} from "./utils/sessionRuntimeStatus";
import { resolveSessionHistoryContext as resolveSessionHistoryContextValue } from "./utils/sessionHistoryContext";
import {
  buildRestoredSessionRuntimeSnapshot,
  deriveRestoredSessionThreadStatusType,
  projectRestoredRuntimeStatusToConversation,
} from "./utils/sessionRestoreRuntimeSnapshot";
import {
  resolvePixelStatusIconKey,
  type PixelStatusIconKey,
} from "./utils/statusIcons";
import {
  elapsedSinceMsValue,
  logAutoEvent,
  logChatScrollDiagEvent,
  logSessionDiagEvent,
} from "./utils/appDiagnostics";
import {
  createLlmSessionId,
  parseOptionalSessionId,
} from "./utils/llmSession";
import {
  normalizeModelRef,
  parseLlmDirectory,
  type CodexApprovalPolicy,
  type ReasoningEffort,
} from "./utils/settingsParsers";
import { buildApprovalCommandLabel } from "./utils/tooling";

const DEFAULT_RUNNER_URL = "http://127.0.0.1:8788";
const DEFAULT_LLM_BACKEND: LlmBackend = "codex_app_server";
const DEFAULT_CODEX_WS_URL = "ws://127.0.0.1:8788/runner-ws";
const NEAR_UNLIMITED_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
const EXPO_EXECUTION_ENVIRONMENT = String(
  (Constants as { executionEnvironment?: unknown })?.executionEnvironment || "unknown"
);
const EXPO_APP_OWNERSHIP = String((Constants as { appOwnership?: unknown })?.appOwnership || "");
const IS_EXPO_GO = EXPO_APP_OWNERSHIP === "expo";
const DEFAULT_LLM_DIRECTORY = "llm_root";
const DEFAULT_DIRECTORY_UI_STATE: PersistedDirectoryUiState = {
  expandedDirectoryIds: [],
};
const SETTINGS_FILE_NAME = "bitty-settings.json";
const DRAWER_SWIPE_EDGE_WIDTH = 48;
const DRAWER_SWIPE_MIN_DISTANCE = 28;
const DRAWER_SWIPE_MIN_VELOCITY = 280;
const STATUS_DOT_GIF = require("../../../assets/images/robot-indicator.gif");
const WAVEFORM_DOT_GIF = require("../../../assets/images/waveform-dots.gif");
const PIXEL_STATUS_ANIMATIONS: Record<PixelStatusIconKey, ImageSourcePropType> = {
  idle: STATUS_DOT_GIF,
  connecting: STATUS_DOT_GIF,
  model_processing: STATUS_DOT_GIF,
  tool_waiting_approval: STATUS_DOT_GIF,
  tool_running: STATUS_DOT_GIF,
  model_generating: STATUS_DOT_GIF,
  search_dir: STATUS_DOT_GIF,
  find_files: STATUS_DOT_GIF,
  search_text: STATUS_DOT_GIF,
  file_open: STATUS_DOT_GIF,
  file_write: STATUS_DOT_GIF,
  file_edit: STATUS_DOT_GIF,
  restricted_exec: STATUS_DOT_GIF,
  completed: STATUS_DOT_GIF,
  error: STATUS_DOT_GIF,
};
const UI_SFX_ASSETS: Record<UiSfxKey, number> = {
  send: require("../../../assets/sfx/retro-send.wav"),
  reply: require("../../../assets/sfx/retro-reply.wav"),
  toolStart: require("../../../assets/sfx/retro-tool-start.wav"),
  toolDone: require("../../../assets/sfx/retro-tool-done.wav"),
  youtubePlay: require("../../../assets/sfx/retro-youtube-play.wav"),
  youtubeStop: require("../../../assets/sfx/retro-youtube-stop.wav"),
  recordStart: require("../../../assets/sfx/retro-record-start.wav"),
  recordStop: require("../../../assets/sfx/retro-record-stop.wav"),
  approval: require("../../../assets/sfx/retro-approval.wav"),
  error: require("../../../assets/sfx/retro-error.wav"),
};
const UI_SFX_VOLUMES: Record<UiSfxKey, number> = {
  send: 0.3,
  reply: 0.3,
  toolStart: 0.24,
  toolDone: 0.26,
  youtubePlay: 0.34,
  youtubeStop: 0.32,
  recordStart: 0.26,
  recordStop: 0.26,
  approval: 0.22,
  error: 0.3,
};
const UI_SFX_MIN_INTERVAL_MS: Partial<Record<UiSfxKey, number>> = {
  youtubePlay: 240,
  youtubeStop: 240,
  error: 220,
};
const PIXEL_ROBOT_IMAGE = require("../../../assets/images/robot-indicator.gif");
const AUDIO_LAB_LOOP_ASSET = require("../../../assets/sfx/audio-lab-loop.wav");
const MODEL_OPTIONS = [
  { label: "ChatGPT 5.5", value: "gpt-5.5" },
  { label: "ChatGPT 5.4 mini", value: "gpt-5.4-mini" },
  { label: "ChatGPT 5.4", value: "gpt-5.4" },
  { label: "gpt-5.3-codex", value: "gpt-5.3-codex" },
  { label: "Codex 5.3 Spark", value: "gpt-5.3-codex-spark" },
  { label: "GPT-5.2", value: "gpt-5.2" },
] as const;
const DEFAULT_MODEL_REF = "gpt-5.5";
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";
const DEFAULT_CODEX_APPROVAL_POLICY: CodexApprovalPolicy = "on-request";
const THINK_OPTIONS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const AUTO_START_THRESHOLD_DB = -30;
const AUTO_STOP_THRESHOLD_DB = -38;
const AUTO_START_HOLD_MS = 200;
const AUTO_STOP_SILENCE_MS = 850;
const AUTO_MIN_SPEECH_MS = 700;
const AUTO_MAX_SPEECH_MS = 20000;
const AUTO_COOLDOWN_MS = 500;
const AUTO_IDLE_ROLLOVER_MS = 10000;
const AUTO_BARGE_IN_THRESHOLD_OFFSET_DB = -4;
const AUTO_BARGE_IN_HOLD_MS = 140;
const AUTO_BARGE_IN_AIRPODS_THRESHOLD_OFFSET_DB = -8;
const AUTO_BARGE_IN_AIRPODS_HOLD_MS = 120;
const AUTO_BARGE_IN_TTS_GAP_GRACE_MS = 420;
const AUTO_BARGE_IN_HOLD_GAP_TOLERANCE_MS = 240;
const AUTO_BARGE_IN_FAST_STOP_AIRPODS_THRESHOLD_DB = -40;
const AUTO_BARGE_IN_FAST_STOP_START_OFFSET_DB = 8;
const AUTO_BARGE_IN_FAST_STOP_HOLD_MS = 140;
const AUTO_BARGE_IN_FAST_STOP_COOLDOWN_MS = 220;
const AUTO_WAVEFORM_POINTS = 72;
const AUTO_WAVEFORM_UPDATE_MS = 160;
const AUTO_SPECTRUM_BARS = 64;
const TTS_WAVEFORM_POINTS = 192;
const DRAWER_SESSION_POPUP_PANEL_ID = "drawer_session_popup";
const LEGACY_MAIN_PANEL_ID = "main";
const CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD = (() => {
  const env = (globalThis as { process?: { env?: Record<string, unknown> } }).process?.env || {};
  const parsed = Number(env.EXPO_PUBLIC_CHAT_BOTTOM_THRESHOLD_PX || 160);
  if (!Number.isFinite(parsed)) return 160;
  return Math.max(8, Math.floor(parsed));
})();
const CHAT_SESSION_SWITCH_TOAST_DELAY_MS = 220;
const CHAT_SCROLL_STATE_UPDATE_THROTTLE_MS = 72;
const CHAT_SCROLL_STATE_UPDATE_MIN_DELTA_PX = 10;
const AUTO_POST_TTS_HUMAN_HOLD_MS = 220;
const AUTO_WAIT_REASON_LOG_THROTTLE_MS = 1200;
const AUTO_WAVEFORM_SKIP_LOG_THROTTLE_MS = 1200;
const AUTO_WAVEFORM_STATUS_LOG_THROTTLE_MS = 700;
const AUTO_WAVEFORM_PATH_LOG_THROTTLE_MS = 700;
const AUTO_WAVEFORM_STATE_LOG_THROTTLE_MS = 700;
const AUTO_WAVEFORM_RENDER_LOG_THROTTLE_MS = 700;
const AUTO_WAVEFORM_FLATLINE_DB = -110;
const AUTO_WAVEFORM_FLATLINE_HOLD_MS = 900;
const AUTO_WAVEFORM_FLATLINE_LOG_THROTTLE_MS = 2200;
const AUTO_WAVEFORM_DECAY_TRIGGER_MS = 260;
const AUTO_WAVEFORM_DECAY_FACTOR = 0.9;
const AUTO_WAVEFORM_DECAY_MIN_SIGNAL = 0.018;
const AUTO_INPUT_ERROR_LOG_THROTTLE_MS = 3000;
const AUTO_BARGE_IN_PROBE_LOG_THROTTLE_MS = 500;
const AUTO_CLIENT_LOG_BUFFER_MAX = 600;
const AUTO_CLIENT_LOG_FLUSH_BATCH_SIZE = 100;
const AUTO_CLIENT_LOG_FLUSH_DELAY_MS = 1200;
const AUTO_CLIENT_LOG_RETRY_MS = 4000;
const AUDIO_LAB_LOG_BUFFER_MAX = 600;
const AUDIO_LAB_LOG_FLUSH_BATCH_SIZE = 100;
const AUDIO_LAB_LOG_FLUSH_DELAY_MS = 1200;
const AUDIO_LAB_LOG_RETRY_MS = 4000;
const SESSION_DIAG_LOG_BUFFER_MAX = 240;
const SESSION_DIAG_LOG_FLUSH_BATCH_SIZE = 40;
const SESSION_DIAG_LOG_FLUSH_DELAY_MS = 700;
const SESSION_DIAG_LOG_RETRY_MS = 3000;
const SESSION_DIAG_EVENT_THROTTLE_DEFAULT_MS = 1200;
const SESSION_DIAG_DETAIL_EVENTS_ENABLED = (() => {
  const env = (globalThis as { process?: { env?: Record<string, unknown> } }).process?.env || {};
  return String(env.EXPO_PUBLIC_SESSION_DIAG_DETAIL_EVENTS || "0").trim() === "1";
})();
const CHAT_SCROLL_DIAG_ENABLED = (() => {
  const env = (globalThis as { process?: { env?: Record<string, unknown> } }).process?.env || {};
  return String(env.EXPO_PUBLIC_CHAT_SCROLL_DIAG || "1").trim() !== "0";
})();
const CHAT_SCROLL_DIAG_SCROLL_THROTTLE_MS = (() => {
  const env = (globalThis as { process?: { env?: Record<string, unknown> } }).process?.env || {};
  const parsed = Number(env.EXPO_PUBLIC_CHAT_SCROLL_DIAG_SCROLL_THROTTLE_MS || 220);
  if (!Number.isFinite(parsed)) return 220;
  return Math.max(0, Math.floor(parsed));
})();
const SLASH_COMMAND_OPTIONS: Array<{ command: SlashCommandName; description: string }> = [
  { command: "/status", description: "現在のセッション情報と実行制限を表示" },
  { command: "/compact", description: "Codex CLIのコンテキスト圧縮を実行" },
];
const AUDIO_LAB_RECENT_LOG_MAX = 24;
const AUDIO_LAB_INPUT_POLL_MS = 1300;
const AUDIO_LAB_METER_LOG_THROTTLE_MS = 500;
const AUDIO_LAB_FLATLINE_DB = -118;
const AUDIO_LAB_ROUTE_ERROR_LOG_THROTTLE_MS = 2400;
const AUDIO_LAB_PLAYBACK_STATUS_LOG_THROTTLE_MS = 700;
const AUDIO_LAB_PLAYBACK_WATCHDOG_INTERVAL_MS = 420;
const AUDIO_LAB_PLAYBACK_WATCHDOG_STATUS_TIMEOUT_MS = 320;
const AUDIO_LAB_PLAYBACK_STALL_MS = 1100;
const AUDIO_LAB_PLAYBACK_RECOVER_COOLDOWN_MS = 1400;
const AUDIO_LAB_PLAYBACK_WATCHDOG_ERROR_LOG_THROTTLE_MS = 1800;
const ENABLE_TTS_PLAYBACK_WATCHDOG = true;
const TTS_PLAYBACK_STATUS_LOG_THROTTLE_MS = 700;
const TTS_PLAYBACK_WATCHDOG_INTERVAL_MS = 420;
const TTS_PLAYBACK_WATCHDOG_STATUS_TIMEOUT_MS = 320;
const TTS_PLAYBACK_STALL_MS = 1100;
const TTS_PLAYBACK_RECOVER_COOLDOWN_MS = 1400;
const TTS_PLAYBACK_WATCHDOG_ERROR_LOG_THROTTLE_MS = 1800;
const TTS_PLAYBACK_FINISH_EPSILON_MS = 36;
const TTS_PLAYBACK_FORCE_STOP_STALL_MS = 4000;
const AUTO_RECORDING_WATCHDOG_INTERVAL_MS = 160;
const AUTO_RECORDING_WATCHDOG_STALE_MS = 420;
const AUTO_RECORDING_WATCHDOG_LOG_THROTTLE_MS = 700;
const AUTO_RECORDING_WATCHDOG_STATUS_TIMEOUT_MS = 260;
const AUTO_RECORDING_WATCHDOG_INFLIGHT_FORCE_RELEASE_MS = 900;
const AUTO_RECORDING_NO_CALLBACK_STATUS_READ_MS = 900;
const AUTO_RECORDING_NO_CALLBACK_FORCE_FINALIZE_MS = 1600;
const AUTO_RECORDING_NO_CALLBACK_FINALIZE_COOLDOWN_MS = 1200;
const AUTO_RECORDING_WATCHDOG_RESTART_STALE_MS = 3200;
const AUTO_RECORDING_WATCHDOG_RESTART_COOLDOWN_MS = 2500;
const AUTO_RECORDING_WATCHDOG_KICK_GUARD_MS = 220;
const AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_STALE_MS = 2600;
const AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_COOLDOWN_MS = 2200;
const AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_STREAM_MIN_MS = 6000;
const AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_STREAM_MARGIN_MS = 1400;
const AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_STREAM_MAX_MS = 30000;
const AUTO_RECORDING_WATCHDOG_RESTART_AFTER_TTS_INTERRUPT_GAP_MS = 600;
const FACE_TRACKING_STT_SUPPRESS_LOG_THROTTLE_MS = 1400;
const FACE_TRACKING_RECORDING_STOP_HOLD_MS = 280;
const AUTO_STATUS_READ_SKIP_LOG_THROTTLE_MS = 900;
const AUTO_AUDIO_MODE_SKIP_LOG_THROTTLE_MS = 1200;
const AUTO_STATUS_NOT_RECORDING_APP_TRANSITION_GRACE_MS = 1200;
const AUTO_STATUS_NOT_RECORDING_SUPPRESS_LOG_THROTTLE_MS = 700;
const AUTO_RESUME_STATUS_PROBE_TIMEOUT_MS = 320;
const AUTO_APPSTATE_NON_ACTIVE_APPLY_DELAY_MS = 360;
const AUTO_INPUT_ROUTE_POLL_MS = 5000;
const AUTO_METER_UI_UPDATE_MS = 260;
const AUTO_FACE_TRACKING_ALLOW_CACHE_MS = 250;
const AUTO_DIAGNOSTICS_ENABLED = false;
const AUTO_WAVEFORM_DEBUG_OVERLAY_ENABLED = false;
const AUTO_WAVEFORM_DATA_PIPELINE_ENABLED = AUTO_DIAGNOSTICS_ENABLED || AUTO_WAVEFORM_DEBUG_OVERLAY_ENABLED;
const AUTO_WAVEFORM_ANIMATION_ENABLED = AUTO_WAVEFORM_DEBUG_OVERLAY_ENABLED;
const AUTO_SPECTRUM_EMPTY_BARS = Array.from({ length: AUTO_SPECTRUM_BARS }, () => 0);
const AUTO_DIAGNOSTIC_CRITICAL_EVENTS = new Set([
  "capture_cycle_fatal",
  "recording_watchdog_restart_error",
  "recording_status_watchdog_error",
  "stt_request_timeout",
  "stt_request_error",
  "auto_transcribe_error",
]);
const AUTO_PENDING_USER_ANIMATION_FRAMES = [".", "..", "..."];
const AUTO_PENDING_USER_ANIMATION_INTERVAL_MS = 180;
const AUTO_PENDING_USER_PROBE_TIMEOUT_MS = 1200;
const YOUTUBE_FLOATING_PLAYER_MARGIN = 12;
const YOUTUBE_PAUSE_CONFIRM_MS = 850;
const YOUTUBE_FLOATING_DRAG_ACTIVATE_PX = 10;
const YOUTUBE_CONTROL_IDLE_TO_DRAG_MS = 4200;
const FIXED_MEDIA_VOLUME = 0.75;
const CHAT_BOTTOM_TOAST_VISIBLE_MS = 2600;
const CHAT_BOTTOM_TOAST_REPLY_THROTTLE_MS = 1400;
const CONVERSATION_KEEP_AWAKE_TAG = "conversation-active";
const APP_RESUME_STREAM_RECOVERY_NON_ACTIVE_MIN_MS = 2500;
const SESSION_RESUME_AUTO_SIGNAL_MAX_AGE_MS = 10 * 60 * 1000;
const WAITING_APPROVAL_RESUME_ATTACH_TIMEOUT_MS = 8000;
const WAITING_APPROVAL_RESUME_RETRY_COOLDOWN_MS = 2500;
const REPLY_DEBUG_MAX_LINES = 120;
const REPLY_DEBUG_MAX_CHARS = 12000;
const EMPTY_TOOL_AUTO_APPROVALS: ToolAutoApprovalMap = {
  "toolrun:youtube_search": true,
};
const EMPTY_DIRECTORY_SESSION_TREE_STATE: DirectorySessionTreeState = {
  loading: false,
  loadingMore: false,
  loaded: false,
  fetchedAtMs: 0,
  error: "",
  latestSessionId: "",
  nextCursor: "",
  hasMore: false,
  entries: [],
};
const DIRECTORY_SESSION_PAGE_SIZE = 5;
const DIRECTORY_SESSION_PREFETCH_TTL_MS = 60 * 1000;
const DIRECTORY_SESSION_PREFETCH_CONCURRENCY = 2;
const DIRECTORY_SESSION_RUNNER_SNAPSHOT_LIMIT = 200;
const YOUTUBE_EMBED_ORIGIN = "https://bitty-embed.local";
const CODEX_CLI_STATUS_AUTO_REFRESH_MS = 10 * 60 * 1000;
const CODEX_CLI_STATUS_MIN_REFRESH_GAP_MS = 15 * 1000;
const EMPTY_TTS_DEBUG_STATS: TtsDebugStats = {
  synthRequests: 0,
  synthMimeType: "",
  synthDetected: "unknown",
  synthAudioBytes: 0,
  synthWaveformBars: 0,
  synthTargetMessageId: "",
  playAttempts: 0,
  playExt: "",
  playDetected: "unknown",
  playAudioBytes: 0,
  playStatusErrors: 0,
  playLastStatusError: "",
  streamChunkCount: 0,
  streamLastSeq: -1,
  streamLastMimeType: "",
  streamLastAudioBytes: 0,
  streamLastWaveformBars: 0,
  streamMergedWaveformBars: 0,
};

function normalizeReplyDebugLog(raw: unknown) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const lines = text
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-REPLY_DEBUG_MAX_LINES);
  if (lines.length <= 0) return "";
  let usedChars = 0;
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const extra = tail.length === 0 ? line.length : line.length + 3;
    if (usedChars + extra > REPLY_DEBUG_MAX_CHARS) break;
    usedChars += extra;
    tail.push(line);
  }
  return tail.reverse().join(" | ");
}

function deriveDirectoryDisplayName(pathRaw: unknown) {
  const path = parseLlmDirectory(pathRaw);
  const segments = path.split("/").filter(Boolean);
  return String(segments[segments.length - 1] || path).trim();
}

function createRegisteredDirectoryId(pathRaw: unknown) {
  const path = parseLlmDirectory(pathRaw);
  return `dir_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}_${path.length.toString(36)}`;
}

function parseDirectoryMarkerColor(raw: unknown): RegisteredDirectoryEntry["markerColor"] {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "gray" || value === "red" || value === "yellow" || value === "green" || value === "black") {
    return value;
  }
  return "none";
}

function parseRegisteredDirectories(raw: unknown): RegisteredDirectoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RegisteredDirectoryEntry[] = [];
  const pathSet = new Set<string>();
  for (const item of raw) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const path = parseLlmDirectory(record.path);
    if (!path || pathSet.has(path)) continue;
    const idRaw = String(record.id || "").trim();
    const id = idRaw || createRegisteredDirectoryId(path);
    const displayNameRaw = String(record.displayName || "").trim();
    out.push({
      id,
      path,
      displayName: displayNameRaw || deriveDirectoryDisplayName(path),
      markerColor: parseDirectoryMarkerColor(record.markerColor),
    });
    pathSet.add(path);
  }
  return out;
}

function parseSessionTitleOverrides(raw: unknown) {
  if (!raw || typeof raw !== "object") return {} as Record<string, string>;
  const entries = Object.entries(raw as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [sessionIdRaw, titleRaw] of entries) {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) continue;
    const title = String(titleRaw || "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    out[sessionId] = title;
  }
  return out;
}

function parseSessionMarkerColors(raw: unknown) {
  if (!raw || typeof raw !== "object") return {} as Record<string, RegisteredDirectoryEntry["markerColor"]>;
  const entries = Object.entries(raw as Record<string, unknown>);
  const out: Record<string, RegisteredDirectoryEntry["markerColor"]> = {};
  for (const [sessionIdRaw, markerColorRaw] of entries) {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) continue;
    const markerColor = parseDirectoryMarkerColor(markerColorRaw);
    if (markerColor === "none") continue;
    out[sessionId] = markerColor;
  }
  return out;
}

function deriveSessionTitleFromConversationMessages(messages: ConversationMessage[]) {
  const firstUser = messages.find((item) => item.role === "user" && String(item.content || "").trim());
  const title = String(firstUser?.content || "").replace(/\s+/g, " ").trim();
  if (title) return title;
  return "（ユーザーメッセージなし）";
}

function normalizeRuntimePanelId(panelIdRaw: unknown) {
  const panelId = String(panelIdRaw || "").trim();
  if (!panelId || panelId === LEGACY_MAIN_PANEL_ID) return "";
  return panelId;
}

function parseExpandedDirectoryIds(raw: unknown, directories: RegisteredDirectoryEntry[]) {
  if (!Array.isArray(raw) || directories.length <= 0) return [];
  const validIds = new Set(directories.map((item) => item.id));
  return raw
    .map((item) => String(item || "").trim())
    .filter((id) => !!id && validIds.has(id));
}

export default function App() {
  const [runnerUrl, setRunnerUrl] = useState(DEFAULT_RUNNER_URL);
  const [llmBackend] = useState<LlmBackend>(DEFAULT_LLM_BACKEND);
  const [llmDirectory, setLlmDirectory] = useState(DEFAULT_LLM_DIRECTORY);
  const [codexWsUrl, setCodexWsUrl] = useState(DEFAULT_CODEX_WS_URL);
  const [codexWsToken, setCodexWsToken] = useState("");
  const [runnerToken, setRunnerToken] = useState("");
  const auxServerBaseUrl = useCallback(() => runnerUrl.trim().replace(/\/$/, ""), [runnerUrl]);
  const baseUrl = useCallback(() => auxServerBaseUrl(), [auxServerBaseUrl]);
  const [activeScreen, setActiveScreen] = useState<AppScreen>("mini_board");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerSessionPrefetchRequestedForOpenRef = useRef(false);
  const [modelRef, setModelRef] = useState<string>(DEFAULT_MODEL_REF);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const [codexApprovalPolicy, setCodexApprovalPolicy] = useState<CodexApprovalPolicy>(DEFAULT_CODEX_APPROVAL_POLICY);
  const [modelSelectOpen, setModelSelectOpen] = useState(false);
  const [directorySelectOpen, setDirectorySelectOpen] = useState(false);
  const [thinkSelectOpen, setThinkSelectOpen] = useState(false);
  const [slashCommandSelectOpen, setSlashCommandSelectOpen] = useState(false);
  const [registeredDirectories, setRegisteredDirectories] = useState<RegisteredDirectoryEntry[]>([]);
  const [sessionTitleOverridesById, setSessionTitleOverridesById] = useState<Record<string, string>>({});
  const [sessionMarkerColorsById, setSessionMarkerColorsById] = useState<
    Record<string, RegisteredDirectoryEntry["markerColor"]>
  >({});
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<string[]>(
    DEFAULT_DIRECTORY_UI_STATE.expandedDirectoryIds
  );
  const [directorySessionsById, setDirectorySessionsById] = useState<Record<string, DirectorySessionTreeState>>({});
  const [selectedLlmSessionId, setSelectedLlmSessionId] = useState("");
  const [llmSessionRestoreLoading, setLlmSessionRestoreLoading] = useState(false);
  const [llmSessionRestoreTargetId, setLlmSessionRestoreTargetId] = useState("");
  const [llmSessionRestoreError, setLlmSessionRestoreError] = useState("");
  const [selectedThreadStatusType, setSelectedThreadStatusType] = useState("unknown");
  const selectedThreadStatusProbeSeqRef = useRef(0);
  const [waitingApprovalResumeLoading, setWaitingApprovalResumeLoading] = useState(false);
  const [waitingApprovalResumeStatusText, setWaitingApprovalResumeStatusText] = useState("");
  const [transcript, setTranscript] = useState("");
  const [composerInputFocused, setComposerInputFocused] = useState(false);
  const [composerFullscreenOpen, setComposerFullscreenOpen] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("返答は1文で");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [sttLoading, setSttLoading] = useState(false);
  const [replyLoading, setReplyLoading] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [ttsQueueProcessing, setTtsQueueProcessing] = useState(false);
  const [ttsUiStatus, setTtsUiStatus] = useState<TtsUiStatus>("idle");
  const [ttsPlaybackMessageId, setTtsPlaybackMessageId] = useState("");
  const [autoRecordingEnabled, setAutoRecordingEnabled] = useState(false);
  const [autoRecordingState, setAutoRecordingState] = useState("idle");
  const [autoMeteringDb, setAutoMeteringDb] = useState<number | null>(null);
  const [autoWaveform, setAutoWaveform] = useState<number[]>(() =>
    buildEmptyWaveformBars(AUTO_WAVEFORM_DATA_PIPELINE_ENABLED, AUTO_WAVEFORM_POINTS)
  );
  const [autoWaveformSpeechMask, setAutoWaveformSpeechMask] = useState<number[]>(() =>
    buildEmptyWaveformBars(AUTO_WAVEFORM_DATA_PIPELINE_ENABLED, AUTO_WAVEFORM_POINTS)
  );
  const [autoLastEvent, setAutoLastEvent] = useState("");
  const [autoSegments, setAutoSegments] = useState(0);
  const [autoInputName, setAutoInputName] = useState("");
  const [autoAirPodsInput, setAutoAirPodsInput] = useState(false);
  const [audioLabRunning, setAudioLabRunning] = useState(false);
  const [audioLabRecordingActive, setAudioLabRecordingActive] = useState(false);
  const [audioLabPlaybackActive, setAudioLabPlaybackActive] = useState(false);
  const [audioLabInputName, setAudioLabInputName] = useState("");
  const [audioLabAirPodsInput, setAudioLabAirPodsInput] = useState(false);
  const [audioLabNowMs, setAudioLabNowMs] = useState(0);
  const [audioLabLastDb, setAudioLabLastDb] = useState<number | null>(null);
  const [audioLabMinDb, setAudioLabMinDb] = useState<number | null>(null);
  const [audioLabMaxDb, setAudioLabMaxDb] = useState<number | null>(null);
  const [audioLabFlatlineMs, setAudioLabFlatlineMs] = useState(0);
  const [audioLabCallbackIntervalMs, setAudioLabCallbackIntervalMs] = useState<number | null>(null);
  const [audioLabPlaybackPositionMs, setAudioLabPlaybackPositionMs] = useState(0);
  const [audioLabPlaybackStallMs, setAudioLabPlaybackStallMs] = useState(0);
  const [audioLabLoopCount, setAudioLabLoopCount] = useState(0);
  const [audioLabUnexpectedStopCount, setAudioLabUnexpectedStopCount] = useState(0);
  const [audioLabPlaybackRecoverCount, setAudioLabPlaybackRecoverCount] = useState(0);
  const [audioLabRecentLogs, setAudioLabRecentLogs] = useState<string[]>([]);
  const [autoBargeInEnabled, setAutoBargeInEnabled] = useState(true);
  const [autoSpeakerPriorityEnabled, setAutoSpeakerPriorityEnabled] = useState(true);
  const [autoTranscribeOnStop, setAutoTranscribeOnStop] = useState(true);
  const [autoReplyAfterStt, setAutoReplyAfterStt] = useState(true);
  const [autoSpeakAfterReply, setAutoSpeakAfterReply] = useState(true);
  const [ttsSound, setTtsSound] = useState<Audio.Sound | null>(null);
  const [autoWaveDebugNowMs, setAutoWaveDebugNowMs] = useState(0);
  const [ttsUri, setTtsUri] = useState("");
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>(DEFAULT_TTS_PROVIDER);
  const [sttProvider, setSttProvider] = useState<SttProvider>(DEFAULT_STT_PROVIDER);
  const [recordingQualityPreset, setRecordingQualityPreset] =
    useState<RecordingQualityPreset>(DEFAULT_RECORDING_QUALITY_PRESET);
  const [recordingTuning, setRecordingTuning] = useState<RecordingTuning>(
    recordingTuningFromPreset(DEFAULT_RECORDING_QUALITY_PRESET)
  );
  const [faceTrackingEnabled, setFaceTrackingEnabled] = useState(false);
  const [faceTrackingRunning, setFaceTrackingRunning] = useState(false);
  const [faceTrackingLooking, setFaceTrackingLooking] = useState(true);
  const [faceTrackingFaceDetected, setFaceTrackingFaceDetected] = useState(false);
  const [, setFaceTrackingYawDeg] = useState(0);
  const [, setFaceTrackingPitchDeg] = useState(0);
  const [, setFaceTrackingLookScore] = useState(0);
  const [ttsSpeed, setTtsSpeed] = useState(DEFAULT_TTS_SPEED);
  const [ttsSpeedInput, setTtsSpeedInput] = useState(DEFAULT_TTS_SPEED.toFixed(1));
  const [selectedVoiceIdByProvider, setSelectedVoiceIdByProvider] =
    useState<SelectedVoiceIdByProvider>(DEFAULT_SELECTED_VOICE_IDS);
  const sessionDiagEventLastAtRef = useRef<Record<string, number>>({});
  const sessionDiagEnqueueRef = useRef<(name: string, data: Record<string, unknown>) => void>(() => {});
  const logSessionDiag = useCallback((
    event: string,
    payload: Record<string, unknown> = {},
    options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean }
  ) => {
    logSessionDiagEvent({
      event,
      payload,
      options,
      sessionDiagDetailEventsEnabled: SESSION_DIAG_DETAIL_EVENTS_ENABLED,
      sessionDiagEventThrottleDefaultMs: SESSION_DIAG_EVENT_THROTTLE_DEFAULT_MS,
      sessionDiagEventLastAtByKey: sessionDiagEventLastAtRef.current,
      enqueueLog: (name, data) => {
        sessionDiagEnqueueRef.current(name, data);
      },
    });
  }, []);
  const logChatScrollDiag = useCallback((
    event: string,
    payload: Record<string, unknown> = {},
    options?: { throttleMs?: number; throttleKey?: string }
  ) => {
    logChatScrollDiagEvent({
      chatScrollDiagEnabled: CHAT_SCROLL_DIAG_ENABLED,
      event,
      payload,
      options,
      logSessionDiag,
    });
  }, [logSessionDiag]);
  const handleSessionDiagLog = useCallback((event: string, payload?: Record<string, unknown>) => {
    logSessionDiag(event, payload, { throttleMs: 0 });
  }, [logSessionDiag]);
  const {
    voicesLoading,
    voiceFilter,
    filteredVoices,
    selectedVoiceId,
    setVoiceFilter,
    loadVoices,
  } = useTtsVoiceCatalog({
    runnerUrl,
    runnerToken,
    ttsProvider,
    getBaseUrl: baseUrl,
    selectedVoiceIdByProvider,
    setSelectedVoiceIdByProvider,
    setErrorMessage: setError,
    reportError,
  });
  const {
    directoryExplorerPath,
    directoryExplorerRootPath,
    directoryExplorerParentPath,
    directoryExplorerEntries,
    directoryExplorerLoading,
    directoryExplorerError,
    fetchRunnerSessionContextUsedPct,
    fetchRunnerSessionMessages,
    fetchLatestSessionIdForDirectory,
    fetchSessionHistory,
    markRunnerSessionRead,
    loadDirectoryExplorer,
    openDirectoryExplorer: primeDirectoryExplorer,
  } = useLlmSessionExplorer({
    codexWsUrl,
    codexWsToken,
    runnerToken,
    auxServerBaseUrl,
    normalizedLlmDirectoryForRequest,
    defaultLlmDirectory: DEFAULT_LLM_DIRECTORY,
    nearUnlimitedTimeoutMs: NEAR_UNLIMITED_TIMEOUT_MS,
    onSessionDiagLog: handleSessionDiagLog,
  });
  const {
    ensureMicReady: ensureMicReadyFromController,
    releaseRecording: releaseRecordingFromController,
  } = useRecordingDeviceController();

  async function transcribeRecording(uriOverride?: string) {
    await transcribeRecordingFnRef.current(uriOverride);
  }

  async function ensureMicReady() {
    return ensureMicReadyFromController();
  }

  async function releaseRecording(rec: Audio.Recording) {
    return releaseRecordingFromController(rec);
  }
  const { playUiSfx } = useUiSfxController({
    uiSfxAssets: UI_SFX_ASSETS,
    uiSfxVolumes: UI_SFX_VOLUMES,
    uiSfxMinIntervalMs: UI_SFX_MIN_INTERVAL_MS,
  });

  const {
    manualRecording,
    recordingUri,
    recordingSec,
    startRecording,
    stopRecording,
    setRecordedClip,
    clearRecordedClip,
  } = useManualRecordingController({
    audioLabRunning,
    audioLabRecordingActive,
    audioLabPlaybackActive,
    autoRecordingEnabled,
    recordingTuning,
    autoTranscribeOnStop,
    ensureMicReady,
    onManualMeteringTick: (status, metering, now) => {
      maybeLogWaveformStatusTick("manual", now, status, metering);
      trackWaveformFlatline({
        source: "manual",
        now,
        metering,
        status,
      });
      appendAutoWaveformSample(metering);
    },
    resetAutoWaveform,
    setAudioModeForPlayback,
    transcribeRecording,
    setErrorMessage: setError,
    playUiSfx,
    reportError,
  });
  const [streamAudioQueueSize, setStreamAudioQueueSize] = useState(0);
  const [streamMode, setStreamMode] = useState("");
  const [streamLlmNativeDeltaCount, setStreamLlmNativeDeltaCount] = useState(0);
  const [streamLlmPseudoDeltaCount, setStreamLlmPseudoDeltaCount] = useState(0);
  const [streamFirstNativeDeltaOffsetMs, setStreamFirstNativeDeltaOffsetMs] = useState<number | null>(null);
  const [streamLlmDeltas, setStreamLlmDeltas] = useState<LlmDeltaEntry[]>([]);
  const [streamLlmProgress, setStreamLlmProgress] = useState<LlmProgressEntry[]>([]);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [, setStreamWaveformPreview] = useState<number[]>([]);
  const [streamReplyYouTubeVideoIds, setStreamReplyYouTubeVideoIds] = useState<string[]>([]);
  const [chatScrollOffsetY, setChatScrollOffsetY] = useState(0);
  const [chatViewportHeight, setChatViewportHeight] = useState(0);
  const [chatScreenLayout, setChatScreenLayout] = useState({ width: 0, height: 0 });
  const [drawerSessionPopupPanelId, setDrawerSessionPopupPanelId] = useState("");
  const [drawerSessionPopupCycleId, setDrawerSessionPopupCycleId] = useState("");
  const [drawerSessionPopupSourceRect, setDrawerSessionPopupSourceRect] = useState<PopupChatSourceRect | null>(null);
  const [youtubeInlineLayout, setYoutubeInlineLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [youtubeFloatingPosition, setYoutubeFloatingPosition] = useState<{ x: number; y: number } | null>(null);
  const [youtubePlayerVideoId, setYoutubePlayerVideoId] = useState("");
  const [youtubePlayerMessageId, setYoutubePlayerMessageId] = useState("");
  const [youtubePlayerSession, setYoutubePlayerSession] = useState(0);
  const [, setYoutubePlayerIsPlaying] = useState(false);
  const [youtubeFloatingInteractionMode, setYoutubeFloatingInteractionMode] = useState<"drag" | "control">("drag");
  const [youtubeVideoMetaById, setYoutubeVideoMetaById] = useState<Record<string, YouTubeVideoMeta>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
  const [replyDebug, setReplyDebugState] = useState("");
  const setReplyDebug = useCallback((value: SetStateAction<string>) => {
    setReplyDebugState((prev) => {
      const next = typeof value === "function"
        ? (value as (current: string) => string)(prev)
        : value;
      return normalizeReplyDebugLog(next);
    });
  }, []);
  const [chatThinkingLogExpanded, setChatThinkingLogExpanded] = useState(false);
  const [acpContextUsedPct, setAcpContextUsedPct] = useState<number | null>(null);
  const [ttsDebugStats, setTtsDebugStats] = useState<TtsDebugStats>(EMPTY_TTS_DEBUG_STATS);
  const [llmActiveToolCalls, setLlmActiveToolCalls] = useState(0);
  const [llmLastToolCall, setLlmLastToolCall] = useState<ToolCallEntry | null>(null);
  const [llmRuntimeLimits, setLlmRuntimeLimits] = useState<LlmRuntimeLimitsSnapshot | null>(null);
  const [llmRuntimeLimitsLoading, setLlmRuntimeLimitsLoading] = useState(false);
  const [llmRuntimeLimitsError, setLlmRuntimeLimitsError] = useState("");
  const [codexCliStatusSnapshot, setCodexCliStatusSnapshot] = useState<CodexCliStatusSnapshot | null>(null);
  const [codexCliStatusFetchedAtMs, setCodexCliStatusFetchedAtMs] = useState(0);
  const [codexCliStatusLoading, setCodexCliStatusLoading] = useState(false);
  const [codexAuthProfilesSnapshot, setCodexAuthProfilesSnapshot] = useState<CodexAuthProfilesSnapshot | null>(null);
  const [codexAuthProfilesLoading, setCodexAuthProfilesLoading] = useState(false);
  const [codexAuthSwitching, setCodexAuthSwitching] = useState(false);
  const [codexAuthSwitchError, setCodexAuthSwitchError] = useState("");
  const [gitChangedFilesByDirectory, setGitChangedFilesByDirectory] = useState<
    Record<string, GitChangedFilesDirectoryState>
  >({});
  const [llmToolMaxRoundsInput, setLlmToolMaxRoundsInput] = useState("500");
  const [llmToolMaxRoundsSaving, setLlmToolMaxRoundsSaving] = useState(false);
  const [codexWsProbeLoading, setCodexWsProbeLoading] = useState(false);
  const [codexWsHandshakeProbeLoading, setCodexWsHandshakeProbeLoading] = useState(false);
  const [codexWsHandshakeProbeStatus, setCodexWsHandshakeProbeStatus] = useState("idle");
  const [codexWsDiagLoading, setCodexWsDiagLoading] = useState(false);
  const [codexWsDiagStatus, setCodexWsDiagStatus] = useState("idle");
  const [codexWsE2eLoading, setCodexWsE2eLoading] = useState(false);
  const [codexWsE2eStatus, setCodexWsE2eStatus] = useState("idle");
  const [runner8788SuiteLoading, setRunner8788SuiteLoading] = useState(false);
  const [runner8788SuiteStatus, setRunner8788SuiteStatus] = useState("idle");
  const [llmToolLogCompact, setLlmToolLogCompact] = useState(true);
  const [toolAutoApprovalMap, setToolAutoApprovalMap] = useState<ToolAutoApprovalMap>(EMPTY_TOOL_AUTO_APPROVALS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const autoRecordingEnabledRef = useRef(false);
  const codexCliStatusLastFetchedAtMsRef = useRef(0);
  const codexCliStatusLastAttemptAtMsRef = useRef(0);
  const codexCliStatusRefreshInFlightRef = useRef(false);
  const codexAuthProfilesRefreshInFlightRef = useRef(false);
  const gitChangedFilesByDirectoryRef = useRef<Record<string, GitChangedFilesDirectoryState>>({});
  const gitChangedFilesRefreshInFlightRef = useRef(new Set<string>());
  const autoRecordingRef = useRef<Audio.Recording | null>(null);
  const autoFinalizeLockRef = useRef(false);
  const autoRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoAppStateNonActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoWaitReasonRef = useRef("");
  const autoWaitReasonLogAtRef = useRef(0);
  const autoClipStartedAtRef = useRef(0);
  const autoSpeechStartedAtRef = useRef(0);
  const autoAboveSinceRef = useRef(0);
  const autoAboveGapSinceRef = useRef(0);
  const autoBelowSinceRef = useRef(0);
  const autoInputDetectAtRef = useRef(0);
  const autoProgressIntervalMsRef = useRef(0);
  const autoProgressIntervalModeRef = useRef<"idle" | "speech" | "barge">("idle");
  const autoUiLatestMeteringRef = useRef<number | null>(null);
  const autoUiLatestSpeechSampleRef = useRef(false);
  const autoWaveformUiAtRef = useRef(0);
  const autoWaveformLastSampleAtRef = useRef(0);
  const autoWaveformSkipLogAtRef = useRef(0);
  const autoWaveStatusTickLogAtRef = useRef(0);
  const autoWaveStatusLastAtRef = useRef(0);
  const manualWaveStatusTickLogAtRef = useRef(0);
  const manualWaveStatusLastAtRef = useRef(0);
  const autoWavePathLogAtRef = useRef(0);
  const autoWaveStateLogAtRef = useRef(0);
  const autoWaveRenderLogAtRef = useRef(0);
  const autoWaveformVersionRef = useRef(0);
  const autoSpectrumVersionRef = useRef(0);
  const autoWaveFlatlineSinceRef = useRef(0);
  const autoWaveFlatlineLogAtRef = useRef(0);
  const autoWaveFlatlineActiveRef = useRef(false);
  const autoWaveFlatlineSourceRef = useRef<"auto" | "manual" | "">("");
  const autoBargeInProbeLogAtRef = useRef(0);
  const autoBargeInFastStopAtRef = useRef(0);
  const autoBargeInFastProbeAboveSinceRef = useRef(0);
  const autoFinalizeResolvedAtRef = useRef(0);
  const autoLastBargeInDetectedAtRef = useRef(0);
  const autoLastTtsStopRequestedAtRef = useRef(0);
  const autoLastTtsStoppedAtRef = useRef(0);
  const autoPlaybackBargeGraceUntilRef = useRef(0);
  const autoBargeInEnabledRef = useRef(true);
  const autoSpeakerPriorityEnabledRef = useRef(true);
  const autoInputNameRef = useRef("");
  const autoInputDetectErrorLogAtRef = useRef(0);
  const autoAirPodsInputRef = useRef(false);
  const audioLabRecordingRef = useRef<Audio.Recording | null>(null);
  const audioLabSoundRef = useRef<Audio.Sound | null>(null);
  const audioLabInputPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioLabPlaybackWatchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioLabActionInFlightRef = useRef(false);
  const audioLabRunIdRef = useRef(0);
  const audioLabStartedAtRef = useRef(0);
  const audioLabLastStatusAtRef = useRef(0);
  const audioLabFlatlineSinceRef = useRef(0);
  const audioLabMeterLogAtRef = useRef(0);
  const audioLabPlaybackWantedRef = useRef(false);
  const audioLabPlaybackLastPlayingAtRef = useRef(0);
  const audioLabPlaybackStatusLogAtRef = useRef(0);
  const audioLabPlaybackRecoverAtRef = useRef(0);
  const audioLabPlaybackWatchdogInFlightRef = useRef(false);
  const audioLabPlaybackWatchdogErrorLogAtRef = useRef(0);
  const audioLabInputNameRef = useRef("");
  const audioLabAirPodsInputRef = useRef(false);
  const audioLabRouteErrorLogAtRef = useRef(0);
  const audioLabRecordingInactiveLoggedRef = useRef(false);
  const autoRecordingWatchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRecordingWatchdogInFlightRef = useRef(false);
  const autoRecordingWatchdogInFlightTokenRef = useRef(0);
  const autoRecordingWatchdogKickAtRef = useRef(0);
  const autoRecordingWatchdogRestartAtRef = useRef(0);
  const autoRecordingWatchdogTtsInterruptAtRef = useRef(0);
  const autoRecordingWatchdogLogAtRef = useRef(0);
  const autoRecordingWatchdogErrorLogAtRef = useRef(0);
  const autoSilenceDeadlineAtRef = useRef(0);
  const autoNoCallbackFinalizeAtRef = useRef(0);
  const autoLastStatusHandledAtRef = useRef(0);
  const autoStatusReadInFlightRef = useRef<Promise<Audio.RecordingStatus> | null>(null);
  const autoStatusReadOwnerRef = useRef<"watchdog" | "">("");
  const autoStatusReadStartedAtRef = useRef(0);
  const autoStatusReadSkipLogAtRef = useRef(0);
  const autoShadowStatusTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoShadowStatusInFlightRef = useRef(false);
  const autoShadowStatusLastAtRef = useRef(0);
  const autoShadowStatusLastMeteringRef = useRef<number | null>(null);
  const autoShadowStatusLastDurationMsRef = useRef<number | null>(null);
  const autoShadowStatusLogAtRef = useRef(0);
  const autoShadowStatusErrorLogAtRef = useRef(0);
  const autoAudioModeSkipLogAtRef = useRef(0);
  const autoBargeInStoppingRef = useRef(false);
  const autoBargeInDetectedForClipRef = useRef(false);
  const autoSpeechStartedDuringTtsRef = useRef(false);
  const autoPostTtsAboveSinceRef = useRef(0);
  const autoPostTtsHumanDetectedRef = useRef(false);
  const ttsPlayingRef = useRef(false);
  const ttsSoundRef = useRef<Audio.Sound | null>(null);
  const ttsPlaybackWantedRef = useRef(false);
  const ttsPlaybackRunIdRef = useRef(0);
  const ttsPlaybackTransitionInFlightRef = useRef(false);
  const ttsPlaybackWatchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ttsPlaybackWatchdogInFlightRef = useRef(false);
  const ttsPlaybackLastPlayingAtRef = useRef(0);
  const ttsPlaybackStatusLogAtRef = useRef(0);
  const ttsPlaybackRecoverAtRef = useRef(0);
  const ttsPlaybackUnexpectedStopLogAtRef = useRef(0);
  const ttsPlaybackWatchdogErrorLogAtRef = useRef(0);
  const ttsStopInFlightRef = useRef<Promise<void> | null>(null);
  const ttsSynthesisRequestIdRef = useRef(0);
  const streamTtsSuppressedRef = useRef(false);
  const streamSocketRef = useRef<WebSocket | null>(null);
  const codexRelayObserverRef = useRef<{ threadId: string; panelId?: string; close: () => void } | null>(null);
  const codexRelayObserverReplyByThreadRef = useRef<Record<string, string>>({});
  const codexRelayObserverStartedAtMsByThreadRef = useRef<Record<string, number>>({});
  const waitingApprovalResumePendingSessionIdRef = useRef("");
  const waitingApprovalResumeAttachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingApprovalResumeCooldownUntilMsRef = useRef(0);
  const codexHandshakeProbeSocketRef = useRef<WebSocket | null>(null);
  const streamAudioQueueRef = useRef<StreamAudioQueueItem[]>([]);
  const streamAudioQueueGenerationRef = useRef(0);
  const streamAudioEnqueueChainRef = useRef<Promise<void>>(Promise.resolve());
  const streamAudioWaveformBarsRef = useRef<number[][]>([]);
  const streamAudioQueueProcessingRef = useRef(false);
  const streamCurrentChunkStartedAtRef = useRef(0);
  const streamCurrentChunkEstimatedDurationMsRef = useRef<number | null>(null);
  const ttsPlaybackProgressUiAtRef = useRef(0);
  const ttsPlaybackMessageIdRef = useRef("");
  const streamReplyYouTubeVideoIdsRef = useRef<string[]>([]);
  const llmConversationSessionIdRef = useRef("");
  const selectedLlmSessionIdRef = useRef("");
  const panelRuntimeEntriesByIdRef = useRef<Record<string, { snapshot?: { selectedSessionId?: string } }>>({});
  const autoSpeechOpenPanelIdsRef = useRef<Record<string, true>>({});
  const ttsPlaybackProjectionTargetRef = useRef<TtsPlaybackTarget>({});
  const stopTtsPlaybackDelegateRef = useRef<(options?: { interruptStream?: boolean }) => Promise<void>>(async () => {});
  const setPanelAutoSpeechOpen = useCallback((panelIdRaw: string, open: boolean) => {
    const panelId = normalizeRuntimePanelId(panelIdRaw);
    if (!panelId) return;
    const currentOpen = !!autoSpeechOpenPanelIdsRef.current[panelId];
    if (open === currentOpen) return;
    if (open) {
      autoSpeechOpenPanelIdsRef.current = {
        ...autoSpeechOpenPanelIdsRef.current,
        [panelId]: true,
      };
    } else {
      const next = { ...autoSpeechOpenPanelIdsRef.current };
      delete next[panelId];
      autoSpeechOpenPanelIdsRef.current = next;
      const playbackPanelId = normalizeRuntimePanelId(ttsPlaybackProjectionTargetRef.current.panelId);
      const hasActiveTts = (
        ttsPlaybackWantedRef.current ||
        ttsPlayingRef.current ||
        ttsSoundRef.current !== null ||
        streamSocketRef.current !== null ||
        streamAudioQueueProcessingRef.current ||
        streamAudioQueueRef.current.length > 0
      );
      if (hasActiveTts && playbackPanelId === panelId) {
        void stopTtsPlaybackDelegateRef.current({ interruptStream: true }).catch(() => {});
      }
    }
  }, []);
  const isChatOpenForAutoSpeech = useCallback((target: TtsPlaybackTarget) => {
    const panelId = normalizeRuntimePanelId(target.panelId);
    const sessionId = parseOptionalSessionId(target.sessionId);
    if (panelId) {
      if (!autoSpeechOpenPanelIdsRef.current[panelId]) return false;
      if (!sessionId) return true;
      const panelSessionId = parseOptionalSessionId(
        panelRuntimeEntriesByIdRef.current[panelId]?.snapshot?.selectedSessionId
      );
      return !panelSessionId || panelSessionId === sessionId;
    }

    const visibleSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || selectedLlmSessionId || llmConversationSessionIdRef.current
    );
    return !!sessionId && (!visibleSessionId || visibleSessionId === sessionId);
  }, [
    selectedLlmSessionId,
  ]);
  useEffect(() => {
    if (!settingsLoaded) return;
    const sessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || selectedLlmSessionId || llmConversationSessionIdRef.current
    );
    if (!sessionId || !codexWsUrl.trim()) {
      setSelectedThreadStatusType("unknown");
      return;
    }
    const probeSeq = selectedThreadStatusProbeSeqRef.current + 1;
    selectedThreadStatusProbeSeqRef.current = probeSeq;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const runProbe = (attempt: number) => {
      logSessionDiag("thread_status_probe_start", {
        sessionId,
        attempt,
        wsUrl: codexWsUrl.trim(),
      }, { throttleMs: 0 });
      void readCodexAppServerThread({
        wsUrl: codexWsUrl.trim(),
        wsToken: codexWsToken.trim(),
        threadId: sessionId,
        timeoutMs: 25_000,
      })
        .then((restored) => {
          if (cancelled || selectedThreadStatusProbeSeqRef.current !== probeSeq) return;
          const nextStatusType = String(restored.threadStatusType || "unknown").trim() || "unknown";
          setSelectedThreadStatusType(nextStatusType);
          logSessionDiag("thread_status_probe_done", {
            sessionId,
            attempt,
            threadStatusType: nextStatusType,
            sessionState: restored.sessionState,
            latestTurnStatus: restored.latestTurnStatus,
            hasRunningTurn: restored.hasRunningTurn,
          }, { throttleMs: 0 });
        })
        .catch((error) => {
          if (cancelled || selectedThreadStatusProbeSeqRef.current !== probeSeq) return;
          if (attempt < 5) {
            logSessionDiag("thread_status_probe_retry", {
              sessionId,
              attempt,
              reason: error instanceof Error ? error.message : String(error),
            }, { throttleMs: 0 });
            retryTimer = setTimeout(() => runProbe(attempt + 1), 1000 * attempt);
            return;
          }
          logSessionDiag("thread_status_probe_failed", {
            sessionId,
            attempt,
            reason: error instanceof Error ? error.message : String(error),
          }, { throttleMs: 0 });
          setSelectedThreadStatusType("unknown");
        });
    };
    runProbe(1);
    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
  }, [
    codexWsToken,
    codexWsUrl,
    selectedLlmSessionId,
    settingsLoaded,
  ]);
  const knownCodexThreadIdsRef = useRef<Set<string>>(new Set());
  const sessionRuntimeStatusByIdRef = useRef<Record<string, SessionRuntimeStatus>>({});
  const startupSessionRestoreAttemptedRef = useRef(false);
  const llmSessionDirectoryRef = useRef(DEFAULT_LLM_DIRECTORY);
  const llmActiveToolCallsRef = useRef(0);
  const llmToolCallArgsByIdRef = useRef<Record<string, unknown>>({});
  const replyLoadingRef = useRef(false);
  const autoReplyAfterSttRef = useRef(false);
  const autoSpeakAfterReplyRef = useRef(false);
  const toolAutoApprovalMapRef = useRef<ToolAutoApprovalMap>(EMPTY_TOOL_AUTO_APPROVALS);
  const sttLoadingRef = useRef(false);
  const transcribeRecordingFnRef = useRef<(uriOverride?: string) => Promise<void>>(async () => {});
  useEffect(() => {
    return () => {
      if (waitingApprovalResumeAttachTimerRef.current) {
        clearTimeout(waitingApprovalResumeAttachTimerRef.current);
      }
      waitingApprovalResumeAttachTimerRef.current = null;
      waitingApprovalResumePendingSessionIdRef.current = "";
    };
  }, [logSessionDiag]);
  const autoClientLogs = useBufferedClientLogs<AutoClientLogEntry>({
    enabled: true,
    source: "app_auto",
    runnerUrl,
    runnerToken,
    getBaseUrl: baseUrl,
    createSessionId: buildAutoClientLogSessionId,
    createEntry: (seed) => ({
      ...seed,
      screen: activeScreen,
      autoEnabled: autoRecordingEnabledRef.current,
      autoState: autoRecordingState,
      autoEvent: autoLastEvent,
      ttsPlaying: ttsPlayingRef.current,
      ttsLoading,
      replyLoading: replyLoadingRef.current,
    }),
    bufferMax: AUTO_CLIENT_LOG_BUFFER_MAX,
    flushBatchSize: AUTO_CLIENT_LOG_FLUSH_BATCH_SIZE,
    flushDelayMs: AUTO_CLIENT_LOG_FLUSH_DELAY_MS,
    retryMs: AUTO_CLIENT_LOG_RETRY_MS,
  });
  const audioLabClientLogs = useBufferedClientLogs<AutoClientLogEntry>({
    enabled: AUTO_DIAGNOSTICS_ENABLED,
    source: "audio_lab",
    runnerUrl,
    runnerToken,
    getBaseUrl: baseUrl,
    createSessionId: buildAutoClientLogSessionId,
    createEntry: (seed) => ({
      ...seed,
      screen: activeScreen,
      autoEnabled: false,
      autoState: audioLabRunning ? "running" : "idle",
      autoEvent: seed.event,
      ttsPlaying: ttsPlayingRef.current,
      ttsLoading,
      replyLoading: replyLoadingRef.current,
    }),
    bufferMax: AUDIO_LAB_LOG_BUFFER_MAX,
    flushBatchSize: AUDIO_LAB_LOG_FLUSH_BATCH_SIZE,
    flushDelayMs: AUDIO_LAB_LOG_FLUSH_DELAY_MS,
    retryMs: AUDIO_LAB_LOG_RETRY_MS,
  });
  const sessionDiagClientLogs = useBufferedClientLogs<AutoClientLogEntry>({
    enabled: true,
    source: "session_diag",
    runnerUrl,
    runnerToken,
    getBaseUrl: baseUrl,
    createSessionId: buildAutoClientLogSessionId,
    createEntry: (seed) => ({
      ...seed,
      screen: activeScreen,
      autoEnabled: autoRecordingEnabledRef.current,
      autoState: autoRecordingState,
      autoEvent: seed.event,
      ttsPlaying: ttsPlayingRef.current,
      ttsLoading,
      replyLoading: replyLoadingRef.current,
    }),
    bufferMax: SESSION_DIAG_LOG_BUFFER_MAX,
    flushBatchSize: SESSION_DIAG_LOG_FLUSH_BATCH_SIZE,
    flushDelayMs: SESSION_DIAG_LOG_FLUSH_DELAY_MS,
    retryMs: SESSION_DIAG_LOG_RETRY_MS,
  });
  sessionDiagEnqueueRef.current = sessionDiagClientLogs.enqueue;
  const autoClientLogQueuedCount = autoClientLogs.queuedCount;
  const autoClientLogSentCount = autoClientLogs.sentCount;
  const autoClientLogStatus = autoClientLogs.status;
  const audioLabLogQueuedCount = audioLabClientLogs.queuedCount;
  const audioLabLogSentCount = audioLabClientLogs.sentCount;
  const audioLabLogStatus = audioLabClientLogs.status;

  useEffect(() => {
    return () => {
      const ws = codexHandshakeProbeSocketRef.current;
      codexHandshakeProbeSocketRef.current = null;
      if (!ws) return;
      try {
        ws.close();
      } catch {}
    };
  }, []);
  const sttProviderRef = useRef<SttProvider>(DEFAULT_STT_PROVIDER);
  const faceTrackingEnabledRef = useRef(false);
  const faceTrackingLookingRef = useRef(true);
  const faceTrackingFaceDetectedRef = useRef(false);
  const faceTrackingAllowCachedAtRef = useRef(0);
  const faceTrackingAllowCachedValueRef = useRef(true);
  const faceTrackingSessionRef = useRef<IosFaceTrackingSession | null>(null);
  const faceTrackingSyncTokenRef = useRef(0);
  const faceTrackingSuppressLogAtRef = useRef(0);
  const faceTrackingSuppressedRef = useRef(false);
  const faceTrackingNotLookingSinceRef = useRef(0);
  const conversationMessagesRef = useRef<ConversationMessage[]>([]);
  type RuntimeConversationWriteOptions = {
    isResponding?: boolean;
    selectedThreadStatusType?: string;
    sessionId?: string;
    clearRespondingRequestStartedAtMs?: number | null;
  };
  type PanelConversationWriteOptions = RuntimeConversationWriteOptions & {
    contextUsedPct?: number | null;
    adoptFromSessionId?: string;
  };
  const getPanelConversationMessagesForCodexRef = useRef<(panelId: string) => ConversationMessage[]>(
    () => []
  );
  const setPanelConversationMessagesForCodexRef = useRef<(
    panelId: string,
    messages: ConversationMessage[],
    options?: PanelConversationWriteOptions
  ) => void>(() => {});
  const getSessionConversationMessagesForCodexRef = useRef<(sessionId: string) => ConversationMessage[]>(
    () => []
  );
  const setSessionConversationMessagesForCodexRef = useRef<(
    sessionId: string,
    messages: ConversationMessage[],
    options?: RuntimeConversationWriteOptions
  ) => void>(() => {});
  const llmSessionRestoreLoadingRef = useRef(false);
  const llmSessionRestoreInFlightRef = useRef(false);
  const llmSessionRestoreRequestSeqRef = useRef(0);
  const sessionSwitchQueuedSendRef = useRef<SessionSwitchQueuedSend | null>(null);
  const chatComposerInputRef = useRef<TextInput | null>(null);
  const chatComposerFullscreenInputRef = useRef<TextInput | null>(null);
  const {
    chatBottomToast,
    chatBottomToastAnimRef,
    showChatBottomToast,
    hideChatBottomToast,
    markConversationMessageToasted,
    shouldShowReplyPreviewToast,
  } = useChatBottomToast({
    visibleMs: CHAT_BOTTOM_TOAST_VISIBLE_MS,
    trimText: trimForInline,
    maxChars: 120,
  });
  const {
    markSessionReadAsync,
    markSessionUnread,
    markSessionRead,
    markDirectorySessionsRead,
  } = useSessionMarkReadController({
    markRunnerSessionRead,
    fetchSessionHistory,
    normalizedLlmDirectoryForRequest,
    setDirectorySessionsById,
    showChatBottomToast,
    logSessionDiag,
  });
  const appStateRef = useRef(AppState.currentState);
  const appStateChangedAtRef = useRef(Date.now());
  const appStateLastNonActiveAtRef = useRef(
    AppState.currentState === "active" ? 0 : Date.now()
  );
  const appResumeSessionSyncInFlightRef = useRef(false);
  const appResumeSessionSyncLastAtRef = useRef(0);
  const autoResumeStatusProbeInFlightRef = useRef(false);
  const autoStatusNotRecordingSuppressLogAtRef = useRef(0);
  const autoCaptureCycleSeqRef = useRef(0);
  const chatContentRef = useRef<View | null>(null);
  const chatScrollOffsetYRef = useRef(0);
  const chatNearBottomRef = useRef(true);
  const chatTouchActiveRef = useRef(false);
  const chatScrollStateLastAtRef = useRef(0);
  const chatScrollStateLastYRef = useRef(0);
  const chatContentHeightRef = useRef(0);
  const chatDistanceToBottomRef = useRef(0);
  const chatViewportHeightRef = useRef(0);
  const chatScreenLayoutRef = useRef({ width: 0, height: 0 });
  const youtubeWebViewRef = useRef<WebView | null>(null);
  const chatThinkingPanelSessionIdRef = useRef(String(selectedLlmSessionId || "").trim());
  const {
    setFaceTrackingEnabledWithRef,
    applyFaceTrackingState,
    faceTrackingAllowsStt,
  } = useFaceTrackingStateController({
    autoFaceTrackingAllowCacheMs: AUTO_FACE_TRACKING_ALLOW_CACHE_MS,
    faceTrackingEnabledRef,
    faceTrackingLookingRef,
    faceTrackingFaceDetectedRef,
    faceTrackingAllowCachedAtRef,
    faceTrackingAllowCachedValueRef,
    faceTrackingSuppressedRef,
    faceTrackingSuppressLogAtRef,
    faceTrackingNotLookingSinceRef,
    setFaceTrackingEnabled,
    setFaceTrackingLooking,
    setFaceTrackingFaceDetected,
    setFaceTrackingRunning,
    setFaceTrackingYawDeg,
    setFaceTrackingPitchDeg,
    setFaceTrackingLookScore,
  });

  useEffect(() => {
    const nextSelectedSessionId = String(selectedLlmSessionId || "").trim();
    const prevSelectedSessionId = String(selectedLlmSessionIdRef.current || "").trim();
    if (prevSelectedSessionId !== nextSelectedSessionId) {
      logSessionDiag("session_id_ref_synced_from_state", {
        source: "selected_session_state_effect",
        directory: normalizedLlmDirectoryForRequest(),
        prevSelectedSessionId,
        nextSelectedSessionId,
        currentSessionId: String(llmConversationSessionIdRef.current || "").trim(),
      }, {
        throttleMs: 0,
      });
    }
    selectedLlmSessionIdRef.current = nextSelectedSessionId;
  }, [selectedLlmSessionId]);
  useEffect(() => {
    const nextSessionId = String(selectedLlmSessionId || "").trim();
    const prevSessionId = String(chatThinkingPanelSessionIdRef.current || "").trim();
    if (prevSessionId && prevSessionId !== nextSessionId) {
      setChatThinkingLogExpanded(false);
    }
    chatThinkingPanelSessionIdRef.current = nextSessionId;
  }, [selectedLlmSessionId]);
  useEffect(() => {
    chatViewportHeightRef.current = Number.isFinite(chatViewportHeight) ? chatViewportHeight : 0;
  }, [chatViewportHeight]);
  useEffect(() => {
    chatScreenLayoutRef.current = {
      width: Number.isFinite(chatScreenLayout.width) ? chatScreenLayout.width : 0,
      height: Number.isFinite(chatScreenLayout.height) ? chatScreenLayout.height : 0,
    };
  }, [chatScreenLayout.height, chatScreenLayout.width]);
  const youtubePlaybackPositionSecRef = useRef(0);
  const youtubeVideoMetaByIdRef = useRef<Record<string, YouTubeVideoMeta>>({});
  const youtubePlaybackQueueRef = useRef<{ messageId: string; videoIds: string[]; index: number } | null>(null);
  const lastAutoOpenedYouTubeMessageIdRef = useRef("");
  const youtubePlayerVideoIdRef = useRef("");
  const youtubePlayerMessageIdRef = useRef("");
  const youtubePlayerSessionRef = useRef(0);
  const youtubePlayerIsPlayingRef = useRef(false);
  const youtubePauseConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const youtubeControlToDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const youtubeFloatingInteractionModeRef = useRef<"drag" | "control">("drag");
  const resetLlmToolTracking = useCallback((clearLastToolCall: boolean) => {
    llmActiveToolCallsRef.current = 0;
    llmToolCallArgsByIdRef.current = {};
    setLlmActiveToolCalls(0);
    if (clearLastToolCall) {
      setLlmLastToolCall(null);
    }
  }, []);
  const {
    llmUiStatus,
    llmUiStatusDetail,
    llmElapsedMs,
    llmElapsedLiveMs,
    llmUiStatusRef,
    llmUiStatusDetailBaseRef,
    llmRequestStartedAtRef,
    updateLlmStatus,
    startLlmRequest,
    finishLlmRequest,
  } = useLlmRequestStatus({
    replyLoading,
    liveLlmStatusDetail,
    onStartRequest: () => resetLlmToolTracking(true),
    onFinishRequest: () => resetLlmToolTracking(false),
    setChatThinkingLogExpanded,
  });
  const stopWaveformPlaybackDelegateRef = useRef<() => Promise<void>>(async () => {});
  const synthesizeSpeechStreamDelegateRef = useRef<(
    textOverride?: string,
    streamOptions?: TtsPlaybackTarget
  ) => Promise<void>>(async () => {});
  const projectTtsPlaybackMessageIdToPanelsRef = useRef<(messageId: string) => void>(() => {});
  const projectTtsWaveformToPanelsRef = useRef<(messageId: string, waveform?: number[]) => void>(() => {});
  const appendAutoWaveformSampleDelegateRef = useRef<(meteringDb: number, isSpeechSample?: boolean) => void>(() => {});
  const decayAutoWaveformFrameDelegateRef = useRef<(now: number) => void>(() => {});
  const resetAutoWaveformDelegateRef = useRef<() => void>(() => {});
  const setTtsPlayingWithReasonDelegateRef = useRef<(
    next: boolean,
    reason: string,
    payload?: Record<string, unknown>
  ) => void>(() => {});
  const markTtsChunkPlaybackFinishedDelegateRef = useRef<() => void>(() => {});
  const markTtsPlaybackStoppedDelegateRef = useRef<() => void>(() => {});
  const stopTtsPlayback = useCallback(async (options?: { interruptStream?: boolean }) => {
    await stopTtsPlaybackDelegateRef.current(options);
  }, []);
  const stopWaveformPlayback = useCallback(async () => {
    await stopWaveformPlaybackDelegateRef.current();
  }, []);
  const synthesizeSpeechStream = useCallback(async (
    textOverride?: string,
    streamOptions?: TtsPlaybackTarget
  ) => {
    ttsPlaybackProjectionTargetRef.current = {
      panelId: streamOptions?.panelId,
      sessionId: streamOptions?.sessionId,
      messageId: streamOptions?.messageId,
    };
    await synthesizeSpeechStreamDelegateRef.current(textOverride, streamOptions);
  }, []);
  const appendAutoWaveformSample = useCallback((meteringDb: number, isSpeechSample?: boolean) => {
    appendAutoWaveformSampleDelegateRef.current(meteringDb, isSpeechSample);
  }, []);
  const decayAutoWaveformFrame = useCallback((now: number) => {
    decayAutoWaveformFrameDelegateRef.current(now);
  }, []);
  function resetAutoWaveform() {
    resetAutoWaveformDelegateRef.current();
  }
  const {
    waitForReplyIdle,
    handleAssistantAudioButtonPress,
  } = useReplyAudioFlowController({
    nearUnlimitedTimeoutMs: NEAR_UNLIMITED_TIMEOUT_MS,
    replyLoadingRef,
    ttsPlayingRef,
    ttsPlaybackMessageId,
    ttsLoading,
    stopWaveformPlayback,
    synthesizeSpeechStream,
  });
  const {
    setConversationMessagesWithLimit,
    removeConversationMessageById,
    patchConversationMessageById,
  } = useConversationMessageWindowController({
    conversationMessagesRef,
    setConversationMessages,
  });
  const {
    autoPendingUserMessageIdRef,
    autoPendingUserAnimFrameRef,
    autoPendingUserMessageStartedAtRef,
    autoPendingUserMessageVisibleAtRef,
    autoPendingUserVisibleLoggedMessageIdRef,
    clearAutoPendingUserAnimationTimer,
    clearAutoPendingUserTimeoutTimer,
    resetAutoPendingUserState,
    startAutoPendingUserMessage,
    resolveAutoPendingUserMessage,
  } = useAutoPendingUserController<SttMessageMeta, ConversationMessage>({
    autoRecordingEnabledRef,
    autoReplyAfterSttRef,
    autoSpeechStartedAtRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    streamAudioQueueRef,
    ttsPlaybackMessageIdRef,
    conversationMessages,
    conversationMessagesRef,
    setConversationMessagesWithLimit,
    buildPendingUserMessage: (content) => buildConversationMessage("user", content, { pendingUser: true }),
    pendingUserAnimationFrames: AUTO_PENDING_USER_ANIMATION_FRAMES,
    pendingUserAnimationIntervalMs: AUTO_PENDING_USER_ANIMATION_INTERVAL_MS,
    ttsLoading,
    elapsedSinceMs,
    logAuto,
    stopTtsPlayback,
    onPendingTimeout: () => {
      autoBargeInStoppingRef.current = false;
      autoBargeInDetectedForClipRef.current = false;
      autoBargeInFastStopAtRef.current = 0;
      autoBargeInFastProbeAboveSinceRef.current = 0;
      autoAboveSinceRef.current = 0;
      autoAboveGapSinceRef.current = 0;
      autoBelowSinceRef.current = 0;
      if (autoRecordingEnabledRef.current && !autoFinalizeLockRef.current) {
        setAutoRecordingState("listening");
        setAutoLastEvent("barge_in_probe_timeout");
        autoClipStartedAtRef.current = Date.now();
      }
      logAuto("barge_in_flags_reset", {
        phase: "pending_timeout",
        autoBargeInStopping: autoBargeInStoppingRef.current,
        detectedForClip: autoBargeInDetectedForClipRef.current,
      });
    },
  });
  const {
    maybeLogWaveformStatusTick,
    maybeLogWaveformSamplePath,
    trackWaveformFlatline,
    readAutoRecordingStatus,
    readRecordingStatusWithTimeout,
  } = useAutoWaveformDiagnostics({
    appStateRef,
    autoFinalizeLockRef,
    autoRecordingRef,
    autoWaveStatusTickLogAtRef,
    autoWaveStatusLastAtRef,
    manualWaveStatusTickLogAtRef,
    manualWaveStatusLastAtRef,
    autoWavePathLogAtRef,
    autoWaveFlatlineSinceRef,
    autoWaveFlatlineLogAtRef,
    autoWaveFlatlineActiveRef,
    autoWaveFlatlineSourceRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    autoStatusReadInFlightRef,
    autoStatusReadOwnerRef,
    autoStatusReadStartedAtRef,
    autoStatusReadSkipLogAtRef,
    manualRecordingActive: Boolean(manualRecording),
    ttsLoading,
    diagnosticsEnabled: AUTO_DIAGNOSTICS_ENABLED,
    waveformStatusLogThrottleMs: AUTO_WAVEFORM_STATUS_LOG_THROTTLE_MS,
    waveformPathLogThrottleMs: AUTO_WAVEFORM_PATH_LOG_THROTTLE_MS,
    waveformFlatlineDb: AUTO_WAVEFORM_FLATLINE_DB,
    waveformFlatlineHoldMs: AUTO_WAVEFORM_FLATLINE_HOLD_MS,
    waveformFlatlineLogThrottleMs: AUTO_WAVEFORM_FLATLINE_LOG_THROTTLE_MS,
    statusReadSkipLogThrottleMs: AUTO_STATUS_READ_SKIP_LOG_THROTTLE_MS,
    elapsedSinceMs,
    logAuto,
  });
  const {
    detectAutoAirPodsInput: detectAutoAirPodsInputFromController,
    setAudioModeForPlayback: setAudioModeForPlaybackFromController,
  } = useAudioInputRouteController({
    autoRecordingRef,
    autoAirPodsInputRef,
    autoInputNameRef,
    autoInputDetectErrorLogAtRef,
    autoAudioModeSkipLogAtRef,
    autoRecordingEnabledRef,
    ttsPlayingRef,
    replyLoadingRef,
    ttsLoading,
    autoInputErrorLogThrottleMs: AUTO_INPUT_ERROR_LOG_THROTTLE_MS,
    autoAudioModeSkipLogThrottleMs: AUTO_AUDIO_MODE_SKIP_LOG_THROTTLE_MS,
    setAutoInputName,
    setAutoAirPodsInput,
    logAuto,
  });
  async function detectAutoAirPodsInput(rec?: Audio.Recording | null) {
    return detectAutoAirPodsInputFromController(rec);
  }

  async function setAudioModeForPlayback(options?: AudioModeSwitchOptions) {
    return setAudioModeForPlaybackFromController(options);
  }
  const { clearAutoRecordingWatchdogTimer } = useAutoRecordingWatchdogResetController({
    autoRecordingWatchdogTimerRef,
    autoRecordingWatchdogInFlightRef,
    autoRecordingWatchdogInFlightTokenRef,
    autoRecordingWatchdogKickAtRef,
    autoRecordingWatchdogRestartAtRef,
    autoRecordingWatchdogTtsInterruptAtRef,
    autoRecordingWatchdogLogAtRef,
    autoRecordingWatchdogErrorLogAtRef,
    autoProgressIntervalMsRef,
    autoProgressIntervalModeRef,
    autoNoCallbackFinalizeAtRef,
    autoLastStatusHandledAtRef,
    autoStatusReadInFlightRef,
    autoStatusReadOwnerRef,
    autoStatusReadStartedAtRef,
    autoStatusReadSkipLogAtRef,
    autoShadowStatusTimerRef,
    autoShadowStatusInFlightRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastMeteringRef,
    autoShadowStatusLastDurationMsRef,
    autoShadowStatusLogAtRef,
    autoShadowStatusErrorLogAtRef,
  });
  const { startAutoRecordingWatchdog } = useAutoRecordingWatchdog({
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoFinalizeLockRef,
    autoRecordingWatchdogTimerRef,
    autoRecordingWatchdogInFlightRef,
    autoRecordingWatchdogInFlightTokenRef,
    autoRecordingWatchdogKickAtRef,
    autoRecordingWatchdogRestartAtRef,
    autoRecordingWatchdogTtsInterruptAtRef,
    autoRecordingWatchdogErrorLogAtRef,
    autoWaveStatusLastAtRef,
    autoSpeechStartedAtRef,
    autoSilenceDeadlineAtRef,
    autoBelowSinceRef,
    autoNoCallbackFinalizeAtRef,
    autoLastStatusHandledAtRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastMeteringRef,
    autoShadowStatusLastDurationMsRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamCurrentChunkStartedAtRef,
    streamCurrentChunkEstimatedDurationMsRef,
    ttsLoading,
    autoMinSpeechMs: AUTO_MIN_SPEECH_MS,
    watchdogIntervalMs: AUTO_RECORDING_WATCHDOG_INTERVAL_MS,
    watchdogStaleMs: AUTO_RECORDING_WATCHDOG_STALE_MS,
    watchdogLogThrottleMs: AUTO_RECORDING_WATCHDOG_LOG_THROTTLE_MS,
    watchdogStatusTimeoutMs: AUTO_RECORDING_WATCHDOG_STATUS_TIMEOUT_MS,
    watchdogInFlightForceReleaseMs: AUTO_RECORDING_WATCHDOG_INFLIGHT_FORCE_RELEASE_MS,
    noCallbackStatusReadMs: AUTO_RECORDING_NO_CALLBACK_STATUS_READ_MS,
    noCallbackForceFinalizeMs: AUTO_RECORDING_NO_CALLBACK_FORCE_FINALIZE_MS,
    noCallbackFinalizeCooldownMs: AUTO_RECORDING_NO_CALLBACK_FINALIZE_COOLDOWN_MS,
    watchdogRestartStaleMs: AUTO_RECORDING_WATCHDOG_RESTART_STALE_MS,
    watchdogRestartCooldownMs: AUTO_RECORDING_WATCHDOG_RESTART_COOLDOWN_MS,
    watchdogKickGuardMs: AUTO_RECORDING_WATCHDOG_KICK_GUARD_MS,
    watchdogTtsInterruptStaleMs: AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_STALE_MS,
    watchdogTtsInterruptCooldownMs: AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_COOLDOWN_MS,
    watchdogTtsInterruptStreamMinMs: AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_STREAM_MIN_MS,
    watchdogTtsInterruptStreamMarginMs: AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_STREAM_MARGIN_MS,
    watchdogTtsInterruptStreamMaxMs: AUTO_RECORDING_WATCHDOG_TTS_INTERRUPT_STREAM_MAX_MS,
    watchdogRestartAfterTtsInterruptGapMs: AUTO_RECORDING_WATCHDOG_RESTART_AFTER_TTS_INTERRUPT_GAP_MS,
    clearAutoRecordingWatchdogTimer,
    readAutoRecordingStatus,
    stopTtsPlayback,
    elapsedSinceMs,
    logAuto,
  });
  const { createAutoRecordingStatusHandler } = useAutoRecordingStatusHandler({
    appStateRef,
    appStateChangedAtRef,
    appStateLastNonActiveAtRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoFinalizeLockRef,
    autoRecordingWatchdogLogAtRef,
    autoStatusNotRecordingSuppressLogAtRef,
    autoLastStatusHandledAtRef,
    autoWaveStatusLastAtRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastMeteringRef,
    autoShadowStatusLastDurationMsRef,
    autoStatusReadOwnerRef,
    autoStatusReadStartedAtRef,
    autoWaitReasonRef,
    autoInputDetectAtRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaveformLastSampleAtRef,
    autoClipStartedAtRef,
    autoSpeechStartedAtRef,
    autoAboveSinceRef,
    autoAboveGapSinceRef,
    autoBelowSinceRef,
    autoSilenceDeadlineAtRef,
    autoBargeInStoppingRef,
    autoBargeInDetectedForClipRef,
    autoBargeInFastStopAtRef,
    autoBargeInFastProbeAboveSinceRef,
    autoSpeechStartedDuringTtsRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    autoPlaybackBargeGraceUntilRef,
    autoBargeInProbeLogAtRef,
    autoPendingUserMessageIdRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    autoBargeInEnabledRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    faceTrackingFaceDetectedRef,
    faceTrackingLookingRef,
    faceTrackingNotLookingSinceRef,
    faceTrackingSuppressedRef,
    faceTrackingSuppressLogAtRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    ttsLoading,
    watchdogLogThrottleMs: AUTO_RECORDING_WATCHDOG_LOG_THROTTLE_MS,
    statusNotRecordingAppTransitionGraceMs: AUTO_STATUS_NOT_RECORDING_APP_TRANSITION_GRACE_MS,
    statusNotRecordingSuppressLogThrottleMs: AUTO_STATUS_NOT_RECORDING_SUPPRESS_LOG_THROTTLE_MS,
    autoInputRoutePollMs: AUTO_INPUT_ROUTE_POLL_MS,
    autoStartThresholdDb: AUTO_START_THRESHOLD_DB,
    autoStartHoldMs: AUTO_START_HOLD_MS,
    autoStopThresholdDb: AUTO_STOP_THRESHOLD_DB,
    autoStopSilenceMs: AUTO_STOP_SILENCE_MS,
    autoMinSpeechMs: AUTO_MIN_SPEECH_MS,
    autoMaxSpeechMs: AUTO_MAX_SPEECH_MS,
    autoIdleRolloverMs: AUTO_IDLE_ROLLOVER_MS,
    autoBargeInThresholdOffsetDb: AUTO_BARGE_IN_THRESHOLD_OFFSET_DB,
    autoBargeInAirpodsThresholdOffsetDb: AUTO_BARGE_IN_AIRPODS_THRESHOLD_OFFSET_DB,
    autoBargeInHoldMs: AUTO_BARGE_IN_HOLD_MS,
    autoBargeInAirpodsHoldMs: AUTO_BARGE_IN_AIRPODS_HOLD_MS,
    autoBargeInHoldGapToleranceMs: AUTO_BARGE_IN_HOLD_GAP_TOLERANCE_MS,
    autoBargeInFastStopAirpodsThresholdDb: AUTO_BARGE_IN_FAST_STOP_AIRPODS_THRESHOLD_DB,
    autoBargeInFastStopStartOffsetDb: AUTO_BARGE_IN_FAST_STOP_START_OFFSET_DB,
    autoBargeInFastStopHoldMs: AUTO_BARGE_IN_FAST_STOP_HOLD_MS,
    autoBargeInFastStopCooldownMs: AUTO_BARGE_IN_FAST_STOP_COOLDOWN_MS,
    autoBargeInProbeLogThrottleMs: AUTO_BARGE_IN_PROBE_LOG_THROTTLE_MS,
    autoPostTtsHumanHoldMs: AUTO_POST_TTS_HUMAN_HOLD_MS,
    faceTrackingSttSuppressLogThrottleMs: FACE_TRACKING_STT_SUPPRESS_LOG_THROTTLE_MS,
    faceTrackingRecordingStopHoldMs: FACE_TRACKING_RECORDING_STOP_HOLD_MS,
    setAutoRecordingState,
    setAutoLastEvent,
    maybeLogWaveformStatusTick,
    trackWaveformFlatline,
    clearAutoPendingUserTimeoutTimer,
    resolveAutoPendingUserMessage,
    faceTrackingAllowsStt,
    detectAutoAirPodsInput,
    elapsedSinceMs,
    logAuto,
  });
  const {
    createRequestBargeInStop,
    createResetSpeechWindowWithoutFinalize,
    createRestartCaptureForWatchdog,
    startAutoRecordingWithRetry,
    scheduleAutoCaptureCycleRetry,
    resetAutoSpeechTracking,
  } = useAutoCaptureCycleRecovery({
    autoRecordingEnabledRef,
    autoBargeInEnabledRef,
    autoRecordingRef,
    autoFinalizeLockRef,
    autoRestartTimerRef,
    autoClipStartedAtRef,
    autoSpeechStartedAtRef,
    autoAboveSinceRef,
    autoAboveGapSinceRef,
    autoBelowSinceRef,
    autoSilenceDeadlineAtRef,
    autoBargeInStoppingRef,
    autoBargeInDetectedForClipRef,
    autoBargeInFastStopAtRef,
    autoBargeInFastProbeAboveSinceRef,
    autoSpeechStartedDuringTtsRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    autoPendingUserMessageIdRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    ttsPlaybackMessageIdRef,
    ttsLoading,
    pendingUserProbeTimeoutMs: AUTO_PENDING_USER_PROBE_TIMEOUT_MS,
    isRecordingNotAllowedError,
    isRecorderNotPreparedError,
    ensureMicReady,
    setAutoLastEvent,
    elapsedSinceMs,
    resolveAutoPendingUserMessage,
    logAuto,
  });
  const { runAutoCaptureCycleCore } = useAutoCaptureCycleCore({
    recordingTuning,
    autoInputDetectAtRef,
    autoProgressIntervalMsRef,
    autoProgressIntervalModeRef,
    autoRecordingRef,
    autoClipStartedAtRef,
    autoFinalizeResolvedAtRef,
    autoBargeInStoppingRef,
    autoBargeInDetectedForClipRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    ttsPlayingRef,
    replyLoadingRef,
    setAutoRecordingState,
    setAutoLastEvent,
    setAutoMeteringDb,
    startAutoPendingUserMessage,
    stopTtsPlayback,
    ensureMicReady,
    detectAutoAirPodsInput,
    releaseRecording,
    clearAutoRecordingWatchdogTimer,
    isBackgroundAudioSessionError,
    isRecordingNotAllowedError,
    createRequestBargeInStop,
    createResetSpeechWindowWithoutFinalize,
    createRestartCaptureForWatchdog,
    createAutoRecordingStatusHandler,
    startAutoRecordingWithRetry,
    startAutoRecordingWatchdog,
    scheduleAutoCaptureCycleRetry,
    resetAutoSpeechTracking,
    logAuto,
    reportError,
  });
  const {
    transcribeRecording: transcribeRecordingImpl,
    enqueueAutoTranscribe,
    cleanupRecordingTranscription,
  } = useRecordingTranscriptionController({
    sttProvider,
    runnerUrl,
    runnerToken,
    recordingUri,
    nearUnlimitedTimeoutMs: NEAR_UNLIMITED_TIMEOUT_MS,
    sttLoadingRef,
    autoRecordingEnabledRef,
    autoReplyAfterSttRef,
    autoSpeakAfterReplyRef,
    replyLoadingRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    autoPendingUserMessageVisibleAtRef,
    setSttLoading,
    setTranscript,
    setErrorMessage: setError,
    getBaseUrl: baseUrl,
    startAutoPendingUserMessage,
    resolveAutoPendingUserMessage,
    waitForReplyIdle,
    sendReplyTranscript,
    sendReplyRequest,
    faceTrackingAllowsStt,
    elapsedSinceMs,
    logAuto,
    reportError,
  });
  transcribeRecordingFnRef.current = transcribeRecordingImpl;
  const {
    finalizeAutoCapture,
    startAutoCaptureCycle,
    startAutoRecordingMode,
    stopAutoRecordingMode,
  } = useAutoRecordingEngine({
    appStateRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoFinalizeLockRef,
    autoRestartTimerRef,
    autoAppStateNonActiveTimerRef,
    autoWaitReasonRef,
    autoWaitReasonLogAtRef,
    autoClipStartedAtRef,
    autoSpeechStartedAtRef,
    autoAboveSinceRef,
    autoAboveGapSinceRef,
    autoBelowSinceRef,
    autoInputDetectAtRef,
    autoProgressIntervalMsRef,
    autoProgressIntervalModeRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaveformSkipLogAtRef,
    autoBargeInProbeLogAtRef,
    autoBargeInFastStopAtRef,
    autoBargeInFastProbeAboveSinceRef,
    autoFinalizeResolvedAtRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    autoPlaybackBargeGraceUntilRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    autoSilenceDeadlineAtRef,
    autoNoCallbackFinalizeAtRef,
    autoLastStatusHandledAtRef,
    autoBargeInStoppingRef,
    autoBargeInDetectedForClipRef,
    autoSpeechStartedDuringTtsRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    faceTrackingSuppressLogAtRef,
    faceTrackingSuppressedRef,
    faceTrackingNotLookingSinceRef,
    autoPendingUserMessageIdRef,
    autoPendingUserAnimFrameRef,
    autoPendingUserMessageStartedAtRef,
    autoPendingUserMessageVisibleAtRef,
    autoPendingUserVisibleLoggedMessageIdRef,
    autoCaptureCycleSeqRef,
    audioLabRecordingRef,
    audioLabSoundRef,
    faceTrackingFaceDetectedRef,
    faceTrackingLookingRef,
    autoSpeakerPriorityEnabledRef,
    autoBargeInEnabledRef,
    replyLoadingRef,
    ttsPlayingRef,
    youtubePlayerIsPlayingRef,
    autoSegments,
    autoRecordingState,
    autoLastEvent,
    autoSpeakerPriorityEnabled,
    autoBargeInEnabled,
    autoReplyAfterStt,
    autoSpeakAfterReply,
    ttsLoading,
    audioLabRunning,
    manualRecordingActive: Boolean(manualRecording),
    autoWaitReasonLogThrottleMs: AUTO_WAIT_REASON_LOG_THROTTLE_MS,
    autoRestartDelayMs: 400,
    autoCooldownMs: AUTO_COOLDOWN_MS,
    autoMinSpeechMs: AUTO_MIN_SPEECH_MS,
    setErrorMessage: setError,
    setAutoRecordingEnabled,
    setAutoRecordingState,
    setAutoLastEvent,
    setAutoInputName,
    setAutoAirPodsInput,
    setAutoMeteringDb,
    setAutoSegments,
    clearAutoPendingUserTimeoutTimer,
    clearAutoPendingUserAnimationTimer,
    clearAutoRecordingWatchdogTimer,
    removeConversationMessageById,
    resolveAutoPendingUserMessage,
    faceTrackingAllowsStt,
    transcribeRecording,
    enqueueAutoTranscribe,
    setRecordedClip,
    runAutoCaptureCycleCore: startAutoCaptureCycleCore,
    resetAutoWaveform,
    playUiSfx,
    releaseRecording,
    setAudioModeForPlayback,
    elapsedSinceMs,
    logAuto,
    reportError,
  });
  const {
    directNativeSttEnabled,
    directNativeSttActive,
    directNativeSttInterimText,
    startDirectNativeStt,
    stopDirectNativeStt,
    cleanupDirectNativeStt,
  } = useDirectNativeSttController({
    sttProvider,
    sttProviderRef,
    manualRecordingActive: Boolean(manualRecording),
    audioLabRunning,
    audioLabRecordingActive,
    audioLabPlaybackActive,
    faceTrackingEnabled,
    faceTrackingLooking,
    autoRecordingEnabledRef,
    appStateRef,
    autoReplyAfterSttRef,
    autoSpeakAfterReplyRef,
    autoBargeInEnabledRef,
    replyLoadingRef,
    ttsPlayingRef,
    streamSocketRef,
    ttsPlaybackMessageIdRef,
    sttLoadingRef,
    ttsLoading,
    runnerUrl,
    runnerToken,
    ensureMicReady,
    faceTrackingAllowsStt,
    stopAutoRecordingMode,
    stopTtsPlayback,
    waitForReplyIdle,
    sendReplyTranscript,
    sendReplyRequest,
    setTranscript,
    setErrorMessage: setError,
    setSttLoading,
    setAudioModeForPlayback,
    playUiSfx,
    logAuto,
    reportError,
  });

  const {
    playAssistantEventSfx,
  } = useAssistantEventSfxController({
    playUiSfx,
  });
  function buildConversationMessage(
    role: "user" | "assistant",
    content: string,
    extra: Omit<Partial<ConversationMessage>, "id" | "role" | "content"> = {}
  ): ConversationMessage {
    return {
      id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      content,
      at: new Date().toISOString(),
      ...extra,
    };
  }

  const {
    createHistoryEntry,
    appendAssistantEventMessage,
  } = useConversationMessageBuilders({
    conversationMessagesRef,
    autoPendingUserMessageIdRef,
    resolveAutoPendingUserMessage,
    buildConversationMessage,
    playAssistantEventSfx,
    setConversationMessagesWithLimit,
  });
  const appendAssistantEventMessageForApprovalRef = useRef((
    line: string,
    _request?: ApprovalRequest
  ) => {
    appendAssistantEventMessage(line);
  });

  function startNewSession(params?: { directory?: string }) {
    const directory = parseLlmDirectory(params?.directory || normalizedLlmDirectoryForRequest());
    void stopTtsPlayback({ interruptStream: true }).catch(() => {});
    resetAutoPendingUserState();
    const ws = streamSocketRef.current;
    if (ws) {
      ws.close();
      streamSocketRef.current = null;
    }
    clearStreamAudioQueue();
    streamAudioWaveformBarsRef.current = [];
    setStreamWaveformPreview([]);
    setReplyLoadingWithRef(false);
    finishLlmRequest("idle", "conversation reset");
    setConversationMessagesWithLimit([], { resetVisibleCount: true });
    setHistory([]);
    setReply("");
    setAcpContextUsedPct(null);
    const nextSessionId = createLlmSessionId();
    applySessionIdentityChange(nextSessionId, {
      source: "reset_conversation_state",
      reason: "conversation_reset_new_session",
      updateSelected: true,
      forceStateSync: true,
      directory,
    });
    setSessionMarkerColorForSession(nextSessionId, "gray");
    setLlmSessionRestoreError("");
    setReplyDebug("new_session");
    setTtsDebugStats(EMPTY_TTS_DEBUG_STATS);
    setStreamReplyYouTubeVideoIdsWithRef([]);
    youtubePlaybackQueueRef.current = null;
    youtubePlaybackPositionSecRef.current = 0;
    lastAutoOpenedYouTubeMessageIdRef.current = "";
    setYoutubeInlineLayout(null);
    setYoutubePlayerVideoId("");
    setYoutubePlayerMessageId("");
    clearYouTubePauseConfirmTimer();
    clearYouTubeControlToDragTimer();
    setYouTubeFloatingInteractionModeWithRef("drag");
    setYouTubePlayingState(false);
    setYoutubeVideoMetaById({});
  }

  const {
    canSend,
    hasComposerText,
    isDirectNativeSttProvider,
    composerWaveformVisible,
    composerDirectSttVisible,
    composerTextInputVisible,
    showComposerFullscreenToggle,
    directNativeSttPreviewText,
    selectedModelLabel,
    youtubeEmbedHtml,
    latestAssistantYouTubeMessage,
    latestAssistantYouTubeVideoIds,
    latestAssistantYouTubeVideos,
    streamReplyYouTubeVideos,
    chatWideYouTubeQueue,
    ttsSegmentProgress,
    chatContextUsedPct,
    chatContextRingProgress,
    chatContextRingTrackColor,
    chatContextRingProgressColor,
    isRobotAnimating,
    llmVisual,
    llmPixelIconKey,
    chatThinkingCurrentMessage,
    chatThinkingLogLines,
    showChatThinkingPanel,
    autoSpectrumBars,
    autoSpeechDetected,
    autoWaveformDebugText,
    audioLabElapsedMs,
  } = useChatDerivedState({
    codexWsUrl,
    transcript,
    replyLoading,
    llmSessionRestoreLoading,
    sttProvider,
    directNativeSttEnabled,
    autoRecordingEnabled,
    manualRecording: !!manualRecording,
    directNativeSttInterimText,
    composerInputFocused,
    modelOptions: MODEL_OPTIONS,
    modelRef,
    reasoningEffort,
    normalizedLlmDirectoryForRequest,
    selectedLlmSessionId,
    youtubePlayerVideoId,
    youtubePlayerSession,
    conversationMessages,
    youtubeVideoMetaById,
    streamReplyYouTubeVideoIds,
    streamSegments,
    acpContextUsedPct,
    ttsLoading,
    ttsPlaying,
    ttsQueueProcessing,
    llmUiStatus,
    llmUiStatusDetail,
    llmUiStatusDetailBase: llmUiStatusDetailBaseRef.current,
    streamLlmProgress,
    replyDebug,
    chatThinkingLogExpanded,
    autoWaveform,
    autoWaveformSpeechMask,
    autoWaveformDataPipelineEnabled: AUTO_WAVEFORM_DATA_PIPELINE_ENABLED,
    autoWaveformDebugOverlayEnabled: AUTO_WAVEFORM_DEBUG_OVERLAY_ENABLED,
    autoSpectrumBarsCount: AUTO_SPECTRUM_BARS,
    autoSpectrumEmptyBars: AUTO_SPECTRUM_EMPTY_BARS,
    autoMeteringDb,
    autoWaveDebugNowMs,
    autoWaveStatusLastAt: autoWaveStatusLastAtRef.current,
    autoShadowStatusLastAt: autoShadowStatusLastAtRef.current,
    autoShadowStatusLastMetering: autoShadowStatusLastMeteringRef.current,
    autoWaveformLastSampleAt: autoWaveformLastSampleAtRef.current,
    autoWaveformUiAt: autoWaveformUiAtRef.current,
    streamAudioQueueSize,
    audioLabRunning,
    audioLabNowMs,
    audioLabStartedAt: audioLabStartedAtRef.current,
  });
  const selectedSessionExecutionFact = useMemo(() => {
    const selectedSessionId = parseOptionalSessionId(selectedLlmSessionId || llmConversationSessionIdRef.current);
    if (replyLoading) {
      const detail = String(llmUiStatusDetailBaseRef.current || llmUiStatusDetail || "").trim();
      return {
        sessionId: selectedSessionId,
        reasonLabel: liveLlmStatusPrefix(llmUiStatus),
        reasonDetail: detail,
        startedAtMs: llmRequestStartedAtRef.current > 0 ? llmRequestStartedAtRef.current : null,
        lastUpdatedAtMs: Date.now(),
      };
    }
    return null;
  }, [
    llmRequestStartedAtRef,
    llmUiStatus,
    llmUiStatusDetail,
    llmUiStatusDetailBaseRef,
    replyLoading,
    selectedLlmSessionId,
  ]);
  const thinkingPanelDiagKeyRef = useRef("");
  useEffect(() => {
    const factSessionId = parseOptionalSessionId(selectedSessionExecutionFact?.sessionId);
    const reasonLabel = String(selectedSessionExecutionFact?.reasonLabel || "");
    const reasonDetail = String(selectedSessionExecutionFact?.reasonDetail || "");
    const llmActiveStatus = isLlmActiveStatus(llmUiStatus);
    const savedFactActive = !!selectedSessionExecutionFact && !replyLoading;
    const shouldShowThinkingPanel = showChatThinkingPanel || !!selectedSessionExecutionFact;
    const thinkingPanelDisplaySource = (
      replyLoading
        ? "reply_loading"
        : llmActiveStatus
          ? "llm_active_status"
          : savedFactActive
            ? "session_execution_fact"
            : chatThinkingLogExpanded && chatThinkingLogLines.length > 0
              ? "expanded_thinking_log"
              : "hidden"
    );
    const nextKey = [
      shouldShowThinkingPanel ? "show" : "hide",
      thinkingPanelDisplaySource,
      showChatThinkingPanel ? "derived" : "no_derived",
      replyLoading ? "loading" : "idle",
      llmUiStatus,
      reasonLabel,
      reasonDetail,
      factSessionId,
      chatThinkingLogExpanded ? "expanded" : "collapsed",
    ].join("|");
    if (thinkingPanelDiagKeyRef.current === nextKey) return;
    thinkingPanelDiagKeyRef.current = nextKey;
    logSessionDiag("chat_thinking_panel_state", {
      shouldShowThinkingPanel,
      displaySource: thinkingPanelDisplaySource,
      showChatThinkingPanel,
      replyLoading,
      replyLoadingRef: replyLoadingRef.current,
      llmUiStatus,
      llmUiStatusRef: llmUiStatusRef.current,
      llmActiveStatus,
      llmUiStatusDetail: String(llmUiStatusDetail || ""),
      llmUiStatusDetailBase: String(llmUiStatusDetailBaseRef.current || ""),
      llmRequestStartedAtMs: llmRequestStartedAtRef.current || null,
      sinceLlmRequestStartedMs: elapsedSinceMs(llmRequestStartedAtRef.current),
      selectedSessionExecutionFact: !!selectedSessionExecutionFact,
      savedFactActive,
      factSessionId,
      factStartedAtMs: selectedSessionExecutionFact?.startedAtMs ?? null,
      sinceFactStartedMs: elapsedSinceMs(Number(selectedSessionExecutionFact?.startedAtMs || 0)),
      factLastUpdatedAtMs: selectedSessionExecutionFact?.lastUpdatedAtMs ?? null,
      sinceFactLastUpdatedMs: elapsedSinceMs(Number(selectedSessionExecutionFact?.lastUpdatedAtMs || 0)),
      reasonLabel,
      reasonDetail,
      chatThinkingLogExpanded,
      chatThinkingLogLines: chatThinkingLogLines.length,
      activeSessionId: parseOptionalSessionId(llmConversationSessionIdRef.current),
      selectedSessionId: parseOptionalSessionId(selectedLlmSessionIdRef.current || selectedLlmSessionId),
    }, {
      throttleMs: 0,
    });
  }, [
    chatThinkingLogExpanded,
    llmUiStatus,
    llmUiStatusDetail,
    replyLoading,
    selectedLlmSessionId,
    selectedSessionExecutionFact,
    chatThinkingLogLines.length,
    showChatThinkingPanel,
  ]);
  const selectedSessionWaitingApproval = useMemo(() => {
    const selectedSessionId = parseOptionalSessionId(selectedLlmSessionId || llmConversationSessionIdRef.current);
    if (!selectedSessionId) return false;
    const resumeStatus = sessionRuntimeStatusByIdRef.current[selectedSessionId];
    if (resumeStatus?.waitingApproval) return true;
    const reasonLabel = String(selectedSessionExecutionFact?.reasonLabel || "");
    if (reasonLabel.includes("承認待ち")) return true;
    const reasonDetail = String(selectedSessionExecutionFact?.reasonDetail || "").toLowerCase();
    return (
      reasonDetail.includes("waitingonapproval") ||
      reasonDetail.includes("waiting_approval")
    );
  }, [
    selectedLlmSessionId,
    selectedSessionExecutionFact,
  ]);
  useEffect(() => {
    if (selectedSessionWaitingApproval) return;
    clearWaitingApprovalResumeAttachTimer();
    waitingApprovalResumePendingSessionIdRef.current = "";
    if (waitingApprovalResumeLoading) {
      setWaitingApprovalResumeLoading(false);
    }
    if (waitingApprovalResumeStatusText) {
      setWaitingApprovalResumeStatusText("");
    }
  }, [
    selectedSessionWaitingApproval,
    waitingApprovalResumeLoading,
    waitingApprovalResumeStatusText,
  ]);
  useEffect(() => {
    if (!composerFullscreenOpen) return;
    const timer = setTimeout(() => {
      chatComposerFullscreenInputRef.current?.focus();
    }, 60);
    return () => clearTimeout(timer);
  }, [composerFullscreenOpen]);
  useEffect(() => {
    if (composerTextInputVisible) return;
    if (composerFullscreenOpen) {
      setComposerFullscreenOpen(false);
    }
    if (composerInputFocused) {
      setComposerInputFocused(false);
    }
  }, [composerFullscreenOpen, composerInputFocused, composerTextInputVisible]);
  function openComposerFullscreen() {
    setComposerInputFocused(false);
    setComposerFullscreenOpen(true);
  }
  function closeComposerFullscreen() {
    setComposerFullscreenOpen(false);
    if (!composerTextInputVisible) return;
    setTimeout(() => {
      chatComposerInputRef.current?.focus();
    }, 60);
  }
  const {
    clearYouTubePauseConfirmTimer,
    clearYouTubeControlToDragTimer,
    setYouTubeFloatingInteractionModeWithRef,
    scheduleYouTubeControlToDrag,
    setYouTubePlayingState,
    fetchYouTubeVideoMetadata,
    openYouTubeVideo,
    closeYouTubePlayer,
    getActiveYouTubeQueuePositionLabel,
    handleYouTubeWebViewMessage,
    setStreamReplyYouTubeVideoIdsWithRef,
  } = useYouTubePlayerController({
    runnerUrl,
    runnerToken,
    baseUrl,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoAirPodsInputRef,
    autoBargeInEnabledRef,
    youtubeWebViewRef,
    youtubePauseConfirmTimerRef,
    youtubeControlToDragTimerRef,
    youtubeFloatingInteractionModeRef,
    youtubePlayerIsPlayingRef,
    youtubePlaybackQueueRef,
    youtubePlaybackPositionSecRef,
    youtubeVideoMetaByIdRef,
    youtubePlayerVideoIdRef,
    youtubePlayerMessageIdRef,
    youtubePlayerSessionRef,
    streamReplyYouTubeVideoIdsRef,
    setYoutubeVideoMetaById,
    setYoutubeFloatingInteractionMode,
    setYoutubePlayerIsPlaying,
    setYoutubeInlineLayout,
    setYoutubeFloatingPosition,
    setYoutubePlayerVideoId,
    setYoutubePlayerMessageId,
    setYoutubePlayerSession,
    setStreamReplyYouTubeVideoIds,
    chatWideYouTubeQueue,
    youtubePauseConfirmMs: YOUTUBE_PAUSE_CONFIRM_MS,
    youtubeControlIdleToDragMs: YOUTUBE_CONTROL_IDLE_TO_DRAG_MS,
    playUiSfx,
    stopTtsPlayback,
    logAuto,
    reportError,
    finalizeAutoCapture,
  });
  const isTtsPlaybackActive = (
    ttsPlaying ||
    ttsLoading ||
    ttsQueueProcessing
  );
  const isStreamWaveformPlaybackActive = isTtsPlaybackActive && ttsPlaybackMessageId === "__stream__";
  const {
    conversationInlineAnchorMessageId,
    showFloatingYouTubePlayer,
    showYouTubeOverlayPlayer,
    youtubeFloatingAnimatedPosition,
    markYouTubeFloatingControlInteraction,
    youtubeFloatingPanResponder,
    setYoutubeInlineAnchor,
    updateYouTubeInlineLayoutFromAnchor,
  } = useYouTubePlayerDisplay({
    activeScreen,
    conversationMessages,
    replyLoading,
    streamReplyYouTubeVideoIds,
    youtubeEmbedHtml,
    youtubePlayerVideoId,
    youtubePlayerMessageId,
    chatScrollOffsetY,
    chatViewportHeight,
    chatScreenLayout,
    youtubeInlineLayout,
    youtubeFloatingPosition,
    setYoutubeInlineLayout,
    setYoutubeFloatingPosition,
    clearYouTubeControlToDragTimer,
    scheduleYouTubeControlToDrag,
    setYouTubeFloatingInteractionModeWithRef,
    youtubeFloatingInteractionMode,
    youtubeFloatingInteractionModeRef,
    chatContentRef,
    dragActivatePx: YOUTUBE_FLOATING_DRAG_ACTIVATE_PX,
    floatingPlayerMargin: YOUTUBE_FLOATING_PLAYER_MARGIN,
  });
  const activeYouTubeQueuePositionLabel = useMemo(
    () => getActiveYouTubeQueuePositionLabel(),
    [
      chatWideYouTubeQueue,
      replyLoading,
      streamReplyYouTubeVideoIds,
      youtubePlayerMessageId,
      youtubePlayerSession,
      youtubePlayerVideoId,
    ]
  );
  const handleChatScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextYRaw = Number(event?.nativeEvent?.contentOffset?.y || 0);
    const nextY = Number.isFinite(nextYRaw) ? nextYRaw : 0;
    const now = Date.now();
    const contentHeight = Number(event?.nativeEvent?.contentSize?.height || 0);
    const viewportHeight = Number(event?.nativeEvent?.layoutMeasurement?.height || 0);
    const distanceToBottom = Math.max(0, contentHeight - (nextY + viewportHeight));
    chatNearBottomRef.current = distanceToBottom <= CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD;
    chatDistanceToBottomRef.current = distanceToBottom;
    chatContentHeightRef.current = Number.isFinite(contentHeight) ? contentHeight : 0;
    if (chatNearBottomRef.current) {
      hideChatBottomToast();
    }
    chatScrollOffsetYRef.current = nextY;
    const shouldCommitScrollState = (
      Math.abs(nextY - chatScrollStateLastYRef.current) >= CHAT_SCROLL_STATE_UPDATE_MIN_DELTA_PX ||
      (now - chatScrollStateLastAtRef.current) >= CHAT_SCROLL_STATE_UPDATE_THROTTLE_MS ||
      nextY <= 0 ||
      chatNearBottomRef.current
    );
    if (shouldCommitScrollState) {
      chatScrollStateLastAtRef.current = now;
      chatScrollStateLastYRef.current = nextY;
      setChatScrollOffsetY(nextY);
    }
    logChatScrollDiag("on_scroll", {
      offsetY: nextY,
      distanceToBottom,
      nearBottom: chatNearBottomRef.current,
      contentHeight,
      viewportHeight,
      replyLoading: replyLoadingRef.current,
      touchActive: chatTouchActiveRef.current,
      thresholdPx: CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD,
    }, {
      throttleMs: CHAT_SCROLL_DIAG_SCROLL_THROTTLE_MS,
      throttleKey: "chat_scroll_on_scroll",
    });
  }, [hideChatBottomToast]);

  function getLlmConversationSessionId() {
    return String(llmConversationSessionIdRef.current || "").trim();
  }

  function applySessionIdentityChange(
    nextSessionIdRaw: unknown,
    options?: {
      source?: string;
      reason?: string;
      updateSelected?: boolean;
      forceStateSync?: boolean;
      directory?: unknown;
      extra?: Record<string, unknown>;
    }
  ) {
    const nextSessionId = String(nextSessionIdRaw || "").trim();
    const prevCurrentSessionId = String(llmConversationSessionIdRef.current || "").trim();
    const prevSelectedSessionId = String(selectedLlmSessionIdRef.current || selectedLlmSessionId || "").trim();
    const source = String(options?.source || "unknown").trim() || "unknown";
    const reason = String(options?.reason || "").trim();
    const directory = parseLlmDirectory(options?.directory || normalizedLlmDirectoryForRequest());
    const updateSelected = options?.updateSelected !== false;
    const forceStateSync = options?.forceStateSync === true;
    const currentChanged = prevCurrentSessionId !== nextSessionId;
    const selectedChanged = updateSelected && prevSelectedSessionId !== nextSessionId;
    if (!currentChanged && !selectedChanged && !forceStateSync) {
      return false;
    }
    llmConversationSessionIdRef.current = nextSessionId;
    if (updateSelected) {
      selectedLlmSessionIdRef.current = nextSessionId;
      setSelectedLlmSessionId((prev) => (forceStateSync || prev !== nextSessionId ? nextSessionId : prev));
    }
    logSessionDiag("session_id_updated", {
      source,
      reason: reason || undefined,
      directory,
      updateSelected,
      forceStateSync,
      prevCurrentSessionId,
      prevSelectedSessionId,
      nextSessionId,
      ...options?.extra,
    }, {
      throttleMs: 0,
      throttleKey: `session_id_updated:${source}:${Date.now()}`,
    });
    return true;
  }

  function rememberKnownCodexThreadId(sessionIdRaw: unknown) {
    const sessionId = String(sessionIdRaw || "").trim();
    if (!sessionId) return;
    knownCodexThreadIdsRef.current.add(sessionId);
  }

  function isKnownCodexThreadId(sessionIdRaw: unknown) {
    const sessionId = String(sessionIdRaw || "").trim();
    if (!sessionId) return false;
    return knownCodexThreadIdsRef.current.has(sessionId);
  }

  function syncLlmConversationSessionId(
    value: unknown,
    options?: { expectedCurrentSessionId?: unknown; syncSelected?: boolean }
  ) {
    const next = String(value || "").trim();
    if (!next) return false;
    const expectedCurrentSessionId = parseOptionalSessionId(options?.expectedCurrentSessionId);
    const selectedSessionId = parseOptionalSessionId(selectedLlmSessionIdRef.current || selectedLlmSessionId || "");
    if (
      expectedCurrentSessionId &&
      selectedSessionId &&
      expectedCurrentSessionId !== selectedSessionId
    ) {
      rememberKnownCodexThreadId(next);
      logSessionDiag("session_id_sync_skipped_expected_mismatch", {
        source: "sync_llm_conversation_session_id",
        expectedCurrentSessionId,
        selectedSessionId,
        nextSessionId: next,
        currentSessionId: String(llmConversationSessionIdRef.current || "").trim(),
        directory: normalizedLlmDirectoryForRequest(),
      }, {
        throttleMs: 0,
      });
      return false;
    }
    carrySessionMarkerColorToSyncedSession(expectedCurrentSessionId || selectedSessionId, next);
    applySessionIdentityChange(next, {
      source: "sync_llm_conversation_session_id",
      reason: "sync_from_codex_thread_resolution",
      updateSelected: options?.syncSelected !== false,
      directory: normalizedLlmDirectoryForRequest(),
      extra: {
        expectedCurrentSessionId: expectedCurrentSessionId || undefined,
      },
    });
    rememberKnownCodexThreadId(next);
    return true;
  }

  function carrySessionMarkerColorToSyncedSession(
    previousSessionIdRaw: unknown,
    nextSessionIdRaw: unknown
  ) {
    const previousSessionId = parseOptionalSessionId(previousSessionIdRaw);
    const nextSessionId = parseOptionalSessionId(nextSessionIdRaw);
    if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) return;
    setSessionMarkerColorsById((prev) => {
      const existingNextMarkerColor = parseDirectoryMarkerColor(prev[nextSessionId]);
      if (existingNextMarkerColor !== "none") return prev;
      const previousMarkerColor = parseDirectoryMarkerColor(prev[previousSessionId]);
      if (previousMarkerColor === "none") return prev;
      return {
        ...prev,
        [nextSessionId]: previousMarkerColor,
      };
    });
  }

  function normalizedLlmDirectoryForRequest() {
    return String(llmDirectory || "").trim() || DEFAULT_LLM_DIRECTORY;
  }

  const selectedRegisteredDirectory = useMemo(() => {
    const currentPath = normalizedLlmDirectoryForRequest();
    return registeredDirectories.find((item) => item.path === currentPath) || null;
  }, [registeredDirectories, llmDirectory]);

  const hasSelectedRegisteredDirectory = useMemo(
    () => !!selectedRegisteredDirectory,
    [selectedRegisteredDirectory]
  );

  const selectedDirectoryDisplayName = useMemo(() => {
    if (!selectedRegisteredDirectory) return "";
    return String(selectedRegisteredDirectory.displayName || "").trim() || selectedRegisteredDirectory.path;
  }, [selectedRegisteredDirectory]);
  const selectedSessionMarkerColor = useMemo(() => {
    const selectedSessionId = parseOptionalSessionId(selectedLlmSessionId || llmConversationSessionIdRef.current);
    if (!selectedSessionId) return "none" as RegisteredDirectoryEntry["markerColor"];
    return parseDirectoryMarkerColor(sessionMarkerColorsById[selectedSessionId]);
  }, [selectedLlmSessionId, sessionMarkerColorsById]);
  const selectedSessionHeaderTitle = useMemo(() => {
    const selectedSessionId = parseOptionalSessionId(selectedLlmSessionId || llmConversationSessionIdRef.current);
    if (!selectedSessionId) return "（ユーザーメッセージなし）";
    const overrideTitle = String(sessionTitleOverridesById[selectedSessionId] || "").trim();
    if (overrideTitle) return overrideTitle;

    const selectedDirectoryId = String(selectedRegisteredDirectory?.id || "").trim();
    const directoryEntries = selectedDirectoryId
      ? (directorySessionsById[selectedDirectoryId]?.entries || [])
      : [];
    const fromDirectoryTree = directoryEntries.find((item) => item.sessionId === selectedSessionId);
    const directoryTreeTitle = String(fromDirectoryTree?.firstUserMessage || "").trim();
    if (directoryTreeTitle) return directoryTreeTitle;

    const allMessages = Array.isArray(conversationMessagesRef.current) ? conversationMessagesRef.current : [];
    for (const message of allMessages) {
      if (String(message?.role || "") !== "user") continue;
      const compact = String(message?.content || "").replace(/\s+/g, " ").trim();
      if (compact) return compact;
    }
    return "（ユーザーメッセージなし）";
  }, [
    sessionTitleOverridesById,
    directorySessionsById,
    selectedRegisteredDirectory,
    selectedLlmSessionId,
    conversationMessages,
  ]);
  const {
    getConversationRuntimeSnapshot,
    finalizeConversationRuntimeAfterRelayLoss,
    upsertConversationRuntimeSnapshot,
  } = useConversationRuntimeStoreController();

  const rememberSessionRuntimeStatus = useCallback((
    sessionIdRaw: unknown,
    status: Omit<SessionRuntimeStatus, "updatedAtMs">
  ) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return;
    sessionRuntimeStatusByIdRef.current[sessionId] = {
      ...status,
      updatedAtMs: Date.now(),
    };
  }, []);

  function selectLlmDirectory(nextDirectoryRaw: unknown) {
    const nextDirectory = parseLlmDirectory(nextDirectoryRaw);
    setLlmDirectory(nextDirectory);
  }

  function upsertRegisteredDirectory(pathRaw: unknown) {
    const path = parseLlmDirectory(pathRaw);
    const existing = registeredDirectories.find((item) => item.path === path);
    let matchedId = "";
    if (existing) {
      matchedId = existing.id;
    } else {
      const next: RegisteredDirectoryEntry = {
        id: createRegisteredDirectoryId(path),
        path,
        displayName: deriveDirectoryDisplayName(path),
        markerColor: "gray",
      };
      matchedId = next.id;
      setRegisteredDirectories((prev) => [...prev, next]);
    }
    if (matchedId) {
      setExpandedDirectoryIds((prev) => (prev.includes(matchedId) ? prev : [...prev, matchedId]));
    }
    selectLlmDirectory(path);
    return matchedId;
  }

  function renameRegisteredDirectory(directoryId: string, nextDisplayNameRaw: unknown) {
    const nextDisplayName = String(nextDisplayNameRaw || "").trim();
    setRegisteredDirectories((prev) => prev.map((item) => {
      if (item.id !== directoryId) return item;
      return {
        ...item,
        displayName: nextDisplayName || deriveDirectoryDisplayName(item.path),
      };
    }));
  }

  function setSelectedSessionTitleOverride(nextTitleRaw: unknown) {
    const sessionId = parseOptionalSessionId(selectedLlmSessionIdRef.current || selectedLlmSessionId);
    if (!sessionId) return;
    setSessionTitleOverrideForSession(sessionId, nextTitleRaw);
  }

  function setSessionTitleOverrideForSession(sessionIdRaw: unknown, nextTitleRaw: unknown) {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return;
    const nextTitle = String(nextTitleRaw || "").replace(/\s+/g, " ").trim();
    setSessionTitleOverridesById((prev) => {
      if (!nextTitle) {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      }
      if (prev[sessionId] === nextTitle) return prev;
      return {
        ...prev,
        [sessionId]: nextTitle,
      };
    });
  }

  function setSelectedSessionMarkerColor(nextMarkerColorRaw: unknown) {
    const sessionId = parseOptionalSessionId(selectedLlmSessionIdRef.current || selectedLlmSessionId);
    if (!sessionId) return;
    setSessionMarkerColorForSession(sessionId, nextMarkerColorRaw);
  }

  function setSessionMarkerColorForSession(sessionIdRaw: unknown, nextMarkerColorRaw: unknown) {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return;
    const nextMarkerColor = parseDirectoryMarkerColor(nextMarkerColorRaw);
    setSessionMarkerColorsById((prev) => {
      if (nextMarkerColor === "none") {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      }
      if (prev[sessionId] === nextMarkerColor) return prev;
      return {
        ...prev,
        [sessionId]: nextMarkerColor,
      };
    });
  }

  function removeRegisteredDirectory(directoryId: string) {
    const target = registeredDirectories.find((item) => item.id === directoryId);
    if (!target) return;
    setRegisteredDirectories((prev) => prev.filter((item) => item.id !== directoryId));
    setExpandedDirectoryIds((prev) => prev.filter((id) => id !== directoryId));
    setDirectorySessionsById((prev) => {
      const next = { ...prev };
      delete next[directoryId];
      return next;
    });
    if (normalizedLlmDirectoryForRequest() === target.path) {
      clearSelectedLlmSession();
      const fallback = registeredDirectories.find((item) => item.id !== directoryId)?.path || DEFAULT_LLM_DIRECTORY;
      selectLlmDirectory(fallback);
    }
  }

  const {
    loadDirectorySessionTree,
    loadMoreDirectorySessionTree,
    toggleDirectoryExpanded,
    prefetchDirectorySessionTreesForDrawerOpen,
  } = useDirectorySessionTreeController({
    directorySessionsById,
    setDirectorySessionsById,
    setExpandedDirectoryIds,
    fetchSessionHistory,
    emptyDirectorySessionTreeState: EMPTY_DIRECTORY_SESSION_TREE_STATE,
    directorySessionPageSize: DIRECTORY_SESSION_PAGE_SIZE,
    directorySessionRunnerSnapshotLimit: DIRECTORY_SESSION_RUNNER_SNAPSHOT_LIMIT,
    directorySessionPrefetchTtlMs: DIRECTORY_SESSION_PREFETCH_TTL_MS,
    directorySessionPrefetchConcurrency: DIRECTORY_SESSION_PREFETCH_CONCURRENCY,
    drawerOpen,
    registeredDirectories,
    normalizedLlmDirectoryForRequest,
  });
  const refreshRegisteredDirectorySessionsForMiniBoard = useCallback(async () => {
    const targets = registeredDirectories.filter((directory) => String(directory.path || "").trim());
    logSessionDiag("mini_board_refresh_registered_directory_sessions_start", {
      directoryCount: targets.length,
    }, { throttleMs: 0 });
    const results = await Promise.allSettled(
      targets.map((directory) => (
        loadDirectorySessionTree(directory.id, directory.path, {
          force: true,
          includeRunnerSnapshots: true,
          runnerSnapshotLimit: DIRECTORY_SESSION_RUNNER_SNAPSHOT_LIMIT,
        })
      ))
    );
    logSessionDiag("mini_board_refresh_registered_directory_sessions_done", {
      directoryCount: targets.length,
      rejectedCount: results.filter((item) => item.status === "rejected").length,
    }, { throttleMs: 0 });
  }, [loadDirectorySessionTree, logSessionDiag, registeredDirectories]);
  const refreshMiniBoardDirectorySessionsForDirectory = useCallback((directoryRaw: unknown, reason: string) => {
    if (activeScreen !== "mini_board") return;
    const directoryPath = parseLlmDirectory(directoryRaw);
    if (!directoryPath) return;
    const target = registeredDirectories.find((directory) => (
      parseLlmDirectory(directory.path) === directoryPath
    ));
    if (!target) {
      logSessionDiag("mini_board_refresh_directory_sessions_skipped_unregistered", {
        reason,
        directory: directoryPath,
      }, { throttleMs: 0 });
      return;
    }
    logSessionDiag("mini_board_refresh_directory_sessions_after_completion", {
      reason,
      directoryId: target.id,
      directory: target.path,
    }, { throttleMs: 0 });
    void loadDirectorySessionTree(target.id, target.path, {
      force: true,
      includeRunnerSnapshots: true,
      runnerSnapshotLimit: DIRECTORY_SESSION_RUNNER_SNAPSHOT_LIMIT,
    });
  }, [
    activeScreen,
    loadDirectorySessionTree,
    logSessionDiag,
    registeredDirectories,
  ]);

  const {
    queueSendReplyAfterSessionRestore,
    clearQueuedSendAfterSessionRestore,
    flushQueuedSendAfterSessionRestore,
  } = useSessionSwitchQueuedSendController({
    llmSessionRestoreInFlightRef,
    llmSessionRestoreLoadingRef,
    llmSessionRestoreRequestSeqRef,
    sessionSwitchQueuedSendRef,
    transcript,
    setTranscript,
    setReplyDebug,
    showChatBottomToast,
    shouldProjectQueuedSendDebug: () => false,
    sendReplyRequest,
  });
  const {
    beginSessionRestore,
    rollbackSessionRestoreOnError,
    finalizeSessionRestore,
  } = useSessionRestoreTransitionController({
    selectedLlmSessionId,
    llmConversationSessionIdRef,
    selectedLlmSessionIdRef,
    llmSessionRestoreInFlightRef,
    llmSessionRestoreLoadingRef,
    llmSessionRestoreRequestSeqRef,
    sessionSwitchQueuedSendRef,
    setSelectedLlmSessionId,
    setLlmSessionRestoreLoadingWithRef,
    setLlmSessionRestoreTargetId,
    setLlmSessionRestoreError,
    setError,
    clearQueuedSendAfterSessionRestore,
    flushQueuedSendAfterSessionRestore,
    logSessionDiag,
  });
  const {
    clearWaitingApprovalResumeAttachTimer,
    finishWaitingApprovalResumeAttempt,
  } = useWaitingApprovalResumeController({
    waitingApprovalResumeAttachTimerRef,
    waitingApprovalResumePendingSessionIdRef,
    waitingApprovalResumeCooldownUntilMsRef,
    waitingApprovalResumeRetryCooldownMs: WAITING_APPROVAL_RESUME_RETRY_COOLDOWN_MS,
    parseOptionalSessionId,
    setWaitingApprovalResumeLoading,
    logSessionDiag,
  });

  async function selectSpecificLlmSession(nextSessionIdRaw: unknown, opts?: SelectSpecificLlmSessionOptions) {
    const nextSessionId = parseOptionalSessionId(nextSessionIdRaw);
    if (!nextSessionId) return false;
    const {
      source,
      directory,
    } = {
      source: String(opts?.source || "unknown"),
      directory: parseLlmDirectory(opts?.directory || normalizedLlmDirectoryForRequest()),
    };
    logSessionDiag("session_restore_select_requested", {
      source,
      directory,
      targetSessionId: nextSessionId,
      currentSessionId: parseOptionalSessionId(llmConversationSessionIdRef.current),
      selectedSessionId: parseOptionalSessionId(selectedLlmSessionIdRef.current || selectedLlmSessionId),
      inFlight: llmSessionRestoreInFlightRef.current,
      loading: llmSessionRestoreLoadingRef.current,
      restoreRequestSeq: llmSessionRestoreRequestSeqRef.current,
    }, {
      throttleMs: 0,
    });
    const restoreBegin = beginSessionRestore(nextSessionId, {
      source,
      directory,
    });
    if (!restoreBegin) return false;
    const {
      restoreRequestSeq,
      prevSessionId,
      prevSelectedSessionId,
      prevEffectiveSessionId,
      isLatestRestoreRequest,
    } = restoreBegin;
    let restoreSucceeded = false;
    let switchedSessionId = "";
    const restoreStartedAt = Date.now();
    const perf = createSessionRestorePerfContext();
    logSessionRestoreStart({
      logSessionDiag,
      restoreRequestSeq,
      source: String(opts?.source || "unknown"),
      directory,
      fromSessionId: prevEffectiveSessionId || undefined,
      targetSessionId: nextSessionId,
      restoreStartedAt,
      perf,
    });
    setReplyDebug((prev) => (
      prev ? `${prev} | session_switch_begin seq=${restoreRequestSeq} session=${nextSessionId}` : `session_switch_begin seq=${restoreRequestSeq} session=${nextSessionId}`
    ));
    try {
      await quiesceForSessionSwitch("select_specific_session");
      if (!isLatestRestoreRequest()) return false;
      markSessionRestoreThreadReadStarted(perf);
      const restored = await fetchRunnerSessionMessages(nextSessionId, directory);
      logSessionRestoreThreadReadDone({
        logSessionDiag,
        perf,
        restoreStartedAt,
        targetSessionId: nextSessionId,
      });
      if (!isLatestRestoreRequest()) return false;
      const {
        restoredMessages,
        nextConversation,
        nextHistory,
        effectiveContextUsedPct,
        nextModelRef,
        nextReasoningEffort,
        modelChanged,
        thinkChanged,
        sessionSwitchToastText,
      } = buildRestoredSessionState({
        restored,
        buildConversationMessage,
        modelOptions: MODEL_OPTIONS,
        modelRef,
        reasoningEffort,
        prevEffectiveSessionId,
        nextSessionId,
      });
      const localConversationBeforeRestore = conversationMessagesRef.current;
      const shouldPreserveLocalCompactMessages = parseOptionalSessionId(prevEffectiveSessionId) === nextSessionId;
      const nextConversationForApply = shouldPreserveLocalCompactMessages
        ? mergeLocalCompactSlashMessages(nextConversation, localConversationBeforeRestore)
        : nextConversation;
      const nextConversationForRuntime = projectRestoredRuntimeStatusToConversation({
        conversation: nextConversationForApply,
        restored,
        fallbackMessageId: `active-${nextSessionId}-restored-live-assistant`,
        buildConversationMessage,
      });
      if (nextConversationForApply.length !== nextConversation.length) {
        logSessionDiag("session_restore_preserved_local_compact_messages", {
          source,
          targetSessionId: nextSessionId,
          restoredMessageCount: nextConversation.length,
          preservedMessageCount: nextConversationForApply.length - nextConversation.length,
        }, { throttleMs: 0 });
      }
      logSessionRestoreMessagesHydrated({
        logSessionDiag,
        perf,
        restoreStartedAt,
        targetSessionId: nextSessionId,
        restoredMessageCount: restoredMessages.length,
      });
      if (!isLatestRestoreRequest()) return false;
      if (modelChanged) {
        setModelRef(nextModelRef);
      }
      if (thinkChanged) {
        setReasoningEffort(nextReasoningEffort);
      }
      applySessionRestoreConversationState({
        nextConversation: nextConversationForRuntime,
        nextHistory,
        restoredMessageCount: restoredMessages.length,
        effectiveContextUsedPct,
        setConversationMessagesWithLimit,
        setHistory,
        setAcpContextUsedPct,
        chatNearBottomRef,
      });
      logSessionRestoreStateApplyQueued({
        logSessionDiag,
        perf,
        restoreStartedAt,
        targetSessionId: nextSessionId,
      });
      scheduleSessionRestoreUiSettle({
        isLatestRestoreRequest,
        sessionSwitchToastText,
        chatSessionSwitchToastDelayMs: CHAT_SESSION_SWITCH_TOAST_DELAY_MS,
        showChatBottomToast,
      });
      const {
        resolvedSessionId,
        hasPendingAssistant,
        hasRunningTurn,
        codexRelayAttached,
        restoredInFlight,
      } = applyRestoredSessionRuntimeFromMessages({
        restored,
        restoredMessages,
        nextConversation: nextConversationForRuntime,
        nextSessionId,
        directory,
        effectiveContextUsedPct,
        restoreReplyRequestForThread,
        setReply,
        panelId: "",
      });
      setSelectedThreadStatusType(deriveRestoredSessionThreadStatusType(restored));
      adoptRestoredSessionDirectory({
        directory,
        resolvedSessionId,
        nextSessionId,
        llmSessionDirectoryRef,
        setReplyDebug,
        rememberKnownCodexThreadId,
      });
      if (normalizedLlmDirectoryForRequest() !== directory) {
        setLlmDirectory(directory);
      }
      restoreSucceeded = true;
      switchedSessionId = resolvedSessionId;
      finalizeSessionRestoreReadAndLog({
        markSessionReadAsync,
        resolvedSessionId,
        directory,
        source: opts?.source,
        perf,
        restoreRequestSeq,
        logSessionDiag,
        targetSessionId: nextSessionId,
        restoreStartedAt,
        restoredMessageCount: restoredMessages.length,
        hasRunningTurn,
        hasPendingAssistant,
        codexRelayAttached,
        restoredInFlight,
      });
      return true;
    } catch (err) {
      if (!isLatestRestoreRequest()) return false;
      rollbackSessionRestoreOnError(prevSessionId, prevSelectedSessionId);
      const message = err instanceof Error ? err.message : String(err);
      setLlmSessionRestoreError(message);
      setError(message);
      logSessionRestoreError({
        logSessionDiag,
        restoreRequestSeq,
        source: String(opts?.source || "unknown"),
        directory,
        targetSessionId: nextSessionId,
        restoreStartedAt,
        message,
        perf,
      });
      return false;
    } finally {
      finalizeSessionRestore({
        isLatestRestoreRequest,
        restoreSucceeded,
        restoreRequestSeq,
        switchedSessionId,
        nextSessionId,
      });
    }
  }

  const reloadActiveSession = useCallback((source: "mini_board" | "drawer" | "session_modal" = "mini_board") => {
    const sessionId = parseOptionalSessionId(selectedLlmSessionIdRef.current || selectedLlmSessionId);
    if (!sessionId) return;
    const directory = normalizedLlmDirectoryForRequest();
    logSessionDiag("session_reload_requested", {
      source,
      sessionId,
      directory,
    }, {
      throttleMs: 0,
      throttleKey: `session_reload_requested:${source}:${sessionId}`,
    });
    void selectSpecificLlmSession(sessionId, {
      source: "all",
      directory,
    });
  }, [normalizedLlmDirectoryForRequest, selectedLlmSessionId, selectSpecificLlmSession]);
  const markSessionReadFromContext = useCallback((
    sessionIdRaw: string,
    source: LlmSessionSource,
    directoryRaw: string
  ) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return;
    const directory = parseLlmDirectory(directoryRaw || normalizedLlmDirectoryForRequest());
    markSessionReadAsync({
      sessionId,
      source: source || "all",
      directory,
      perfTraceId: "mini_board_popup",
      restoreRequestSeq: Date.now(),
    });
  }, [
    markSessionReadAsync,
    normalizedLlmDirectoryForRequest,
  ]);
  const markSelectedSessionUnreadFromContext = useCallback(() => {
    const sessionId = parseOptionalSessionId(selectedLlmSessionIdRef.current || selectedLlmSessionId);
    if (!sessionId) {
      showChatBottomToast("assistant", "セッションIDが見つかりません。");
      return;
    }
    void markSessionUnread({
      sessionId,
      source: "all",
      directory: normalizedLlmDirectoryForRequest(),
    });
  }, [
    markSessionUnread,
    normalizedLlmDirectoryForRequest,
    selectedLlmSessionId,
    showChatBottomToast,
  ]);

  const { refreshGitChangedFiles } = useGitChangedFilesController({
    auxServerBaseUrl,
    runnerToken,
    gitChangedFilesByDirectoryRef,
    gitChangedFilesRefreshInFlightRef,
    setGitChangedFilesByDirectory,
    logSessionDiag,
  });
  const {
    fetchRunnerCodexCliStatusForSlash,
    applyCodexCliStatusSnapshot,
    refreshCodexCliStatusForWidget,
    refreshCodexAuthProfiles,
    switchCodexAuthProfile,
  } = useCodexStatusAuthController({
    activeScreen,
    appStateRef,
    auxServerBaseUrl,
    runnerToken,
    codexCliStatusMinRefreshGapMs: CODEX_CLI_STATUS_MIN_REFRESH_GAP_MS,
    codexCliStatusLastFetchedAtMsRef,
    codexCliStatusLastAttemptAtMsRef,
    codexCliStatusRefreshInFlightRef,
    codexAuthProfilesRefreshInFlightRef,
    codexAuthProfilesSnapshot,
    setCodexCliStatusSnapshot,
    setCodexCliStatusFetchedAtMs,
    setCodexCliStatusLoading,
    setCodexAuthProfilesSnapshot,
    setCodexAuthProfilesLoading,
    setCodexAuthSwitching,
    setCodexAuthSwitchError,
    onAuthSwitchStarted: () => {
      Alert.alert(
        "認証切替を開始しました",
        "Codex App Server を昇格再起動します。数秒後に再接続してください。"
      );
    },
  });
  const {
    closeCodexRelayObserver,
    clearCodexRelayObserverForMiss,
  } = useCodexRelayObserverLifecycleController({
    codexRelayObserverRef,
    codexRelayObserverReplyByThreadRef,
    codexRelayObserverStartedAtMsByThreadRef,
    finishWaitingApprovalResumeAttempt,
    setWaitingApprovalResumeStatusText,
    logSessionDiag,
  });
  const {
    upsertStreamSegment,
    appendLlmDelta,
    applyAssistantReply,
  } = useLlmTraceStateController({
    setStreamSegments,
    setStreamLlmDeltas,
    stripYouTubeTags,
  });
  const {
    setTtsSoundWithRef,
    setTtsPlaybackMessageIdWithRef,
    clearTtsPlaybackWatchdogTimer,
    setTtsPlaybackWanted,
    syncTtsPlaybackWantedFromPipeline,
  } = useTtsPlaybackWatchdogController({
    enableTtsPlaybackWatchdog: ENABLE_TTS_PLAYBACK_WATCHDOG,
    ttsLoading,
    ttsPlaybackWatchdogStatusTimeoutMs: TTS_PLAYBACK_WATCHDOG_STATUS_TIMEOUT_MS,
    ttsPlaybackStatusLogThrottleMs: TTS_PLAYBACK_STATUS_LOG_THROTTLE_MS,
    ttsPlaybackStallMs: TTS_PLAYBACK_STALL_MS,
    ttsPlaybackRecoverCooldownMs: TTS_PLAYBACK_RECOVER_COOLDOWN_MS,
    ttsPlaybackWatchdogErrorLogThrottleMs: TTS_PLAYBACK_WATCHDOG_ERROR_LOG_THROTTLE_MS,
    ttsPlaybackFinishEpsilonMs: TTS_PLAYBACK_FINISH_EPSILON_MS,
    ttsPlaybackForceStopStallMs: TTS_PLAYBACK_FORCE_STOP_STALL_MS,
    ttsPlaybackWatchdogIntervalMs: TTS_PLAYBACK_WATCHDOG_INTERVAL_MS,
    ttsPlayingRef,
    ttsSoundRef,
    ttsPlaybackWantedRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackTransitionInFlightRef,
    ttsPlaybackWatchdogTimerRef,
    ttsPlaybackWatchdogInFlightRef,
    ttsPlaybackLastPlayingAtRef,
    ttsPlaybackStatusLogAtRef,
    ttsPlaybackRecoverAtRef,
    ttsPlaybackUnexpectedStopLogAtRef,
    ttsPlaybackWatchdogErrorLogAtRef,
    ttsStopInFlightRef,
    ttsPlaybackMessageIdRef,
    streamSocketRef,
    streamAudioQueueRef,
    streamAudioQueueProcessingRef,
    streamTtsSuppressedRef,
    setTtsSound,
    setTtsPlaybackMessageId,
    setTtsUiStatus,
    onTtsPlaybackMessageIdChanged: (messageId) => {
      projectTtsPlaybackMessageIdToPanelsRef.current(messageId);
    },
    setTtsPlayingWithReasonRef: setTtsPlayingWithReasonDelegateRef,
    markTtsChunkPlaybackFinishedRef: markTtsChunkPlaybackFinishedDelegateRef,
    markTtsPlaybackStoppedRef: markTtsPlaybackStoppedDelegateRef,
    logAuto,
  });
  const {
    setTtsPlayingWithReason,
    markTtsChunkPlaybackFinished,
    markTtsPlaybackStopped,
    clearStreamAudioQueue,
    waitForPlaybackToFinish,
  } = useTtsPlaybackStateController({
    nearUnlimitedTimeoutMs: NEAR_UNLIMITED_TIMEOUT_MS,
    autoBargeInTtsGapGraceMs: AUTO_BARGE_IN_TTS_GAP_GRACE_MS,
    autoLastTtsStoppedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoPlaybackBargeGraceUntilRef,
    replyLoadingRef,
    streamSocketRef,
    streamAudioQueueRef,
    streamAudioQueueProcessingRef,
    streamCurrentChunkStartedAtRef,
    streamCurrentChunkEstimatedDurationMsRef,
    streamAudioQueueGenerationRef,
    streamAudioEnqueueChainRef,
    ttsPlayingRef,
    ttsPlaybackWantedRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackProgressUiAtRef,
    ttsSoundRef,
    setTtsPlaying,
    setTtsUiStatus,
    setStreamAudioQueueSize,
    setTtsPlaybackWanted,
    setTtsPlaybackMessageIdWithRef,
    clearTtsPlaybackWatchdogTimer,
    logAuto,
    elapsedSinceMs,
  });
  setTtsPlayingWithReasonDelegateRef.current = setTtsPlayingWithReason;
  markTtsChunkPlaybackFinishedDelegateRef.current = markTtsChunkPlaybackFinished;
  markTtsPlaybackStoppedDelegateRef.current = markTtsPlaybackStopped;
  const prepareTtsPlaybackSession = usePrepareTtsPlaybackSessionController({
    autoRecordingEnabledRef,
    autoSpeakerPriorityEnabledRef,
    autoBargeInEnabledRef,
    autoRecordingRef,
    detectAutoAirPodsInput,
    stopAutoRecordingMode,
    setAudioModeForPlayback,
    logAuto,
  });
  const shouldProjectTtsDebugToActiveSession = useCallback(() => false, []);
  const attachTtsSoundStatusHandler = useAttachTtsSoundStatusHandlerController({
    ttsPlaybackStatusLogThrottleMs: TTS_PLAYBACK_STATUS_LOG_THROTTLE_MS,
    ttsPlaybackRunIdRef,
    ttsPlaybackWantedRef,
    ttsPlaybackUnexpectedStopLogAtRef,
    ttsPlaybackStatusLogAtRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackLastPlayingAtRef,
    streamAudioQueueRef,
    streamAudioQueueProcessingRef,
    streamSocketRef,
    streamTtsSuppressedRef,
    trimForInline,
    logAuto,
    setTtsDebugStats,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
    setError,
    markTtsPlaybackStopped,
    markTtsChunkPlaybackFinished,
    syncTtsPlaybackWantedFromPipeline,
    setTtsSoundWithRef,
  });
  const playPreparedStreamAudioAndWait = usePlayPreparedStreamAudioController({
    fixedMediaVolume: FIXED_MEDIA_VOLUME,
    ttsStopInFlightRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackTransitionInFlightRef,
    ttsPlaybackLastPlayingAtRef,
    setTtsPlaybackWanted,
    setTtsPlayingWithReason,
    setTtsUiStatus,
    setTtsUri,
    setTtsSoundWithRef,
    attachTtsSoundStatusHandler,
    waitForPlaybackToFinish,
    markTtsPlaybackStopped,
  });
  const playTtsAudio = usePlayTtsAudioController({
    fixedMediaVolume: FIXED_MEDIA_VOLUME,
    ttsStopInFlightRef,
    ttsPlaybackRunIdRef,
    ttsPlaybackProgressUiAtRef,
    ttsPlaybackTransitionInFlightRef,
    ttsPlaybackLastPlayingAtRef,
    ttsSoundRef,
    setTtsPlaybackWanted,
    setTtsPlayingWithReason,
    setTtsUiStatus,
    setTtsDebugStats,
    setTtsUri,
    setTtsSoundWithRef,
    prepareTtsPlaybackSession,
    attachTtsSoundStatusHandler,
    markTtsPlaybackStopped,
  });
  const synthesizeSpeech = useSynthesizeSpeechController({
    reply,
    runnerUrl,
    runnerToken,
    ttsProvider,
    selectedVoiceId,
    ttsSpeed,
    ttsLoading,
    ttsSynthesisRequestIdRef,
    baseUrl,
    setTtsPlaybackMessageIdWithRef,
    setTtsLoading,
    setTtsUiStatus,
    setError,
    setTtsDebugStats,
    setReplyDebug,
    reportError,
    playTtsAudio,
  });
  const processStreamAudioQueue = useProcessStreamAudioQueueController({
    streamAudioQueueProcessingRef,
    streamAudioQueueRef,
    streamCurrentChunkStartedAtRef,
    streamCurrentChunkEstimatedDurationMsRef,
    ttsPlaybackMessageIdRef,
    setTtsQueueProcessing,
    syncTtsPlaybackWantedFromPipeline,
    prepareTtsPlaybackSession,
    setStreamAudioQueueSize,
    setTtsPlaybackMessageIdWithRef,
    upsertStreamSegment,
    setTtsUiStatus,
    playPreparedStreamAudioAndWait,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
    reportError,
    markTtsPlaybackStopped,
    clearStreamAudioQueue,
  });
  const enqueueStreamAudio = useEnqueueStreamAudioController({
    streamAudioQueueGenerationRef,
    streamAudioEnqueueChainRef,
    streamTtsSuppressedRef,
    streamAudioQueueRef,
    streamSocketRef,
    setTtsPlaybackWanted,
    setTtsUiStatus,
    setStreamAudioQueueSize,
    processStreamAudioQueue,
    setReplyDebug,
    shouldProjectTtsDebugToActiveSession,
  });
  const synthesizeSpeechStreamFromController = useSynthesizeSpeechStreamController({
    reply,
    runnerToken,
    ttsProvider,
    selectedVoiceId,
    ttsSpeed,
    ttsWaveformPoints: TTS_WAVEFORM_POINTS,
    streamSocketRef,
    streamTtsSuppressedRef,
    streamAudioWaveformBarsRef,
    ttsPlayingRef,
    streamAudioQueueRef,
    baseUrl,
    ttsStreamWsUrl,
    clearStreamAudioQueue,
    upsertStreamSegment,
    enqueueStreamAudio,
    patchConversationMessageById: (messageId, patch) => {
      patchConversationMessageById(messageId, patch);
      projectTtsWaveformToPanelsRef.current(messageId, patch.ttsWaveform);
    },
    reportError,
    setError,
    setReplyDebug,
    setTtsLoading,
    setTtsUiStatus,
    setTtsPlaybackWanted,
    patchTtsDebugStats,
    setStreamWaveformPreview,
    clearStreamLlmProgress: () => setStreamLlmProgress([]),
    clearStreamSegments: () => setStreamSegments([]),
    setStreamMode,
    setTtsPlaybackMessageIdWithRef,
    setTtsPlaybackProjectionTarget: (target) => {
      ttsPlaybackProjectionTargetRef.current = target;
    },
    setTtsDebugStats,
    syncTtsPlaybackWantedFromPipeline,
  });
  synthesizeSpeechStreamDelegateRef.current = synthesizeSpeechStreamFromController;
  const resolveSessionHistoryContext = useCallback((sessionId: unknown) => (
    resolveSessionHistoryContextValue({
      sessionId,
      registeredDirectories,
      directorySessionsById,
      sessionTitleOverridesById,
    })
  ), [
    directorySessionsById,
    registeredDirectories,
    sessionTitleOverridesById,
  ]);
  const {
    handleApprovalRequest,
    clearToolAutoApprovals,
    clearPendingApprovals,
    clearPendingApprovalsForSession,
    approvalDialog,
    respondToApprovalDialog,
  } = useApprovalRequestController({
    setReplyDebug,
    updateLlmStatus,
    appendAssistantEventMessage: (line, request) => {
      appendAssistantEventMessageForApprovalRef.current(line, request);
    },
    setLlmLastToolCall,
    playUiSfx,
    toolAutoApprovalMapRef,
    setToolAutoApprovalMap,
    speakApprovalReason: (reason) => synthesizeSpeech(reason),
    shouldUpdateLlmStatusForApproval: (request) => {
      if (normalizeRuntimePanelId(request.sessionInfo?.panelId)) return false;
      const requestSessionId = parseOptionalSessionId(request.sessionInfo?.sessionId || request.threadId);
      if (!requestSessionId) return true;
      const visibleSessionId = parseOptionalSessionId(
        selectedLlmSessionIdRef.current || selectedLlmSessionId || llmConversationSessionIdRef.current
      );
      if (!visibleSessionId) return true;
      return requestSessionId === visibleSessionId;
    },
  });
  const getActiveConversationMessagesForCodex = useCallback(() => (
    conversationMessagesRef.current.map((message) => ({
      ...message,
      youtubeVideoIds: Array.isArray(message.youtubeVideoIds) ? [...message.youtubeVideoIds] : undefined,
      ttsWaveform: Array.isArray(message.ttsWaveform) ? [...message.ttsWaveform] : undefined,
      sttMeta: message.sttMeta ? { ...message.sttMeta } : undefined,
    }))
  ), []);
  const setActiveConversationMessagesForCodex = useCallback((
    messages: ConversationMessage[],
    options?: RuntimeConversationWriteOptions
  ) => {
    setConversationMessagesWithLimit(messages);
    if (typeof options?.isResponding === "boolean") {
      setReplyLoadingWithRef(options.isResponding);
    }
    if (options?.selectedThreadStatusType) {
      setSelectedThreadStatusType(options.selectedThreadStatusType);
    }
    const sessionId = parseOptionalSessionId(options?.sessionId || selectedLlmSessionIdRef.current || selectedLlmSessionId);
    if (sessionId) {
      upsertConversationRuntimeSnapshot({
        sessionId,
        conversationMessages: messages,
        isResponding: Boolean(options?.isResponding),
        selectedThreadStatusType: String(options?.selectedThreadStatusType || "unknown").trim() || "unknown",
        clearRespondingRequestStartedAtMs: options?.clearRespondingRequestStartedAtMs,
      });
    }
  }, [
    selectedLlmSessionId,
    setConversationMessagesWithLimit,
    setReplyLoadingWithRef,
    upsertConversationRuntimeSnapshot,
  ]);
  const getSessionConversationMessagesForCodex = useCallback((sessionId: string) => (
    getSessionConversationMessagesForCodexRef.current(sessionId)
  ), []);
  const setSessionConversationMessagesForCodex = useCallback((
    sessionId: string,
    messages: ConversationMessage[],
    options?: RuntimeConversationWriteOptions
  ) => {
    setSessionConversationMessagesForCodexRef.current(sessionId, messages, options);
  }, []);
  const handleRelayAssistantTurnCompleted = useCallback(async (params: {
    threadId: string;
    panelId?: string;
    messageId: string;
    text: string;
    directory: string;
    reason: string;
  }) => {
    const sessionId = parseOptionalSessionId(params.threadId);
    const text = stripYouTubeTags(String(params.text || ""));
    if (!sessionId || !text.trim()) return;
    const youtubeIds = extractYouTubeVideoIds(params.text);
    void fetchYouTubeVideoMetadata(youtubeIds);
    const target = {
      panelId: params.panelId,
      sessionId,
      messageId: params.messageId,
    };
    const visibleSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || selectedLlmSessionId || llmConversationSessionIdRef.current
    );
    const completedActiveSession = !params.panelId && (!visibleSessionId || visibleSessionId === sessionId);
    if (completedActiveSession) {
      playUiSfx("reply");
      setReply(text);
      finishLlmRequest("completed", "turn completed");
    }
    void refreshGitChangedFiles(params.directory, { force: true });
    refreshMiniBoardDirectorySessionsForDirectory(params.directory, "relay_turn_completed");
    const speechAllowed = autoSpeakAfterReply && !!text.trim() && isChatOpenForAutoSpeech(target);
    if (speechAllowed) {
      await synthesizeSpeechStream(text, target);
    }
    logSessionDiag("relay_assistant_turn_completed_played", {
      sessionId,
      panelId: params.panelId || "",
      reason: params.reason,
      textChars: text.length,
      autoSpeakAfterReply,
      speechAllowed,
      completedActiveSession,
    }, { throttleMs: 0 });
  }, [
    autoSpeakAfterReply,
    extractYouTubeVideoIds,
    fetchYouTubeVideoMetadata,
    finishLlmRequest,
    isChatOpenForAutoSpeech,
    logSessionDiag,
    playUiSfx,
    refreshMiniBoardDirectorySessionsForDirectory,
    refreshGitChangedFiles,
    selectedLlmSessionId,
    stripYouTubeTags,
    synthesizeSpeechStream,
  ]);
  const rememberRuntimeApprovalRequest = useCallback((request: ApprovalRequest) => {
    const sessionId = parseOptionalSessionId(request.sessionInfo?.sessionId || request.threadId);
    if (!sessionId) return;
    const approvalId = String(request.requestId || request.approvalKey || "").trim();
    if (!approvalId) return;
    const previous = getConversationRuntimeSnapshot(sessionId);
    const previousEvents = previous?.events || [];
    const existingEvent = previousEvents.find((event) => (
      event.kind === "approval_request" &&
      event.approvalId === approvalId &&
      event.state === "pending"
    ));
    const commandLabel = buildApprovalCommandLabel(request.command, request.args);
    const text = String(request.reason || request.message || commandLabel || "承認が必要です").trim();
    const nextEvents = existingEvent
      ? previousEvents
      : [
        ...previousEvents,
        {
          kind: "approval_request" as const,
          sessionId,
          seq: previousEvents.length + 1,
          text,
          approvalId,
          state: "pending" as const,
          request,
          atMs: Date.now(),
        },
      ];
    upsertConversationRuntimeSnapshot({
      sessionId,
      events: nextEvents,
      pendingApproval: request,
      isResponding: true,
      selectedThreadStatusType: "waiting_approval",
    });
    rememberSessionRuntimeStatus(sessionId, {
      hasRunningTurn: true,
      hasPendingAssistant: true,
      restoredInFlight: false,
      waitingApproval: true,
    });
    logSessionDiag("session_runtime_approval_requested", {
      sessionId,
      approvalId,
      command: String(request.command || "").trim() || undefined,
      eventCount: nextEvents.length,
      source: "runtime_player",
    }, {
      throttleMs: 0,
      throttleKey: `session_runtime_approval_requested:${sessionId}:${approvalId}`,
    });
  }, [
    getConversationRuntimeSnapshot,
    logSessionDiag,
    rememberSessionRuntimeStatus,
    upsertConversationRuntimeSnapshot,
  ]);
  const resolveRuntimeApprovalRequest = useCallback((request: ApprovalRequest, action: string) => {
    const sessionId = parseOptionalSessionId(request.sessionInfo?.sessionId || request.threadId);
    if (!sessionId) return;
    const approvalId = String(request.requestId || request.approvalKey || "").trim();
    if (!approvalId) return;
    const previous = getConversationRuntimeSnapshot(sessionId);
    if (!previous) return;
    const nextState = action === "approve_once" || action === "approve_for_session"
      ? "approved"
      : (action === "cancel" ? "cancelled" : "declined");
    const keepTerminalState = action === "cancel" &&
      previous.isResponding === false &&
      String(previous.selectedThreadStatusType || "").trim() === "idle";
    const nextEvents = previous.events.map((event) => (
      event.kind === "approval_request" && event.approvalId === approvalId
        ? { ...event, state: nextState as "approved" | "declined" | "cancelled" }
        : event
    ));
    upsertConversationRuntimeSnapshot({
      sessionId,
      events: nextEvents,
      pendingApproval: null,
      isResponding: keepTerminalState ? false : true,
      selectedThreadStatusType: keepTerminalState ? "idle" : "active",
    });
    rememberSessionRuntimeStatus(sessionId, {
      hasRunningTurn: keepTerminalState ? false : true,
      hasPendingAssistant: keepTerminalState ? false : true,
      restoredInFlight: false,
      waitingApproval: false,
    });
    logSessionDiag("session_runtime_approval_resolved", {
      sessionId,
      approvalId,
      state: nextState,
      source: "runtime_player",
    }, {
      throttleMs: 0,
      throttleKey: `session_runtime_approval_resolved:${sessionId}:${approvalId}:${nextState}`,
    });
  }, [
    getConversationRuntimeSnapshot,
    logSessionDiag,
    rememberSessionRuntimeStatus,
    upsertConversationRuntimeSnapshot,
  ]);
  const finalizeSessionRuntimeAfterRelayLoss = useCallback((sessionIdRaw: unknown, reasonRaw: string) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return;
    const finalized = finalizeConversationRuntimeAfterRelayLoss(sessionId, reasonRaw);
    const detail = finalized?.reason || String(reasonRaw || "relay unavailable").trim() || "relay unavailable";
    const messages = finalized?.snapshot.conversationMessages || [];

    if (messages.length > 0) {
      setSessionConversationMessagesForCodexRef.current(sessionId, messages, {
        isResponding: false,
        selectedThreadStatusType: "idle",
        sessionId,
      });
    }
    rememberSessionRuntimeStatus(sessionId, {
      hasRunningTurn: false,
      hasPendingAssistant: false,
      restoredInFlight: false,
      waitingApproval: false,
    });
    clearPendingApprovalsForSession(sessionId);
    const visibleSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || selectedLlmSessionId || llmConversationSessionIdRef.current
    );
    if (visibleSessionId === sessionId) {
      setReplyLoadingWithRef(false);
      setSelectedThreadStatusType("idle");
      if (isLlmActiveStatus(llmUiStatusRef.current)) {
        updateLlmStatus("error", detail);
      }
    }
    logSessionDiag("session_runtime_relay_unavailable", {
      sessionId,
      reason: detail,
      cancelledPendingApprovals: finalized?.cancelledPendingApprovals || 0,
      messageCount: messages.length,
    }, {
      throttleMs: 0,
      throttleKey: `session_runtime_relay_unavailable:${sessionId}:${detail}`,
    });
  }, [
    clearPendingApprovalsForSession,
    finalizeConversationRuntimeAfterRelayLoss,
    logSessionDiag,
    llmUiStatusRef,
    rememberSessionRuntimeStatus,
    selectedLlmSessionId,
    selectedLlmSessionIdRef,
    setSessionConversationMessagesForCodexRef,
    updateLlmStatus,
  ]);
  const enrichApprovalRequestWithSessionContext = useCallback((request: ApprovalRequest): ApprovalRequest => {
    const sessionId = parseOptionalSessionId(request.sessionInfo?.sessionId || request.threadId);
    const context = resolveSessionHistoryContext(sessionId);
    if (!sessionId || !context) return request;
    return {
      ...request,
      sessionInfo: {
        ...request.sessionInfo,
        sessionId,
        directoryPath: context.directory,
        directoryDisplayName: context.directoryDisplayName,
        sessionTitle: context.sessionTitle || request.sessionInfo?.sessionTitle,
      },
    };
  }, [resolveSessionHistoryContext]);
  const handleRuntimeApprovalRequest = useCallback(async (request: ApprovalRequest) => {
    const enrichedRequest = enrichApprovalRequestWithSessionContext(request);
    rememberRuntimeApprovalRequest(enrichedRequest);
    const action = await handleApprovalRequest(enrichedRequest);
    resolveRuntimeApprovalRequest(enrichedRequest, action);
    return action;
  }, [
    enrichApprovalRequestWithSessionContext,
    handleApprovalRequest,
    rememberRuntimeApprovalRequest,
    resolveRuntimeApprovalRequest,
  ]);
  const shouldProjectRelayConversation = useCallback((params: {
    threadId: string;
    reason: string;
  }) => {
    if (params.reason === "codex_queue_turn") return true;
    const threadId = parseOptionalSessionId(params.threadId);
    if (!threadId) return true;
    const request = getConversationRuntimeSnapshot(threadId)?.request;
    return !isConversationRuntimeRequestResponding(request);
  }, [getConversationRuntimeSnapshot, parseOptionalSessionId]);
  const completeRuntimeRequestForRelayCompletion = useCallback((params: {
    threadId: string;
    startedAtMs: number | null;
    reason: string;
  }) => {
    const sessionId = parseOptionalSessionId(params.threadId);
    const startedAtMs = Number.isFinite(Number(params.startedAtMs))
      ? Math.floor(Number(params.startedAtMs))
      : 0;
    if (!sessionId || startedAtMs <= 0) return;
    const request = getConversationRuntimeSnapshot(sessionId)?.request;
    if (!isConversationRuntimeRequestResponding(request)) return;
    if (Math.floor(Number(request?.startedAtMs || 0)) !== startedAtMs) return;
    upsertConversationRuntimeSnapshot({
      sessionId,
      isResponding: false,
      selectedThreadStatusType: "idle",
      clearRespondingRequestStartedAtMs: startedAtMs,
    });
    logSessionDiag("session_runtime_request_completed_from_relay", {
      sessionId,
      reason: params.reason,
      startedAtMs,
      requestId: request?.requestId || "",
      requestSeq: request?.requestSeq || 0,
    }, {
      throttleMs: 0,
      throttleKey: `session_runtime_request_completed_from_relay:${sessionId}:${startedAtMs}`,
    });
  }, [
    getConversationRuntimeSnapshot,
    logSessionDiag,
    parseOptionalSessionId,
    upsertConversationRuntimeSnapshot,
  ]);
  const { startCodexRelayObserverForSession } = useCodexRelayObserverStartController({
    parseOptionalSessionId,
    parseLlmDirectory,
    normalizedLlmDirectoryForRequest,
    codexRelayObserverRef,
    codexRelayObserverReplyByThreadRef,
    codexRelayObserverStartedAtMsByThreadRef,
    llmRequestStartedAtRef,
    reply,
    codexWsUrl,
    codexWsToken,
    logSessionDiag,
    waitingApprovalResumePendingSessionIdRef,
    setWaitingApprovalResumeStatusText,
    finishWaitingApprovalResumeAttempt,
    clearCodexRelayObserverForMiss,
    applyAssistantReply,
    buildConversationMessage,
    getPanelConversationMessagesForCodexRef,
    setPanelConversationMessagesForCodexRef,
    getActiveConversationMessagesForCodex,
    setActiveConversationMessagesForCodex,
    getSessionConversationMessagesForCodex,
    setSessionConversationMessagesForCodex,
    rememberSessionRuntimeStatus,
    finalizeSessionRuntimeAfterRelayLoss,
    closeCodexRelayObserver,
    shouldProjectRelayConversation,
    completeRuntimeRequestForRelayCompletion,
    onApprovalRequest: handleRuntimeApprovalRequest,
    onAssistantTurnCompleted: handleRelayAssistantTurnCompleted,
  });

  function applyRestoredSessionRuntimeFromMessages({
    restored,
    restoredMessages,
    nextConversation,
    nextSessionId,
    directory,
    effectiveContextUsedPct,
    restoreReplyRequestForThread,
    setReply,
    panelId,
  }: {
    restored: RunnerSessionMessagesResult;
    restoredMessages: LlmSessionMessage[];
    nextConversation: ConversationMessage[];
    nextSessionId: string;
    directory: string;
    effectiveContextUsedPct: number | null;
    restoreReplyRequestForThread: (sessionIdRaw: unknown, options?: { panelId?: string }) => boolean;
    setReply: (value: string) => void;
    panelId?: string;
  }) {
    const runtimeSnapshot = buildRestoredSessionRuntimeSnapshot({
      restored,
      restoredMessages,
      nextConversation,
      nextSessionId,
      sessionResumeAutoSignalMaxAgeMs: SESSION_RESUME_AUTO_SIGNAL_MAX_AGE_MS,
      restoreReplyRequestForThread,
      panelId,
    });
    const {
      hasPendingAssistant,
      hasRunningTurn,
      latestAssistantText,
      restoredThreadId,
      restoredInFlight,
      runningTurnStatus,
      runningTurnSummary,
      latestToolLabelOnRestore,
      waitingApprovalOnRestore,
      hasApprovalRequiredMessage,
      hasApprovalBlockedErrorMessage,
      runningStartedAtMs,
      runningUpdatedAtMs,
      runningSignalAgeMs,
      hasFreshResumeSignal,
      effectiveHasPendingAssistant,
    } = runtimeSnapshot;
    setReply(latestAssistantText);
    const rememberRuntime = (sessionId: string) => {
      rememberSessionRuntimeStatus(sessionId, {
        hasRunningTurn,
        hasPendingAssistant: effectiveHasPendingAssistant,
        restoredInFlight: Boolean(restoredInFlight),
        waitingApproval: waitingApprovalOnRestore,
      });
    };
    rememberRuntime(restoredThreadId);
    if (restoredThreadId !== nextSessionId) rememberRuntime(nextSessionId);

    if (effectiveHasPendingAssistant || hasRunningTurn || restoredInFlight) {
      const reason = summarizeExecutionReasonFromStatus(
        hasRunningTurn,
        effectiveHasPendingAssistant,
        Boolean(restoredInFlight),
        runningTurnSummary,
        runningTurnStatus,
        latestToolLabelOnRestore
      );
      if (!restoredInFlight && !waitingApprovalOnRestore) {
        updateLlmStatus("model_processing", reason.reasonDetail || reason.reasonLabel);
      }
    } else {
      if (!replyLoadingRef.current && isLlmActiveStatus(llmUiStatusRef.current)) {
        updateLlmStatus("idle", "session_restored_completed");
      }
    }

    if (restoredInFlight) {
      setReplyDebug((prev) => (
        prev
          ? `${prev} | session_live_turn_hydrated thread=${restoredThreadId}`
          : `session_live_turn_hydrated thread=${restoredThreadId}`
      ));
    } else if (replyLoadingRef.current) {
      setReplyLoadingWithRef(false);
    }
    if (waitingApprovalOnRestore && !restoredInFlight) {
      const approvalSummary = latestToolLabelOnRestore || runningTurnSummary || "承認待ちで停止中";
      const approvalStatus = runningTurnStatus || "waiting_approval";
      updateLlmStatus("tool_waiting_approval", `approval required: ${approvalSummary}`);
      if (!hasApprovalRequiredMessage) {
        appendAssistantEventMessage(`tool_approval_required : ${approvalSummary} (${approvalStatus})`);
      }
      if (!hasApprovalBlockedErrorMessage) {
        const toolDetail = latestToolLabelOnRestore ? `実行中: ${latestToolLabelOnRestore}。` : "";
        appendAssistantEventMessage(
          `tool_error : 承認待ちで停止中。${toolDetail}承認要求の再表示を待機しています。`
        );
      }
    }

    let codexRelayAttached = false;
    if (!restoredInFlight && hasRunningTurn) {
      codexRelayAttached = startCodexRelayObserverForSession(nextSessionId, {
        directory,
        startedAtMs: runningStartedAtMs ?? undefined,
        resumeFromSeq: 0,
        reason: "session_restored_running_turn",
        panelId,
      });
    } else {
      const activeObserver = codexRelayObserverRef.current;
      if (activeObserver && activeObserver.threadId !== nextSessionId) {
        closeCodexRelayObserver("session_restored_other_thread");
      }
    }
    logSessionDiag("session_runtime_player_hydrated", {
      targetSessionId: nextSessionId,
      restoredThreadId,
      hasPendingAssistant,
      effectiveHasPendingAssistant,
      hasRunningTurn,
      restoredInFlight: Boolean(restoredInFlight),
      waitingApprovalOnRestore,
      runningSignalAgeMs,
      hasFreshResumeSignal,
      codexRelayAttached,
      contextPct: effectiveContextUsedPct ?? null,
    }, { throttleMs: 0 });
    return {
      resolvedSessionId: restored.threadId || nextSessionId,
      hasPendingAssistant,
      hasRunningTurn,
      codexRelayAttached,
      restoredInFlight,
      restoredThreadId,
    };
  }
	  const {
	    stopTtsPlayback: stopTtsPlaybackFromController,
    stopWaveformPlayback: stopWaveformPlaybackFromController,
  } = useStopTtsPlaybackController({
    ttsStopInFlightRef,
    ttsPlaybackTransitionInFlightRef,
    autoLastTtsStopRequestedAtRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStoppedAtRef,
    ttsPlaybackRunIdRef,
    ttsSynthesisRequestIdRef,
    ttsPlayingRef,
    replyLoadingRef,
    streamSocketRef,
    streamAudioQueueRef,
    streamAudioQueueProcessingRef,
    streamTtsSuppressedRef,
    streamAudioWaveformBarsRef,
    ttsPlaybackMessageIdRef,
    ttsSoundRef,
    ttsLoading,
    ttsUiStatus,
    setTtsPlaybackWanted,
    setTtsLoading,
    setTtsUiStatus,
    setTtsQueueProcessing,
    logAuto,
    elapsedSinceMs,
    clearStreamAudioQueue,
    setStreamWaveformPreview,
    markTtsPlaybackStopped,
    setAudioModeForPlayback,
    clearTtsPlaybackWatchdogTimer,
    setTtsSoundWithRef,
  });
  stopTtsPlaybackDelegateRef.current = stopTtsPlaybackFromController;
  stopWaveformPlaybackDelegateRef.current = stopWaveformPlaybackFromController;
  const { quiesceForSessionSwitch } = useSessionSwitchQuiesceController({
    suspendCodexTurnRequestForSessionSwitch,
    closeCodexRelayObserver,
    stopTtsPlayback,
    streamSocketRef,
    clearStreamAudioQueue,
    streamAudioWaveformBarsRef,
    setStreamWaveformPreview,
    streamTtsSuppressedRef,
    setStreamMode,
    setStreamLlmNativeDeltaCount,
    setStreamLlmPseudoDeltaCount,
    setStreamFirstNativeDeltaOffsetMs,
    setStreamLlmDeltas,
    setStreamLlmProgress,
    setStreamSegments,
    setStreamReplyYouTubeVideoIdsWithRef,
    setTtsPlaybackMessageIdWithRef,
    setReply,
    replyLoadingRef,
    setReplyLoadingWithRef,
    finishLlmRequest,
    setReplyDebug,
  });

  const { resumeWaitingApprovalForActiveSession } = useWaitingApprovalResumeActionController({
    parseOptionalSessionId,
    selectedSessionId: () => selectedLlmSessionIdRef.current || selectedLlmSessionId,
    waitingApprovalResumeLoading,
    waitingApprovalResumeCooldownUntilMsRef,
    showChatBottomToast,
    formatElapsedMmSs,
    normalizedLlmDirectoryForRequest,
    sessionRuntimeStatusByIdRef,
    selectedSessionWaitingApproval,
    reloadActiveSession,
    rememberSessionRuntimeStatus,
    setWaitingApprovalResumeLoading,
    setWaitingApprovalResumeStatusText,
    waitingApprovalResumePendingSessionIdRef,
    clearWaitingApprovalResumeAttachTimer,
    waitingApprovalResumeAttachTimerRef,
    finishWaitingApprovalResumeAttempt,
    logSessionDiag,
    waitingApprovalResumeAttachTimeoutMs: WAITING_APPROVAL_RESUME_ATTACH_TIMEOUT_MS,
    setReplyDebug,
    closeCodexRelayObserver,
    startCodexRelayObserverForSession,
    selectedSessionExecutionFactStartedAtMs: selectedSessionExecutionFact?.startedAtMs,
  });

  function clearSelectedLlmSession() {
    applySessionIdentityChange("", {
      source: "clear_selected_llm_session",
      reason: "clear_selected_session",
      updateSelected: true,
      forceStateSync: true,
      directory: normalizedLlmDirectoryForRequest(),
    });
    setLlmSessionRestoreError("");
  }

  function openDirectoryExplorer() {
    setDirectorySelectOpen(true);
    primeDirectoryExplorer();
  }

  function ttsStreamWsUrl() {
    const targetCodexWsUrl = codexWsUrl.trim();
    if (isRunnerWsUrl(targetCodexWsUrl)) {
      try {
        const url = new URL(targetCodexWsUrl);
        const runnerWsToken = codexWsToken.trim() || runnerToken.trim();
        if (runnerWsToken && !String(url.searchParams.get("token") || "").trim()) {
          url.searchParams.set("token", runnerWsToken);
        }
        return url.toString();
      } catch {
        // fall back to the legacy stream-tts URL below
      }
    }
    const targetBaseUrl = auxServerBaseUrl();
    const url = new URL(targetBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/stream-tts";
    url.search = "";
    url.searchParams.set("token", runnerToken.trim());
    return url.toString();
  }

  const {
    setTtsSpeedWithSync,
    applyRecordingQualityPreset,
    setRecordingSampleRateFromInput,
    setRecordingChannelsFromInput,
    setRecordingBitRateFromInput,
    setRecordingProgressUpdateIntervalFromInput,
  } = useAudioSettingsInputController({
    setTtsSpeed,
    setTtsSpeedInput,
    clampTtsSpeed,
    setRecordingQualityPreset,
    setRecordingTuning,
    parseRecordingQualityPreset,
    recordingTuningFromPreset,
    clampRecordingChannels,
  });

  function setReplyLoadingWithRef(next: boolean) {
    const wasReplyLoading = replyLoadingRef.current;
    replyLoadingRef.current = next;
    setReplyLoading(next);
    if (wasReplyLoading !== next) {
      logSessionDiag("reply_loading_changed", {
        from: wasReplyLoading,
        to: next,
        activeSessionId: parseOptionalSessionId(llmConversationSessionIdRef.current),
        selectedSessionId: parseOptionalSessionId(selectedLlmSessionIdRef.current || selectedLlmSessionId),
        llmUiStatus,
        llmUiStatusDetail: String(llmUiStatusDetail || ""),
      }, {
        throttleMs: 0,
      });
    }
  }

  function setLlmSessionRestoreLoadingWithRef(next: boolean) {
    llmSessionRestoreLoadingRef.current = next;
    setLlmSessionRestoreLoading(next);
  }

  function patchTtsDebugStats(patch: Partial<TtsDebugStats>) {
    setTtsDebugStats((prev) => ({
      ...prev,
      ...patch,
    }));
  }
  const {
    loadLlmRuntimeLimits,
    updateLlmToolMaxRounds,
    fetchRunnerLlmRuntimeLimitsForStatus,
  } = useLlmRuntimeLimitsController({
    auxServerBaseUrl,
    runnerToken,
    llmToolMaxRoundsInput,
    setLlmRuntimeLimits,
    setLlmRuntimeLimitsError,
    setLlmRuntimeLimitsLoading,
    setLlmToolMaxRoundsInput,
    setLlmToolMaxRoundsSaving,
    setReplyDebug,
  });

  function elapsedSinceMs(startedAtMs: number) {
    return elapsedSinceMsValue(startedAtMs);
  }

  function logAuto(event: string, payload: Record<string, unknown> = {}) {
    logAutoEvent({
      event,
      payload,
      autoDiagnosticsEnabled: AUTO_DIAGNOSTICS_ENABLED,
      autoDiagnosticCriticalEvents: AUTO_DIAGNOSTIC_CRITICAL_EVENTS,
      enqueueLog: (name, data) => {
        autoClientLogs.enqueue(name, data);
      },
    });
  }

  async function sendAutoClientLogsNow() {
    await autoClientLogs.sendNow();
  }

  function clearAutoClientLogsLocal() {
    autoClientLogs.clearLocal();
  }

  const {
    logAudioLab,
    sendAudioLabLogsNow,
    clearAudioLabLogsLocal,
  } = useAudioLabLoggingController({
    autoDiagnosticsEnabled: AUTO_DIAGNOSTICS_ENABLED,
    audioLabRecentLogMax: AUDIO_LAB_RECENT_LOG_MAX,
    audioLabClientLogs,
    setAudioLabRecentLogs: (updater) => setAudioLabRecentLogs(updater),
    toInlineSummary,
  });

  const {
    clearAudioLabInputPollTimer,
    clearAudioLabPlaybackWatchdogTimer,
    bindAudioLabPlaybackStatus,
    startAudioLabPlaybackWatchdog,
    detectAudioLabInputRoute,
    startAudioLabInputRoutePolling,
  } = useAudioLabPlaybackMonitoring({
    audioLabRecordingRef,
    audioLabSoundRef,
    audioLabInputPollTimerRef,
    audioLabPlaybackWatchdogTimerRef,
    audioLabRunIdRef,
    audioLabPlaybackWantedRef,
    audioLabPlaybackLastPlayingAtRef,
    audioLabPlaybackStatusLogAtRef,
    audioLabPlaybackRecoverAtRef,
    audioLabPlaybackWatchdogInFlightRef,
    audioLabPlaybackWatchdogErrorLogAtRef,
    audioLabInputNameRef,
    audioLabAirPodsInputRef,
    audioLabRouteErrorLogAtRef,
    audioLabInputPollMs: AUDIO_LAB_INPUT_POLL_MS,
    playbackStatusLogThrottleMs: AUDIO_LAB_PLAYBACK_STATUS_LOG_THROTTLE_MS,
    playbackWatchdogIntervalMs: AUDIO_LAB_PLAYBACK_WATCHDOG_INTERVAL_MS,
    playbackWatchdogStatusTimeoutMs: AUDIO_LAB_PLAYBACK_WATCHDOG_STATUS_TIMEOUT_MS,
    playbackRecoverCooldownMs: AUDIO_LAB_PLAYBACK_RECOVER_COOLDOWN_MS,
    playbackStallMs: AUDIO_LAB_PLAYBACK_STALL_MS,
    playbackWatchdogErrorLogThrottleMs: AUDIO_LAB_PLAYBACK_WATCHDOG_ERROR_LOG_THROTTLE_MS,
    routeErrorLogThrottleMs: AUDIO_LAB_ROUTE_ERROR_LOG_THROTTLE_MS,
    setAudioLabPlaybackActive,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackStallMs,
    setAudioLabLoopCount,
    setAudioLabUnexpectedStopCount,
    setAudioLabPlaybackRecoverCount,
    setAudioLabInputName,
    setAudioLabAirPodsInput,
    logAudioLab,
    isAirPodsInputName,
  });

  const {
    stopAudioLabPlaybackOnly,
    startAudioLabPlaybackOnly,
  } = useAudioLabPlaybackController({
    audioLabLoopAsset: AUDIO_LAB_LOOP_ASSET,
    audioLabRunning,
    audioLabActionInFlightRef,
    audioLabRecordingRef,
    audioLabSoundRef,
    audioLabPlaybackWantedRef,
    audioLabRunIdRef,
    audioLabStartedAtRef,
    audioLabPlaybackLastPlayingAtRef,
    clearAudioLabPlaybackWatchdogTimer,
    startAudioLabPlaybackWatchdog,
    bindAudioLabPlaybackStatus,
    setAudioLabRunning,
    setAudioLabNowMs,
    setAudioLabPlaybackActive,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackStallMs,
    logAudioLab,
    reportError,
  });

  const { startAudioLabProbe, stopAudioLabProbe } = useAudioLabProbeController({
    audioLabLoopAsset: AUDIO_LAB_LOOP_ASSET,
    audioLabFlatlineDb: AUDIO_LAB_FLATLINE_DB,
    audioLabMeterLogThrottleMs: AUDIO_LAB_METER_LOG_THROTTLE_MS,
    audioLabRunning,
    manualRecording,
    ttsLoading,
    autoRecordingEnabledRef,
    ttsPlayingRef,
    audioLabActionInFlightRef,
    audioLabRecordingRef,
    audioLabSoundRef,
    audioLabRunIdRef,
    audioLabStartedAtRef,
    audioLabLastStatusAtRef,
    audioLabFlatlineSinceRef,
    audioLabMeterLogAtRef,
    audioLabPlaybackWantedRef,
    audioLabPlaybackLastPlayingAtRef,
    audioLabPlaybackStatusLogAtRef,
    audioLabPlaybackRecoverAtRef,
    audioLabPlaybackWatchdogErrorLogAtRef,
    audioLabInputNameRef,
    audioLabAirPodsInputRef,
    audioLabRecordingInactiveLoggedRef,
    recordingTuning,
    clearAudioLabInputPollTimer,
    clearAudioLabPlaybackWatchdogTimer,
    detectAudioLabInputRoute,
    startAudioLabInputRoutePolling,
    bindAudioLabPlaybackStatus,
    startAudioLabPlaybackWatchdog,
    stopAudioLabPlaybackOnly,
    stopWaveformPlayback,
    ensureMicReady,
    releaseRecording,
    setAudioModeForPlayback,
    setError,
    setAudioLabLastDb,
    setAudioLabMinDb,
    setAudioLabMaxDb,
    setAudioLabFlatlineMs,
    setAudioLabCallbackIntervalMs,
    setAudioLabPlaybackPositionMs,
    setAudioLabPlaybackStallMs,
    setAudioLabLoopCount,
    setAudioLabUnexpectedStopCount,
    setAudioLabPlaybackRecoverCount,
    setAudioLabInputName,
    setAudioLabAirPodsInput,
    setAudioLabNowMs,
    setAudioLabRecordingActive,
    setAudioLabPlaybackActive,
    setAudioLabRunning,
    logAudioLab,
    reportError,
    isRecordingNotAllowedError,
    isRecorderNotPreparedError,
    buildRecordingOptions,
    clampRecordingProgressUpdateIntervalMs,
  });
  const {
    appendAutoWaveformSample: appendAutoWaveformSampleFromController,
    decayAutoWaveformFrame: decayAutoWaveformFrameFromController,
    resetAutoWaveform: resetAutoWaveformFromController,
  } = useAutoWaveformStateController({
    autoWaveformDataPipelineEnabled: AUTO_WAVEFORM_DATA_PIPELINE_ENABLED,
    autoWaveformPoints: AUTO_WAVEFORM_POINTS,
    autoWaveformUpdateMs: AUTO_WAVEFORM_UPDATE_MS,
    autoWaveformDecayMinSignal: AUTO_WAVEFORM_DECAY_MIN_SIGNAL,
    autoWaveformDecayFactor: AUTO_WAVEFORM_DECAY_FACTOR,
    autoWaveformSkipLogThrottleMs: AUTO_WAVEFORM_SKIP_LOG_THROTTLE_MS,
    autoStartThresholdDb: AUTO_START_THRESHOLD_DB,
    ttsLoading,
    autoRecordingState,
    autoLastEvent,
    ttsPlayingRef,
    autoRecordingEnabledRef,
    autoBargeInEnabledRef,
    autoWaveformSkipLogAtRef,
    autoWaveformUiAtRef,
    autoWaveformLastSampleAtRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaveFlatlineSinceRef,
    autoWaveFlatlineLogAtRef,
    autoWaveFlatlineActiveRef,
    autoWaveFlatlineSourceRef,
    maybeLogWaveformSamplePath,
    logAuto,
    normalizeMetering,
    buildEmptyWaveformBars,
    setAutoWaveform: (updater) => setAutoWaveform(updater),
    setAutoWaveformSpeechMask: (updater) => setAutoWaveformSpeechMask(updater),
  });
  appendAutoWaveformSampleDelegateRef.current = appendAutoWaveformSampleFromController;
  decayAutoWaveformFrameDelegateRef.current = decayAutoWaveformFrameFromController;
  resetAutoWaveformDelegateRef.current = resetAutoWaveformFromController;

  function reportError(raw: unknown, scope = "app") {
    const message = raw instanceof Error ? raw.message : String(raw);
    console.error(`[${scope}]`, raw);
    setError(message);
    playUiSfx("error");
  }

  function commitTtsSpeedInput(raw: string) {
    setTtsSpeedWithSync(parseTtsSpeed(raw));
  }

  function prepareChatForOutgoingMessageWindow() {
    chatNearBottomRef.current = true;
  }

  function handleChatTouchStart() {
    chatTouchActiveRef.current = true;
    logChatScrollDiag("touch_event", {
      phase: "start",
      offsetY: chatScrollOffsetYRef.current,
      distanceToBottom: chatDistanceToBottomRef.current,
      nearBottom: chatNearBottomRef.current,
    }, {
      throttleMs: 0,
      throttleKey: `chat_scroll_touch_start:${Date.now()}`,
    });
  }

  function handleChatTouchEnd() {
    chatTouchActiveRef.current = false;
    logChatScrollDiag("touch_event", {
      phase: "end",
      offsetY: chatScrollOffsetYRef.current,
      distanceToBottom: chatDistanceToBottomRef.current,
      nearBottom: chatNearBottomRef.current,
    }, {
      throttleMs: 0,
      throttleKey: `chat_scroll_touch_end:${Date.now()}`,
    });
  }

  useEffect(() => {
    logChatScrollDiag("diag_config", {
      chatScrollDiagEnabled: CHAT_SCROLL_DIAG_ENABLED,
      thresholdPx: CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD,
      scrollThrottleMs: CHAT_SCROLL_DIAG_SCROLL_THROTTLE_MS,
    }, {
      throttleMs: 0,
      throttleKey: "chat_scroll_diag_config_once",
    });
  }, []);

  useAppStateAutoRecoveryController({
    appStateRef,
    appStateChangedAtRef,
    appStateLastNonActiveAtRef,
    autoWaveStatusLastAtRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastMeteringRef,
    autoShadowStatusLastDurationMsRef,
    autoStatusReadOwnerRef,
    autoStatusReadStartedAtRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoFinalizeLockRef,
    autoResumeStatusProbeInFlightRef,
    autoAppStateNonActiveTimerRef,
    autoRestartTimerRef,
    streamSocketRef,
    replyLoadingRef,
    elapsedSinceMs,
    logAuto,
    logSessionDiag,
    recoverTtsStreamAfterResume,
    flushAutoClientLogs: () => {
      void autoClientLogs.flush({ maxBatches: 8 });
    },
    flushSessionDiagClientLogs: () => {
      void sessionDiagClientLogs.flush({ maxBatches: 8 });
    },
    setAutoRecordingState,
    setAutoLastEvent,
    readRecordingStatusWithTimeout,
    clearAutoRecordingWatchdogTimer,
    releaseRecording,
    startAutoCaptureCycle,
    autoAppStateNonActiveApplyDelayMs: AUTO_APPSTATE_NON_ACTIVE_APPLY_DELAY_MS,
    appResumeStreamRecoveryNonActiveMinMs: APP_RESUME_STREAM_RECOVERY_NON_ACTIVE_MIN_MS,
    autoResumeStatusProbeTimeoutMs: AUTO_RESUME_STATUS_PROBE_TIMEOUT_MS,
  });

  useEffect(() => {
    if (activeScreen !== "mini_board") return;
    if (appStateRef.current !== "active") return;
    if (!runnerToken.trim()) return;
    for (const directory of registeredDirectories) {
      void refreshGitChangedFiles(directory.path, { force: true });
    }
  }, [activeScreen, refreshGitChangedFiles, registeredDirectories, runnerToken]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      if (activeScreen !== "mini_board") return;
      if (!runnerToken.trim()) return;
      for (const directory of registeredDirectories) {
        void refreshGitChangedFiles(directory.path, { force: true });
      }
    });
    return () => {
      sub.remove();
    };
  }, [activeScreen, refreshGitChangedFiles, registeredDirectories, runnerToken]);

  useCodexStatusRefreshEffects({
    activeScreen,
    runnerUrl,
    runnerToken,
    appStateRef,
    codexCliStatusLastAttemptAtMsRef,
    codexCliStatusAutoRefreshMs: CODEX_CLI_STATUS_AUTO_REFRESH_MS,
    refreshCodexCliStatusForWidget,
    refreshCodexAuthProfiles,
  });

  useEffect(() => {
    chatScrollOffsetYRef.current = chatScrollOffsetY;
  }, [chatScrollOffsetY]);

  const { importSettingsJson, logSettingsJson } = useAppSettingsPersistenceController({
    settingsLoaded,
    setSettingsLoaded,
    settingsFileName: SETTINGS_FILE_NAME,
    modelOptions: MODEL_OPTIONS,
    defaultModelRef: DEFAULT_MODEL_REF,
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    defaultRecordingQualityPreset: DEFAULT_RECORDING_QUALITY_PRESET,
    defaultSelectedVoiceIds: DEFAULT_SELECTED_VOICE_IDS,
    runnerUrl,
    runnerToken,
    llmBackend,
    llmDirectory,
    registeredDirectories,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    expandedDirectoryIds,
    selectedLlmSessionId,
    codexWsUrl,
    codexWsToken,
    modelRef,
    reasoningEffort,
    codexApprovalPolicy,
    ttsProvider,
    sttProvider,
    recordingQualityPreset,
    recordingTuning,
    faceTrackingEnabled,
    ttsSpeed,
    selectedVoiceIdByProvider,
    autoBargeInEnabled,
    autoSpeakerPriorityEnabled,
    autoTranscribeOnStop,
    autoReplyAfterStt,
    autoSpeakAfterReply,
    toolAutoApprovalMap,
    llmToolLogCompact,
    setRunnerUrl,
    setRunnerToken,
    setLlmDirectory,
    setRegisteredDirectories,
    setSessionTitleOverridesById,
    setSessionMarkerColorsById,
    setExpandedDirectoryIds,
    setSelectedLlmSessionId,
    selectedLlmSessionIdRef,
    llmConversationSessionIdRef,
    rememberKnownCodexThreadId,
    setCodexWsUrl,
    setCodexWsToken,
    setModelRef,
    setReasoningEffort,
    setCodexApprovalPolicy,
    setSelectedVoiceIdByProvider,
    setTtsProvider,
    setSttProvider,
    setRecordingQualityPreset,
    setRecordingTuning,
    setFaceTrackingEnabledWithRef,
    setTtsSpeedWithSync,
    setToolAutoApprovalMap,
    setLlmToolLogCompact,
    setAutoTranscribeOnStop,
    setAutoBargeInEnabled,
    setAutoSpeakerPriorityEnabled,
    setAutoReplyAfterStt,
    setAutoSpeakAfterReply,
    parseRegisteredDirectories,
    parseSessionTitleOverrides,
    parseSessionMarkerColors,
    parseExpandedDirectoryIds,
  });

  useEffect(() => {
    const normalizedDirectory = normalizedLlmDirectoryForRequest();
    if (!settingsLoaded) {
      llmSessionDirectoryRef.current = normalizedDirectory;
      return;
    }
    if (llmSessionDirectoryRef.current === normalizedDirectory) return;
    llmSessionDirectoryRef.current = normalizedDirectory;
    if (llmSessionRestoreInFlightRef.current || llmSessionRestoreLoadingRef.current) {
      setReplyDebug((prev) => (
        prev
          ? `${prev} | directory_change_reset_skipped reason=session_restore directory=${normalizedDirectory}`
          : `directory_change_reset_skipped reason=session_restore directory=${normalizedDirectory}`
      ));
      return;
    }
    startNewSession({ directory: normalizedDirectory });
  }, [llmDirectory, settingsLoaded]);

  useEffect(() => {
    if (!drawerOpen) {
      drawerSessionPrefetchRequestedForOpenRef.current = false;
      return;
    }
    if (drawerSessionPrefetchRequestedForOpenRef.current) return;
    drawerSessionPrefetchRequestedForOpenRef.current = true;
    void prefetchDirectorySessionTreesForDrawerOpen();
  }, [drawerOpen, prefetchDirectorySessionTreesForDrawerOpen]);

  useSessionStartupRecoveryController({
    settingsLoaded,
    startupSessionRestoreAttemptedRef,
    conversationMessagesRef,
    codexWsUrl,
    normalizedLlmDirectoryForRequest,
    parseOptionalSessionId,
    selectedLlmSessionId,
    getLlmConversationSessionId,
    selectSpecificLlmSession,
    fetchLatestSessionIdForDirectory,
    clearSelectedLlmSession,
    setLlmSessionRestoreError,
    activeScreen,
    llmSessionRestoreLoading,
    replyLoadingRef,
    streamSocketRef,
    appResumeSessionSyncInFlightRef,
    appResumeSessionSyncLastAtRef,
    setReplyDebug,
    logSessionDiag,
    llmDirectory,
    llmBackend,
    codexWsToken,
  });

  useEffect(() => {
    return () => {
      closeCodexRelayObserver("app_unmount");
    };
  }, []);

  useEffect(() => {
    if (activeScreen !== "mini_board") return;
    if (chatNearBottomRef.current) return;
    const last = conversationMessages[conversationMessages.length - 1];
    if (!last) return;
    if (!markConversationMessageToasted(last.id)) return;
    showChatBottomToast(last.role, last.content);
  }, [activeScreen, conversationMessages, markConversationMessageToasted, showChatBottomToast]);

  useEffect(() => {
    if (activeScreen !== "mini_board") return;
    if (!replyLoading) return;
    if (chatNearBottomRef.current) return;
    const nextReply = String(reply || "").trim();
    if (!nextReply) return;
    if (!shouldShowReplyPreviewToast(nextReply, CHAT_BOTTOM_TOAST_REPLY_THROTTLE_MS)) return;
    showChatBottomToast("assistant", nextReply);
  }, [activeScreen, reply, replyLoading, shouldShowReplyPreviewToast, showChatBottomToast]);

  useEffect(() => {
    if (activeScreen === "mini_board") return;
    hideChatBottomToast();
  }, [activeScreen, hideChatBottomToast]);

  const shouldKeepAwake = (
    Platform.OS === "ios" &&
    activeScreen === "mini_board" &&
    (
      replyLoading ||
      sttLoading ||
      ttsLoading ||
      ttsPlaying ||
      manualRecording !== null ||
      autoRecordingEnabled ||
      directNativeSttEnabled
    )
  );
  useEffect(() => {
    if (!shouldKeepAwake) {
      deactivateKeepAwake(CONVERSATION_KEEP_AWAKE_TAG);
      return;
    }
    void activateKeepAwakeAsync(CONVERSATION_KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(CONVERSATION_KEEP_AWAKE_TAG);
    };
  }, [shouldKeepAwake]);

  useEffect(() => {
    youtubeVideoMetaByIdRef.current = youtubeVideoMetaById;
  }, [youtubeVideoMetaById]);

  useEffect(() => {
    streamReplyYouTubeVideoIdsRef.current = streamReplyYouTubeVideoIds;
  }, [streamReplyYouTubeVideoIds]);

  useEffect(() => {
    youtubePlayerVideoIdRef.current = youtubePlayerVideoId;
  }, [youtubePlayerVideoId]);

  useEffect(() => {
    youtubePlayerMessageIdRef.current = youtubePlayerMessageId;
  }, [youtubePlayerMessageId]);

  useEffect(() => {
    youtubePlayerSessionRef.current = youtubePlayerSession;
  }, [youtubePlayerSession]);

  useEffect(() => {
    return () => {
      clearYouTubePauseConfirmTimer();
      clearYouTubeControlToDragTimer();
    };
  }, []);

  useEffect(() => {
    if (!latestAssistantYouTubeVideoIds.length) return;
    void fetchYouTubeVideoMetadata(latestAssistantYouTubeVideoIds);
  }, [latestAssistantYouTubeVideoIds, runnerToken, runnerUrl]);

  useEffect(() => {
    if (!streamReplyYouTubeVideoIds.length) return;
    void fetchYouTubeVideoMetadata(streamReplyYouTubeVideoIds);
  }, [streamReplyYouTubeVideoIds, runnerToken, runnerUrl]);

  useEffect(() => {
    if (activeScreen !== "mini_board") return;
    if (!latestAssistantYouTubeMessage) return;
    if (!latestAssistantYouTubeMessage.videoIds.length) return;
    if (lastAutoOpenedYouTubeMessageIdRef.current === latestAssistantYouTubeMessage.id) return;
    lastAutoOpenedYouTubeMessageIdRef.current = latestAssistantYouTubeMessage.id;
    openYouTubeVideo(latestAssistantYouTubeMessage.videoIds[0], latestAssistantYouTubeMessage.id, {
      queueVideoIds: latestAssistantYouTubeMessage.videoIds,
      queueIndex: 0,
    });
  }, [activeScreen, latestAssistantYouTubeMessage]);

  useEffect(() => {
    return () => {
      if (ttsSound) {
        void ttsSound.unloadAsync().catch(() => {});
      }
    };
  }, [ttsSound]);

  useAppUnmountCleanupController({
    conversationKeepAwakeTag: CONVERSATION_KEEP_AWAKE_TAG,
    clearPendingApprovals,
    hideChatBottomToast,
    autoRecordingEnabledRef,
    resetAutoPendingUserState,
    autoClientLogs,
    clearAutoRecordingWatchdogTimer,
    autoRestartTimerRef,
    autoAppStateNonActiveTimerRef,
    autoRecordingRef,
    releaseRecording,
    streamSocketRef,
    cleanupRecordingTranscription,
    cleanupDirectNativeStt,
    faceTrackingSessionRef,
    clearAudioLabInputPollTimer,
    clearAudioLabPlaybackWatchdogTimer,
    audioLabClientLogs,
    clearTtsPlaybackWatchdogTimer,
    ttsPlaybackWantedRef,
    ttsPlaybackTransitionInFlightRef,
    ttsStopInFlightRef,
    audioLabActionInFlightRef,
    audioLabPlaybackWantedRef,
    audioLabRecordingRef,
    audioLabSoundRef,
  });

  useEffect(() => {
    if (!AUTO_WAVEFORM_DATA_PIPELINE_ENABLED) return;
    if (!manualRecording && !autoRecordingEnabled) return;
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - autoWaveformLastSampleAtRef.current < AUTO_WAVEFORM_DECAY_TRIGGER_MS) return;
      decayAutoWaveformFrame(now);
    }, AUTO_WAVEFORM_UPDATE_MS);
    return () => clearInterval(timer);
  }, [manualRecording, autoRecordingEnabled]);

  useEffect(() => {
    if (!autoRecordingEnabled) return;
    const timer = setInterval(() => {
      const metering = autoUiLatestMeteringRef.current;
      if (typeof metering !== "number") return;
      setAutoMeteringDb(metering);
      appendAutoWaveformSample(metering, autoUiLatestSpeechSampleRef.current);
    }, AUTO_METER_UI_UPDATE_MS);
    return () => clearInterval(timer);
  }, [autoRecordingEnabled, ttsLoading, autoRecordingState, autoLastEvent]);

  useEffect(() => {
    void setAudioModeForPlayback({ reason: "app_boot" }).catch(() => {});
  }, []);

  useEffect(() => {
    autoReplyAfterSttRef.current = autoReplyAfterStt;
  }, [autoReplyAfterStt]);

  useEffect(() => {
    autoBargeInEnabledRef.current = autoBargeInEnabled;
  }, [autoBargeInEnabled]);

  useEffect(() => {
    autoSpeakerPriorityEnabledRef.current = autoSpeakerPriorityEnabled;
  }, [autoSpeakerPriorityEnabled]);

  useEffect(() => {
    autoSpeakAfterReplyRef.current = autoSpeakAfterReply;
  }, [autoSpeakAfterReply]);

  useEffect(() => {
    toolAutoApprovalMapRef.current = toolAutoApprovalMap;
  }, [toolAutoApprovalMap]);

  useEffect(() => {
    sttLoadingRef.current = sttLoading;
  }, [sttLoading]);

  useEffect(() => {
    sttProviderRef.current = sttProvider;
  }, [sttProvider]);

  useEffect(() => {
    faceTrackingEnabledRef.current = faceTrackingEnabled;
  }, [faceTrackingEnabled]);

  useEffect(() => {
    faceTrackingLookingRef.current = faceTrackingLooking;
  }, [faceTrackingLooking]);

  useEffect(() => {
    faceTrackingFaceDetectedRef.current = faceTrackingFaceDetected;
  }, [faceTrackingFaceDetected]);

  useEffect(() => {
    const shouldRunFaceTracking = (
      Platform.OS === "ios" &&
      faceTrackingEnabled &&
      activeScreen === "mini_board" &&
      (
        autoRecordingEnabled ||
        (sttProvider === "ios_native_direct" && directNativeSttEnabled)
      )
    );
    const syncToken = faceTrackingSyncTokenRef.current + 1;
    faceTrackingSyncTokenRef.current = syncToken;
    let disposed = false;

    async function syncFaceTrackingSession() {
      const currentSession = faceTrackingSessionRef.current;
      if (!shouldRunFaceTracking) {
        faceTrackingSuppressedRef.current = false;
        if (!currentSession) {
          if (!faceTrackingEnabled) {
            setFaceTrackingRunning(false);
            setFaceTrackingFaceDetected(false);
            setFaceTrackingLooking(true);
          }
          return;
        }
        faceTrackingSessionRef.current = null;
        await currentSession.stop().catch(() => {});
        if (disposed || faceTrackingSyncTokenRef.current !== syncToken) return;
        setFaceTrackingRunning(false);
        setFaceTrackingFaceDetected(false);
        setFaceTrackingLooking(true);
        return;
      }
      if (currentSession) return;
      if (!isIosFaceTrackingAvailable()) {
        reportError(
          "Face Tracking は iOS Development Build でのみ利用できます。",
          "face_tracking"
        );
        setFaceTrackingEnabledWithRef(false);
        return;
      }
      try {
        const nextSession = await startIosFaceTrackingSession({
          onState: (state) => {
            applyFaceTrackingState(state);
          },
          onError: (error) => {
            const message = error instanceof Error ? error.message : String(error);
            logAuto("face_tracking_error", { message });
          },
        });
        if (disposed || faceTrackingSyncTokenRef.current !== syncToken || !faceTrackingEnabledRef.current) {
          await nextSession.stop().catch(() => {});
          return;
        }
        faceTrackingSessionRef.current = nextSession;
      } catch (error) {
        reportError(error, "face_tracking:start");
        setFaceTrackingEnabledWithRef(false);
      }
    }

    void syncFaceTrackingSession();
    return () => {
      disposed = true;
    };
  }, [
    activeScreen,
    autoRecordingEnabled,
    directNativeSttEnabled,
    faceTrackingEnabled,
    sttProvider,
  ]);

  useEffect(() => {
    if (!AUTO_WAVEFORM_DEBUG_OVERLAY_ENABLED) return;
    const isRecordingActive = Boolean(manualRecording) || autoRecordingEnabled;
    if (!isRecordingActive) return;
    setAutoWaveDebugNowMs(Date.now());
    const timer = setInterval(() => {
      setAutoWaveDebugNowMs(Date.now());
    }, 240);
    return () => clearInterval(timer);
  }, [manualRecording, autoRecordingEnabled]);

  useEffect(() => {
    if (!audioLabRunning) return;
    setAudioLabNowMs(Date.now());
    const timer = setInterval(() => {
      setAudioLabNowMs(Date.now());
    }, 240);
    return () => clearInterval(timer);
  }, [audioLabRunning]);

  useEffect(() => {
    if (activeScreen === "audio_lab") return;
    if (!audioLabRunning && !audioLabRecordingRef.current && !audioLabSoundRef.current) return;
    void stopAudioLabProbe("screen_changed");
  }, [activeScreen, audioLabRunning]);

  useEffect(() => {
    const isRecordingActive = Boolean(manualRecording) || autoRecordingEnabled;
    if (!AUTO_DIAGNOSTICS_ENABLED) return;
    if (!isRecordingActive) return;
    autoWaveformVersionRef.current += 1;
    const now = Date.now();
    if (now - autoWaveStateLogAtRef.current < AUTO_WAVEFORM_STATE_LOG_THROTTLE_MS) return;
    autoWaveStateLogAtRef.current = now;
    const len = autoWaveform.length;
    let peak = 0;
    let floor = 1;
    let sum = 0;
    for (let i = 0; i < len; i += 1) {
      const value = Number(autoWaveform[i] || 0);
      peak = Math.max(peak, value);
      floor = Math.min(floor, value);
      sum += value;
    }
    const tail = len > 0 ? Number(autoWaveform[len - 1] || 0) : 0;
    logAuto("waveform_state_updated", {
      version: autoWaveformVersionRef.current,
      len,
      peak: Number(peak.toFixed(4)),
      floor: Number((Number.isFinite(floor) ? floor : 0).toFixed(4)),
      tail: Number(tail.toFixed(4)),
      avg: Number((len > 0 ? sum / len : 0).toFixed(4)),
      sinceLastSampleMs: elapsedSinceMs(autoWaveformLastSampleAtRef.current),
      sinceLastUiMs: elapsedSinceMs(autoWaveformUiAtRef.current),
    });
  }, [autoWaveform, manualRecording, autoRecordingEnabled]);

  useEffect(() => {
    const isRecordingActive = Boolean(manualRecording) || autoRecordingEnabled;
    if (!AUTO_DIAGNOSTICS_ENABLED) return;
    if (!isRecordingActive) return;
    autoSpectrumVersionRef.current += 1;
    const now = Date.now();
    if (now - autoWaveRenderLogAtRef.current < AUTO_WAVEFORM_RENDER_LOG_THROTTLE_MS) return;
    autoWaveRenderLogAtRef.current = now;
    const len = autoSpectrumBars.length;
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < len; i += 1) {
      const value = Number(autoSpectrumBars[i] || 0);
      peak = Math.max(peak, value);
      sum += value;
    }
    const head = len > 0 ? Number(autoSpectrumBars[0] || 0) : 0;
    const mid = len > 0 ? Number(autoSpectrumBars[Math.floor(len / 2)] || 0) : 0;
    const tail = len > 0 ? Number(autoSpectrumBars[len - 1] || 0) : 0;
    const digest = [
      Math.round(head * 1000),
      Math.round(mid * 1000),
      Math.round(tail * 1000),
      Math.round(peak * 1000),
    ].join("-");
    logAuto("waveform_render_snapshot", {
      version: autoSpectrumVersionRef.current,
      len,
      peak: Number(peak.toFixed(4)),
      avg: Number((len > 0 ? sum / len : 0).toFixed(4)),
      head: Number(head.toFixed(4)),
      mid: Number(mid.toFixed(4)),
      tail: Number(tail.toFixed(4)),
      digest,
      waveformVersion: autoWaveformVersionRef.current,
      sinceLastSampleMs: elapsedSinceMs(autoWaveformLastSampleAtRef.current),
      sinceLastUiMs: elapsedSinceMs(autoWaveformUiAtRef.current),
    });
  }, [autoSpectrumBars, manualRecording, autoRecordingEnabled]);

  function recoverTtsStreamAfterResume(reason: string) {
    const ws = streamSocketRef.current;
    if (ws) {
      ws.close();
      streamSocketRef.current = null;
    }
    clearStreamAudioQueue();
    streamAudioWaveformBarsRef.current = [];
    setStreamWaveformPreview([]);
    streamTtsSuppressedRef.current = false;
    setTtsLoading(false);
    setTtsUiStatus("idle");
    syncTtsPlaybackWantedFromPipeline("resume_recovered");
    logAuto("stream_tts_resume_recovered", {
      reason,
      hadSocket: Boolean(ws),
      ttsPlaying: ttsPlayingRef.current,
      queuedAudio: streamAudioQueueRef.current.length,
    });
    logSessionDiag("stream_tts_resume_recovered", {
      reason,
      hadSocket: Boolean(ws),
      ttsPlaying: ttsPlayingRef.current,
      queuedAudio: streamAudioQueueRef.current.length,
    }, {
      throttleMs: 0,
      throttleKey: `stream_tts_resume_recovered:${reason}`,
    });
  }

  async function startAutoCaptureCycleCore(captureCycleId: number) {
    await runAutoCaptureCycleCore({
      captureCycleId,
      startAutoCaptureCycle,
      finalizeAutoCapture,
    });
  }

  const { appendSlashCommandResult, appendSlashCommandProgress } = useSlashCommandResultAppender({
    buildConversationMessage,
    getConversationMessages: (conversationId) => (
      getPanelConversationMessagesForCodexRef.current(conversationId)
    ),
    getConversationMessagesBySessionId: (sessionId) => (
      getConversationRuntimeSnapshot(sessionId)?.conversationMessages || []
    ),
    setConversationMessages: (conversationId, messages, options) => {
      setPanelConversationMessagesForCodexRef.current(conversationId, messages, options);
    },
  });
  const { runSlashStatusCommand } = useSlashStatusCommandController({
    fetchRunnerCodexCliStatusForSlash,
    applyCodexCliStatusSnapshot,
    fetchRunnerLlmRuntimeLimitsForStatus,
    llmRuntimeLimits,
    llmBackend,
    normalizedLlmDirectoryForRequest,
    modelRef,
    reasoningEffort,
    codexApprovalPolicy,
    chatContextUsedPct,
    appendSlashCommandResult,
    setReplyDebug,
  });
  const [codexCompactRunningVersion, setCodexCompactRunningVersion] = useState(0);
  const codexCompactRunningThreadIdsRef = useRef<Set<string>>(new Set());
  const setCodexCompactRunning = useCallback((threadIdRaw: string, running: boolean) => {
    const threadId = String(threadIdRaw || "").trim();
    if (!threadId) return;
    const wasRunning = codexCompactRunningThreadIdsRef.current.has(threadId);
    if (running) {
      codexCompactRunningThreadIdsRef.current.add(threadId);
    } else {
      codexCompactRunningThreadIdsRef.current.delete(threadId);
    }
    if (wasRunning !== running) {
      setCodexCompactRunningVersion((version) => version + 1);
    }
  }, []);
  const isCodexCompactRunning = useCallback((threadIdRaw: string) => {
    const threadId = String(threadIdRaw || "").trim();
    return !!threadId && codexCompactRunningThreadIdsRef.current.has(threadId);
  }, [codexCompactRunningVersion]);
  const runSlashCancelQueueCommand = useCallback(async (
    commandText: string,
    options?: Parameters<typeof appendSlashCommandResult>[2]
  ) => {
    const queuedTurnId = String(commandText || "").trim().split(/\s+/)[1] || "";
    if (!queuedTurnId) {
      appendSlashCommandResult(
        commandText,
        "キャンセルする queueId を指定してください。例: /cancel-queue codexq_xxx",
        options
      );
      return true;
    }
    try {
      const result = await cancelRunnerCodexQueuedTurn({
        wsUrl: codexWsUrl.trim(),
        wsToken: codexWsToken.trim(),
        queuedTurnId,
      });
      appendSlashCommandResult(
        commandText,
        [
          "queueをキャンセルしました。",
          `- queueId: ${result.queuedTurn.queuedTurnId}`,
          `- status: ${result.queuedTurn.status}`,
        ].join("\n"),
        options
      );
    } catch (error) {
      appendSlashCommandResult(
        commandText,
        `queueキャンセルに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        options
      );
    }
    return true;
  }, [appendSlashCommandResult, codexWsToken, codexWsUrl]);
  const cancelCodexQueuedTurnForMessage = useCallback(async (params: {
    queuedTurnId: string;
    messageId: string;
    panelId?: string;
  }) => {
    const queuedTurnId = String(params.queuedTurnId || "").trim();
    const messageId = String(params.messageId || "").trim();
    const panelId = normalizeRuntimePanelId(params.panelId);
    if (!queuedTurnId || !messageId) return;
    try {
      const result = await cancelRunnerCodexQueuedTurn({
        wsUrl: codexWsUrl.trim(),
        wsToken: codexWsToken.trim(),
        queuedTurnId,
      });
      const rawStatus = String(result.queuedTurn.status || "").trim();
      const status = (
        ["queued", "waiting_compact", "running", "completed", "failed", "cancelled"].includes(rawStatus)
          ? rawStatus
          : "failed"
      ) as NonNullable<ConversationMessage["codexQueue"]>["status"];
      const patch = {
        codexQueue: {
          queuedTurnId,
          status,
          errorMessage: result.queuedTurn.errorMessage || undefined,
        },
      };
      const messages = getPanelConversationMessagesForCodexRef.current(panelId);
      setPanelConversationMessagesForCodexRef.current(
        panelId,
        messages.map((message) => (
          message.id === messageId ? { ...message, ...patch } : message
        )),
        { isResponding: false }
      );
      showChatBottomToast("assistant", "queueをキャンセルしました。");
    } catch (error) {
      logSessionDiag("codex_queue_cancel_from_message_failed", {
        queuedTurnId,
        messageId,
        panelId,
        message: error instanceof Error ? error.message : String(error),
      }, { throttleMs: 0 });
      showChatBottomToast("assistant", `queueキャンセルに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [
    codexWsToken,
    codexWsUrl,
    logSessionDiag,
    showChatBottomToast,
  ]);
  const { runSlashCompactCommand } = useSlashCompactCommandController({
    codexWsUrl,
    codexWsToken,
    nearUnlimitedTimeoutMs: NEAR_UNLIMITED_TIMEOUT_MS,
    normalizedLlmDirectoryForRequest,
    fetchRunnerSessionContextUsedPct,
    setReplyDebug,
    appendSlashCommandResult,
    appendSlashCommandProgress,
    speakSlashCommandResult: (text) => synthesizeSpeech(text),
    setCodexCompactRunning,
    logSessionDiag,
  });
  const { runSlashCommand } = useSlashCommandController({
    setTranscript,
    runSlashStatusCommand,
    runSlashCompactCommand,
    runSlashCancelQueueCommand,
  });

  const {
    testHardcodedCodexWsConnection,
    uploadCodexWsPreflightLog,
    runCodexWsDiagnosticsAndUpload,
    runRunner8788ReachabilitySuite,
    runCodexWsE2eTurnAndUpload,
    testHardcodedCodexWsHandshakeOnly,
  } = useCodexWsDiagnosticsController({
    defaultCodexWsUrl: DEFAULT_CODEX_WS_URL,
    nearUnlimitedTimeoutMs: NEAR_UNLIMITED_TIMEOUT_MS,
    executionEnvironment: EXPO_EXECUTION_ENVIRONMENT,
    isExpoGo: IS_EXPO_GO,
    codexWsUrl,
    codexWsToken,
    runnerToken,
    activeScreen,
    autoRecordingState,
    autoLastEvent,
    ttsLoading,
    modelRef,
    reasoningEffort,
    codexApprovalPolicy,
    codexWsProbeLoading,
    codexWsDiagLoading,
    runner8788SuiteLoading,
    codexWsE2eLoading,
    codexWsHandshakeProbeLoading,
    autoClientSessionIdRef: autoClientLogs.sessionIdRef,
    autoRecordingEnabledRef,
    ttsPlayingRef,
    replyLoadingRef,
    codexHandshakeProbeSocketRef,
    baseUrl,
    normalizedLlmDirectoryForRequest,
    handleApprovalRequest: handleRuntimeApprovalRequest,
    setError,
    setReplyDebug,
    setCodexWsProbeLoading,
    setCodexWsDiagLoading,
    setCodexWsDiagStatus,
    setRunner8788SuiteLoading,
    setRunner8788SuiteStatus,
    setCodexWsE2eLoading,
    setCodexWsE2eStatus,
    setCodexWsHandshakeProbeLoading,
    setCodexWsHandshakeProbeStatus,
  });

  const handleLlmMessageCompleted = useCallback((directory: string) => {
    void refreshGitChangedFiles(directory, { force: true });
    refreshMiniBoardDirectorySessionsForDirectory(directory, "llm_message_completed");
  }, [
    refreshMiniBoardDirectorySessionsForDirectory,
    refreshGitChangedFiles,
  ]);

	  const {
	    sendReplyRequest: sendReplyRequestFromCodex,
    cancelReplyRequest: cancelReplyRequestFromCodex,
    suspendReplyRequest: suspendReplyRequestFromCodex,
    restoreReplyRequestForThread,
  } = useCodexReplyRequest<
    ConversationMessage,
    SttMessageMeta,
    HistoryEntry
  >({
    transcript,
    codexWsUrl,
    codexWsToken,
    modelRef,
    reasoningEffort,
    codexApprovalPolicy,
    autoSpeakAfterReply,
    isChatOpenForAutoSpeech,
    conversationMessagesRef,
    replyLoadingRef,
    streamSocketRef,
    streamAudioWaveformBarsRef,
    streamTtsSuppressedRef,
    llmRequestStartedAtRef,
    setTranscript,
    setReply,
    setReplyLoadingWithRef,
    setError,
    setReplyDebug,
    setStreamMode,
    setStreamLlmNativeDeltaCount,
    setStreamLlmPseudoDeltaCount,
    setStreamFirstNativeDeltaOffsetMs,
    resetStreamLlmDeltas: () => setStreamLlmDeltas([]),
    resetStreamLlmProgress: () => setStreamLlmProgress([]),
    resetStreamSegments: () => setStreamSegments([]),
    setStreamWaveformPreview,
    setTtsPlaybackMessageIdWithRef,
    setStreamReplyYouTubeVideoIdsWithRef,
    clearStreamAudioQueue,
    runSlashCommand,
    prepareChatForOutgoingMessageWindow,
    setConversationMessagesWithLimit,
    buildConversationMessage,
    setHistory,
    createHistoryEntry,
    getPanelConversationMessages: (panelId) => (
      getPanelConversationMessagesForCodexRef.current(panelId)
    ),
    setPanelConversationMessages: (panelId, messages, options) => {
      setPanelConversationMessagesForCodexRef.current(panelId, messages, options);
    },
    normalizedLlmDirectoryForRequest,
    isCodexCompactRunning,
    syncLlmConversationSessionId,
    rememberKnownCodexThreadId,
    handleApprovalRequest: handleRuntimeApprovalRequest,
    setSelectedThreadStatusType,
    appendLlmDelta,
    applyAssistantReply,
    updateLlmStatus,
    startLlmRequest,
    finishLlmRequest,
    parseContextUsageUsedPct,
    fetchRunnerSessionContextUsedPct,
    extractYouTubeVideoIds,
    stripYouTubeTags,
    fetchYouTubeVideoMetadata,
    synthesizeSpeechStream,
    playUiSfx: (key) => playUiSfx(key),
    logAuto,
    logSessionDiag: (event, payload, options) => {
      logSessionDiag(event, payload, options);
    },
    uploadCodexWsPreflightLog,
    trimForInline,
    reportError,
    updateConversationRuntimeRequest: (input) => {
      const isRespondingRequest = isConversationRuntimeRequestResponding(input);
      const requestThreadStatusType = isRespondingRequest
        ? (input.status === "tool_waiting_approval" ? "waiting_approval" : "active")
        : "idle";
      upsertConversationRuntimeSnapshot({
        sessionId: input.sessionId,
        isResponding: isRespondingRequest,
        selectedThreadStatusType: requestThreadStatusType,
        request: input,
      });
    },
    startCodexRelayObserverForSession,
    onLlmMessageCompleted: handleLlmMessageCompleted,
  });

  const {
    sendReplyRequestWithSessionGuard,
    cancelCodexTurnRequestGuarded,
    suspendCodexTurnRequestForSessionSwitchGuarded,
  } = useSendReplyRequestController<SttMessageMeta>({
    queueSendReplyAfterSessionRestore,
    showChatBottomToast,
    normalizedLlmDirectoryForRequest,
    closeCodexRelayObserver,
    logSessionDiag,
    sendReplyRequestFromCodex,
    llmBackend,
    cancelReplyRequestFromCodex,
    suspendReplyRequestFromCodex,
  });

  type WriteSessionSnapshot = {
    sessionId?: string;
    threadId?: string;
    directory?: string;
    directoryDisplayName?: string;
    sessionTitle?: string;
    modelRef?: string;
    reasoningEffort?: ReasoningEffort | string;
    source?: string;
  };

  function resolveWritePanelId(panelIdRaw: unknown): string | null {
    const panelId = normalizeRuntimePanelId(panelIdRaw);
    if (panelRuntimeEntriesById[panelId]) return panelId;
    logSessionDiag("panel_write_rejected_unknown_panel", {
      panelId,
      reason: "unknown_panel_id",
    }, {
      throttleMs: 1000,
      throttleKey: `panel_write_rejected_unknown_panel:${panelId}`,
    });
    return null;
  }

  function resolvePanelWriteSessionSnapshot(panelId: string): WriteSessionSnapshot | undefined {
    if (!panelId) return undefined;
    const entry = panelRuntimeEntriesById[panelId];
    const snapshot = entry?.snapshot;
    if (!snapshot) return undefined;
    const sessionId = String(snapshot.selectedSessionId || "").trim();
    if (!sessionId) {
      logSessionDiag("panel_write_missing_session_snapshot", {
        panelId,
      }, {
        throttleMs: 1000,
        throttleKey: `panel_write_missing_session_snapshot:${panelId}`,
      });
      return undefined;
    }
    const directory = String(snapshot.selectedDirectoryPath || "").trim() || normalizedLlmDirectoryForRequest();
    const threadId = isKnownCodexThreadId(sessionId) ? sessionId : "";
    logSessionDiag("panel_write_session_snapshot_resolved", {
      panelId,
      sessionId,
      threadId: threadId || undefined,
      directory,
      knownCodexThreadId: isKnownCodexThreadId(sessionId),
    }, {
      throttleMs: 0,
      throttleKey: `panel_write_session_snapshot_resolved:${panelId}:${Date.now()}`,
    });
    return {
      sessionId,
      threadId,
      directory,
      directoryDisplayName: String(snapshot.selectedDirectoryDisplayName || "").trim(),
      sessionTitle: String(snapshot.selectedSessionTitle || "").trim(),
      modelRef: normalizeModelRef(snapshot.modelRef),
      reasoningEffort: String(snapshot.reasoningEffort || "").trim(),
      source: `panel_runtime_snapshot:panel=${panelId}`,
    };
  }

  async function sendReplyRequest(
    transcriptOverride?: string,
    options?: { sttMeta?: SttMessageMeta; panelId?: string; sessionSnapshot?: WriteSessionSnapshot }
  ) {
    const requestPanelId = normalizeRuntimePanelId(options?.panelId);
    const requestSessionSnapshot = options?.sessionSnapshot;
    logSessionDiag("reply_send_requested", {
      panelId: requestPanelId,
      transcriptChars: typeof transcriptOverride === "string" ? transcriptOverride.trim().length : null,
      hasSttMeta: !!options?.sttMeta,
      hasSessionSnapshot: !!requestSessionSnapshot,
      requestSessionId: String(requestSessionSnapshot?.sessionId || "").trim() || undefined,
      requestThreadId: String(requestSessionSnapshot?.threadId || "").trim() || undefined,
      requestDirectory: String(requestSessionSnapshot?.directory || "").trim() || undefined,
    }, { throttleMs: 0 });
    const resolvedPanelId = resolveWritePanelId(options?.panelId);
    if (!resolvedPanelId) {
      showChatBottomToast("assistant", "不明なパネルIDのため送信を中止しました。");
      return;
    }
    const panelSessionSnapshot = resolvePanelWriteSessionSnapshot(resolvedPanelId);
    if (!panelSessionSnapshot && !options?.sessionSnapshot) {
      showChatBottomToast("assistant", "パネルのセッション情報が未同期です。少し待ってから再送してください。");
      return;
    }
    const nextOptions = {
      ...options,
      panelId: resolvedPanelId,
      sessionSnapshot: options?.sessionSnapshot || panelSessionSnapshot,
    };
    const effectiveSnapshot = nextOptions.sessionSnapshot;
    logSessionDiag("reply_send_dispatch_to_guard", {
      panelId: resolvedPanelId,
      hasSessionSnapshot: !!effectiveSnapshot,
      sessionId: String(effectiveSnapshot?.sessionId || "").trim() || undefined,
      threadId: String(effectiveSnapshot?.threadId || "").trim() || undefined,
      directory: String(effectiveSnapshot?.directory || "").trim() || undefined,
      source: String(effectiveSnapshot?.source || "").trim() || undefined,
    }, { throttleMs: 0 });
    await sendReplyRequestWithSessionGuard(transcriptOverride, nextOptions);
  }

  async function cancelCodexTurnRequest(options?: { panelId?: string }) {
    await cancelCodexTurnRequestGuarded(options);
  }

  function suspendCodexTurnRequestForSessionSwitch(options?: { panelId?: string }) {
    return suspendCodexTurnRequestForSessionSwitchGuarded(options);
  }

  async function sendReplyTranscript(
    transcriptOverride?: string,
    options?: { sttMeta?: SttMessageMeta; panelId?: string; sessionSnapshot?: WriteSessionSnapshot }
  ) {
    const resolvedPanelId = resolveWritePanelId(options?.panelId);
    if (!resolvedPanelId) {
      showChatBottomToast("assistant", "不明なパネルIDのため送信を中止しました。");
      return;
    }
    const panelSessionSnapshot = resolvePanelWriteSessionSnapshot(resolvedPanelId);
    if (!panelSessionSnapshot && !options?.sessionSnapshot) {
      showChatBottomToast("assistant", "パネルのセッション情報が未同期です。少し待ってから再送してください。");
      return;
    }
    const effectiveOptions = {
      ...options,
      panelId: resolvedPanelId,
      sessionSnapshot: options?.sessionSnapshot || panelSessionSnapshot,
    };
    const effectiveTranscript = (transcriptOverride ?? transcript).trim();
    if (queueSendReplyAfterSessionRestore(transcriptOverride, effectiveOptions, "send_reply_transcript")) {
      return;
    }
    if (await runSlashCommand(effectiveTranscript, {
      clearInput: typeof transcriptOverride === "undefined",
      sttMeta: effectiveOptions?.sttMeta,
      panelId: resolvedPanelId,
      sessionSnapshot: effectiveOptions?.sessionSnapshot,
    })) {
      return;
    }
    await sendReplyRequest(transcriptOverride, effectiveOptions);
  }

  const {
    openDrawer,
    closeDrawer,
    openDebugScreen,
    openAudioLabScreen,
    openMiniBoardScreen,
    changeRunnerUrl,
    changeLlmDirectory,
    changeCodexWsUrl,
    changeCodexWsToken,
    changeRunnerToken,
    selectCodexApprovalPolicy,
    openModelSelect,
    openThinkSelect,
    selectModel,
    selectThinkOption,
    probeCurrentWsFromContext,
    probeHandshakeOnlyFromContext,
    runWsDiagFromContext,
    runAuxServerSuiteFromContext,
    runWsE2eFromContext,
    loadLlmRuntimeLimitsFromContext,
    updateLlmToolMaxRoundsFromContext,
    changeLlmToolMaxRoundsInputFromContext,
    toggleLlmToolLogCompactFromContext,
    changeTranscript,
    changeSystemPrompt,
    sendReplyRequestFromContext,
    sendReplyTranscriptFromContext,
    reloadSelectedSessionFromContext,
    goDirectoryParentFromContext,
    goDirectoryRootFromContext,
    selectCurrentDirectoryFromContext,
    openDirectoryEntryFromContext,
    resumeWaitingApprovalSessionFromContext,
    renameSelectedDirectoryFromContext,
    renameSelectedSessionTitleFromContext,
    selectSessionMarkerColorFromContext,
    removeSelectedDirectoryFromContext,
    openLatestYouTubeVideoFromDebugContext,
    synthesizeSpeechFromDebugContext,
    stopTtsPlaybackFromDebugContext,
    startDirectNativeSttFromDebugSpeechContext,
    stopDirectNativeSttFromDebugSpeechContext,
    startAutoRecordingModeFromDebugSpeechContext,
    stopAutoRecordingModeFromDebugSpeechContext,
    sendAutoClientLogsFromDebugSpeechContext,
    transcribeRecordingFromDebugSpeechContext,
    startAudioLabProbeFromContext,
    stopAudioLabProbeFromContext,
    startAudioLabPlaybackOnlyFromContext,
    stopAudioLabPlaybackOnlyFromContext,
    sendAudioLabLogsFromContext,
    stopDirectNativeSttFromComposerContext,
    stopAutoRecordingModeFromComposerContext,
    stopRecordingFromComposerContext,
    stopLlmTurnFromComposerContext,
    startDirectNativeSttFromComposerContext,
    startAutoRecordingModeFromComposerContext,
    stopWaveformPlaybackFromVisualContext,
    refreshCodexCliStatusFromContext,
    loadCodexAuthProfilesFromContext,
    switchCodexAuthProfileFromContext,
    loadVoicesFromSettingsContext,
    decreaseTtsSpeedFromSettingsContext,
    increaseTtsSpeedFromSettingsContext,
    selectVoiceIdFromSettingsContext,
  } = useAppContextActions({
    drawerOpen,
    defaultLlmDirectory: DEFAULT_LLM_DIRECTORY,
    directoryExplorerParentPath,
    directoryExplorerRootPath,
    directoryExplorerPath,
    selectedRegisteredDirectory,
    latestAssistantYouTubeVideoIds,
    ttsSpeed,
    ttsProvider,
    setDrawerOpen,
    setActiveScreen,
    setRunnerUrl,
    selectLlmDirectory,
    setCodexWsUrl,
    setCodexWsToken,
    setRunnerToken,
    setCodexApprovalPolicy,
    setModelSelectOpen,
    setThinkSelectOpen,
    setModelRef,
    setReasoningEffort,
    testHardcodedCodexWsConnection,
    testHardcodedCodexWsHandshakeOnly,
    runCodexWsDiagnosticsAndUpload,
    runRunner8788ReachabilitySuite,
    runCodexWsE2eTurnAndUpload,
    loadLlmRuntimeLimits,
    updateLlmToolMaxRounds,
    setLlmToolMaxRoundsInput,
    setLlmToolLogCompact,
    setTranscript,
    setSystemPrompt,
    sendReplyRequest,
    sendReplyTranscript,
    reloadActiveSession,
    loadDirectoryExplorer,
    upsertRegisteredDirectory,
    setDirectorySelectOpen,
    resumeWaitingApprovalForActiveSession,
    renameRegisteredDirectory,
    setSelectedSessionTitleOverride,
    setSelectedSessionMarkerColor,
    removeRegisteredDirectory,
    openYouTubeVideo,
    synthesizeSpeech,
    stopTtsPlayback,
    startDirectNativeStt,
    stopDirectNativeStt,
    startAutoRecordingMode,
    stopAutoRecordingMode,
    sendAutoClientLogsNow,
    transcribeRecording,
    startAudioLabProbe,
    stopAudioLabProbe,
    startAudioLabPlaybackOnly,
    stopAudioLabPlaybackOnly,
    sendAudioLabLogsNow,
    stopRecording,
    cancelCodexTurnRequest,
    stopWaveformPlayback,
    refreshCodexCliStatusForWidget,
    refreshCodexAuthProfiles,
    switchCodexAuthProfile,
    loadVoices,
    setTtsSpeedWithSync,
    setSelectedVoiceIdByProvider,
  });
  useEffect(() => {
    if (!approvalDialog) return;
    closeDrawer();
    setComposerFullscreenOpen(false);
    setComposerInputFocused(false);
    setSlashCommandSelectOpen(false);
    setModelSelectOpen(false);
    setDirectorySelectOpen(false);
    setThinkSelectOpen(false);
  }, [approvalDialog, closeDrawer]);
  const sendReplyRequestForPanelWithTranscriptFromContext = useCallback((
    panelId: string,
    transcriptRaw: string
  ) => {
    const panel = normalizeRuntimePanelId(panelId);
    const transcriptValue = String(transcriptRaw || "").trim();
    if (!transcriptValue) return Promise.resolve();
    logSessionDiag("panel_send_request_with_transcript_triggered", {
      panelId: panel,
      transcriptChars: transcriptValue.length,
      route: "sendReplyRequestForPanelWithTranscript",
    }, { throttleMs: 0 });
    return sendReplyRequest(transcriptValue, { panelId: panel });
  }, [sendReplyRequest]);
  const sendReplyTranscriptForPanelFromContext = useCallback((panelId: string, transcriptOverride?: string) => {
    const panel = normalizeRuntimePanelId(panelId);
    const transcriptChars = typeof transcriptOverride === "string"
      ? transcriptOverride.trim().length
      : null;
    logSessionDiag("panel_send_transcript_triggered", {
      panelId: panel,
      transcriptChars,
      route: "sendReplyTranscriptForPanel",
    }, { throttleMs: 0 });
    return sendReplyTranscript(transcriptOverride, { panelId: panel });
  }, [sendReplyTranscript]);
  const cancelReplyRequestForPanelFromContext = useCallback((panelId: string) => {
    const panel = normalizeRuntimePanelId(panelId);
    logSessionDiag("panel_cancel_triggered", {
      panelId: panel,
      route: "cancelReplyRequestForPanel",
    }, { throttleMs: 0 });
    void cancelCodexTurnRequest({ panelId: panel });
  }, [cancelCodexTurnRequest]);
  const selectedDirectoryPathForConversationContext = normalizedLlmDirectoryForRequest();
  const appShellContextValue = useAppShellContextValue({
    activeScreen,
    drawerOpen,
    setActiveScreen,
    setDrawerOpen,
    openDrawer,
    closeDrawer,
    openDebugScreen,
    openAudioLabScreen,
    openMiniBoardScreen,
  });
  const appSettingsContextValue = useAppSettingsContextValue({
    runnerUrl,
    llmDirectory,
    codexWsUrl,
    codexWsToken,
    runnerToken,
    executionEnvironment: EXPO_EXECUTION_ENVIRONMENT,
    isExpoGo: IS_EXPO_GO,
    isDev: __DEV__,
    defaultCodexWsUrl: DEFAULT_CODEX_WS_URL,
    codexApprovalPolicy,
    selectedModelLabel,
    modelRef,
    reasoningEffort,
    modelOptions: MODEL_OPTIONS,
    thinkOptions: THINK_OPTIONS,
    ttsProvider,
    sttProvider,
    voicesLoading,
    filteredVoices,
    ttsSpeedInput,
    ttsSpeed,
    voiceFilter,
    selectedVoiceId,
    recordingQualityPreset,
    recordingTuning,
    autoTranscribeOnStop,
    autoReplyAfterStt,
    autoBargeInEnabled,
    autoSpeakerPriorityEnabled,
    autoSpeakAfterReply,
    changeRunnerUrl,
    changeLlmDirectory,
    changeCodexWsUrl,
    changeCodexWsToken,
    changeRunnerToken,
    selectCodexApprovalPolicy,
    loadVoices: loadVoicesFromSettingsContext,
    changeTtsSpeedInput: setTtsSpeedInput,
    commitTtsSpeedInput,
    decreaseTtsSpeed: decreaseTtsSpeedFromSettingsContext,
    increaseTtsSpeed: increaseTtsSpeedFromSettingsContext,
    changeVoiceFilter: setVoiceFilter,
    selectVoiceId: selectVoiceIdFromSettingsContext,
    selectTtsProvider: setTtsProvider,
    selectSttProvider: setSttProvider,
    applyRecordingQualityPreset,
    changeRecordingSampleRate: setRecordingSampleRateFromInput,
    changeRecordingBitRate: setRecordingBitRateFromInput,
    changeRecordingChannels: setRecordingChannelsFromInput,
    changeRecordingProgressUpdateInterval: setRecordingProgressUpdateIntervalFromInput,
    toggleAutoTranscribeOnStop: setAutoTranscribeOnStop,
    toggleAutoReplyAfterStt: setAutoReplyAfterStt,
    toggleAutoBargeInEnabled: setAutoBargeInEnabled,
    toggleAutoSpeakerPriorityEnabled: setAutoSpeakerPriorityEnabled,
    toggleAutoSpeakAfterReply: setAutoSpeakAfterReply,
    openModelSelect,
    openThinkSelect,
    modelSelectOpen,
    thinkSelectOpen,
    setModelSelectOpen,
    setThinkSelectOpen,
    selectModel,
    selectThinkOption,
  });
  const debugRuntimeContextValue = useDebugRuntimeContextValue({
    codexWsProbeLoading,
    probeCurrentWs: probeCurrentWsFromContext,
    codexWsHandshakeProbeLoading,
    probeHandshakeOnly: probeHandshakeOnlyFromContext,
    codexWsDiagLoading,
    runWsDiag: runWsDiagFromContext,
    runner8788SuiteLoading,
    runAuxServerSuite: runAuxServerSuiteFromContext,
    codexWsE2eLoading,
    runWsE2e: runWsE2eFromContext,
    codexWsHandshakeProbeStatus,
    codexWsDiagStatus,
    runner8788SuiteStatus,
    codexWsE2eStatus,
    llmRuntimeLimitsLoading,
    loadLlmRuntimeLimits: loadLlmRuntimeLimitsFromContext,
    llmToolMaxRoundsInput,
    changeLlmToolMaxRoundsInput: changeLlmToolMaxRoundsInputFromContext,
    llmToolMaxRoundsSaving,
    updateLlmToolMaxRounds: updateLlmToolMaxRoundsFromContext,
    llmRuntimeLimits,
    llmRuntimeLimitsError,
    llmToolLogCompact,
    toggleLlmToolLogCompact: toggleLlmToolLogCompactFromContext,
  });
  const debugConversationContextValue = useDebugConversationContextValue({
    llmVisual,
    llmStatusText: llmStatusLabel(llmUiStatus),
    llmUiStatusDetail,
    llmPixelIconKey,
    pixelStatusAnimations: PIXEL_STATUS_ANIMATIONS,
    llmActiveToolCalls,
    llmElapsedLabel: formatElapsedMmSs(replyLoading ? llmElapsedLiveMs : llmElapsedMs),
    llmLastToolCall,
    streamAudioQueueSize,
    streamMode,
    streamLlmNativeDeltaCount,
    streamLlmPseudoDeltaCount,
    streamFirstNativeDeltaOffsetMs,
    ttsDebugStats,
    streamLlmProgress,
    streamLlmDeltas,
    streamSegments,
    trimForInline,
    replyDebug,
    latestAssistantYouTubeVideos,
    youtubePlayerMessageId,
    youtubePlayerVideoId,
    youtubeEmbedHtml,
    youtubePlayerSession,
    youtubeEmbedOrigin: YOUTUBE_EMBED_ORIGIN,
    onYouTubeWebViewMessage: handleYouTubeWebViewMessage,
    onOpenLatestYouTubeVideo: openLatestYouTubeVideoFromDebugContext,
    formatYouTubePublishedDate,
    formatYouTubeViewCount,
    canReadReplyAudio: !!sanitizeTextForTts(reply) && !ttsLoading && !!runnerUrl.trim() && !!runnerToken.trim(),
    ttsLoading,
    synthesizeSpeech: synthesizeSpeechFromDebugContext,
    hasTtsSound: !!ttsSound,
    stopTtsPlayback: stopTtsPlaybackFromDebugContext,
    ttsUri,
    history,
  });
  const debugSpeechContextValue = useDebugSpeechContextValue({
    importSettingsJson,
    logSettingsJson,
    clearToolAutoApprovals,
    toolAutoApprovalRuleCount: Object.keys(toolAutoApprovalMap).length,
    isDirectNativeSttProvider,
    directNativeSttEnabled,
    directNativeSttActive,
    directNativeSttPreviewText,
    startDirectNativeStt: startDirectNativeSttFromDebugSpeechContext,
    stopDirectNativeStt: stopDirectNativeSttFromDebugSpeechContext,
    autoRecordingEnabled,
    startAutoRecordingMode: startAutoRecordingModeFromDebugSpeechContext,
    stopAutoRecordingMode: stopAutoRecordingModeFromDebugSpeechContext,
    autoWaveformAnimationEnabled: AUTO_WAVEFORM_ANIMATION_ENABLED,
    waveformDotGif: WAVEFORM_DOT_GIF,
    autoSpeechDetected,
    autoWaveformDebugOverlayEnabled: AUTO_WAVEFORM_DEBUG_OVERLAY_ENABLED,
    autoWaveformDebugText,
    autoRecordingState,
    autoMeteringDb,
    autoLastEvent,
    autoSegments,
    autoInputName,
    autoAirPodsInput,
    autoClientLogQueuedCount,
    autoClientLogSentCount,
    autoClientLogStatus,
    sendAutoClientLogs: sendAutoClientLogsFromDebugSpeechContext,
    clearAutoClientLogs: clearAutoClientLogsLocal,
    manualRecording: Boolean(manualRecording),
    startRecording,
    stopRecording,
    recordingUri,
    transcribeRecording: transcribeRecordingFromDebugSpeechContext,
    recordingSec,
    clearRecordedClip,
  });
  const renameDirectoryForPathFromContext = useCallback((directoryPathRaw: string, nextDisplayName: string) => {
    const directoryPath = parseLlmDirectory(directoryPathRaw);
    const directory = registeredDirectories.find((item) => parseLlmDirectory(item.path) === directoryPath);
    if (!directory) return;
    renameRegisteredDirectory(directory.id, nextDisplayName);
  }, [registeredDirectories]);
  const renameSessionTitleForSessionFromContext = useCallback((sessionId: string, nextTitle: string) => {
    setSessionTitleOverrideForSession(sessionId, nextTitle);
  }, []);
  const selectSessionMarkerColorForSessionFromContext = useCallback((
    sessionId: string,
    nextMarkerColor: RegisteredDirectoryEntry["markerColor"]
  ) => {
    setSessionMarkerColorForSession(sessionId, nextMarkerColor);
  }, []);
  const removeDirectoryForPathFromContext = useCallback((directoryPathRaw: string) => {
    const directoryPath = parseLlmDirectory(directoryPathRaw);
    const directory = registeredDirectories.find((item) => parseLlmDirectory(item.path) === directoryPath);
    if (!directory) return;
    removeRegisteredDirectory(directory.id);
  }, [registeredDirectories]);
  const selectedSessionIdForExecutionStatus = parseOptionalSessionId(
    selectedLlmSessionId || llmConversationSessionIdRef.current
  );
  const selectedSessionExecutionStatusType = deriveSessionExecutionStatusType({
    threadStatusType: selectedThreadStatusType,
    isResponding: replyLoading,
    isCompactRunning: isCodexCompactRunning(selectedSessionIdForExecutionStatus),
  });
  const conversationContextValue = useConversationContextValue({
    conversationMessages,
    llmSessionRestoreLoading,
    selectedSessionExecutionFact,
    selectedThreadStatusType: selectedSessionExecutionStatusType,
    selectedSessionWaitingApproval,
    waitingApprovalResumeLoading,
    waitingApprovalResumeStatusText,
    directorySelectOpen,
    selectedDirectoryLabel: selectedDirectoryPathForConversationContext,
    directoryExplorerPathLabel: directoryExplorerPath || "-",
    directoryExplorerHasParent: Boolean(directoryExplorerParentPath),
    directoryExplorerLoading,
    directoryExplorerError,
    directoryExplorerEntries,
    llmSessionRestoreError,
    registeredDirectories,
    directorySessionsById,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    selectedLlmSessionId,
    hasSelectedDirectory: hasSelectedRegisteredDirectory,
    selectedDirectoryDisplayName,
    selectedSessionMarkerColor,
    selectedSessionTitle: selectedSessionHeaderTitle,
    selectedDirectoryPath: selectedDirectoryPathForConversationContext,
    reply,
    transcript,
    systemPrompt,
    canSend,
    replyLoading,
    sttLoading,
    startNewSession,
    setDirectorySelectOpen,
    goDirectoryParent: goDirectoryParentFromContext,
    goDirectoryRoot: goDirectoryRootFromContext,
    selectCurrentDirectory: selectCurrentDirectoryFromContext,
    openDirectoryEntry: openDirectoryEntryFromContext,
    formatSessionUpdatedAt,
    refreshRegisteredDirectorySessions: refreshRegisteredDirectorySessionsForMiniBoard,
    markSessionRead: markSessionReadFromContext,
    markSelectedSessionUnread: markSelectedSessionUnreadFromContext,
    reloadSelectedSession: reloadSelectedSessionFromContext,
    resumeWaitingApprovalSession: resumeWaitingApprovalSessionFromContext,
    renameSelectedDirectory: renameSelectedDirectoryFromContext,
    renameSelectedSessionTitle: renameSelectedSessionTitleFromContext,
    selectSelectedSessionMarkerColor: selectSessionMarkerColorFromContext,
    removeSelectedDirectory: removeSelectedDirectoryFromContext,
    renameDirectoryForPath: renameDirectoryForPathFromContext,
    renameSessionTitleForSession: renameSessionTitleForSessionFromContext,
    selectSessionMarkerColorForSession: selectSessionMarkerColorForSessionFromContext,
    removeDirectoryForPath: removeDirectoryForPathFromContext,
    markSessionUnread,
    showChatBottomToast,
    setTranscript: changeTranscript,
    setSystemPrompt: changeSystemPrompt,
    sendReplyRequest: sendReplyRequestFromContext,
    sendReplyTranscript: sendReplyTranscriptFromContext,
    sendReplyRequestForPanelWithTranscript: sendReplyRequestForPanelWithTranscriptFromContext,
    sendReplyTranscriptForPanel: sendReplyTranscriptForPanelFromContext,
    cancelReplyRequestForPanel: cancelReplyRequestForPanelFromContext,
    cancelCodexQueuedTurnForMessage,
    logSessionDiag,
  });
  type PanelRuntimeSnapshotPatch = Partial<Omit<PanelRuntimeSnapshot, "conversationMessages">> & {
    conversationMessages?: ConversationMessage[];
  };
  const [panelRuntimeEntriesById, setPanelRuntimeEntriesById] = useState<Record<string, PanelRuntimeEntry>>({});
  useEffect(() => {
    panelRuntimeEntriesByIdRef.current = panelRuntimeEntriesById;
  }, [panelRuntimeEntriesById]);
  const cloneConversationMessages = useCallback((messages: ConversationMessage[]): ConversationMessage[] => (
    messages.map((message) => ({
      ...message,
      youtubeVideoIds: Array.isArray(message.youtubeVideoIds) ? [...message.youtubeVideoIds] : undefined,
      ttsWaveform: Array.isArray(message.ttsWaveform) ? [...message.ttsWaveform] : undefined,
      sttMeta: message.sttMeta ? { ...message.sttMeta } : undefined,
    }))
  ), []);
  const createPanelRuntimeSnapshot = useCallback((
    panelIdRaw: string,
    baseSnapshot: PanelRuntimeSnapshot,
    patch: PanelRuntimeSnapshotPatch = {}
  ): PanelRuntimeSnapshot => {
    const contextUsedPctRaw = Object.prototype.hasOwnProperty.call(patch, "contextUsedPct")
      ? patch.contextUsedPct
      : baseSnapshot.contextUsedPct;
    const contextUsedPct = contextUsedPctRaw !== null && typeof contextUsedPctRaw !== "undefined" && Number.isFinite(Number(contextUsedPctRaw))
      ? Math.max(0, Math.min(100, Math.round(Number(contextUsedPctRaw))))
      : null;
    const messages = Array.isArray(patch.conversationMessages)
      ? patch.conversationMessages
      : baseSnapshot.conversationMessages;
    const selectedSessionId = String(patch.selectedSessionId ?? baseSnapshot.selectedSessionId ?? "").trim();
    const isResponding = typeof patch.isResponding === "boolean"
      ? patch.isResponding
      : Boolean(baseSnapshot.isResponding);
    const snapshot: PanelRuntimeSnapshot = {
      panelId: normalizeRuntimePanelId(panelIdRaw),
      selectedSessionId,
      selectedDirectoryPath: String(patch.selectedDirectoryPath ?? baseSnapshot.selectedDirectoryPath ?? "").trim(),
      selectedDirectoryDisplayName: String(
        patch.selectedDirectoryDisplayName ?? baseSnapshot.selectedDirectoryDisplayName ?? ""
      ).trim(),
      selectedSessionTitle: String(patch.selectedSessionTitle ?? baseSnapshot.selectedSessionTitle ?? "").trim(),
      selectedSessionUpdatedAt: String(
        patch.selectedSessionUpdatedAt ?? baseSnapshot.selectedSessionUpdatedAt ?? ""
      ).trim(),
      selectedSessionMarkerColor: parseDirectoryMarkerColor(
        patch.selectedSessionMarkerColor ?? baseSnapshot.selectedSessionMarkerColor
      ),
      selectedThreadStatusType: deriveSessionExecutionStatusType({
        threadStatusType: patch.selectedThreadStatusType ?? baseSnapshot.selectedThreadStatusType,
        isResponding,
        isCompactRunning: isCodexCompactRunning(selectedSessionId),
      }),
      modelRef: normalizeModelRef(patch.modelRef ?? baseSnapshot.modelRef),
      reasoningEffort: String(patch.reasoningEffort ?? baseSnapshot.reasoningEffort ?? "").trim(),
      contextUsedPct,
      isResponding,
      isHydrating: typeof patch.isHydrating === "boolean"
        ? patch.isHydrating
        : Boolean(baseSnapshot.isHydrating),
      conversationMessages: cloneConversationMessages(messages),
    };
    const requestStartedAtMsRaw = patch.requestStartedAtMs ?? baseSnapshot.requestStartedAtMs;
    const requestStartedAtMs = Number(requestStartedAtMsRaw || 0);
    if (snapshot.isResponding && Number.isFinite(requestStartedAtMs) && requestStartedAtMs > 0) {
      snapshot.requestStartedAtMs = requestStartedAtMs;
    }
    const scrollOffsetY = patch.scrollOffsetY ?? baseSnapshot.scrollOffsetY;
    const scrollViewportHeight = patch.scrollViewportHeight ?? baseSnapshot.scrollViewportHeight;
    const scrollNearBottom = patch.scrollNearBottom ?? baseSnapshot.scrollNearBottom;
    const ttsPlaybackMessageId = patch.ttsPlaybackMessageId ?? baseSnapshot.ttsPlaybackMessageId;
    if (typeof scrollOffsetY === "number") snapshot.scrollOffsetY = scrollOffsetY;
    if (typeof scrollViewportHeight === "number") snapshot.scrollViewportHeight = scrollViewportHeight;
    if (typeof scrollNearBottom === "boolean") snapshot.scrollNearBottom = scrollNearBottom;
    if (typeof ttsPlaybackMessageId === "string") snapshot.ttsPlaybackMessageId = ttsPlaybackMessageId;
    return snapshot;
  }, [cloneConversationMessages, isCodexCompactRunning]);
  const createEmptyPanelRuntimeSnapshot = useCallback((panelIdRaw: string): PanelRuntimeSnapshot => ({
    panelId: normalizeRuntimePanelId(panelIdRaw),
    selectedSessionId: "",
    selectedDirectoryPath: normalizedLlmDirectoryForRequest(),
    selectedDirectoryDisplayName: String(selectedDirectoryDisplayName || "").trim(),
    selectedSessionTitle: "（ユーザーメッセージなし）",
    selectedSessionUpdatedAt: "",
    selectedSessionMarkerColor: "none",
    selectedThreadStatusType: "unknown",
    modelRef: normalizeModelRef(modelRef),
    reasoningEffort: String(reasoningEffort || "").trim(),
    contextUsedPct: null,
    isResponding: false,
    isHydrating: false,
    conversationMessages: [],
    scrollOffsetY: 0,
    scrollViewportHeight: 0,
    scrollNearBottom: true,
    ttsPlaybackMessageId: "",
  }), [
    modelRef,
    normalizedLlmDirectoryForRequest,
    reasoningEffort,
    selectedDirectoryDisplayName,
  ]);
  const activeConversationSnapshot = useMemo<PanelRuntimeSnapshot>(() => ({
    panelId: "",
    selectedSessionId: String(selectedLlmSessionId || "").trim(),
    selectedDirectoryPath: normalizedLlmDirectoryForRequest(),
    selectedDirectoryDisplayName: String(selectedDirectoryDisplayName || "").trim(),
    selectedSessionTitle: String(selectedSessionHeaderTitle || "").trim(),
    selectedSessionUpdatedAt: String(conversationMessages[conversationMessages.length - 1]?.at || "").trim(),
    selectedSessionMarkerColor,
    selectedThreadStatusType: selectedSessionExecutionStatusType,
    modelRef: normalizeModelRef(modelRef),
    reasoningEffort: String(reasoningEffort || "").trim(),
    contextUsedPct: chatContextUsedPct,
    isResponding: replyLoading,
    isHydrating: false,
    requestStartedAtMs: replyLoading && llmRequestStartedAtRef.current > 0
      ? llmRequestStartedAtRef.current
      : undefined,
    conversationMessages,
    scrollOffsetY: chatScrollOffsetY,
    scrollViewportHeight: chatViewportHeight,
    scrollNearBottom: chatNearBottomRef.current,
    ttsPlaybackMessageId,
  }), [
    chatContextUsedPct,
    chatScrollOffsetY,
    chatViewportHeight,
    conversationMessages,
    llmDirectory,
    modelRef,
    reasoningEffort,
    replyLoading,
    selectedDirectoryDisplayName,
    selectedSessionMarkerColor,
    selectedSessionExecutionStatusType,
    selectedLlmSessionId,
    selectedSessionHeaderTitle,
    ttsPlaybackMessageId,
  ]);
  const miniBoardPanelRuntimeSnapshotSignatureRef = useRef("");
  useEffect(() => {
    const selectedSessionId = String(activeConversationSnapshot.selectedSessionId || "").trim();
    if (!selectedSessionId) return;
    upsertConversationRuntimeSnapshot({
      sessionId: selectedSessionId,
      conversationMessages: activeConversationSnapshot.conversationMessages,
      contextUsedPct: activeConversationSnapshot.contextUsedPct,
      isResponding: activeConversationSnapshot.isResponding,
      selectedThreadStatusType: activeConversationSnapshot.selectedThreadStatusType,
    });
  }, [
    activeConversationSnapshot.conversationMessages,
    activeConversationSnapshot.contextUsedPct,
    activeConversationSnapshot.isResponding,
    activeConversationSnapshot.selectedSessionId,
    activeConversationSnapshot.selectedThreadStatusType,
    upsertConversationRuntimeSnapshot,
  ]);
  const projectConversationRuntimeToPanelSnapshot = useCallback((
    panelIdRaw: string,
    baseSnapshot: PanelRuntimeSnapshot
  ) => {
    const sessionId = String(baseSnapshot.selectedSessionId || "").trim();
    if (!sessionId) return baseSnapshot;
    const runtimeSnapshot = getConversationRuntimeSnapshot(sessionId);
    if (!runtimeSnapshot) return baseSnapshot;
    const runtimeRequestStartedAtMs = runtimeSnapshot.isResponding &&
      runtimeSnapshot.request &&
      isConversationRuntimeRequestResponding(runtimeSnapshot.request) &&
      runtimeSnapshot.request.startedAtMs > 0
      ? runtimeSnapshot.request.startedAtMs
      : undefined;
    return createPanelRuntimeSnapshot(panelIdRaw, baseSnapshot, {
      conversationMessages: runtimeSnapshot.conversationMessages,
      contextUsedPct: runtimeSnapshot.contextUsedPct,
      isResponding: runtimeSnapshot.isResponding,
      requestStartedAtMs: runtimeRequestStartedAtMs,
      selectedThreadStatusType: runtimeSnapshot.selectedThreadStatusType,
    });
  }, [createPanelRuntimeSnapshot, getConversationRuntimeSnapshot]);
  useEffect(() => {
    setPanelRuntimeEntriesById((prev) => {
      let changed = false;
      const next: Record<string, PanelRuntimeEntry> = { ...prev };
      for (const [panelId, entry] of Object.entries(prev)) {
        if (!entry.snapshot) continue;
        const snapshotSessionId = parseOptionalSessionId(entry.snapshot.selectedSessionId);
        const entrySessionId = parseOptionalSessionId(entry.sessionId);
        const candidateSessionIds = [snapshotSessionId, entrySessionId].filter((id, index, source) => (
          !!id && source.indexOf(id) === index
        ));
        if (candidateSessionIds.length <= 0) continue;
        let overrideTitle = "";
        for (const candidateSessionId of candidateSessionIds) {
          const value = String(sessionTitleOverridesById[candidateSessionId] || "").trim();
          if (!value) continue;
          overrideTitle = value;
          break;
        }
        const fallbackTitle = deriveSessionTitleFromConversationMessages(entry.snapshot.conversationMessages);
        const expectedTitle = overrideTitle || fallbackTitle;
        let expectedMarkerColor: RegisteredDirectoryEntry["markerColor"] = "none";
        for (const candidateSessionId of candidateSessionIds) {
          const value = parseDirectoryMarkerColor(sessionMarkerColorsById[candidateSessionId]);
          if (value === "none") continue;
          expectedMarkerColor = value;
          break;
        }
        if (
          expectedTitle === entry.snapshot.selectedSessionTitle &&
          expectedMarkerColor === entry.snapshot.selectedSessionMarkerColor
        ) {
          continue;
        }
        next[panelId] = {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            selectedSessionTitle: expectedTitle,
            selectedSessionMarkerColor: expectedMarkerColor,
          },
        };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessionMarkerColorsById, sessionTitleOverridesById]);
  const clearPanelSnapshot = useCallback((panelIdRaw: string) => {
    const panelId = normalizeRuntimePanelId(panelIdRaw);
    if (!panelId) return;
    setPanelAutoSpeechOpen(panelId, false);
    setPanelRuntimeEntriesById((prev) => {
      if (!prev[panelId]) return prev;
      const next = { ...prev };
      delete next[panelId];
      return next;
    });
    logSessionDiag("panel_runtime_snapshot_cleared", {
      panelId,
    }, {
      throttleMs: 0,
      throttleKey: `panel_runtime_snapshot_cleared:${panelId}:${Date.now()}`,
    });
  }, [logSessionDiag, setPanelAutoSpeechOpen]);
  const resolvePanelSnapshotForDisplay = useCallback((panelIdRaw: string): PanelRuntimeSnapshot => {
    const panelId = normalizeRuntimePanelId(panelIdRaw);
    const entry = panelRuntimeEntriesById[panelId];
    if (entry?.snapshot) {
      return projectConversationRuntimeToPanelSnapshot(panelId, entry.snapshot);
    }
    return createEmptyPanelRuntimeSnapshot(panelId);
  }, [createEmptyPanelRuntimeSnapshot, panelRuntimeEntriesById, projectConversationRuntimeToPanelSnapshot]);
  const startNewPanelSession = usePanelNewSessionController({
    registeredDirectories,
    normalizedLlmDirectoryForRequest,
    normalizeRuntimePanelId,
    resolvePanelSnapshotForDisplay,
    createEmptyPanelRuntimeSnapshot,
    createPanelRuntimeSnapshot,
    setSessionMarkerColorForSession,
    upsertConversationRuntimeSnapshot,
    setPanelRuntimeEntriesById,
    logSessionDiag,
  });
  useEffect(() => {
    const watchedPanelIds = [
      "mini_preview_1",
      "mini_preview_2",
      "mini_preview_3",
      "mini_preview_4",
      "mini_preview_5",
      "mini_preview_6",
      "mini_popup_1",
      "mini_popup_2",
      "mini_popup_3",
      "mini_popup_4",
      "mini_popup_5",
      "mini_popup_6",
    ];
    const runtimeByPanel = watchedPanelIds.map((panelId) => {
      const entry = panelRuntimeEntriesById[panelId];
      const snapshot = entry?.snapshot;
      const snapshotMessages = Array.isArray(snapshot?.conversationMessages) ? snapshot.conversationMessages : [];
      const snapshotLastMessage = snapshotMessages.length > 0
        ? snapshotMessages[snapshotMessages.length - 1]
        : null;
      return {
        panelId,
        hasSnapshot: !!entry?.snapshot,
        entrySessionId: String(entry?.sessionId || "").trim(),
        snapshotSessionId: String(snapshot?.selectedSessionId || "").trim(),
        snapshotDirectoryPath: String(snapshot?.selectedDirectoryPath || "").trim(),
        snapshotIsResponding: Boolean(snapshot?.isResponding),
        snapshotIsHydrating: Boolean(snapshot?.isHydrating),
        snapshotContextUsedPct: Number.isFinite(Number(snapshot?.contextUsedPct)) ? Number(snapshot?.contextUsedPct) : null,
        snapshotMessageCount: snapshotMessages.length,
        snapshotLastMessageId: String(snapshotLastMessage?.id || "").trim(),
        snapshotLastMessageRole: String(snapshotLastMessage?.role || "").trim(),
        snapshotLastMessageContentLength: String(snapshotLastMessage?.content || "").length,
      };
    });
    const runtimeSignature = JSON.stringify({ runtimeByPanel });
    if (miniBoardPanelRuntimeSnapshotSignatureRef.current === runtimeSignature) return;
    miniBoardPanelRuntimeSnapshotSignatureRef.current = runtimeSignature;
    logSessionDiag("mini_board_panel_runtime_state_snapshot", {
      runtimeByPanel,
    }, {
      throttleMs: 2000,
      throttleKey: "mini_board_panel_runtime_state_snapshot",
    });
  }, [
    logSessionDiag,
    panelRuntimeEntriesById,
  ]);
  const copyPanelSnapshot = useCallback((sourcePanelIdRaw: string, targetPanelIdRaw: string) => {
    const sourcePanelId = normalizeRuntimePanelId(sourcePanelIdRaw);
    const targetPanelId = normalizeRuntimePanelId(targetPanelIdRaw);
    if (!targetPanelId) return;
    const sourceSnapshot = resolvePanelSnapshotForDisplay(sourcePanelId);
    const copiedSnapshot = createPanelRuntimeSnapshot(targetPanelId, sourceSnapshot);
    const copiedLastMessage = copiedSnapshot.conversationMessages.length > 0
      ? copiedSnapshot.conversationMessages[copiedSnapshot.conversationMessages.length - 1]
      : null;
    setPanelRuntimeEntriesById((prev) => ({
      ...prev,
      [targetPanelId]: {
        sessionId: copiedSnapshot.selectedSessionId,
        snapshot: copiedSnapshot,
      },
    }));
    logSessionDiag("panel_runtime_copy_snapshot", {
      sourcePanelId,
      targetPanelId,
      sessionId: copiedSnapshot.selectedSessionId || undefined,
      directory: copiedSnapshot.selectedDirectoryPath || undefined,
      messageCount: copiedSnapshot.conversationMessages.length,
      lastMessageId: String(copiedLastMessage?.id || "").trim(),
      lastMessageRole: String(copiedLastMessage?.role || "").trim(),
      lastMessageContentLength: String(copiedLastMessage?.content || "").length,
      lastMessagePreview: String(copiedLastMessage?.content || "").slice(0, 80),
    }, { throttleMs: 0 });
  }, [createPanelRuntimeSnapshot, resolvePanelSnapshotForDisplay]);
  const updatePanelSettings = useCallback((
    panelIdRaw: string,
    settings: { modelRef?: string; reasoningEffort?: string }
  ) => {
    const panelId = normalizeRuntimePanelId(panelIdRaw);
    if (!panelId) return;
    const nextModelRef = normalizeModelRef(settings?.modelRef);
    const nextReasoningEffort = String(settings?.reasoningEffort || "").trim();
    if (!nextModelRef && !nextReasoningEffort) return;
    const baseSnapshot = resolvePanelSnapshotForDisplay(panelId);
    const nextSnapshot = createPanelRuntimeSnapshot(panelId, baseSnapshot, {
      panelId,
      modelRef: nextModelRef || normalizeModelRef(baseSnapshot.modelRef),
      reasoningEffort: nextReasoningEffort || String(baseSnapshot.reasoningEffort || "").trim(),
    });
    const selectedSessionId = String(nextSnapshot.selectedSessionId || "").trim();
    const syncedPanelIds: string[] = [];
    setPanelRuntimeEntriesById((prev) => {
      const next: Record<string, PanelRuntimeEntry> = {
        ...prev,
        [panelId]: {
          sessionId: selectedSessionId,
          snapshot: nextSnapshot,
        },
      };
      if (selectedSessionId) {
        for (const [entryPanelId, entry] of Object.entries(prev)) {
          if (entryPanelId === panelId || !entry.snapshot) continue;
          const entrySessionId = String(entry.snapshot.selectedSessionId || entry.sessionId || "").trim();
          if (entrySessionId !== selectedSessionId) continue;
          next[entryPanelId] = {
            ...entry,
            sessionId: entry.sessionId || selectedSessionId,
            snapshot: {
              ...entry.snapshot,
              modelRef: nextSnapshot.modelRef,
              reasoningEffort: nextSnapshot.reasoningEffort,
            },
          };
          syncedPanelIds.push(entryPanelId);
        }
      }
      return next;
    });
    logSessionDiag("panel_runtime_settings_updated", {
      panelId,
      sessionId: selectedSessionId || undefined,
      modelRef: nextSnapshot.modelRef,
      reasoningEffort: nextSnapshot.reasoningEffort,
      syncedSameSessionPanelIds: syncedPanelIds,
    }, { throttleMs: 0 });
  }, [createPanelRuntimeSnapshot, logSessionDiag, resolvePanelSnapshotForDisplay]);
  const getPanelConversationMessagesForCodex = useCallback((panelIdRaw: string): ConversationMessage[] => {
    const panelId = normalizeRuntimePanelId(panelIdRaw);
    const snapshot = resolvePanelSnapshotForDisplay(panelId);
    return cloneConversationMessages(snapshot.conversationMessages);
  }, [cloneConversationMessages, resolvePanelSnapshotForDisplay]);
  const setPanelConversationMessagesForCodex = useCallback((
    panelIdRaw: string,
    messagesRaw: ConversationMessage[],
    options?: PanelConversationWriteOptions
  ) => {
    const panelId = normalizeRuntimePanelId(panelIdRaw);
    if (!panelId) return;
    const optionSessionId = parseOptionalSessionId(options?.sessionId);
    const baseSnapshot = resolvePanelSnapshotForDisplay(panelId);
    const contextUsedPct = options?.contextUsedPct !== null && typeof options?.contextUsedPct !== "undefined" && Number.isFinite(Number(options?.contextUsedPct))
      ? Math.max(0, Math.min(100, Math.round(Number(options?.contextUsedPct))))
      : baseSnapshot.contextUsedPct;
    const isResponding = typeof options?.isResponding === "boolean"
      ? options.isResponding
      : Boolean(baseSnapshot.isResponding);
    const selectedThreadStatusTypeForPanel = typeof options?.selectedThreadStatusType === "string"
      ? String(options?.selectedThreadStatusType || "unknown").trim() || "unknown"
      : String(baseSnapshot.selectedThreadStatusType || "unknown").trim() || "unknown";
    const selectedSessionId = String(optionSessionId || baseSnapshot.selectedSessionId || "").trim();
    const runtimeSnapshot = selectedSessionId ? getConversationRuntimeSnapshot(selectedSessionId) : null;
    const runtimeRequestStartedAtMs = runtimeSnapshot?.isResponding &&
      runtimeSnapshot.request &&
      isConversationRuntimeRequestResponding(runtimeSnapshot.request) &&
      runtimeSnapshot.request.startedAtMs > 0
      ? runtimeSnapshot.request.startedAtMs
      : undefined;
    const shouldSyncSameSession = !!selectedSessionId;
    const previousMessageCount = Array.isArray(baseSnapshot.conversationMessages)
      ? baseSnapshot.conversationMessages.length
      : 0;
    const nextMessageCount = Array.isArray(messagesRaw) ? messagesRaw.length : 0;
    const lastMessage = nextMessageCount > 0 ? messagesRaw[nextMessageCount - 1] : null;
    const selectedSessionUpdatedAt = String(lastMessage?.at || "").trim() || new Date().toISOString();
    const nextSnapshot = createPanelRuntimeSnapshot(panelId, baseSnapshot, {
      selectedSessionId,
      selectedSessionUpdatedAt,
      contextUsedPct,
      isResponding,
      requestStartedAtMs: runtimeRequestStartedAtMs,
      selectedThreadStatusType: selectedThreadStatusTypeForPanel,
      conversationMessages: messagesRaw,
    });
    const currentPanelSessionId = parseOptionalSessionId(resolvePanelSnapshotForDisplay(panelId).selectedSessionId);
    const adoptFromSessionId = parseOptionalSessionId(options?.adoptFromSessionId);
    const shouldAdoptSourcePanelSession = Boolean(
      optionSessionId &&
      adoptFromSessionId &&
      currentPanelSessionId === adoptFromSessionId
    );
    const shouldUpdateSourcePanel = (
      !optionSessionId ||
      !currentPanelSessionId ||
      currentPanelSessionId === selectedSessionId ||
      shouldAdoptSourcePanelSession
    );
    if (nextSnapshot.selectedSessionId) {
      upsertConversationRuntimeSnapshot({
        sessionId: nextSnapshot.selectedSessionId,
        conversationMessages: nextSnapshot.conversationMessages,
        contextUsedPct: nextSnapshot.contextUsedPct,
        isResponding: nextSnapshot.isResponding,
        selectedThreadStatusType: nextSnapshot.selectedThreadStatusType,
        clearRespondingRequestStartedAtMs: options?.clearRespondingRequestStartedAtMs,
      });
    }
    const syncedPanelIds: string[] = [];
    setPanelRuntimeEntriesById((prev) => {
      const next: Record<string, PanelRuntimeEntry> = { ...prev };
      if (shouldUpdateSourcePanel) {
        next[panelId] = {
          sessionId: nextSnapshot.selectedSessionId,
          snapshot: nextSnapshot,
        };
      }
      if (shouldSyncSameSession) {
        for (const [entryPanelId, entry] of Object.entries(prev)) {
          if (entryPanelId === panelId) continue;
          const entrySessionId = String(entry.snapshot.selectedSessionId || entry.sessionId || "").trim();
          if (entrySessionId !== selectedSessionId) continue;
          next[entryPanelId] = {
            ...entry,
            sessionId: entry.sessionId || selectedSessionId,
            snapshot: createPanelRuntimeSnapshot(entryPanelId, entry.snapshot, {
              modelRef: entry.snapshot.modelRef || baseSnapshot.modelRef,
              reasoningEffort: entry.snapshot.reasoningEffort || baseSnapshot.reasoningEffort,
              selectedSessionUpdatedAt,
              contextUsedPct,
              isResponding,
              requestStartedAtMs: runtimeRequestStartedAtMs,
              selectedThreadStatusType: selectedThreadStatusTypeForPanel,
              conversationMessages: messagesRaw,
            }),
          };
          syncedPanelIds.push(entryPanelId);
        }
      }
      return next;
    });
    const hasContextUpdate = options?.contextUsedPct !== null &&
      typeof options?.contextUsedPct !== "undefined" &&
      Number.isFinite(Number(options?.contextUsedPct));
    logSessionDiag("panel_runtime_messages_updated", {
      panelId,
      sessionId: nextSnapshot.selectedSessionId || undefined,
      contextUsedPct: nextSnapshot.contextUsedPct,
      isResponding: nextSnapshot.isResponding,
      selectedThreadStatusType: nextSnapshot.selectedThreadStatusType,
      syncedSameSessionPanelIds: syncedPanelIds,
      sourcePanelUpdated: shouldUpdateSourcePanel,
      sourcePanelSessionAdopted: shouldAdoptSourcePanelSession,
      adoptFromSessionId: adoptFromSessionId || undefined,
      currentPanelSessionId: currentPanelSessionId || undefined,
      previousMessageCount,
      messageCount: nextSnapshot.conversationMessages.length,
      messageCountDelta: nextMessageCount - previousMessageCount,
      lastMessageId: String(lastMessage?.id || "").trim(),
      lastMessageRole: String(lastMessage?.role || "").trim(),
      lastMessageContentLength: String(lastMessage?.content || "").length,
      lastMessagePreview: String(lastMessage?.content || "").slice(0, 80),
      source: "codex_reply_request",
      updateKind: hasContextUpdate ? "final" : "stream",
    }, {
      throttleMs: hasContextUpdate ? 0 : 1000,
      throttleKey: hasContextUpdate
        ? `panel_runtime_messages_updated:${panelId}:${Date.now()}`
        : `panel_runtime_messages_updated:${panelId}:stream`,
    });
  }, [
    createPanelRuntimeSnapshot,
    getConversationRuntimeSnapshot,
    logSessionDiag,
    panelRuntimeEntriesById,
    resolvePanelSnapshotForDisplay,
    upsertConversationRuntimeSnapshot,
  ]);
  getSessionConversationMessagesForCodexRef.current = (sessionIdRaw: string) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return [];
    const visibleSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || selectedLlmSessionId || llmConversationSessionIdRef.current
    );
    if (visibleSessionId === sessionId) {
      return cloneConversationMessages(conversationMessagesRef.current);
    }
    const runtimeSnapshot = getConversationRuntimeSnapshot(sessionId);
    if (runtimeSnapshot) return runtimeSnapshot.conversationMessages;
    for (const entry of Object.values(panelRuntimeEntriesByIdRef.current as Record<string, PanelRuntimeEntry>)) {
      const snapshot = entry?.snapshot;
      const entrySessionId = parseOptionalSessionId(snapshot?.selectedSessionId || entry?.sessionId);
      if (entrySessionId !== sessionId || !snapshot) continue;
      return cloneConversationMessages(snapshot.conversationMessages);
    }
    return [];
  };
  setSessionConversationMessagesForCodexRef.current = (
    sessionIdRaw: string,
    messagesRaw: ConversationMessage[],
    options?: RuntimeConversationWriteOptions
  ) => {
    const sessionId = parseOptionalSessionId(options?.sessionId || sessionIdRaw);
    if (!sessionId) return;
    const runtimeSnapshot = getConversationRuntimeSnapshot(sessionId);
    const messages = cloneConversationMessages(messagesRaw);
    const isResponding = typeof options?.isResponding === "boolean"
      ? options.isResponding
      : Boolean(runtimeSnapshot?.isResponding);
    const selectedThreadStatusTypeForRuntime = typeof options?.selectedThreadStatusType === "string"
      ? String(options.selectedThreadStatusType || "unknown").trim() || "unknown"
      : String(runtimeSnapshot?.selectedThreadStatusType || "unknown").trim() || "unknown";
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    const selectedSessionUpdatedAt = String(lastMessage?.at || "").trim() || new Date().toISOString();
    upsertConversationRuntimeSnapshot({
      sessionId,
      conversationMessages: messages,
      isResponding,
      selectedThreadStatusType: selectedThreadStatusTypeForRuntime,
      clearRespondingRequestStartedAtMs: options?.clearRespondingRequestStartedAtMs,
    });

    const visibleSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || selectedLlmSessionId || llmConversationSessionIdRef.current
    );
    if (visibleSessionId === sessionId) {
      setConversationMessagesWithLimit(messages);
      setReplyLoadingWithRef(isResponding);
      setSelectedThreadStatusType(selectedThreadStatusTypeForRuntime);
    }

    const syncedPanelIds: string[] = [];
    setPanelRuntimeEntriesById((prev) => {
      let changed = false;
      const next: Record<string, PanelRuntimeEntry> = { ...prev };
      for (const [panelId, entry] of Object.entries(prev)) {
        const snapshot = entry.snapshot;
        const entrySessionId = parseOptionalSessionId(snapshot?.selectedSessionId || entry.sessionId);
        if (entrySessionId !== sessionId || !snapshot) continue;
        next[panelId] = {
          ...entry,
          sessionId,
          snapshot: createPanelRuntimeSnapshot(panelId, snapshot, {
            conversationMessages: messages,
            selectedSessionUpdatedAt,
            isResponding,
            selectedThreadStatusType: selectedThreadStatusTypeForRuntime,
          }),
        };
        syncedPanelIds.push(panelId);
        changed = true;
      }
      return changed ? next : prev;
    });
    logSessionDiag("session_runtime_messages_updated", {
      sessionId,
      isResponding,
      selectedThreadStatusType: selectedThreadStatusTypeForRuntime,
      syncedPanelIds,
      messageCount: messages.length,
      source: "codex_relay_observer",
    }, {
      throttleMs: isResponding ? 1000 : 0,
      throttleKey: isResponding
        ? `session_runtime_messages_updated:${sessionId}:stream`
        : `session_runtime_messages_updated:${sessionId}:${Date.now()}`,
    });
  };
  projectTtsPlaybackMessageIdToPanelsRef.current = (messageIdRaw: string) => {
    const target = ttsPlaybackProjectionTargetRef.current;
    const targetPanelId = normalizeRuntimePanelId(target.panelId);
    if (!targetPanelId) return;
    const targetSessionId = parseOptionalSessionId(target.sessionId);
    const nextMessageId = String(messageIdRaw || "").trim();
    const targetMessageId = String(target.messageId || "").trim();
    if (nextMessageId && targetMessageId && nextMessageId !== targetMessageId) return;
    if (nextMessageId && !targetMessageId) return;
    setPanelRuntimeEntriesById((prev) => {
      const targetEntry = prev[targetPanelId];
      if (!targetEntry?.snapshot) return prev;
      const snapshotSessionId = parseOptionalSessionId(targetEntry.snapshot.selectedSessionId);
      const syncSessionId = targetSessionId || snapshotSessionId;
      let changed = false;
      const next: Record<string, PanelRuntimeEntry> = { ...prev };
      for (const [entryPanelId, entry] of Object.entries(prev)) {
        if (entryPanelId !== targetPanelId) {
          if (!syncSessionId) continue;
          const entrySessionId = parseOptionalSessionId(entry.snapshot.selectedSessionId || entry.sessionId);
          if (entrySessionId !== syncSessionId) continue;
        }
        if (String(entry.snapshot.ttsPlaybackMessageId || "").trim() === nextMessageId) continue;
        next[entryPanelId] = {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            ttsPlaybackMessageId: nextMessageId,
          },
        };
        changed = true;
      }
      return changed ? next : prev;
    });
  };
  projectTtsWaveformToPanelsRef.current = (messageIdRaw: string, waveformRaw?: number[]) => {
    const target = ttsPlaybackProjectionTargetRef.current;
    const targetPanelId = normalizeRuntimePanelId(target.panelId);
    if (!targetPanelId) return;
    const messageId = String(messageIdRaw || "").trim();
    const targetMessageId = String(target.messageId || "").trim();
    if (!messageId || !targetMessageId || messageId !== targetMessageId) return;
    if (!Array.isArray(waveformRaw) || waveformRaw.length <= 0) return;
    const targetSessionId = parseOptionalSessionId(target.sessionId);
    setPanelRuntimeEntriesById((prev) => {
      const targetEntry = prev[targetPanelId];
      if (!targetEntry?.snapshot) return prev;
      const snapshotSessionId = parseOptionalSessionId(targetEntry.snapshot.selectedSessionId);
      const syncSessionId = targetSessionId || snapshotSessionId;
      let changed = false;
      const next: Record<string, PanelRuntimeEntry> = { ...prev };
      for (const [entryPanelId, entry] of Object.entries(prev)) {
        if (entryPanelId !== targetPanelId) {
          if (!syncSessionId) continue;
          const entrySessionId = parseOptionalSessionId(entry.snapshot.selectedSessionId || entry.sessionId);
          if (entrySessionId !== syncSessionId) continue;
        }
        const messageIndex = entry.snapshot.conversationMessages.findIndex((message) => message.id === messageId);
        if (messageIndex < 0) continue;
        const existingWaveform = entry.snapshot.conversationMessages[messageIndex]?.ttsWaveform;
        if (
          Array.isArray(existingWaveform) &&
          existingWaveform.length === waveformRaw.length &&
          existingWaveform.every((value, index) => value === waveformRaw[index])
        ) {
          continue;
        }
        const nextMessages = [...entry.snapshot.conversationMessages];
        nextMessages[messageIndex] = {
          ...nextMessages[messageIndex],
          ttsWaveform: [...waveformRaw],
        };
        next[entryPanelId] = {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            conversationMessages: nextMessages,
          },
        };
        changed = true;
      }
      return changed ? next : prev;
    });
  };
  const appendAssistantEventMessageForApproval = useCallback((line: string, request?: ApprovalRequest) => {
    const content = String(line || "").trim();
    if (!content) return;
    const sessionId = parseOptionalSessionId(
      request?.sessionInfo?.sessionId || request?.threadId
    );
    const requestedPanelId = normalizeRuntimePanelId(request?.sessionInfo?.panelId || "");
    const knownPanelIds = Array.from(new Set([
      requestedPanelId,
      ...Object.keys(panelRuntimeEntriesById),
    ].filter(Boolean)));
    const targetPanelId = (() => {
      if (requestedPanelId && panelRuntimeEntriesById[requestedPanelId]) return requestedPanelId;
      if (sessionId) {
        for (const panelId of knownPanelIds) {
          const entry = panelRuntimeEntriesById[panelId];
          const snapshotSessionId = parseOptionalSessionId(entry?.snapshot?.selectedSessionId || entry?.sessionId);
          if (snapshotSessionId === sessionId) return panelId;
        }
      }
      return "";
    })();

    if (!targetPanelId) {
      logSessionDiag("approval_message_skipped_missing_panel", {
        sessionId,
        requestedPanelId: requestedPanelId || undefined,
        command: String(request?.command || "").trim() || undefined,
      }, {
        throttleMs: 1000,
        throttleKey: `approval_message_skipped_missing_panel:${sessionId}:${content}`,
      });
      return;
    }

    const messages = getPanelConversationMessagesForCodex(targetPanelId);
    const nextMessages = appendAssistantEventMessageToMessages({
      messages,
      line: content,
      buildConversationMessage,
    });
    if (!nextMessages) return;
    playAssistantEventSfx(content);
    setPanelConversationMessagesForCodex(targetPanelId, nextMessages, {
      sessionId,
    });
  }, [
    buildConversationMessage,
    getPanelConversationMessagesForCodex,
    logSessionDiag,
    panelRuntimeEntriesById,
    playAssistantEventSfx,
    setPanelConversationMessagesForCodex,
  ]);
  appendAssistantEventMessageForApprovalRef.current = appendAssistantEventMessageForApproval;
  const hydratePanelFromSessionHistory = useCallback(async (params: {
    panelId: string;
    sessionId: string;
    directory: string;
    directoryDisplayName?: string;
    diagnosticCycleId?: string;
    title?: string;
    updatedAt?: string;
    modelRef?: string;
    reasoningEffort?: string;
    contextUsedPct?: number | null;
  }) => {
    const panelId = normalizeRuntimePanelId(params?.panelId);
    const sessionId = parseOptionalSessionId(params?.sessionId);
    const directoryRaw = String(params?.directory || "").trim();
    const directory = directoryRaw ? parseLlmDirectory(directoryRaw) : "";
    const directoryDisplayNameHint = String(params?.directoryDisplayName || "").trim();
    const diagnosticCycleId = String(params?.diagnosticCycleId || "").trim();
    const titleHint = String(params?.title || "").trim();
    const updatedAtHint = String(params?.updatedAt || "").trim();
    const modelRefHint = normalizeModelRef(params?.modelRef);
    const reasoningEffortHint = String(params?.reasoningEffort || "").trim();
    const contextUsedPctHint = Number.isFinite(Number(params?.contextUsedPct))
      ? Math.max(0, Math.min(100, Math.round(Number(params?.contextUsedPct))))
      : null;
    if (!panelId || !sessionId || !directory) {
      logSessionDiag("panel_runtime_hydrate_skipped_invalid_params", {
        diagnosticCycleId,
        panelId,
        sessionId,
        directory,
      }, { throttleMs: 0 });
      return false;
    }
    logSessionDiag("panel_runtime_hydrate_start", {
      diagnosticCycleId,
      panelId,
      sessionId,
      directory,
    }, { throttleMs: 0 });
    const directoryDisplayName = (
      directoryDisplayNameHint ||
      registeredDirectories.find((item) => parseLlmDirectory(item.path) === directory)?.displayName ||
      deriveDirectoryDisplayName(directory)
    ).trim();
    const loadingSnapshot = createPanelRuntimeSnapshot(panelId, createEmptyPanelRuntimeSnapshot(panelId), {
      selectedSessionId: sessionId,
      selectedDirectoryPath: directory,
      selectedDirectoryDisplayName: directoryDisplayName,
      selectedSessionTitle: titleHint || "（ユーザーメッセージなし）",
      selectedSessionUpdatedAt: updatedAtHint,
      selectedThreadStatusType: "loading",
      modelRef: modelRefHint,
      reasoningEffort: reasoningEffortHint,
      contextUsedPct: contextUsedPctHint,
      isResponding: false,
      isHydrating: true,
      conversationMessages: [],
    });
    setPanelRuntimeEntriesById((prev) => ({
      ...prev,
      [panelId]: {
        sessionId,
        snapshot: loadingSnapshot,
      },
    }));
    logSessionDiag("mini_board_hydrate_request_received", {
      diagnosticCycleId,
      panelId,
      requestedSessionId: sessionId,
      requestedDirectory: directory,
      requestedTitleHint: titleHint,
      requestedModelRefHint: modelRefHint,
      requestedReasoningEffortHint: reasoningEffortHint,
    }, { throttleMs: 0 });
    try {
      const restored = await fetchRunnerSessionMessages(sessionId, directory);
      const restoredContextUsedPct = Number.isFinite(Number(restored.contextUsedPct))
        ? Math.max(0, Math.min(100, Math.round(Number(restored.contextUsedPct))))
        : null;
      const contextUsedPct = restoredContextUsedPct ?? contextUsedPctHint;
      const panelModelRef = normalizeModelRef(restored.modelRef || modelRefHint);
      const panelReasoningEffort = String(restored.reasoningEffort || reasoningEffortHint || "").trim();
      const resolvedSessionId = parseOptionalSessionId(restored.threadId || sessionId);
      rememberKnownCodexThreadId(resolvedSessionId || sessionId);
      const markerSessionId = resolvedSessionId || sessionId;
      const conversation = (Array.isArray(restored.messages) ? restored.messages : []).map((message, index) => {
        const role = message.role === "assistant" ? "assistant" : "user";
        const content = String(message.content || "");
        const at = String(message.at || "").trim();
        return {
          id: `panel-${panelId}-${resolvedSessionId || sessionId}-${index}-${role}`,
          role,
          content,
          at: at || undefined,
        } satisfies ConversationMessage;
      });
      const firstConversation = conversation[0];
      const lastConversation = conversation.length > 0 ? conversation[conversation.length - 1] : null;
      logSessionDiag("mini_board_hydrate_loaded_messages", {
        diagnosticCycleId,
        panelId,
        requestedSessionId: sessionId,
        resolvedSessionId,
        requestedDirectory: directory,
        restoredThreadId: restored.threadId,
        restoredCwd: restored.cwd,
        modelRef: panelModelRef,
        reasoningEffort: panelReasoningEffort,
        contextUsedPct,
        messageCount: conversation.length,
        firstMessageRole: firstConversation?.role || "",
        firstMessagePreview: String(firstConversation?.content || "").slice(0, 80),
        lastMessageRole: lastConversation?.role || "",
        lastMessagePreview: String(lastConversation?.content || "").slice(0, 80),
      }, { throttleMs: 0 });
      let selectedSessionTitle = titleHint;
      const overrideTitle = String(
        sessionTitleOverridesById[markerSessionId] ||
        sessionTitleOverridesById[sessionId] ||
        ""
      ).trim();
      // セッションタイトルの手動上書きは履歴タイトルより優先する。
      selectedSessionTitle = overrideTitle || selectedSessionTitle;
      if (!selectedSessionTitle) selectedSessionTitle = overrideTitle;
      if (!selectedSessionTitle) selectedSessionTitle = deriveSessionTitleFromConversationMessages(conversation);
      const selectedSessionMarkerColor = parseDirectoryMarkerColor(
        sessionMarkerColorsById[markerSessionId] || sessionMarkerColorsById[sessionId]
      );
      const restoredResponding = Boolean(restored.hasRunningTurn);
      const restoredThreadStatusType = deriveRestoredSessionThreadStatusType(restored);
      const conversationForSnapshot = projectRestoredRuntimeStatusToConversation({
        conversation,
        restored,
        fallbackMessageId: `panel-${panelId}-${resolvedSessionId || sessionId}-restored-live-assistant`,
        buildConversationMessage,
      });
      const snapshot = createPanelRuntimeSnapshot(panelId, createEmptyPanelRuntimeSnapshot(panelId), {
        selectedSessionId: resolvedSessionId || sessionId,
        selectedDirectoryPath: directory,
        selectedDirectoryDisplayName: directoryDisplayName,
        selectedSessionTitle,
        selectedSessionUpdatedAt: updatedAtHint,
        selectedSessionMarkerColor,
        modelRef: panelModelRef,
        reasoningEffort: panelReasoningEffort,
        contextUsedPct,
        isResponding: restoredResponding,
        isHydrating: false,
        selectedThreadStatusType: restoredThreadStatusType,
        conversationMessages: conversationForSnapshot,
      });
      upsertConversationRuntimeSnapshot({
        sessionId: snapshot.selectedSessionId,
        conversationMessages: snapshot.conversationMessages,
        contextUsedPct: snapshot.contextUsedPct,
        isResponding: snapshot.isResponding,
        selectedThreadStatusType: snapshot.selectedThreadStatusType,
      });
      setPanelRuntimeEntriesById((prev) => ({
        ...prev,
        [panelId]: {
          sessionId: snapshot.selectedSessionId,
          snapshot,
        },
      }));
      logSessionDiag("panel_runtime_hydrate_done", {
        diagnosticCycleId,
        panelId,
        sessionId: snapshot.selectedSessionId,
        directory,
        modelRef: snapshot.modelRef,
        reasoningEffort: snapshot.reasoningEffort,
        contextUsedPct: snapshot.contextUsedPct,
        isResponding: snapshot.isResponding,
        selectedThreadStatusType: snapshot.selectedThreadStatusType,
        messageCount: snapshot.conversationMessages.length,
      }, { throttleMs: 0 });
      if (restoredResponding && snapshot.selectedSessionId) {
        const runningStartedAtMsRaw = Date.parse(String(restored.runningTurn?.startedAt || ""));
        const relayAttached = startCodexRelayObserverForSession(snapshot.selectedSessionId, {
          directory,
          startedAtMs: Number.isFinite(runningStartedAtMsRaw) ? runningStartedAtMsRaw : Date.now(),
          resumeFromSeq: 0,
          reason: "session_restored_running_turn",
        });
        logSessionDiag("panel_runtime_hydrate_session_player_attach", {
          diagnosticCycleId,
          panelId,
          sessionId: snapshot.selectedSessionId,
          directory,
          relayAttached,
          selectedThreadStatusType: snapshot.selectedThreadStatusType,
        }, { throttleMs: 0 });
      }
      return true;
    } catch (error) {
      logSessionDiag("panel_runtime_hydrate_error", {
        diagnosticCycleId,
        panelId,
        sessionId,
        directory,
        message: error instanceof Error ? error.message : String(error),
      }, { throttleMs: 0 });
      setPanelRuntimeEntriesById((prev) => {
        const current = prev[panelId];
        const currentSessionId = parseOptionalSessionId(current?.snapshot.selectedSessionId || current?.sessionId);
        if (currentSessionId && currentSessionId !== sessionId) return prev;
        const baseSnapshot = current?.snapshot || loadingSnapshot;
        return {
          ...prev,
          [panelId]: {
            sessionId: current?.sessionId || sessionId,
            snapshot: createPanelRuntimeSnapshot(panelId, baseSnapshot, {
              isHydrating: false,
              isResponding: false,
              selectedThreadStatusType: "error",
            }),
          },
        };
      });
      return false;
    }
  }, [
    buildConversationMessage,
    createEmptyPanelRuntimeSnapshot,
    createPanelRuntimeSnapshot,
    fetchRunnerSessionMessages,
    logSessionDiag,
    rememberKnownCodexThreadId,
    registeredDirectories,
    sessionMarkerColorsById,
    sessionTitleOverridesById,
    startCodexRelayObserverForSession,
    upsertConversationRuntimeSnapshot,
  ]);
  getPanelConversationMessagesForCodexRef.current = getPanelConversationMessagesForCodex;
  setPanelConversationMessagesForCodexRef.current = setPanelConversationMessagesForCodex;
  const panelRuntimeStoreContextValue = useMemo<PanelRuntimeStoreContextValue>(() => {
    return {
      getSnapshot: resolvePanelSnapshotForDisplay,
      getKnownPanelIds: () => Object.keys(panelRuntimeEntriesById),
    };
  }, [panelRuntimeEntriesById, resolvePanelSnapshotForDisplay]);
  const panelRuntimeControllerContextValue = useMemo<PanelRuntimeControllerContextValue>(() => ({
    clearPanelSnapshot,
    copyPanelSnapshot,
    setPanelAutoSpeechOpen,
    startNewPanelSession,
    updatePanelSettings,
    hydratePanelFromSessionHistory,
  }), [
    clearPanelSnapshot,
    copyPanelSnapshot,
    hydratePanelFromSessionHistory,
    setPanelAutoSpeechOpen,
    startNewPanelSession,
    updatePanelSettings,
  ]);
  const audioLabContextValue = useAudioLabContextValue({
    audioLabFlatlineDb: AUDIO_LAB_FLATLINE_DB,
    audioLabRunning,
    audioLabRecordingActive,
    audioLabPlaybackActive,
    audioLabInputName,
    audioLabAirPodsInput,
    audioLabElapsedMs,
    audioLabCallbackIntervalMs,
    audioLabLastDb,
    audioLabMinDb,
    audioLabMaxDb,
    audioLabFlatlineMs,
    audioLabPlaybackPositionMs,
    audioLabPlaybackStallMs,
    audioLabLoopCount,
    audioLabUnexpectedStopCount,
    audioLabPlaybackRecoverCount,
    audioLabLogQueuedCount,
    audioLabLogSentCount,
    audioLabLogStatus,
    audioLabRecentLogs,
    errorMessage: error,
    startProbe: startAudioLabProbeFromContext,
    stopProbe: stopAudioLabProbeFromContext,
    startPlaybackOnly: startAudioLabPlaybackOnlyFromContext,
    stopPlaybackOnly: stopAudioLabPlaybackOnlyFromContext,
    sendLogs: sendAudioLabLogsFromContext,
    clearLogs: clearAudioLabLogsLocal,
    runnerUrl,
    runnerToken,
  });
  const youTubePlayerContextValue = useYouTubePlayerContextValue({
    activeYouTubeQueuePositionLabel,
    youtubeVideoMetaById,
    conversationInlineAnchorMessageId,
    showFloatingYouTubePlayer,
    setYoutubeInlineAnchor,
    youtubePlayerVideoId,
    youtubeEmbedHtml,
    youtubeWebViewRef,
    youtubePlayerSession,
    youtubeEmbedOrigin: YOUTUBE_EMBED_ORIGIN,
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
  });
  const chatDiagnosticsContextValue = useChatDiagnosticsContextValue({
    codexCliStatusSnapshot,
    codexCliStatusFetchedAtMs,
    codexCliStatusLoading,
    codexAuthProfilesSnapshot,
    codexAuthProfilesLoading,
    codexAuthSwitching,
    codexAuthSwitchError,
    gitChangedFilesByDirectory,
    refreshGitChangedFiles,
    refreshCodexCliStatus: refreshCodexCliStatusFromContext,
    loadCodexAuthProfiles: loadCodexAuthProfilesFromContext,
    switchCodexAuthProfile: switchCodexAuthProfileFromContext,
  });
  const handleSelectSlashCommand = useCallback((command: string) => {
    chatComposerInputRef.current?.blur();
    void runSlashCommand(command);
  }, [chatComposerInputRef, runSlashCommand]);
  const chatComposerContextValue = useChatComposerContextValue({
    composerWaveformVisible,
    autoWaveformAnimationEnabled: AUTO_WAVEFORM_ANIMATION_ENABLED,
    waveformDotGif: WAVEFORM_DOT_GIF,
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
    manualRecording: Boolean(manualRecording),
    faceTrackingEnabled,
    faceTrackingLooking,
    hasComposerText,
    canStopLlmTurn: llmBackend === "codex_app_server" && replyLoading,
    stopDirectNativeStt: stopDirectNativeSttFromComposerContext,
    stopAutoRecordingMode: stopAutoRecordingModeFromComposerContext,
    stopRecording: stopRecordingFromComposerContext,
    stopLlmTurn: stopLlmTurnFromComposerContext,
    startDirectNativeStt: startDirectNativeSttFromComposerContext,
    startAutoRecordingMode: startAutoRecordingModeFromComposerContext,
    setFaceTrackingEnabledWithRef,
    faceTrackingRunning,
    setSlashCommandSelectOpen,
    slashCommandOptions: SLASH_COMMAND_OPTIONS,
    onSelectSlashCommand: handleSelectSlashCommand,
  });
  const chatVisualContextValue = useChatVisualContextValue({
    isRobotAnimating,
    pixelRobotImage: PIXEL_ROBOT_IMAGE,
    pixelRobotImageStatic: PIXEL_ROBOT_IMAGE,
    chatContextUsedPct,
    chatContextRingProgress,
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
    pixelStatusAnimations: PIXEL_STATUS_ANIMATIONS,
    showChatThinkingPanel,
    chatThinkingCurrentMessage,
    llmElapsedLiveMs,
    chatThinkingLogLines,
    setChatThinkingLogExpanded,
    chatThinkingLogExpanded,
    isStreamWaveformPlaybackActive,
    stopWaveformPlayback: stopWaveformPlaybackFromVisualContext,
    error,
    chatBottomToast,
    chatBottomToastAnimRef,
  });
  const chatScreenContextValue = useChatScreenContextValue({
    approvalDialogPending: !!approvalDialog,
    setChatScreenLayout,
    setChatViewportHeight,
    handleChatScroll,
    chatContentRef,
    handleChatTouchStart,
    handleChatTouchEnd,
    runnerUrl,
    runnerToken,
    isCodexCompactRunning,
    sanitizeTextForTts,
    handleAssistantAudioButtonPress,
  });
  const closeDrawerSessionPopup = useCallback(() => {
    if (drawerSessionPopupPanelId) {
      clearPanelSnapshot(drawerSessionPopupPanelId);
    }
    setDrawerSessionPopupPanelId("");
    setDrawerSessionPopupCycleId("");
    setDrawerSessionPopupSourceRect(null);
  }, [clearPanelSnapshot, drawerSessionPopupPanelId]);
  const openNewSessionPopup = useCallback((params: { directory: string }) => {
    const directory = parseLlmDirectory(params?.directory || normalizedLlmDirectoryForRequest());
    const sessionId = startNewPanelSession({
      panelId: DRAWER_SESSION_POPUP_PANEL_ID,
      directory,
    });
    if (!sessionId) return;
    const cycleId = `drawer-new-session-popup-${Date.now().toString(36)}`;
    setDrawerSessionPopupSourceRect(null);
    setDrawerSessionPopupCycleId(cycleId);
    setDrawerSessionPopupPanelId(DRAWER_SESSION_POPUP_PANEL_ID);
    logSessionDiag("drawer_new_session_popup_opened", {
      panelId: DRAWER_SESSION_POPUP_PANEL_ID,
      sessionId,
      directory,
      cycleId,
    }, { throttleMs: 0 });
  }, [
    logSessionDiag,
    normalizedLlmDirectoryForRequest,
    startNewPanelSession,
  ]);
  const openSessionHistoryPopup = useCallback((params: {
    sessionId: string;
    source: LlmSessionSource;
    directory?: string;
    sourceRect?: PopupChatSourceRect;
  }) => {
    const sessionId = parseOptionalSessionId(params.sessionId);
    if (!sessionId) {
      showChatBottomToast("assistant", "セッションIDが不明なため開けませんでした。");
      return;
    }
    const context = resolveSessionHistoryContext(sessionId);
    const directoryRaw = String(params.directory || "").trim();
    const directory = context?.directory || (directoryRaw ? parseLlmDirectory(directoryRaw) : "");
    if (!directory) {
      showChatBottomToast("assistant", "セッションのディレクトリが不明なため開けませんでした。");
      logSessionDiag("drawer_session_popup_open_skipped_missing_directory", {
        sessionId,
        source: params.source,
      }, { throttleMs: 0 });
      return;
    }
    const cycleId = `drawer-session-popup-${Date.now().toString(36)}`;
    setDrawerSessionPopupSourceRect(params.sourceRect || null);
    setDrawerSessionPopupCycleId(cycleId);
    setDrawerSessionPopupPanelId(DRAWER_SESSION_POPUP_PANEL_ID);
    void hydratePanelFromSessionHistory({
      panelId: DRAWER_SESSION_POPUP_PANEL_ID,
      sessionId,
      directory,
      directoryDisplayName: context?.directoryDisplayName,
      diagnosticCycleId: cycleId,
      title: context?.sessionTitle,
      updatedAt: context?.updatedAt,
      modelRef: context?.modelRef,
      reasoningEffort: context?.reasoningEffort,
      contextUsedPct: context?.contextUsedPct,
    }).then((hydrated) => {
      if (!hydrated) {
        showChatBottomToast("assistant", "セッションをポップアップに読み込めませんでした。");
        clearPanelSnapshot(DRAWER_SESSION_POPUP_PANEL_ID);
        setDrawerSessionPopupPanelId("");
        return;
      }
      markSessionReadFromContext(sessionId, params.source, directory);
    }).catch((err) => {
      showChatBottomToast("assistant", `セッション読込に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      clearPanelSnapshot(DRAWER_SESSION_POPUP_PANEL_ID);
      setDrawerSessionPopupPanelId("");
    });
  }, [
    clearPanelSnapshot,
    hydratePanelFromSessionHistory,
    markSessionReadFromContext,
    logSessionDiag,
    resolveSessionHistoryContext,
    showChatBottomToast,
  ]);

  const resolveCompletionNotificationDirectoryName = useCallback((sessionIdRaw: string) => {
    return resolveSessionHistoryContext(sessionIdRaw)?.directoryDisplayName || "";
  }, [resolveSessionHistoryContext]);

  const openCompletedLlmSession = useCallback((sessionIdRaw: string) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return;
    closeDrawer();
    openSessionHistoryPopup({
      sessionId,
      source: "all",
    });
  }, [
    closeDrawer,
    openSessionHistoryPopup,
  ]);

  const visibleCompletionNotificationSessionIds = useMemo(() => {
    const ids: string[] = [];
    if (activeScreen === "mini_board") {
      const activeSessionId = parseOptionalSessionId(
        selectedLlmSessionId || llmConversationSessionIdRef.current
      );
      if (activeSessionId) ids.push(activeSessionId);
    }
    if (drawerSessionPopupPanelId) {
      const popupEntry = panelRuntimeEntriesById[drawerSessionPopupPanelId];
      const popupSessionId = parseOptionalSessionId(
        popupEntry?.snapshot?.selectedSessionId || popupEntry?.sessionId
      );
      if (popupSessionId) ids.push(popupSessionId);
    }
    return Array.from(new Set(ids));
  }, [
    activeScreen,
    drawerSessionPopupPanelId,
    panelRuntimeEntriesById,
    selectedLlmSessionId,
  ]);

  const appDrawerProps = useAppDrawerSessionController({
    selectedDirectoryPath: selectedDirectoryPathForConversationContext,
    selectedLlmSessionId,
    registeredDirectories,
    expandedDirectoryIds,
    directorySessionsById,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    llmSessionRestoreLoading,
    llmSessionRestoreTargetId,
    formatSessionUpdatedAt,
    closeDrawer,
    openDebugScreen,
    openMiniBoardScreen,
    openDirectoryExplorer,
    toggleDirectoryExpanded,
    loadMoreDirectorySessionTree,
    selectLlmDirectory,
    openNewSessionPopup,
    openSessionHistoryPopup,
    markSessionUnread,
    markSessionRead,
    markDirectorySessionsRead,
  });

  return (
    <GestureHandlerRootView style={styles.safeArea}>
      <AppProviders
        appShell={appShellContextValue}
        appSettings={appSettingsContextValue}
        conversation={conversationContextValue}
        panelRuntimeStore={panelRuntimeStoreContextValue}
        panelRuntimeController={panelRuntimeControllerContextValue}
        audioLab={audioLabContextValue}
        youTubePlayer={youTubePlayerContextValue}
        chatDiagnostics={chatDiagnosticsContextValue}
        chatComposer={chatComposerContextValue}
        chatVisual={chatVisualContextValue}
        chatScreen={chatScreenContextValue}
        debugRuntime={debugRuntimeContextValue}
        debugConversation={debugConversationContextValue}
        debugSpeech={debugSpeechContextValue}
        runnerWsUrl={codexWsUrl.trim()}
        runnerWsToken={codexWsToken.trim() || runnerToken.trim()}
        runnerWsEnabled={isRunnerWsUrl(codexWsUrl)}
      >
      <KeyboardProvider>
        <Drawer
        open={drawerOpen}
        onOpen={openDrawer}
        onClose={closeDrawer}
        swipeEnabled={activeScreen === "mini_board"}
        swipeEdgeWidth={DRAWER_SWIPE_EDGE_WIDTH}
        swipeMinDistance={DRAWER_SWIPE_MIN_DISTANCE}
        swipeMinVelocity={DRAWER_SWIPE_MIN_VELOCITY}
        keyboardDismissMode="on-drag"
        drawerType="front"
        drawerPosition="left"
        drawerStyle={styles.appDrawerPanel}
        overlayStyle={styles.appDrawerOverlay}
        renderDrawerContent={() => (
          <AppDrawer {...appDrawerProps} />
        )}
      >
      <SafeAreaView style={styles.safeArea}>
      {activeScreen === "debug" ? (
        <DebugScreen />
      ) : activeScreen === "mini_board" ? (
        <MiniBoardScreen />
      ) : (
        <AudioLabScreen />
      )}
      <AppOverlays
        composerFullscreenOpen={composerFullscreenOpen}
        closeComposerFullscreen={closeComposerFullscreen}
        chatComposerFullscreenInputRef={chatComposerFullscreenInputRef}
        setComposerInputFocused={setComposerInputFocused}
        slashCommandSelectOpen={slashCommandSelectOpen}
        setSlashCommandSelectOpen={setSlashCommandSelectOpen}
        slashCommandOptions={SLASH_COMMAND_OPTIONS}
        onSelectSlashCommand={handleSelectSlashCommand}
        approvalDialog={approvalDialog}
        onApprovalDialogAction={respondToApprovalDialog}
      />
      </SafeAreaView>
        </Drawer>
        {drawerSessionPopupPanelId ? (
          <View pointerEvents="box-none" style={styles.drawerPopupOverlayHost}>
            <SafeAreaView style={styles.drawerPopupSafeArea}>
              <PopupChatOverlay
                visible={!!drawerSessionPopupPanelId}
                panelId={drawerSessionPopupPanelId}
                cycleId={drawerSessionPopupCycleId}
                sourceRect={drawerSessionPopupSourceRect}
                onClose={closeDrawerSessionPopup}
              />
            </SafeAreaView>
          </View>
        ) : null}
        <SafeAreaView pointerEvents="box-none" style={styles.llmCompletionNotificationLayer}>
          <LlmCompletionNotifications
            visibleSessionIds={visibleCompletionNotificationSessionIds}
            resolveDirectoryName={resolveCompletionNotificationDirectoryName}
            onOpenSession={openCompletedLlmSession}
          />
        </SafeAreaView>
      </KeyboardProvider>
      </AppProviders>
    </GestureHandlerRootView>
  );
}
