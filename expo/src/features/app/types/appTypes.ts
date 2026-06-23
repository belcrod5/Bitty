import type { SttProvider } from "../../stt/sttConfig";
import type { LlmUiStatus } from "../hooks/useLlmRequestStatus";
import type { LlmSessionSource } from "../hooks/useLlmSessionExplorer";

export type HistoryEntry = {
  id: string;
  createdAt: string;
  transcript: string;
  reply: string;
};

export type SttMessageMeta = {
  source: "recording_uri" | "native_direct";
  sttProvider?: SttProvider;
  durationMs?: number;
  speechMs?: number;
  silenceTrimmedMs?: number;
  speechRatio?: number;
  mimeType?: string;
  payloadBytes?: number;
  segmentSeq?: number;
  sttRoundtripMs?: number;
  profile?: string;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  at?: string;
  inheritedFromParent?: boolean;
  pendingUser?: boolean;
  youtubeVideoIds?: string[];
  ttsWaveform?: number[];
  llmStatus?: LlmUiStatus;
  llmStatusDetail?: string;
  llmElapsedMs?: number;
  sttMeta?: SttMessageMeta;
  codexQueue?: {
    queuedTurnId: string;
    status: "queued" | "waiting_compact" | "running" | "completed" | "failed" | "cancelled";
    errorMessage?: string;
  };
};

export type AudioModeSwitchOptions = {
  force?: boolean;
  reason?: string;
  allowsRecordingIOS?: boolean;
};

export type YouTubeVideoMeta = {
  videoId: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number | null;
};

export type StreamSegmentStatus = "queued" | "synthesizing" | "ready" | "playing" | "played";

export type StreamSegment = {
  seq: number;
  text: string;
  status: StreamSegmentStatus;
  chunkChars?: number | null;
  segmentTargetChars?: number | null;
  estimatedDurationMs?: number | null;
  actualDurationMs?: number | null;
  playedSinceFirstNativeDeltaMs?: number | null;
  llmNativeDeltaCountAtPlayed?: number | null;
  llmNativeDeltaLastAtPlayed?: string | null;
};

export type StreamAudioQueueItem = {
  seq: number;
  mimeType: string;
  playbackMessageId: string;
  uri: string;
  chunkChars?: number | null;
  segmentTargetChars?: number | null;
  estimatedDurationMs?: number | null;
  actualDurationMs?: number | null;
};

export type SelectSpecificLlmSessionOptions = {
  source?: LlmSessionSource;
  directory?: string;
};

export type LlmDeltaSource = "native" | "pseudo" | "mock" | "unknown";

export type LlmDeltaEntry = {
  source: LlmDeltaSource;
  text: string;
};

export type LlmBackend = "codex_app_server";
export type AudioContainer = "wav" | "mp3" | "ogg" | "m4a" | "unknown";

export type TtsDebugStats = {
  synthRequests: number;
  synthMimeType: string;
  synthDetected: AudioContainer;
  synthAudioBytes: number;
  synthWaveformBars: number;
  synthTargetMessageId: string;
  playAttempts: number;
  playExt: string;
  playDetected: AudioContainer;
  playAudioBytes: number;
  playStatusErrors: number;
  playLastStatusError: string;
  streamChunkCount: number;
  streamLastSeq: number;
  streamLastMimeType: string;
  streamLastAudioBytes: number;
  streamLastWaveformBars: number;
  streamMergedWaveformBars: number;
};

export type ToolAutoApprovalMap = Record<string, true>;
export type TtsUiStatus = "idle" | "queued" | "synthesizing" | "playing" | "error";
export type TtsPlaybackTarget = {
  messageId?: string;
  panelId?: string;
  sessionId?: string;
};
export type MediaTarget = "all" | "youtube" | "tts";
export type MediaAction = "stop" | "next" | "prev";

export type ChatYouTubeQueueEntry = {
  videoId: string;
  messageId: string;
};

export type ToolCallPhase = "start" | "done";
export type ToolCallEntry = {
  at: number;
  phase: ToolCallPhase;
  toolName: string;
  status?: string;
  durationMs?: number | null;
  summary?: string;
};

export type LlmProgressEntry = {
  at: number;
  stage: string;
  message: string;
  round: number | null;
  maxToolRounds: number | null;
  toolCalls: number | null;
  pendingToolCalls: number | null;
  toolName: string;
  status: string;
  durationMs: number | null;
};

export type LlmSessionMessageRole = "user" | "assistant";
export type LlmSessionMessage = {
  role: LlmSessionMessageRole;
  content: string;
  at: string;
};

export type SessionExecutionFact = {
  sessionId: string;
  reasonLabel: string;
  reasonDetail: string;
  startedAtMs: number | null;
  lastUpdatedAtMs: number | null;
};

export type SessionRuntimeStatus = {
  hasRunningTurn: boolean;
  hasPendingAssistant: boolean;
  restoredInFlight: boolean;
  waitingApproval: boolean;
  updatedAtMs: number;
};

export type LlmRuntimeLimitsSnapshot = {
  llmTimeoutMs: number | null;
  toolMaxRounds: number | null;
  approvalTimeoutMs: number | null;
  sttTimeoutMs: number | null;
  fetchedAt: string;
};

export type CodexCliStatusLimitLine = {
  section: string;
  label: string;
  value: string;
};

export type CodexCliStatusSnapshot = {
  statusText: string;
  limitLines: CodexCliStatusLimitLine[];
  fetchedAt: string;
};

export type CodexAuthProfileEntry = {
  authId: string;
  fileName: string;
  isCurrent: boolean;
};

export type CodexAuthProfilesSnapshot = {
  currentAuthId: string;
  profiles: CodexAuthProfileEntry[];
  fetchedAt: string;
};

export type GitChangedFilesSnapshot = {
  branchName: string;
  behindCount: number;
  branches: {
    name: string;
    kind: "local" | "remote";
  }[];
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  fetchedAt: string;
};

export type GitChangedFilesDirectoryState = {
  snapshot: GitChangedFilesSnapshot | null;
  loading: boolean;
  error: string;
};

export type AppScreen = "mini_board" | "debug" | "audio_lab";
export type SlashCommandName = "/status" | "/compact";

export type UiSfxKey =
  | "send"
  | "reply"
  | "toolStart"
  | "toolDone"
  | "youtubePlay"
  | "youtubeStop"
  | "recordStart"
  | "recordStop"
  | "approval"
  | "error";

export type AutoClientLogEntry = {
  sessionId: string;
  seq: number;
  at: string;
  event: string;
  payload: Record<string, unknown>;
  screen: AppScreen;
  autoEnabled: boolean;
  autoState: string;
  autoEvent: string;
  ttsPlaying: boolean;
  ttsLoading: boolean;
  replyLoading: boolean;
};

export type PersistedDirectoryUiState = {
  expandedDirectoryIds: string[];
};

export type SessionSwitchQueuedSend = {
  transcript: string;
  sttMeta?: SttMessageMeta;
  panelId: string;
  sessionSnapshot?: ReplyRequestSessionSnapshot;
  restoreRequestSeq: number;
  queuedAt: number;
  source: "send_reply_request" | "send_reply_transcript";
};

export type ReplyRequestSessionSnapshot = {
  sessionId?: string;
  threadId?: string;
  directory?: string;
  directoryDisplayName?: string;
  sessionTitle?: string;
  modelRef?: string;
  reasoningEffort?: string;
  source?: string;
};
