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
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
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
    logAuto,
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
    logAuto("tts_trace", { stage: "button_press", messageId: message.id });
    if (message.role !== "assistant") {
      logAuto("tts_trace", { stage: "button_ignored", reason: "role", messageId: message.id });
      return;
    }
    const text = String(message.content || "").trim();
    if (!text) {
      logAuto("tts_trace", { stage: "button_ignored", reason: "empty_text", messageId: message.id });
      return;
    }
    if (replyLoadingRef.current) {
      logAuto("tts_trace", { stage: "button_ignored", reason: "reply_loading", messageId: message.id });
      return;
    }

    const isCurrentMessagePlaying = (
      ttsPlaybackMessageId === message.id &&
      (ttsPlayingRef.current || ttsLoading)
    );

    if (isCurrentMessagePlaying) {
      logAuto("tts_trace", { stage: "button_stop_current", messageId: message.id });
      await stopWaveformPlayback();
      return;
    }

    if (ttsPlayingRef.current || ttsLoading) {
      logAuto("tts_trace", {
        stage: "button_stop_previous",
        messageId: message.id,
        previousMessageId: ttsPlaybackMessageId,
      });
      await stopWaveformPlayback();
    }

    logAuto("tts_trace", { stage: "button_synthesize", messageId: message.id });
    await synthesizeSpeechStream(text, {
      ...target,
      messageId: message.id,
    });
  }, [
    replyLoadingRef,
    logAuto,
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
