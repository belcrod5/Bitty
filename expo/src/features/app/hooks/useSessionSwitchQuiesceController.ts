import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  LlmDeltaEntry,
  LlmProgressEntry,
  StreamSegment,
} from "../types/appTypes";
import type { LlmUiStatus } from "./useLlmRequestStatus";

type UseSessionSwitchQuiesceControllerArgs = {
  suspendCodexTurnRequestForSessionSwitch: () => void;
  closeCodexRelayObserver: (reason: string) => void;
  stopTtsPlayback: (opts?: { interruptStream?: boolean; clearPlaybackMessageId?: boolean }) => Promise<void>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  clearStreamAudioQueue: () => void;
  streamAudioWaveformBarsRef: MutableRefObject<number[][]>;
  setStreamWaveformPreview: Dispatch<SetStateAction<number[]>>;
  streamTtsSuppressedRef: MutableRefObject<boolean>;
  setStreamMode: Dispatch<SetStateAction<string>>;
  setStreamLlmNativeDeltaCount: Dispatch<SetStateAction<number>>;
  setStreamLlmPseudoDeltaCount: Dispatch<SetStateAction<number>>;
  setStreamFirstNativeDeltaOffsetMs: Dispatch<SetStateAction<number | null>>;
  setStreamLlmDeltas: Dispatch<SetStateAction<LlmDeltaEntry[]>>;
  setStreamLlmProgress: Dispatch<SetStateAction<LlmProgressEntry[]>>;
  setStreamSegments: Dispatch<SetStateAction<StreamSegment[]>>;
  setStreamReplyYouTubeVideoIdsWithRef: (next: string[]) => void;
  setTtsPlaybackMessageIdWithRef: (next: string) => void;
  setReply: Dispatch<SetStateAction<string>>;
  replyLoadingRef: MutableRefObject<boolean>;
  setReplyLoadingWithRef: (next: boolean) => void;
  finishLlmRequest: (nextStatus: LlmUiStatus, reason?: string) => void;
  setReplyDebug: Dispatch<SetStateAction<string>>;
};

export function useSessionSwitchQuiesceController({
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
}: UseSessionSwitchQuiesceControllerArgs) {
  const quiesceForSessionSwitch = useCallback(async (reason: string) => {
    suspendCodexTurnRequestForSessionSwitch();
    closeCodexRelayObserver(`session_switch:${reason}`);
    await stopTtsPlayback({ interruptStream: false }).catch(() => {});
    const ws = streamSocketRef.current;
    if (ws) {
      ws.close();
      streamSocketRef.current = null;
    }
    clearStreamAudioQueue();
    streamAudioWaveformBarsRef.current = [];
    setStreamWaveformPreview([]);
    streamTtsSuppressedRef.current = false;
    setStreamMode("");
    setStreamLlmNativeDeltaCount(0);
    setStreamLlmPseudoDeltaCount(0);
    setStreamFirstNativeDeltaOffsetMs(null);
    setStreamLlmDeltas([]);
    setStreamLlmProgress([]);
    setStreamSegments([]);
    setStreamReplyYouTubeVideoIdsWithRef([]);
    setTtsPlaybackMessageIdWithRef("");
    setReply("");
    if (replyLoadingRef.current) {
      setReplyLoadingWithRef(false);
      finishLlmRequest("idle", "session_switch");
    }
    setReplyDebug((prev) => (
      prev ? `${prev} | session_switch_quiesced reason=${reason}` : `session_switch_quiesced reason=${reason}`
    ));
  }, [
    clearStreamAudioQueue,
    closeCodexRelayObserver,
    finishLlmRequest,
    replyLoadingRef,
    setReply,
    setReplyDebug,
    setReplyLoadingWithRef,
    setStreamFirstNativeDeltaOffsetMs,
    setStreamLlmDeltas,
    setStreamLlmNativeDeltaCount,
    setStreamLlmProgress,
    setStreamLlmPseudoDeltaCount,
    setStreamMode,
    setStreamReplyYouTubeVideoIdsWithRef,
    setStreamSegments,
    setStreamWaveformPreview,
    setTtsPlaybackMessageIdWithRef,
    stopTtsPlayback,
    streamAudioWaveformBarsRef,
    streamSocketRef,
    streamTtsSuppressedRef,
    suspendCodexTurnRequestForSessionSwitch,
  ]);

  return {
    quiesceForSessionSwitch,
  };
}
