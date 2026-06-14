import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

type PendingUserMessageLike<TSttMeta> = {
  id: string;
  role: "user" | "assistant";
  content: string;
  pendingUser?: boolean;
  sttMeta?: TSttMeta;
};

type UseAutoPendingUserControllerOptions<
  TSttMeta,
  TMessage extends PendingUserMessageLike<TSttMeta>,
> = {
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoReplyAfterSttRef: MutableRefObject<boolean>;
  autoSpeechStartedAtRef: MutableRefObject<number>;
  autoLastBargeInDetectedAtRef: MutableRefObject<number>;
  autoLastTtsStopRequestedAtRef: MutableRefObject<number>;
  autoLastTtsStoppedAtRef: MutableRefObject<number>;
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamAudioQueueRef: MutableRefObject<Array<unknown>>;
  ttsPlaybackMessageIdRef: MutableRefObject<string>;
  conversationMessages: TMessage[];
  conversationMessagesRef: MutableRefObject<TMessage[]>;
  setConversationMessagesWithLimit: (next: TMessage[]) => TMessage[];
  buildPendingUserMessage: (content: string) => TMessage;
  pendingUserAnimationFrames: string[];
  pendingUserAnimationIntervalMs: number;
  ttsLoading: boolean;
  elapsedSinceMs: (startedAt: number) => number | null;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  stopTtsPlayback: (options?: { interruptStream?: boolean }) => Promise<void>;
  onPendingTimeout: () => void;
};

export function useAutoPendingUserController<
  TSttMeta,
  TMessage extends PendingUserMessageLike<TSttMeta>,
>(options: UseAutoPendingUserControllerOptions<TSttMeta, TMessage>) {
  const {
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
    buildPendingUserMessage,
    pendingUserAnimationFrames,
    pendingUserAnimationIntervalMs,
    ttsLoading,
    elapsedSinceMs,
    logAuto,
    stopTtsPlayback,
    onPendingTimeout,
  } = options;

  const autoPendingUserMessageIdRef = useRef("");
  const autoPendingUserAnimTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoPendingUserTimeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoPendingUserAnimFrameRef = useRef(0);
  const autoPendingUserMessageStartedAtRef = useRef(0);
  const autoPendingUserMessageVisibleAtRef = useRef(0);
  const autoPendingUserVisibleLoggedMessageIdRef = useRef("");

  const clearAutoPendingUserAnimationTimer = useCallback(() => {
    if (!autoPendingUserAnimTimerRef.current) return;
    clearInterval(autoPendingUserAnimTimerRef.current);
    autoPendingUserAnimTimerRef.current = null;
  }, []);

  const clearAutoPendingUserTimeoutTimer = useCallback(() => {
    if (!autoPendingUserTimeoutTimerRef.current) return;
    clearTimeout(autoPendingUserTimeoutTimerRef.current);
    autoPendingUserTimeoutTimerRef.current = null;
  }, []);

  const resetAutoPendingUserState = useCallback(() => {
    clearAutoPendingUserTimeoutTimer();
    clearAutoPendingUserAnimationTimer();
    autoPendingUserAnimFrameRef.current = 0;
    autoPendingUserMessageIdRef.current = "";
    autoPendingUserMessageStartedAtRef.current = 0;
    autoPendingUserMessageVisibleAtRef.current = 0;
    autoPendingUserVisibleLoggedMessageIdRef.current = "";
  }, [clearAutoPendingUserAnimationTimer, clearAutoPendingUserTimeoutTimer]);

  const resolveAutoPendingUserMessage = useCallback((finalTranscript: string, sttMeta?: TSttMeta) => {
    const pendingId = autoPendingUserMessageIdRef.current;
    const pendingStartedAt = autoPendingUserMessageStartedAtRef.current;
    const pendingVisibleAt = autoPendingUserMessageVisibleAtRef.current;
    resetAutoPendingUserState();
    if (!pendingId) {
      return false;
    }
    const current = conversationMessagesRef.current;
    const index = current.findIndex((item) => item.id === pendingId);
    if (index < 0) return false;
    const normalized = String(finalTranscript || "").trim();
    if (!normalized) {
      const next = [...current.slice(0, index), ...current.slice(index + 1)];
      setConversationMessagesWithLimit(next);
      logAuto("pending_user_message_cleared", {
        pendingMessageId: pendingId,
        sincePendingStartMs: elapsedSinceMs(pendingStartedAt),
        sincePendingVisibleMs: elapsedSinceMs(pendingVisibleAt),
      });
      return true;
    }
    const next = [...current];
    next[index] = {
      ...next[index],
      content: normalized,
      pendingUser: false,
      sttMeta: sttMeta || next[index].sttMeta,
    };
    const resolvedMessage = next[index];
    const withoutResolved = [...next.slice(0, index), ...next.slice(index + 1)];
    const reordered = [...withoutResolved, resolvedMessage];
    setConversationMessagesWithLimit(reordered);
    logAuto("pending_user_message_resolved", {
      pendingMessageId: pendingId,
      transcriptChars: normalized.length,
      sincePendingStartMs: elapsedSinceMs(pendingStartedAt),
      sincePendingVisibleMs: elapsedSinceMs(pendingVisibleAt),
      movedToTail: true,
      fromIndex: index,
    });
    return true;
  }, [
    conversationMessagesRef,
    elapsedSinceMs,
    logAuto,
    resetAutoPendingUserState,
    setConversationMessagesWithLimit,
  ]);

  const startAutoPendingUserMessage = useCallback((options?: { source?: string; timeoutMs?: number }) => {
    if (!autoRecordingEnabledRef.current || !autoReplyAfterSttRef.current) return;
    const source = String(options?.source || "unknown");
    const timeoutMs = Math.max(0, Number(options?.timeoutMs || 0));
    const existingId = autoPendingUserMessageIdRef.current;
    if (existingId) {
      const stillExists = conversationMessagesRef.current.some((item) => item.id === existingId);
      if (stillExists) return;
      autoPendingUserMessageIdRef.current = "";
    }
    clearAutoPendingUserTimeoutTimer();
    clearAutoPendingUserAnimationTimer();
    autoPendingUserAnimFrameRef.current = 0;
    const pendingMessage = buildPendingUserMessage(pendingUserAnimationFrames[0] || ".");
    autoPendingUserMessageStartedAtRef.current = Date.now();
    autoPendingUserMessageVisibleAtRef.current = 0;
    autoPendingUserVisibleLoggedMessageIdRef.current = "";
    autoPendingUserMessageIdRef.current = pendingMessage.id;
    logAuto("pending_user_message_start", {
      pendingMessageId: pendingMessage.id,
      source,
      timeoutMs,
      sinceBargeInDetectedMs: elapsedSinceMs(autoLastBargeInDetectedAtRef.current),
      sinceTtsStopRequestedMs: elapsedSinceMs(autoLastTtsStopRequestedAtRef.current),
      sinceTtsStoppedMs: elapsedSinceMs(autoLastTtsStoppedAtRef.current),
    });
    setConversationMessagesWithLimit([
      ...conversationMessagesRef.current,
      pendingMessage,
    ]);
    autoPendingUserAnimTimerRef.current = setInterval(() => {
      const pendingId = autoPendingUserMessageIdRef.current;
      if (!pendingId) {
        clearAutoPendingUserTimeoutTimer();
        clearAutoPendingUserAnimationTimer();
        return;
      }
      const current = conversationMessagesRef.current;
      const index = current.findIndex((item) => item.id === pendingId);
      if (index < 0) {
        autoPendingUserMessageIdRef.current = "";
        clearAutoPendingUserTimeoutTimer();
        clearAutoPendingUserAnimationTimer();
        return;
      }
      autoPendingUserAnimFrameRef.current = (
        autoPendingUserAnimFrameRef.current + 1
      ) % Math.max(1, pendingUserAnimationFrames.length);
      const nextFrame = pendingUserAnimationFrames[autoPendingUserAnimFrameRef.current] || ".";
      if (current[index].content === nextFrame) return;
      const next = [...current];
      next[index] = {
        ...next[index],
        content: nextFrame,
        pendingUser: true,
      };
      setConversationMessagesWithLimit(next);
    }, pendingUserAnimationIntervalMs);
    if (timeoutMs <= 0) return;
    autoPendingUserTimeoutTimerRef.current = setTimeout(() => {
      autoPendingUserTimeoutTimerRef.current = null;
      const activePendingId = autoPendingUserMessageIdRef.current;
      if (!activePendingId || activePendingId !== pendingMessage.id) return;
      if (autoSpeechStartedAtRef.current > 0) return;
      logAuto("pending_user_message_timeout", {
        pendingMessageId: activePendingId,
        source,
        timeoutMs,
        sincePendingStartMs: elapsedSinceMs(autoPendingUserMessageStartedAtRef.current),
        sincePendingVisibleMs: elapsedSinceMs(autoPendingUserMessageVisibleAtRef.current),
        ttsPlaying: ttsPlayingRef.current,
        ttsLoading,
        replyLoading: replyLoadingRef.current,
        streamSocketAlive: streamSocketRef.current !== null,
      });
      resolveAutoPendingUserMessage("");
      onPendingTimeout();
    }, timeoutMs);
  }, [
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    autoRecordingEnabledRef,
    autoReplyAfterSttRef,
    autoSpeechStartedAtRef,
    buildPendingUserMessage,
    clearAutoPendingUserAnimationTimer,
    clearAutoPendingUserTimeoutTimer,
    conversationMessagesRef,
    elapsedSinceMs,
    logAuto,
    onPendingTimeout,
    pendingUserAnimationFrames,
    pendingUserAnimationIntervalMs,
    replyLoadingRef,
    resolveAutoPendingUserMessage,
    setConversationMessagesWithLimit,
    streamSocketRef,
    ttsLoading,
    ttsPlayingRef,
  ]);

  useEffect(() => {
    const pendingId = autoPendingUserMessageIdRef.current;
    if (!pendingId) return;
    if (autoPendingUserVisibleLoggedMessageIdRef.current === pendingId) return;
    const pendingMessage = conversationMessages.find((item) => (
      item.id === pendingId &&
      item.role === "user" &&
      item.pendingUser
    ));
    if (!pendingMessage) return;
    autoPendingUserVisibleLoggedMessageIdRef.current = pendingId;
    autoPendingUserMessageVisibleAtRef.current = Date.now();
    logAuto("pending_user_message_visible", {
      pendingMessageId: pendingId,
      sincePendingStartMs: elapsedSinceMs(autoPendingUserMessageStartedAtRef.current),
      sinceBargeInDetectedMs: elapsedSinceMs(autoLastBargeInDetectedAtRef.current),
      sinceTtsStopRequestedMs: elapsedSinceMs(autoLastTtsStopRequestedAtRef.current),
      sinceTtsStoppedMs: elapsedSinceMs(autoLastTtsStoppedAtRef.current),
    });
    const queuedStreamAudio = streamAudioQueueRef.current.length;
    const shouldStopTtsOnPendingVisible = ttsPlayingRef.current || queuedStreamAudio > 0;
    if (!shouldStopTtsOnPendingVisible) return;
    logAuto("pending_user_message_visible_stop_tts", {
      pendingMessageId: pendingId,
      ttsPlaying: ttsPlayingRef.current,
      ttsLoading,
      streamSocketAlive: streamSocketRef.current !== null,
      queuedStreamAudio,
      ttsPlaybackMessageId: ttsPlaybackMessageIdRef.current,
    });
    void stopTtsPlayback({ interruptStream: true }).catch(() => {});
  }, [
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    conversationMessages,
    elapsedSinceMs,
    logAuto,
    stopTtsPlayback,
    streamAudioQueueRef,
    streamSocketRef,
    ttsLoading,
    ttsPlaybackMessageIdRef,
    ttsPlayingRef,
  ]);

  useEffect(() => {
    return () => {
      clearAutoPendingUserTimeoutTimer();
      clearAutoPendingUserAnimationTimer();
    };
  }, [clearAutoPendingUserAnimationTimer, clearAutoPendingUserTimeoutTimer]);

  return {
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
  };
}
