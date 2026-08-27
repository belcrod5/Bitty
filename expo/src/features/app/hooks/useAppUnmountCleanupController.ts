import { useEffect, type MutableRefObject } from "react";
import { deactivateKeepAwake } from "expo-keep-awake";
import { Audio } from "../audio";
import type { IosFaceTrackingSession } from "../../faceTracking/iosFaceTrackingClient";
import type { StreamTtsControlState } from "../types/appTypes";

type BufferedClientLogsLike = {
  clearFlushTimer: () => void;
};

type UseAppUnmountCleanupControllerOptions = {
  conversationKeepAwakeTag: string;
  clearPendingApprovals: () => void;
  hideChatBottomToast: () => void;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoClientLogs: BufferedClientLogsLike;
  clearAutoRecordingWatchdogTimer: () => void;
  autoRestartTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  autoAppStateNonActiveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  releaseRecording: (recording: Audio.Recording) => Promise<unknown>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  cleanupRecordingTranscription: () => void;
  cleanupDirectNativeStt: () => void;
  faceTrackingSessionRef: MutableRefObject<IosFaceTrackingSession | null>;
  clearTtsPlaybackWatchdogTimer: () => void;
  ttsPlaybackWantedRef: MutableRefObject<boolean>;
  ttsPlaybackTransitionInFlightRef: MutableRefObject<boolean>;
  ttsStopInFlightRef: MutableRefObject<Promise<void> | null>;
};

export function useAppUnmountCleanupController({
  conversationKeepAwakeTag,
  clearPendingApprovals,
  hideChatBottomToast,
  autoRecordingEnabledRef,
  autoClientLogs,
  clearAutoRecordingWatchdogTimer,
  autoRestartTimerRef,
  autoAppStateNonActiveTimerRef,
  autoRecordingRef,
  releaseRecording,
  streamSocketRef,
  streamTtsControlRef,
  cleanupRecordingTranscription,
  cleanupDirectNativeStt,
  faceTrackingSessionRef,
  clearTtsPlaybackWatchdogTimer,
  ttsPlaybackWantedRef,
  ttsPlaybackTransitionInFlightRef,
  ttsStopInFlightRef,
}: UseAppUnmountCleanupControllerOptions) {
  useEffect(() => {
    return () => {
      clearPendingApprovals();
      hideChatBottomToast();
      deactivateKeepAwake(conversationKeepAwakeTag);
      autoRecordingEnabledRef.current = false;
      autoClientLogs.clearFlushTimer();
      clearAutoRecordingWatchdogTimer();
      if (autoRestartTimerRef.current) {
        clearTimeout(autoRestartTimerRef.current);
        autoRestartTimerRef.current = null;
      }
      if (autoAppStateNonActiveTimerRef.current) {
        clearTimeout(autoAppStateNonActiveTimerRef.current);
        autoAppStateNonActiveTimerRef.current = null;
      }
      const rec = autoRecordingRef.current;
      if (rec) {
        void releaseRecording(rec).catch(() => {});
      }
      const ws = streamSocketRef.current;
      if (ws) {
        ws.close();
        streamSocketRef.current = null;
      }
      const streamTtsControl = streamTtsControlRef.current;
      if (streamTtsControl) {
        streamTtsControl.cleanup();
        streamTtsControlRef.current = null;
      }
      cleanupRecordingTranscription();
      cleanupDirectNativeStt();
      const faceTrackingSession = faceTrackingSessionRef.current;
      faceTrackingSessionRef.current = null;
      if (faceTrackingSession) {
        void faceTrackingSession.stop().catch(() => {});
      }
      clearTtsPlaybackWatchdogTimer();
      ttsPlaybackWantedRef.current = false;
      ttsPlaybackTransitionInFlightRef.current = false;
      ttsStopInFlightRef.current = null;
    };
  }, [clearPendingApprovals, cleanupDirectNativeStt, cleanupRecordingTranscription]);
}
