import { useCallback, type MutableRefObject } from "react";
import type { ConversationMessage, TtsPlaybackTarget } from "../types/appTypes";

type UseReplyAudioFlowControllerOptions = {
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
    ttsPlayingRef,
    ttsPlaybackMessageId,
    ttsLoading,
    stopWaveformPlayback,
    synthesizeSpeechStream,
    logAuto,
  } = options;

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
    logAuto,
    stopWaveformPlayback,
    synthesizeSpeechStream,
    ttsLoading,
    ttsPlaybackMessageId,
    ttsPlayingRef,
  ]);

  return {
    handleAssistantAudioButtonPress,
  };
}
