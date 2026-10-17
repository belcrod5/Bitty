import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  LlmDeltaEntry,
  LlmProgressEntry,
  StreamSegment,
  TtsPlaybackTarget,
} from "../types/appTypes";
import type { LlmUiStatus } from "./useLlmRequestStatus";

type UseSessionSwitchQuiesceControllerArgs = {
  suspendCodexTurnRequestForSessionSwitch: () => void;
  closeCodexRelayObserver: (reason: string) => void;
  stopTtsPlayback: (opts?: { interruptStream?: boolean; reason?: string }) => Promise<void>;
  ttsPlaybackProjectionTargetRef: MutableRefObject<TtsPlaybackTarget>;
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
  ttsPlaybackProjectionTargetRef,
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
  const quiesceForSessionSwitch = useCallback(async (
    reason: string,
    opts?: { preserveRelayObserver?: boolean }
  ) => {
    suspendCodexTurnRequestForSessionSwitch();
    // 復帰時の同一セッション再同期(preserveRelayObserver)では、ライブ配信路である
    // relay observerをcloseしない。closeするとWS ready時のseq resume(サーバー差分再送)が
    // 失われ、resume_missも発生しないため回復経路が発火しなくなる(G1)。
    if (opts?.preserveRelayObserver !== true) {
      closeCodexRelayObserver(`session_switch:${reason}`);
    }
    const playbackTarget = ttsPlaybackProjectionTargetRef.current;
    if (playbackTarget.scope !== "voice") {
      await stopTtsPlayback({ interruptStream: true, reason: `session_switch:${reason}` }).catch(() => {});
      if (ttsPlaybackProjectionTargetRef.current === playbackTarget) {
        setStreamMode("");
        setStreamSegments([]);
        setTtsPlaybackMessageIdWithRef("");
      }
    }
    setStreamLlmNativeDeltaCount(0);
    setStreamLlmPseudoDeltaCount(0);
    setStreamFirstNativeDeltaOffsetMs(null);
    setStreamLlmDeltas([]);
    setStreamLlmProgress([]);
    setStreamReplyYouTubeVideoIdsWithRef([]);
    setReply("");
    if (replyLoadingRef.current) {
      setReplyLoadingWithRef(false);
      finishLlmRequest("idle", "session_switch");
    }
    setReplyDebug((prev) => (
      prev ? `${prev} | session_switch_quiesced reason=${reason}` : `session_switch_quiesced reason=${reason}`
    ));
  }, [
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
    setTtsPlaybackMessageIdWithRef,
    stopTtsPlayback,
    ttsPlaybackProjectionTargetRef,
    suspendCodexTurnRequestForSessionSwitch,
  ]);

  return {
    quiesceForSessionSwitch,
  };
}
