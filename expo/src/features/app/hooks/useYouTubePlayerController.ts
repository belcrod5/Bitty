import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Audio } from "expo-av";
import type { WebView, WebViewMessageEvent } from "react-native-webview";
import { isSameStringArray, normalizeYouTubeVideoIds } from "../utils/youtube";

export type YouTubeVideoMeta = {
  videoId: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number | null;
};

type ChatYouTubeQueueEntry = {
  videoId: string;
  messageId: string;
};

type MediaTarget = "all" | "youtube" | "tts";
type MediaAction = "stop" | "next" | "prev";
const FIXED_YOUTUBE_VOLUME_PERCENT = 75;

type UseYouTubePlayerControllerOptions = {
  runnerUrl: string;
  runnerToken: string;
  baseUrl: () => string;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  autoAirPodsInputRef: MutableRefObject<boolean>;
  autoBargeInEnabledRef: MutableRefObject<boolean>;
  youtubeWebViewRef: MutableRefObject<WebView | null>;
  youtubePauseConfirmTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  youtubeControlToDragTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  youtubeFloatingInteractionModeRef: MutableRefObject<"drag" | "control">;
  youtubePlayerIsPlayingRef: MutableRefObject<boolean>;
  youtubePlaybackQueueRef: MutableRefObject<{ messageId: string; videoIds: string[]; index: number } | null>;
  youtubePlaybackPositionSecRef: MutableRefObject<number>;
  youtubeVideoMetaByIdRef: MutableRefObject<Record<string, YouTubeVideoMeta>>;
  youtubePlayerVideoIdRef: MutableRefObject<string>;
  youtubePlayerMessageIdRef: MutableRefObject<string>;
  youtubePlayerSessionRef: MutableRefObject<number>;
  streamReplyYouTubeVideoIdsRef: MutableRefObject<string[]>;
  setYoutubeVideoMetaById: Dispatch<SetStateAction<Record<string, YouTubeVideoMeta>>>;
  setYoutubeFloatingInteractionMode: Dispatch<SetStateAction<"drag" | "control">>;
  setYoutubePlayerIsPlaying: Dispatch<SetStateAction<boolean>>;
  setYoutubeInlineLayout: Dispatch<SetStateAction<{ x: number; y: number; width: number; height: number } | null>>;
  setYoutubeFloatingPosition: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  setYoutubePlayerVideoId: Dispatch<SetStateAction<string>>;
  setYoutubePlayerMessageId: Dispatch<SetStateAction<string>>;
  setYoutubePlayerSession: Dispatch<SetStateAction<number>>;
  setStreamReplyYouTubeVideoIds: Dispatch<SetStateAction<string[]>>;
  chatWideYouTubeQueue: ChatYouTubeQueueEntry[];
  youtubePauseConfirmMs: number;
  youtubeControlIdleToDragMs: number;
  playUiSfx: (key: "youtubePlay" | "youtubeStop") => void;
  stopTtsPlayback: (options?: { interruptStream?: boolean }) => Promise<void>;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  reportError: (raw: unknown, scope?: string) => void;
  finalizeAutoCapture: (shouldTranscribe: boolean, reason: string) => Promise<void>;
};

export function useYouTubePlayerController(options: UseYouTubePlayerControllerOptions) {
  const {
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
    youtubePauseConfirmMs,
    youtubeControlIdleToDragMs,
    playUiSfx,
    stopTtsPlayback,
    logAuto,
    reportError,
    finalizeAutoCapture,
  } = options;

  const clearYouTubePauseConfirmTimer = useCallback(() => {
    const timer = youtubePauseConfirmTimerRef.current;
    if (!timer) return;
    clearTimeout(timer);
    youtubePauseConfirmTimerRef.current = null;
  }, [youtubePauseConfirmTimerRef]);

  const clearYouTubeControlToDragTimer = useCallback(() => {
    const timer = youtubeControlToDragTimerRef.current;
    if (!timer) return;
    clearTimeout(timer);
    youtubeControlToDragTimerRef.current = null;
  }, [youtubeControlToDragTimerRef]);

  const setYouTubeFloatingInteractionModeWithRef = useCallback((next: "drag" | "control") => {
    if (youtubeFloatingInteractionModeRef.current === next) return;
    youtubeFloatingInteractionModeRef.current = next;
    setYoutubeFloatingInteractionMode(next);
  }, [setYoutubeFloatingInteractionMode, youtubeFloatingInteractionModeRef]);

  const scheduleYouTubeControlToDrag = useCallback(() => {
    clearYouTubeControlToDragTimer();
    youtubeControlToDragTimerRef.current = setTimeout(() => {
      youtubeControlToDragTimerRef.current = null;
      setYouTubeFloatingInteractionModeWithRef("drag");
    }, youtubeControlIdleToDragMs);
  }, [
    clearYouTubeControlToDragTimer,
    setYouTubeFloatingInteractionModeWithRef,
    youtubeControlIdleToDragMs,
    youtubeControlToDragTimerRef,
  ]);

  const setYouTubePlayingState = useCallback((next: boolean) => {
    if (youtubePlayerIsPlayingRef.current === next) return;
    youtubePlayerIsPlayingRef.current = next;
    setYoutubePlayerIsPlaying(next);
    playUiSfx(next ? "youtubePlay" : "youtubeStop");
    if (
      next &&
      autoRecordingEnabledRef.current &&
      autoRecordingRef.current &&
      !autoAirPodsInputRef.current
    ) {
      logAuto("youtube_playback_finalize_request", {
        autoRecordingActive: Boolean(autoRecordingRef.current),
        autoAirPodsInput: autoAirPodsInputRef.current,
        autoBargeInEnabled: autoBargeInEnabledRef.current,
      });
      void finalizeAutoCapture(false, "youtube_playback");
    }
  }, [
    autoAirPodsInputRef,
    autoBargeInEnabledRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    finalizeAutoCapture,
    logAuto,
    playUiSfx,
    setYoutubePlayerIsPlaying,
    youtubePlayerIsPlayingRef,
  ]);

  const scheduleYouTubePauseConfirmation = useCallback(() => {
    clearYouTubePauseConfirmTimer();
    youtubePauseConfirmTimerRef.current = setTimeout(() => {
      youtubePauseConfirmTimerRef.current = null;
      setYouTubePlayingState(false);
    }, youtubePauseConfirmMs);
  }, [
    clearYouTubePauseConfirmTimer,
    setYouTubePlayingState,
    youtubePauseConfirmMs,
    youtubePauseConfirmTimerRef,
  ]);

  const fetchYouTubeVideoMetadata = useCallback(async (videoIds: string[]) => {
    const ids = Array.from(
      new Set(
        (Array.isArray(videoIds) ? videoIds : [])
          .map((item) => String(item || "").trim())
          .filter((item) => /^[A-Za-z0-9_-]{11}$/.test(item))
      )
    );
    if (!ids.length) return;
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    const missing = ids.filter((id) => !youtubeVideoMetaByIdRef.current[id]);
    if (!missing.length) return;

    try {
      const res = await fetch(`${baseUrl()}/youtube-videos`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runnerToken.trim()}`,
        },
        body: JSON.stringify({
          videoIds: missing,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.log("[youtube-videos] failed response", { status: res.status, data });
        return;
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      setYoutubeVideoMetaById((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const item of results) {
          const videoId = String(item?.videoId || "").trim();
          if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
          const channelTitle = String(item?.channelTitle || "").trim();
          const publishedAt = String(item?.publishedAt || "").trim();
          const viewCountRaw = Number(item?.viewCount);
          const viewCount = Number.isFinite(viewCountRaw) && viewCountRaw >= 0 ? Math.floor(viewCountRaw) : null;
          const prevItem = prev[videoId];
          if (
            prevItem &&
            prevItem.channelTitle === channelTitle &&
            prevItem.publishedAt === publishedAt &&
            prevItem.viewCount === viewCount
          ) {
            continue;
          }
          changed = true;
          next[videoId] = {
            videoId,
            channelTitle,
            publishedAt,
            viewCount,
          };
        }
        return changed ? next : prev;
      });
    } catch (err) {
      console.error("[youtube-videos] error", err);
    }
  }, [baseUrl, runnerToken, runnerUrl, setYoutubeVideoMetaById, youtubeVideoMetaByIdRef]);

  const openYouTubeVideo = useCallback((
    videoId: string,
    messageId = "",
    options?: { queueVideoIds?: string[]; queueIndex?: number }
  ) => {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(normalized)) {
      reportError("無効な YouTube 動画IDです。", "youtube");
      return;
    }
    const queueVideoIds = normalizeYouTubeVideoIds(options?.queueVideoIds || [normalized]);
    const queueIndexRaw = Number(options?.queueIndex);
    const queueIndex = Number.isInteger(queueIndexRaw)
      ? Math.max(0, Math.min(queueVideoIds.length - 1, queueIndexRaw))
      : Math.max(0, queueVideoIds.indexOf(normalized));
    const currentQueue = youtubePlaybackQueueRef.current;
    const targetMessageId = String(messageId || "");
    if (
      youtubePlayerVideoIdRef.current === normalized &&
      youtubePlayerMessageIdRef.current === targetMessageId &&
      currentQueue &&
      currentQueue.index === queueIndex &&
      currentQueue.messageId === targetMessageId &&
      isSameStringArray(currentQueue.videoIds, queueVideoIds)
    ) {
      return;
    }
    if (youtubePlayerVideoIdRef.current !== normalized) {
      youtubePlaybackPositionSecRef.current = 0;
    }
    void fetchYouTubeVideoMetadata(queueVideoIds.length > 0 ? queueVideoIds : [normalized]);
    if (queueVideoIds.length > 1 && queueIndex >= 0) {
      youtubePlaybackQueueRef.current = {
        messageId: targetMessageId,
        videoIds: queueVideoIds,
        index: queueIndex,
      };
    } else {
      youtubePlaybackQueueRef.current = null;
    }
    setYoutubeInlineLayout(null);
    clearYouTubePauseConfirmTimer();
    clearYouTubeControlToDragTimer();
    setYouTubeFloatingInteractionModeWithRef("drag");
    setYouTubePlayingState(false);
    setYoutubePlayerVideoId(normalized);
    setYoutubePlayerMessageId(targetMessageId);
    setYoutubePlayerSession((prev) => {
      const next = prev + 1;
      youtubePlayerSessionRef.current = next;
      return next;
    });
  }, [
    clearYouTubeControlToDragTimer,
    clearYouTubePauseConfirmTimer,
    fetchYouTubeVideoMetadata,
    reportError,
    setYouTubeFloatingInteractionModeWithRef,
    setYouTubePlayingState,
    setYoutubeInlineLayout,
    setYoutubePlayerMessageId,
    setYoutubePlayerSession,
    setYoutubePlayerVideoId,
    youtubePlaybackPositionSecRef,
    youtubePlaybackQueueRef,
    youtubePlayerMessageIdRef,
    youtubePlayerSessionRef,
    youtubePlayerVideoIdRef,
  ]);

  const closeYouTubePlayer = useCallback(() => {
    youtubePlaybackQueueRef.current = null;
    youtubePlaybackPositionSecRef.current = 0;
    setYoutubeInlineLayout(null);
    setYoutubeFloatingPosition(null);
    setYoutubePlayerVideoId("");
    setYoutubePlayerMessageId("");
    clearYouTubePauseConfirmTimer();
    clearYouTubeControlToDragTimer();
    setYouTubeFloatingInteractionModeWithRef("drag");
    setYouTubePlayingState(false);
    setYoutubePlayerSession((prev) => {
      const next = prev + 1;
      youtubePlayerSessionRef.current = next;
      return next;
    });
  }, [
    clearYouTubeControlToDragTimer,
    clearYouTubePauseConfirmTimer,
    setYouTubeFloatingInteractionModeWithRef,
    setYouTubePlayingState,
    setYoutubeFloatingPosition,
    setYoutubeInlineLayout,
    setYoutubePlayerMessageId,
    setYoutubePlayerSession,
    setYoutubePlayerVideoId,
    youtubePlaybackPositionSecRef,
    youtubePlaybackQueueRef,
    youtubePlayerSessionRef,
  ]);

  const getActiveYouTubeQueuePosition = useCallback(() => {
    const queue = youtubePlaybackQueueRef.current;
    if (queue && queue.videoIds.length > 0) {
      const index = Math.max(0, Math.min(queue.videoIds.length - 1, queue.index));
      return {
        index: index + 1,
        total: queue.videoIds.length,
      };
    }
    const currentVideoId = String(youtubePlayerVideoIdRef.current || "").trim();
    if (!currentVideoId || chatWideYouTubeQueue.length <= 0) return null;
    const queueIndex = chatWideYouTubeQueue.findIndex((entry) => entry.videoId === currentVideoId);
    if (queueIndex < 0) return null;
    return {
      index: queueIndex + 1,
      total: chatWideYouTubeQueue.length,
    };
  }, [chatWideYouTubeQueue, youtubePlaybackQueueRef, youtubePlayerVideoIdRef]);

  const getActiveYouTubeQueuePositionLabel = useCallback(() => {
    const position = getActiveYouTubeQueuePosition();
    if (!position) return "";
    return `${position.index}/${position.total}`;
  }, [getActiveYouTubeQueuePosition]);

  const stepYouTubePlaybackQueue = useCallback((step: 1 | -1) => {
    const queue = youtubePlaybackQueueRef.current;
    if (!queue) return false;
    const nextIndex = queue.index + step;
    if (nextIndex < 0 || nextIndex >= queue.videoIds.length) return false;
    openYouTubeVideo(queue.videoIds[nextIndex], queue.messageId, {
      queueVideoIds: queue.videoIds,
      queueIndex: nextIndex,
    });
    return true;
  }, [openYouTubeVideo, youtubePlaybackQueueRef]);

  const stepChatWideYouTubeQueue = useCallback((step: 1 | -1) => {
    if (chatWideYouTubeQueue.length <= 0) return false;
    const currentVideoId = String(youtubePlayerVideoIdRef.current || "").trim();
    const currentMessageId = String(youtubePlayerMessageIdRef.current || "").trim();
    let currentIndex = -1;
    if (currentVideoId) {
      currentIndex = chatWideYouTubeQueue.findIndex((entry) => (
        entry.videoId === currentVideoId &&
        entry.messageId === currentMessageId
      ));
      if (currentIndex < 0) {
        currentIndex = chatWideYouTubeQueue.findIndex((entry) => entry.videoId === currentVideoId);
      }
    }
    const defaultIndex = step > 0 ? 0 : chatWideYouTubeQueue.length - 1;
    const targetIndex = currentIndex >= 0 ? currentIndex + step : defaultIndex;
    if (targetIndex < 0 || targetIndex >= chatWideYouTubeQueue.length) return false;
    const target = chatWideYouTubeQueue[targetIndex];
    const queueVideoIds = chatWideYouTubeQueue.map((entry) => entry.videoId);
    openYouTubeVideo(target.videoId, target.messageId, {
      queueVideoIds,
      queueIndex: targetIndex,
    });
    return true;
  }, [chatWideYouTubeQueue, openYouTubeVideo, youtubePlayerMessageIdRef, youtubePlayerVideoIdRef]);

  const controlMediaPlayback = useCallback(async (action: MediaAction, target: MediaTarget) => {
    if (action === "next") {
      if (target === "all" || target === "youtube") {
        if (!stepChatWideYouTubeQueue(1)) {
          return stepYouTubePlaybackQueue(1);
        }
        return true;
      }
      return false;
    }
    if (action === "prev") {
      if (target === "all" || target === "youtube") {
        if (!stepChatWideYouTubeQueue(-1)) {
          return stepYouTubePlaybackQueue(-1);
        }
        return true;
      }
      return false;
    }
    let applied = false;
    if (target === "all" || target === "youtube") {
      closeYouTubePlayer();
      applied = true;
    }
    if (target === "all" || target === "tts") {
      await stopTtsPlayback({ interruptStream: false });
      applied = true;
    }
    return applied;
  }, [closeYouTubePlayer, stepChatWideYouTubeQueue, stepYouTubePlaybackQueue, stopTtsPlayback]);

  const handleYouTubePlayerEnded = useCallback((reportedVideoId: string) => {
    youtubePlaybackPositionSecRef.current = 0;
    const queue = youtubePlaybackQueueRef.current;
    if (!queue) return;
    if (reportedVideoId && queue.videoIds[queue.index] !== reportedVideoId) return;
    const nextIndex = queue.index + 1;
    if (nextIndex >= queue.videoIds.length) {
      youtubePlaybackQueueRef.current = null;
      return;
    }
    openYouTubeVideo(queue.videoIds[nextIndex], queue.messageId, {
      queueVideoIds: queue.videoIds,
      queueIndex: nextIndex,
    });
  }, [openYouTubeVideo, youtubePlaybackPositionSecRef, youtubePlaybackQueueRef]);

  const sendYouTubePlayerControl = useCallback((payload: Record<string, unknown>) => {
    const webView = youtubeWebViewRef.current;
    if (!webView) return;
    try {
      webView.postMessage(JSON.stringify(payload));
    } catch {}
  }, [youtubeWebViewRef]);

  const handleYouTubeWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    const raw = String(event?.nativeEvent?.data || "").trim();
    if (!raw) return;
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(payload?.type || "").trim();
    const reportedSessionRaw = Number(payload?.session);
    if (
      Number.isFinite(reportedSessionRaw) &&
      Number.isInteger(reportedSessionRaw) &&
      Number(reportedSessionRaw) !== youtubePlayerSessionRef.current
    ) {
      return;
    }
    const reportedVideoId = String(payload?.videoId || "").trim();
    if (reportedVideoId && reportedVideoId === youtubePlayerVideoIdRef.current) {
      const currentTimeRaw = Number(payload?.currentTime);
      const currentTime = Number.isFinite(currentTimeRaw) ? currentTimeRaw : NaN;
      if (Number.isFinite(currentTime) && currentTime >= 0) {
        youtubePlaybackPositionSecRef.current = currentTime;
      }
    }
    if (type === "youtube_ended") {
      clearYouTubePauseConfirmTimer();
      setYouTubePlayingState(false);
      handleYouTubePlayerEnded(reportedVideoId);
      return;
    }
    if (type === "youtube_ready") {
      if (youtubeFloatingInteractionModeRef.current === "control") {
        scheduleYouTubeControlToDrag();
      }
      sendYouTubePlayerControl({
        type: "youtube_set_volume",
        volume: FIXED_YOUTUBE_VOLUME_PERCENT,
        muted: false,
      });
      sendYouTubePlayerControl({
        type: "youtube_play",
        seekTo: youtubePlaybackPositionSecRef.current,
      });
      return;
    }
    if (type === "youtube_autoplay_blocked") {
      if (youtubeFloatingInteractionModeRef.current === "control") {
        scheduleYouTubeControlToDrag();
      }
      sendYouTubePlayerControl({
        type: "youtube_set_volume",
        volume: FIXED_YOUTUBE_VOLUME_PERCENT,
        muted: false,
      });
      sendYouTubePlayerControl({
        type: "youtube_play",
        seekTo: youtubePlaybackPositionSecRef.current,
      });
      return;
    }
    if (type === "youtube_playing" || type === "youtube_buffering") {
      if (youtubeFloatingInteractionModeRef.current === "control") {
        scheduleYouTubeControlToDrag();
      }
      clearYouTubePauseConfirmTimer();
      setYouTubePlayingState(true);
      return;
    }
    if (type === "youtube_paused") {
      if (youtubeFloatingInteractionModeRef.current === "control") {
        scheduleYouTubeControlToDrag();
      }
      scheduleYouTubePauseConfirmation();
      return;
    }
    if (type === "youtube_error") {
      clearYouTubePauseConfirmTimer();
      setYouTubePlayingState(false);
      return;
    }
  }, [
    clearYouTubePauseConfirmTimer,
    handleYouTubePlayerEnded,
    scheduleYouTubeControlToDrag,
    scheduleYouTubePauseConfirmation,
    sendYouTubePlayerControl,
    setYouTubePlayingState,
    youtubeFloatingInteractionModeRef,
    youtubePlaybackPositionSecRef,
    youtubePlayerSessionRef,
    youtubePlayerVideoIdRef,
  ]);

  const setStreamReplyYouTubeVideoIdsWithRef = useCallback((nextIds: string[]) => {
    const normalized = normalizeYouTubeVideoIds(nextIds);
    streamReplyYouTubeVideoIdsRef.current = normalized;
    setStreamReplyYouTubeVideoIds(normalized);
  }, [setStreamReplyYouTubeVideoIds, streamReplyYouTubeVideoIdsRef]);

  const appendStreamYouTubeCandidates = useCallback((videoIdsRaw: unknown, _source: "tool_call" | "text_delta") => {
    const ids = normalizeYouTubeVideoIds(videoIdsRaw);
    if (!ids.length) return;
    setStreamReplyYouTubeVideoIds((prev) => {
      const merged = normalizeYouTubeVideoIds([...prev, ...ids]);
      streamReplyYouTubeVideoIdsRef.current = merged;
      return isSameStringArray(prev, merged) ? prev : merged;
    });
    void fetchYouTubeVideoMetadata(ids);
  }, [fetchYouTubeVideoMetadata, setStreamReplyYouTubeVideoIds, streamReplyYouTubeVideoIdsRef]);

  return {
    clearYouTubePauseConfirmTimer,
    clearYouTubeControlToDragTimer,
    setYouTubeFloatingInteractionModeWithRef,
    scheduleYouTubeControlToDrag,
    setYouTubePlayingState,
    scheduleYouTubePauseConfirmation,
    fetchYouTubeVideoMetadata,
    openYouTubeVideo,
    closeYouTubePlayer,
    getActiveYouTubeQueuePositionLabel,
    controlMediaPlayback,
    sendYouTubePlayerControl,
    handleYouTubeWebViewMessage,
    setStreamReplyYouTubeVideoIdsWithRef,
    appendStreamYouTubeCandidates,
  };
}
