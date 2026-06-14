import { useCallback, type MutableRefObject } from "react";
import type { ConversationMessage, TtsPlaybackTarget } from "../types/appTypes";

type UseReplyAudioFlowControllerOptions = {
  nearUnlimitedTimeoutMs: number;
  replyLoadingRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  ttsPlaybackMessageId: string;
  ttsLoading: boolean;
  stopWaveformPlayback: () => Promise<void>;
  synthesizeSpeechStream: (
    textOverride?: string,
    streamOptions?: TtsPlaybackTarget
  ) => Promise<void>;
};

export function useReplyAudioFlowController(options: UseReplyAudioFlowControllerOptions) {
  const {
    nearUnlimitedTimeoutMs,
    replyLoadingRef,
    ttsPlayingRef,
    ttsPlaybackMessageId,
    ttsLoading,
    stopWaveformPlayback,
    synthesizeSpeechStream,
  } = options;

  const waitForReplyIdle = useCallback(async (timeoutMs = nearUnlimitedTimeoutMs) => {
    const startedAt = Date.now();
    while (replyLoadingRef.current) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("reply待機タイムアウト");
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }, [
    nearUnlimitedTimeoutMs,
    replyLoadingRef,
  ]);

  const handleAssistantAudioButtonPress = useCallback(async (
    message: ConversationMessage,
    target?: Omit<TtsPlaybackTarget, "messageId">
  ) => {
    if (message.role !== "assistant") return;
    const text = String(message.content || "").trim();
    if (!text) return;
    if (replyLoadingRef.current) return;

    const isCurrentMessagePlaying = (
      ttsPlaybackMessageId === message.id &&
      (ttsPlayingRef.current || ttsLoading)
    );

    if (isCurrentMessagePlaying) {
      await stopWaveformPlayback();
      return;
    }

    if (ttsPlayingRef.current || ttsLoading) {
      await stopWaveformPlayback();
    }

    await synthesizeSpeechStream(text, {
      ...target,
      messageId: message.id,
    });
  }, [
    replyLoadingRef,
    stopWaveformPlayback,
    synthesizeSpeechStream,
    ttsLoading,
    ttsPlaybackMessageId,
    ttsPlayingRef,
  ]);

  return {
    waitForReplyIdle,
    handleAssistantAudioButtonPress,
  };
}
