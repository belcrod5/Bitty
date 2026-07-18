import { useMemo } from "react";
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
  codexWsUrl: string;
  transcript: string;
  replyLoading: boolean;
  llmSessionRestoreLoading: boolean;
  sttProvider: string;
  directNativeSttEnabled: boolean;
  autoRecordingEnabled: boolean;
  manualRecording: boolean;
  directNativeSttInterimText: string;
  composerInputFocused: boolean;
  modelOptions: readonly { label: string; value: string }[];
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
  autoWaveform: number[];
  autoWaveformSpeechMask: number[];
  autoWaveformDataPipelineEnabled: boolean;
  autoWaveformDebugOverlayEnabled: boolean;
  autoSpectrumBarsCount: number;
  autoSpectrumEmptyBars: number[];
  autoMeteringDb: number | null;
  autoWaveDebugNowMs: number;
  autoWaveStatusLastAt: number;
  autoShadowStatusLastAt: number;
  autoShadowStatusLastMetering: number | null;
  autoWaveformLastSampleAt: number;
  autoWaveformUiAt: number;
  streamAudioQueueSize: number;
  audioLabRunning: boolean;
  audioLabNowMs: number;
  audioLabStartedAt: number;
};

export function useChatDerivedState({
  codexWsUrl,
  transcript,
  replyLoading,
  llmSessionRestoreLoading,
  sttProvider,
  directNativeSttEnabled,
  autoRecordingEnabled,
  manualRecording,
  directNativeSttInterimText,
  composerInputFocused,
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
  autoWaveform,
  autoWaveformSpeechMask,
  autoWaveformDataPipelineEnabled,
  autoWaveformDebugOverlayEnabled,
  autoSpectrumBarsCount,
  autoSpectrumEmptyBars,
  autoMeteringDb,
  autoWaveDebugNowMs,
  autoWaveStatusLastAt,
  autoShadowStatusLastAt,
  autoShadowStatusLastMetering,
  autoWaveformLastSampleAt,
  autoWaveformUiAt,
  streamAudioQueueSize,
  audioLabRunning,
  audioLabNowMs,
  audioLabStartedAt,
}: UseChatDerivedStateParams) {
  const canSend = useMemo(
    () => !!transcript.trim() && !replyLoading && !llmSessionRestoreLoading && !!codexWsUrl.trim(),
    [codexWsUrl, transcript, replyLoading, llmSessionRestoreLoading]
  );
  const hasComposerText = useMemo(() => !!transcript.trim(), [transcript]);
  const isDirectNativeSttProvider = sttProvider === "ios_native_direct";
  const composerInputNewlineCount = useMemo(() => {
    const text = String(transcript || "");
    if (!text) return 0;
    const matches = text.match(/\r\n|\r|\n/g);
    return matches ? matches.length : 0;
  }, [transcript]);
  const composerWaveformVisible = (manualRecording || autoRecordingEnabled) && !isDirectNativeSttProvider;
  const composerDirectSttVisible = isDirectNativeSttProvider && directNativeSttEnabled;
  const composerTextInputVisible = !composerWaveformVisible && !composerDirectSttVisible;
  const showComposerFullscreenToggle = (
    composerTextInputVisible &&
    composerInputFocused
  );
  const directNativeSttPreviewText = useMemo(() => {
    const text = String(directNativeSttInterimText || "").trim();
    if (text) return text;
    return String(transcript || "").trim();
  }, [directNativeSttInterimText, transcript]);
  const selectedModelLabel = useMemo(
    () => modelOptions.find((item) => item.value === modelRef)?.label || modelRef,
    [modelOptions, modelRef]
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
    () => buildYouTubeEmbedHtml(youtubePlayerVideoId, youtubePlayerSession),
    [youtubePlayerSession, youtubePlayerVideoId]
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
  const chatContextRingTrackColor = "#dbeafe";
  const chatContextRingProgressColor = "#0284c7";
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
  const autoSpectrumBars = useMemo(() => {
    if (!autoWaveformDataPipelineEnabled) return autoSpectrumEmptyBars;
    const len = autoWaveform.length;
    if (len === 0) return autoSpectrumEmptyBars;
    return Array.from({ length: autoSpectrumBarsCount }, (_, index) => {
      const from = Math.floor((index / autoSpectrumBarsCount) * len);
      const to = Math.max(from + 1, Math.floor(((index + 1) / autoSpectrumBarsCount) * len));
      let peak = 0;
      for (let i = from; i < to; i += 1) {
        peak = Math.max(peak, autoWaveform[i] || 0);
      }
      const frequencyWeight = 0.5 + 0.5 * Math.sin((index / autoSpectrumBarsCount) * Math.PI);
      return Math.min(1, Math.max(0.02, peak * (0.7 + 0.3 * frequencyWeight)));
    });
  }, [autoWaveform, autoSpectrumBarsCount, autoSpectrumEmptyBars, autoWaveformDataPipelineEnabled]);
  const autoSpectrumSpeechMask = useMemo(() => {
    if (!autoWaveformDataPipelineEnabled) return autoSpectrumEmptyBars;
    const len = autoWaveformSpeechMask.length;
    if (len === 0) return autoSpectrumEmptyBars;
    return Array.from({ length: autoSpectrumBarsCount }, (_, index) => {
      const from = Math.floor((index / autoSpectrumBarsCount) * len);
      const to = Math.max(from + 1, Math.floor(((index + 1) / autoSpectrumBarsCount) * len));
      for (let i = from; i < to; i += 1) {
        if (Number(autoWaveformSpeechMask[i] || 0) > 0.5) return 1;
      }
      return 0;
    });
  }, [autoWaveformSpeechMask, autoSpectrumBarsCount, autoSpectrumEmptyBars, autoWaveformDataPipelineEnabled]);
  const autoSpeechDetected = useMemo(
    () => autoSpectrumSpeechMask.some((value) => Number(value || 0) > 0.5),
    [autoSpectrumSpeechMask]
  );
  const autoWaveformDebugText = useMemo(() => {
    if (!autoWaveformDebugOverlayEnabled) return "";
    const now = autoWaveDebugNowMs > 0 ? autoWaveDebugNowMs : Date.now();
    const meterText = autoMeteringDb !== null ? `${autoMeteringDb.toFixed(1)}dB` : "-";
    const callbackAgeMs = autoWaveStatusLastAt > 0 ? Math.max(0, now - autoWaveStatusLastAt) : null;
    const shadowAgeMs = autoShadowStatusLastAt > 0 ? Math.max(0, now - autoShadowStatusLastAt) : null;
    const shadowMeterText = typeof autoShadowStatusLastMetering === "number"
      ? `${autoShadowStatusLastMetering.toFixed(1)}dB`
      : "-";
    const sampleAgeMs = autoWaveformLastSampleAt > 0 ? Math.max(0, now - autoWaveformLastSampleAt) : null;
    const uiAgeMs = autoWaveformUiAt > 0 ? Math.max(0, now - autoWaveformUiAt) : null;
    return (
      `meter ${meterText} / sampleAge ${sampleAgeMs !== null ? `${sampleAgeMs}ms` : "-"}` +
      ` / uiAge ${uiAgeMs !== null ? `${uiAgeMs}ms` : "-"}` +
      ` / cbAge ${callbackAgeMs !== null ? `${callbackAgeMs}ms` : "-"}` +
      ` / shAge ${shadowAgeMs !== null ? `${shadowAgeMs}ms` : "-"}` +
      ` / shM ${shadowMeterText}` +
      ` / tts ${ttsPlaying ? "on" : "off"} / q ${streamAudioQueueSize}`
    );
  }, [
    autoMeteringDb,
    autoShadowStatusLastAt,
    autoShadowStatusLastMetering,
    autoWaveDebugNowMs,
    autoWaveStatusLastAt,
    autoWaveformDebugOverlayEnabled,
    autoWaveformLastSampleAt,
    autoWaveformUiAt,
    streamAudioQueueSize,
    ttsPlaying,
  ]);
  const audioLabElapsedMs = useMemo(() => {
    if (!audioLabRunning || audioLabStartedAt <= 0) return 0;
    const now = audioLabNowMs > 0 ? audioLabNowMs : Date.now();
    return Math.max(0, now - audioLabStartedAt);
  }, [audioLabNowMs, audioLabRunning, audioLabStartedAt]);

  return {
    canSend,
    hasComposerText,
    isDirectNativeSttProvider,
    composerInputNewlineCount,
    composerWaveformVisible,
    composerDirectSttVisible,
    composerTextInputVisible,
    showComposerFullscreenToggle,
    directNativeSttPreviewText,
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
    autoSpectrumBars,
    autoSpectrumSpeechMask,
    autoSpeechDetected,
    autoWaveformDebugText,
    audioLabElapsedMs,
  };
}
