import { useEffect, type MutableRefObject } from "react";
import { deactivateKeepAwake } from "expo-keep-awake";
import { Audio } from "expo-av";
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
  resetAutoPendingUserState: () => void;
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
  clearAudioLabInputPollTimer: () => void;
  clearAudioLabPlaybackWatchdogTimer: () => void;
  audioLabClientLogs: BufferedClientLogsLike;
  clearTtsPlaybackWatchdogTimer: () => void;
  ttsPlaybackWantedRef: MutableRefObject<boolean>;
  ttsPlaybackTransitionInFlightRef: MutableRefObject<boolean>;
  ttsStopInFlightRef: MutableRefObject<Promise<void> | null>;
  audioLabActionInFlightRef: MutableRefObject<boolean>;
  audioLabPlaybackWantedRef: MutableRefObject<boolean>;
  audioLabRecordingRef: MutableRefObject<Audio.Recording | null>;
  audioLabSoundRef: MutableRefObject<Audio.Sound | null>;
};

export function useAppUnmountCleanupController({
  conversationKeepAwakeTag,
  clearPendingApprovals,
  hideChatBottomToast,
  autoRecordingEnabledRef,
  resetAutoPendingUserState,
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
  clearAudioLabInputPollTimer,
  clearAudioLabPlaybackWatchdogTimer,
  audioLabClientLogs,
  clearTtsPlaybackWatchdogTimer,
  ttsPlaybackWantedRef,
  ttsPlaybackTransitionInFlightRef,
  ttsStopInFlightRef,
  audioLabActionInFlightRef,
  audioLabPlaybackWantedRef,
  audioLabRecordingRef,
  audioLabSoundRef,
}: UseAppUnmountCleanupControllerOptions) {
  useEffect(() => {
    return () => {
      clearPendingApprovals();
      hideChatBottomToast();
      deactivateKeepAwake(conversationKeepAwakeTag);
      autoRecordingEnabledRef.current = false;
      resetAutoPendingUserState();
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
      clearAudioLabInputPollTimer();
      clearAudioLabPlaybackWatchdogTimer();
      audioLabClientLogs.clearFlushTimer();
      clearTtsPlaybackWatchdogTimer();
      ttsPlaybackWantedRef.current = false;
      ttsPlaybackTransitionInFlightRef.current = false;
      ttsStopInFlightRef.current = null;
      audioLabActionInFlightRef.current = false;
      audioLabPlaybackWantedRef.current = false;
      const audioLabRec = audioLabRecordingRef.current;
      audioLabRecordingRef.current = null;
      if (audioLabRec) {
        audioLabRec.setOnRecordingStatusUpdate(null);
        void releaseRecording(audioLabRec).catch(() => {});
      }
      const audioLabSound = audioLabSoundRef.current;
      audioLabSoundRef.current = null;
      if (audioLabSound) {
        audioLabSound.setOnPlaybackStatusUpdate(null);
        void audioLabSound.unloadAsync().catch(() => {});
      }
    };
  }, [clearPendingApprovals, cleanupDirectNativeStt, cleanupRecordingTranscription]);
}
