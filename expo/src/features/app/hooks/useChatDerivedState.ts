import { useMemo } from "react";
import { Platform } from "react-native";
import {
  isLlmActiveStatus,
  liveLlmStatusPrefix,
  llmStatusVisual,
  parseReplyDebugLines,
  summarizeChatThinkingDetail,
  trimForInline,
} from "../utils/statusText";
import { buildProgressStatusLine } from "../utils/tooling";
import { resolvePixelStatusIconKey } from "../utils/statusIcons";
import { findLatestAssistantMessageIndex } from "../utils/sessionRuntimeStatus";
import { buildYouTubeEmbedHtml, normalizeYouTubeVideoIds } from "../utils/youtube";
import type { CodexCommandExecutionInfo } from "../../codex/client/types";
import type { VisualTheme } from "../theme/visualThemes";

type LlmUiStatus =
  | "idle"
  | "connecting"
  | "model_processing"
  | "tool_waiting_approval"
  | "tool_running"
  | "model_generating"
  | "completed"
  | "error";

type ConversationMessageLike = {
  id: string;
  role: "user" | "assistant";
  content?: string;
  youtubeVideoIds?: unknown;
  ttsWaveform?: unknown;
  commandExecution?: CodexCommandExecutionInfo;
};

type StreamSegmentLike = {
  messageId: string;
  status?: string;
};

type ChatYouTubeQueueEntry = {
  videoId: string;
  messageId: string;
};
type ProgressStatusLineEntry = Parameters<typeof buildProgressStatusLine>[0];

type VideoMetaLike = {
  channelTitle?: string;
  publishedAt?: string;
  viewCount?: number | null;
};

type UseChatDerivedStateParams = {
  visualTheme: VisualTheme;
  codexWsUrl: string;
  transcript: string;
  replyLoading: boolean;
  llmSessionRestoreLoading: boolean;
  composerInputFocused: boolean;
  llmBackend: string;
  modelOptions: readonly { label: string; modelId: string; backendId: string }[];
  modelRef: string;
  reasoningEffort: string;
  normalizedLlmDirectoryForRequest: () => string;
  selectedLlmSessionId: string;
  youtubePlayerVideoId: string;
  youtubePlayerSession: number;
  conversationMessages: ConversationMessageLike[];
  youtubeVideoMetaById: Record<string, VideoMetaLike>;
  streamReplyYouTubeVideoIds: string[];
  streamSegments: StreamSegmentLike[];
  ttsPlaybackMessageId: string;
  acpContextUsedPct: number | null;
  ttsLoading: boolean;
  ttsPlaying: boolean;
  ttsQueueProcessing: boolean;
  llmUiStatus: LlmUiStatus;
  llmUiStatusDetail: string;
  llmUiStatusDetailBase: string;
  streamLlmProgress: unknown[];
  replyDebug: string;
  chatThinkingLogExpanded: boolean;
};

export function useChatDerivedState({
  visualTheme,
  codexWsUrl,
  transcript,
  replyLoading,
  llmSessionRestoreLoading,
  composerInputFocused,
  llmBackend,
  modelOptions,
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
  ttsPlaybackMessageId,
  acpContextUsedPct,
  ttsLoading,
  ttsPlaying,
  ttsQueueProcessing,
  llmUiStatus,
  llmUiStatusDetail,
  llmUiStatusDetailBase,
  streamLlmProgress,
  replyDebug,
  chatThinkingLogExpanded,
}: UseChatDerivedStateParams) {
  const canSend = useMemo(
    () => !!transcript.trim() && !replyLoading && !llmSessionRestoreLoading && !!codexWsUrl.trim(),
    [codexWsUrl, transcript, replyLoading, llmSessionRestoreLoading]
  );
  const hasComposerText = useMemo(() => !!transcript.trim(), [transcript]);
  const composerInputNewlineCount = useMemo(() => {
    const text = String(transcript || "");
    if (!text) return 0;
    const matches = text.match(/\r\n|\r|\n/g);
    return matches ? matches.length : 0;
  }, [transcript]);
  const showComposerFullscreenToggle = (
    (Platform.OS === "macos" || composerInputFocused)
  );
  const selectedModelLabel = useMemo(
    () => modelOptions.find((item) => item.backendId === llmBackend && item.modelId === modelRef)?.label || modelRef,
    [llmBackend, modelOptions, modelRef]
  );
  const chatFooterDirectoryLabel = useMemo(
    () => `${selectedModelLabel} ${reasoningEffort} ${normalizedLlmDirectoryForRequest()}`,
    [reasoningEffort, selectedModelLabel, normalizedLlmDirectoryForRequest]
  );
  const selectedLlmSessionLabel = useMemo(() => {
    const normalized = String(selectedLlmSessionId || "").trim();
    if (!normalized) return "最新を自動再開";
    if (normalized.length <= 12) return normalized;
    return `${normalized.slice(0, 12)}...`;
  }, [selectedLlmSessionId]);
  const youtubeEmbedHtml = useMemo(
    () => buildYouTubeEmbedHtml(youtubePlayerVideoId, youtubePlayerSession, visualTheme.dark.surfaceRaised),
    [visualTheme.dark.surfaceRaised, youtubePlayerSession, youtubePlayerVideoId]
  );
  const latestAssistantYouTubeMessage = useMemo(() => {
    for (let i = conversationMessages.length - 1; i >= 0; i -= 1) {
      const item = conversationMessages[i];
      if (item.role !== "assistant") continue;
      const ids = normalizeYouTubeVideoIds(item.youtubeVideoIds);
      if (ids.length > 0) {
        return {
          id: item.id,
          videoIds: ids,
        };
      }
    }
    return null;
  }, [conversationMessages]);
  const latestAssistantYouTubeVideoIds = latestAssistantYouTubeMessage?.videoIds || [];
  const latestAssistantYouTubeVideos = useMemo(
    () => latestAssistantYouTubeVideoIds.map((videoId) => ({
      videoId,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      channelTitle: String(youtubeVideoMetaById[videoId]?.channelTitle || "").trim(),
      publishedAt: String(youtubeVideoMetaById[videoId]?.publishedAt || "").trim(),
      viewCount: Number.isFinite(Number(youtubeVideoMetaById[videoId]?.viewCount))
        ? Number(youtubeVideoMetaById[videoId]?.viewCount)
        : null,
    })),
    [latestAssistantYouTubeVideoIds, youtubeVideoMetaById]
  );
  const streamReplyYouTubeVideos = useMemo(
    () => streamReplyYouTubeVideoIds.map((videoId) => ({
      videoId,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      channelTitle: String(youtubeVideoMetaById[videoId]?.channelTitle || "").trim(),
      publishedAt: String(youtubeVideoMetaById[videoId]?.publishedAt || "").trim(),
      viewCount: Number.isFinite(Number(youtubeVideoMetaById[videoId]?.viewCount))
        ? Number(youtubeVideoMetaById[videoId]?.viewCount)
        : null,
    })),
    [streamReplyYouTubeVideoIds, youtubeVideoMetaById]
  );
  const chatWideYouTubeQueue = useMemo(() => {
    const out: ChatYouTubeQueueEntry[] = [];
    const seen = new Set<string>();
    const pushEntries = (videoIdsRaw: unknown, messageIdRaw: unknown) => {
      const messageId = String(messageIdRaw || "").trim();
      if (!messageId) return;
      const ids = normalizeYouTubeVideoIds(videoIdsRaw);
      for (const videoId of ids) {
        if (seen.has(videoId)) continue;
        seen.add(videoId);
        out.push({ videoId, messageId });
      }
    };
    for (const message of conversationMessages) {
      if (message.role !== "assistant") continue;
      pushEntries(message.youtubeVideoIds, message.id);
    }
    if (replyLoading && streamReplyYouTubeVideoIds.length > 0) {
      pushEntries(streamReplyYouTubeVideoIds, "__stream__");
    }
    return out;
  }, [conversationMessages, replyLoading, streamReplyYouTubeVideoIds]);
  const ttsSegmentProgress = useMemo(() => {
    const activeSegments = streamSegments.filter((segment) => segment.messageId === ttsPlaybackMessageId);
    const total = activeSegments.length;
    if (total <= 0) {
      return {
        total: 0,
        playedNow: 0,
        generated: 0,
        playbackRatio: 0,
        generationRatio: 0,
      };
    }
    let played = 0;
    let playing = 0;
    let generated = 0;
    for (const segment of activeSegments) {
      if (segment.status === "played") {
        played += 1;
        generated += 1;
      } else if (segment.status === "playing") {
        playing += 1;
        generated += 1;
      } else if (segment.status === "ready") {
        generated += 1;
      }
    }
    const playedNow = played + playing;
    return {
      total,
      playedNow,
      generated,
      playbackRatio: Math.max(0, Math.min(1, playedNow / total)),
      generationRatio: Math.max(0, Math.min(1, generated / total)),
    };
  }, [streamSegments, ttsPlaybackMessageId]);
  // null means "not fetched yet"; keep it null so the UI shows "--" instead of a fake 0%.
  const chatContextUsedPct = acpContextUsedPct === null
    ? null
    : Math.max(0, Math.min(100, Math.round(acpContextUsedPct)));
  const chatContextRingProgress = chatContextUsedPct === null
    ? 0
    : Math.max(0, Math.min(1, chatContextUsedPct / 100));
  const chatContextRingTrackColor = visualTheme.colors.infoMuted;
  const chatContextRingProgressColor = visualTheme.colors.contextProgress;
  const isRobotAnimating = useMemo(
    () => (
      replyLoading ||
      ttsLoading ||
      ttsPlaying ||
      ttsQueueProcessing
    ),
    [replyLoading, ttsLoading, ttsPlaying, ttsQueueProcessing]
  );
  const latestAssistantWaveformLen = useMemo(() => {
    const index = findLatestAssistantMessageIndex(conversationMessages);
    if (index < 0) return 0;
    const points = conversationMessages[index].ttsWaveform;
    return Array.isArray(points) ? points.length : 0;
  }, [conversationMessages]);
  const llmVisual = llmStatusVisual(llmUiStatus);
  const llmPixelIconKey = useMemo(
    () => resolvePixelStatusIconKey(llmUiStatus, llmUiStatusDetail),
    [llmUiStatus, llmUiStatusDetail]
  );
  const chatThinkingCurrentMessage = useMemo(() => {
    const prefix = liveLlmStatusPrefix(llmUiStatus);
    const humanized = summarizeChatThinkingDetail(llmUiStatusDetailBase);
    if (humanized) return `${prefix}... ${humanized}`;
    if (llmUiStatusDetailBase) {
      return `${prefix}... ${trimForInline(llmUiStatusDetailBase, 90)}`;
    }
    return prefix;
  }, [llmUiStatus, llmUiStatusDetail, llmUiStatusDetailBase]);
  const chatThinkingLogLines = useMemo(() => {
    const lines: string[] = [];
    for (const entryRaw of streamLlmProgress.slice(-10)) {
      if (!entryRaw || typeof entryRaw !== "object") continue;
      lines.push(buildProgressStatusLine(entryRaw as ProgressStatusLineEntry));
    }
    for (const line of parseReplyDebugLines(replyDebug).slice(-12)) {
      lines.push(line);
    }
    return lines.slice(-12);
  }, [streamLlmProgress, replyDebug]);
  const showChatThinkingPanel = useMemo(() => {
    if (replyLoading) return true;
    if (isLlmActiveStatus(llmUiStatus)) return true;
    return chatThinkingLogExpanded && chatThinkingLogLines.length > 0;
  }, [replyLoading, llmUiStatus, chatThinkingLogExpanded, chatThinkingLogLines.length]);
  return {
    canSend,
    hasComposerText,
    composerInputNewlineCount,
    showComposerFullscreenToggle,
    selectedModelLabel,
    chatFooterDirectoryLabel,
    selectedLlmSessionLabel,
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
    latestAssistantWaveformLen,
    llmVisual,
    llmPixelIconKey,
    chatThinkingCurrentMessage,
    chatThinkingLogLines,
    showChatThinkingPanel,
  };
}
