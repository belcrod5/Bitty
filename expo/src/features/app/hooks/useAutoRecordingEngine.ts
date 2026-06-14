import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Audio } from "expo-av";
import type { AppStateStatus } from "react-native";

type AutoProgressMode = "idle" | "speech" | "barge";

type UseAutoRecordingEngineOptions = {
  appStateRef: MutableRefObject<AppStateStatus>;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  autoFinalizeLockRef: MutableRefObject<boolean>;
  autoRestartTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  autoAppStateNonActiveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  autoWaitReasonRef: MutableRefObject<string>;
  autoWaitReasonLogAtRef: MutableRefObject<number>;
  autoClipStartedAtRef: MutableRefObject<number>;
  autoSpeechStartedAtRef: MutableRefObject<number>;
  autoAboveSinceRef: MutableRefObject<number>;
  autoAboveGapSinceRef: MutableRefObject<number>;
  autoBelowSinceRef: MutableRefObject<number>;
  autoInputDetectAtRef: MutableRefObject<number>;
  autoProgressIntervalMsRef: MutableRefObject<number>;
  autoProgressIntervalModeRef: MutableRefObject<AutoProgressMode>;
  autoUiLatestMeteringRef: MutableRefObject<number | null>;
  autoUiLatestSpeechSampleRef: MutableRefObject<boolean>;
  autoWaveformSkipLogAtRef: MutableRefObject<number>;
  autoBargeInProbeLogAtRef: MutableRefObject<number>;
  autoBargeInFastStopAtRef: MutableRefObject<number>;
  autoBargeInFastProbeAboveSinceRef: MutableRefObject<number>;
  autoFinalizeResolvedAtRef: MutableRefObject<number>;
  autoLastBargeInDetectedAtRef: MutableRefObject<number>;
  autoLastTtsStopRequestedAtRef: MutableRefObject<number>;
  autoLastTtsStoppedAtRef: MutableRefObject<number>;
  autoPlaybackBargeGraceUntilRef: MutableRefObject<number>;
  autoInputNameRef: MutableRefObject<string>;
  autoAirPodsInputRef: MutableRefObject<boolean>;
  autoSilenceDeadlineAtRef: MutableRefObject<number>;
  autoNoCallbackFinalizeAtRef: MutableRefObject<number>;
  autoLastStatusHandledAtRef: MutableRefObject<number>;
  autoBargeInStoppingRef: MutableRefObject<boolean>;
  autoBargeInDetectedForClipRef: MutableRefObject<boolean>;
  autoSpeechStartedDuringTtsRef: MutableRefObject<boolean>;
  autoPostTtsAboveSinceRef: MutableRefObject<number>;
  autoPostTtsHumanDetectedRef: MutableRefObject<boolean>;
  faceTrackingSuppressLogAtRef: MutableRefObject<number>;
  faceTrackingSuppressedRef: MutableRefObject<boolean>;
  faceTrackingNotLookingSinceRef: MutableRefObject<number>;
  autoPendingUserMessageIdRef: MutableRefObject<string>;
  autoPendingUserAnimFrameRef: MutableRefObject<number>;
  autoPendingUserMessageStartedAtRef: MutableRefObject<number>;
  autoPendingUserMessageVisibleAtRef: MutableRefObject<number>;
  autoPendingUserVisibleLoggedMessageIdRef: MutableRefObject<string>;
  autoCaptureCycleSeqRef: MutableRefObject<number>;
  audioLabRecordingRef: MutableRefObject<Audio.Recording | null>;
  audioLabSoundRef: MutableRefObject<Audio.Sound | null>;
  faceTrackingFaceDetectedRef: MutableRefObject<boolean>;
  faceTrackingLookingRef: MutableRefObject<boolean>;
  autoSpeakerPriorityEnabledRef: MutableRefObject<boolean>;
  autoBargeInEnabledRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  youtubePlayerIsPlayingRef: MutableRefObject<boolean>;
  autoSegments: number;
  autoRecordingState: string;
  autoLastEvent: string;
  autoSpeakerPriorityEnabled: boolean;
  autoBargeInEnabled: boolean;
  autoReplyAfterStt: boolean;
  autoSpeakAfterReply: boolean;
  ttsLoading: boolean;
  audioLabRunning: boolean;
  manualRecordingActive: boolean;
  autoWaitReasonLogThrottleMs: number;
  autoRestartDelayMs: number;
  autoCooldownMs: number;
  autoMinSpeechMs: number;
  setErrorMessage: (message: string) => void;
  setAutoRecordingEnabled: (enabled: boolean) => void;
  setAutoRecordingState: (state: string) => void;
  setAutoLastEvent: (event: string) => void;
  setAutoInputName: (name: string) => void;
  setAutoAirPodsInput: (active: boolean) => void;
  setAutoMeteringDb: (value: number | null) => void;
  setAutoSegments: Dispatch<SetStateAction<number>>;
  clearAutoPendingUserTimeoutTimer: () => void;
  clearAutoPendingUserAnimationTimer: () => void;
  clearAutoRecordingWatchdogTimer: () => void;
  removeConversationMessageById: (messageId: string) => void;
  resolveAutoPendingUserMessage: (finalTranscript: string) => void;
  faceTrackingAllowsStt: (forceFresh?: boolean) => boolean;
  transcribeRecording: (uriOverride?: string) => Promise<void>;
  enqueueAutoTranscribe: (uri: string, reason: string) => void;
  setRecordedClip: (uri: string, sec: number) => void;
  runAutoCaptureCycleCore: (captureCycleId: number) => Promise<void>;
  resetAutoWaveform: () => void;
  playUiSfx: (key: "recordStart" | "recordStop") => void;
  releaseRecording: (rec: Audio.Recording) => Promise<Audio.RecordingStatus | null>;
  setAudioModeForPlayback: (options?: { force?: boolean; reason?: string; allowsRecordingIOS?: boolean }) => Promise<void>;
  elapsedSinceMs: (startedAtMs: number) => number | null;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  reportError: (raw: unknown, scope?: string) => void;
};

export function useAutoRecordingEngine(options: UseAutoRecordingEngineOptions) {
  const {
    appStateRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoFinalizeLockRef,
    autoRestartTimerRef,
    autoAppStateNonActiveTimerRef,
    autoWaitReasonRef,
    autoWaitReasonLogAtRef,
    autoClipStartedAtRef,
    autoSpeechStartedAtRef,
    autoAboveSinceRef,
    autoAboveGapSinceRef,
    autoBelowSinceRef,
    autoInputDetectAtRef,
    autoProgressIntervalMsRef,
    autoProgressIntervalModeRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaveformSkipLogAtRef,
    autoBargeInProbeLogAtRef,
    autoBargeInFastStopAtRef,
    autoBargeInFastProbeAboveSinceRef,
    autoFinalizeResolvedAtRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    autoPlaybackBargeGraceUntilRef,
    autoInputNameRef,
    autoAirPodsInputRef,
    autoSilenceDeadlineAtRef,
    autoNoCallbackFinalizeAtRef,
    autoLastStatusHandledAtRef,
    autoBargeInStoppingRef,
    autoBargeInDetectedForClipRef,
    autoSpeechStartedDuringTtsRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    faceTrackingSuppressLogAtRef,
    faceTrackingSuppressedRef,
    faceTrackingNotLookingSinceRef,
    autoPendingUserMessageIdRef,
    autoPendingUserAnimFrameRef,
    autoPendingUserMessageStartedAtRef,
    autoPendingUserMessageVisibleAtRef,
    autoPendingUserVisibleLoggedMessageIdRef,
    autoCaptureCycleSeqRef,
    audioLabRecordingRef,
    audioLabSoundRef,
    faceTrackingFaceDetectedRef,
    faceTrackingLookingRef,
    autoSpeakerPriorityEnabledRef,
    autoBargeInEnabledRef,
    replyLoadingRef,
    ttsPlayingRef,
    youtubePlayerIsPlayingRef,
    autoSegments,
    autoRecordingState,
    autoLastEvent,
    autoSpeakerPriorityEnabled,
    autoBargeInEnabled,
    autoReplyAfterStt,
    autoSpeakAfterReply,
    ttsLoading,
    audioLabRunning,
    manualRecordingActive,
    autoWaitReasonLogThrottleMs,
    autoRestartDelayMs,
    autoCooldownMs,
    autoMinSpeechMs,
    setErrorMessage,
    setAutoRecordingEnabled,
    setAutoRecordingState,
    setAutoLastEvent,
    setAutoInputName,
    setAutoAirPodsInput,
    setAutoMeteringDb,
    setAutoSegments,
    clearAutoPendingUserTimeoutTimer,
    clearAutoPendingUserAnimationTimer,
    clearAutoRecordingWatchdogTimer,
    removeConversationMessageById,
    resolveAutoPendingUserMessage,
    faceTrackingAllowsStt,
    transcribeRecording,
    enqueueAutoTranscribe,
    setRecordedClip,
    runAutoCaptureCycleCore,
    resetAutoWaveform,
    playUiSfx,
    releaseRecording,
    setAudioModeForPlayback,
    elapsedSinceMs,
    logAuto,
    reportError,
  } = options;

  const startAutoCaptureCycle = useCallback(async () => {
    if (!autoRecordingEnabledRef.current || autoRecordingRef.current) return;
    if (appStateRef.current !== "active") {
      setAutoRecordingState("starting");
      setAutoLastEvent("waiting_foreground");
      const now = Date.now();
      const waitReason = "waiting_foreground";
      if (
        autoWaitReasonRef.current !== waitReason ||
        now - autoWaitReasonLogAtRef.current >= autoWaitReasonLogThrottleMs
      ) {
        autoWaitReasonRef.current = waitReason;
        autoWaitReasonLogAtRef.current = now;
        logAuto("capture_wait", { reason: waitReason, appState: appStateRef.current });
      }
      return;
    }
    if (!faceTrackingAllowsStt(true)) {
      setAutoRecordingState("starting");
      setAutoLastEvent("face_not_looking_wait");
      const now = Date.now();
      const waitReason = "face_not_looking";
      if (
        autoWaitReasonRef.current !== waitReason ||
        now - autoWaitReasonLogAtRef.current >= autoWaitReasonLogThrottleMs
      ) {
        autoWaitReasonRef.current = waitReason;
        autoWaitReasonLogAtRef.current = now;
        logAuto("capture_wait", {
          reason: waitReason,
          faceDetected: faceTrackingFaceDetectedRef.current,
          lookState: faceTrackingLookingRef.current,
        });
      }
      if (autoRestartTimerRef.current) clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = setTimeout(() => {
        autoRestartTimerRef.current = null;
        if (autoRecordingEnabledRef.current) {
          void startAutoCaptureCycle();
        }
      }, autoRestartDelayMs);
      return;
    }
    const waitingReplyOnly = (
      replyLoadingRef.current &&
      !ttsPlayingRef.current &&
      !autoBargeInEnabledRef.current
    );
    const ttsPlaybackBlocksCapture = (
      ttsPlayingRef.current &&
      !autoAirPodsInputRef.current &&
      !autoBargeInEnabledRef.current
    );
    const youtubePlaybackBlocksCapture = (
      youtubePlayerIsPlayingRef.current &&
      !autoAirPodsInputRef.current
    );
    const playbackBlocksCapture = (
      ttsPlaybackBlocksCapture ||
      youtubePlaybackBlocksCapture
    );
    if (waitingReplyOnly || playbackBlocksCapture) {
      const now = Date.now();
      const waitReason = waitingReplyOnly
        ? "waiting_reply"
        : youtubePlaybackBlocksCapture
          ? "youtube_playback_blocked"
          : "playback_blocked";
      if (
        autoWaitReasonRef.current !== waitReason ||
        now - autoWaitReasonLogAtRef.current >= autoWaitReasonLogThrottleMs
      ) {
        autoWaitReasonRef.current = waitReason;
        autoWaitReasonLogAtRef.current = now;
        logAuto("capture_wait", {
          reason: waitReason,
          replyLoading: replyLoadingRef.current,
          ttsPlaying: ttsPlayingRef.current,
          youtubePlaying: youtubePlayerIsPlayingRef.current,
          ttsPlaybackBlocksCapture,
          youtubePlaybackBlocksCapture,
          ttsLoading,
          autoAirPodsInput: autoAirPodsInputRef.current,
          speakerPriority: autoSpeakerPriorityEnabledRef.current,
          autoBargeInEnabled: autoBargeInEnabledRef.current,
        });
      }
      if (autoRestartTimerRef.current) clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = setTimeout(() => {
        autoRestartTimerRef.current = null;
        if (autoRecordingEnabledRef.current) {
          void startAutoCaptureCycle();
        }
      }, autoRestartDelayMs);
      return;
    }
    if (autoWaitReasonRef.current) {
      logAuto("capture_wait_cleared", { reason: autoWaitReasonRef.current });
      autoWaitReasonRef.current = "";
      autoWaitReasonLogAtRef.current = 0;
    }
    const captureCycleId = autoCaptureCycleSeqRef.current + 1;
    autoCaptureCycleSeqRef.current = captureCycleId;
    logAuto("capture_cycle_start", {
      captureCycleId,
      replyLoading: replyLoadingRef.current,
      ttsPlaying: ttsPlayingRef.current,
      youtubePlaying: youtubePlayerIsPlayingRef.current,
      ttsLoading,
      autoAirPodsInput: autoAirPodsInputRef.current,
      speakerPriority: autoSpeakerPriorityEnabledRef.current,
      autoBargeInEnabled: autoBargeInEnabledRef.current,
    });
    await runAutoCaptureCycleCore(captureCycleId);
  }, [
    appStateRef,
    autoAirPodsInputRef,
    autoBargeInEnabledRef,
    autoCaptureCycleSeqRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoRestartDelayMs,
    autoRestartTimerRef,
    autoSpeakerPriorityEnabledRef,
    autoWaitReasonLogAtRef,
    autoWaitReasonLogThrottleMs,
    autoWaitReasonRef,
    faceTrackingAllowsStt,
    faceTrackingFaceDetectedRef,
    faceTrackingLookingRef,
    logAuto,
    replyLoadingRef,
    runAutoCaptureCycleCore,
    setAutoLastEvent,
    setAutoRecordingState,
    ttsLoading,
    ttsPlayingRef,
    youtubePlayerIsPlayingRef,
  ]);

  const finalizeAutoCapture = useCallback(async (shouldTranscribe: boolean, reason: string) => {
    if (autoFinalizeLockRef.current) return;
    const rec = autoRecordingRef.current;
    if (!rec) return;

    const startedAt = autoSpeechStartedAtRef.current;
    const speechMsAtFinalize = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
    logAuto("finalize_begin", {
      reason,
      shouldTranscribe,
      speechMs: speechMsAtFinalize,
      autoSegments,
      sinceBargeInDetectedMs: elapsedSinceMs(autoLastBargeInDetectedAtRef.current),
      sinceTtsStopRequestedMs: elapsedSinceMs(autoLastTtsStopRequestedAtRef.current),
      sinceTtsStoppedMs: elapsedSinceMs(autoLastTtsStoppedAtRef.current),
    });
    autoFinalizeLockRef.current = true;
    setAutoRecordingState("cooldown");
    setAutoLastEvent(`finalize:${reason}`);

    try {
      const status = await releaseRecording(rec);

      const uri = rec.getURI() || "";
      const durationMillis = status?.durationMillis || 0;
      setRecordedClip(uri, Math.round(durationMillis / 1000));

      let shouldTranscribeResolved = shouldTranscribe;
      const bargeInDetectedForClip = autoBargeInDetectedForClipRef.current;
      if (
        shouldTranscribeResolved &&
        autoSpeechStartedDuringTtsRef.current &&
        !autoPostTtsHumanDetectedRef.current &&
        !bargeInDetectedForClip
      ) {
        shouldTranscribeResolved = false;
        setAutoLastEvent("suppressed_self_tts");
      }
      logAuto("finalize_resolved", {
        reason,
        durationMillis,
        hasUri: Boolean(uri),
        shouldTranscribe: shouldTranscribeResolved,
        speechStartedDuringTts: autoSpeechStartedDuringTtsRef.current,
        postTtsHumanDetected: autoPostTtsHumanDetectedRef.current,
        bargeInDetectedForClip,
      });
      autoFinalizeResolvedAtRef.current = Date.now();

      if (shouldTranscribeResolved && uri) {
        setAutoSegments((v) => v + 1);
        enqueueAutoTranscribe(uri, reason);
      } else if (autoPendingUserMessageIdRef.current) {
        resolveAutoPendingUserMessage("");
      }
    } catch (e) {
      reportError(e, "auto:finalize");
    } finally {
      rec.setOnRecordingStatusUpdate(null);
      clearAutoRecordingWatchdogTimer();
      autoRecordingRef.current = null;
      await setAudioModeForPlayback({ reason: "auto_finalize" }).catch(() => {});
      autoFinalizeLockRef.current = false;
      autoClipStartedAtRef.current = 0;
      autoSpeechStartedAtRef.current = 0;
      autoAboveSinceRef.current = 0;
      autoAboveGapSinceRef.current = 0;
      autoBelowSinceRef.current = 0;
      autoSilenceDeadlineAtRef.current = 0;
      autoBargeInStoppingRef.current = false;
      autoBargeInDetectedForClipRef.current = false;
      autoBargeInFastStopAtRef.current = 0;
      autoBargeInFastProbeAboveSinceRef.current = 0;
      logAuto("barge_in_flags_reset", {
        phase: "finalize",
        autoBargeInStopping: autoBargeInStoppingRef.current,
        detectedForClip: autoBargeInDetectedForClipRef.current,
      });
      autoSpeechStartedDuringTtsRef.current = false;
      autoPostTtsAboveSinceRef.current = 0;
      autoPostTtsHumanDetectedRef.current = false;
      autoUiLatestMeteringRef.current = null;
      autoUiLatestSpeechSampleRef.current = false;
      setAutoMeteringDb(null);

      if (autoRecordingEnabledRef.current) {
        if (autoRestartTimerRef.current) clearTimeout(autoRestartTimerRef.current);
        logAuto("finalize_schedule_restart", { cooldownMs: autoCooldownMs, reason });
        autoRestartTimerRef.current = setTimeout(() => {
          autoRestartTimerRef.current = null;
          if (autoRecordingEnabledRef.current) {
            void startAutoCaptureCycle();
          }
        }, autoCooldownMs);
      } else {
        setAutoRecordingState("idle");
      }
    }
  }, [
    autoAboveGapSinceRef,
    autoAboveSinceRef,
    autoBargeInDetectedForClipRef,
    autoBargeInFastProbeAboveSinceRef,
    autoBargeInFastStopAtRef,
    autoBargeInStoppingRef,
    autoBelowSinceRef,
    autoClipStartedAtRef,
    autoCooldownMs,
    autoFinalizeLockRef,
    autoFinalizeResolvedAtRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    autoPendingUserMessageIdRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoRestartTimerRef,
    autoSegments,
    autoSilenceDeadlineAtRef,
    autoSpeechStartedAtRef,
    autoSpeechStartedDuringTtsRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    clearAutoRecordingWatchdogTimer,
    elapsedSinceMs,
    enqueueAutoTranscribe,
    logAuto,
    releaseRecording,
    reportError,
    resolveAutoPendingUserMessage,
    setAudioModeForPlayback,
    setAutoLastEvent,
    setAutoMeteringDb,
    setAutoRecordingState,
    setAutoSegments,
    setRecordedClip,
    startAutoCaptureCycle,
  ]);

  const startAutoRecordingMode = useCallback(async () => {
    if (autoRecordingEnabledRef.current) return;
    if (audioLabRecordingRef.current || audioLabSoundRef.current || audioLabRunning) {
      reportError("Audio Lab実行中はAuto Recordingを開始できません。", "auto:start-mode");
      return;
    }
    if (manualRecordingActive) {
      reportError("手動録音を停止してから自動録音を開始してください。", "auto:start-mode");
      return;
    }
    logAuto("mode_start_requested", {
      speakerPriority: autoSpeakerPriorityEnabled,
      autoBargeInEnabled,
      autoReplyAfterStt,
      autoSpeakAfterReply,
    });
    setErrorMessage("");
    autoRecordingEnabledRef.current = true;
    autoBargeInStoppingRef.current = false;
    autoBargeInDetectedForClipRef.current = false;
    autoSilenceDeadlineAtRef.current = 0;
    autoNoCallbackFinalizeAtRef.current = 0;
    autoLastStatusHandledAtRef.current = 0;
    autoProgressIntervalMsRef.current = 0;
    autoProgressIntervalModeRef.current = "idle";
    autoUiLatestMeteringRef.current = null;
    autoUiLatestSpeechSampleRef.current = false;
    setAutoInputName("");
    setAutoAirPodsInput(false);
    autoAirPodsInputRef.current = false;
    autoInputDetectAtRef.current = 0;
    autoSpeechStartedDuringTtsRef.current = false;
    autoPostTtsAboveSinceRef.current = 0;
    autoPostTtsHumanDetectedRef.current = false;
    autoWaitReasonRef.current = "";
    autoWaitReasonLogAtRef.current = 0;
    autoWaveformSkipLogAtRef.current = 0;
    autoBargeInProbeLogAtRef.current = 0;
    autoBargeInFastStopAtRef.current = 0;
    autoBargeInFastProbeAboveSinceRef.current = 0;
    autoFinalizeResolvedAtRef.current = 0;
    autoPlaybackBargeGraceUntilRef.current = 0;
    autoAboveGapSinceRef.current = 0;
    faceTrackingSuppressedRef.current = false;
    faceTrackingSuppressLogAtRef.current = 0;
    faceTrackingNotLookingSinceRef.current = 0;
    clearAutoPendingUserTimeoutTimer();
    clearAutoPendingUserAnimationTimer();
    autoPendingUserAnimFrameRef.current = 0;
    autoPendingUserMessageIdRef.current = "";
    autoPendingUserMessageStartedAtRef.current = 0;
    autoPendingUserMessageVisibleAtRef.current = 0;
    autoPendingUserVisibleLoggedMessageIdRef.current = "";
    clearAutoRecordingWatchdogTimer();
    if (autoAppStateNonActiveTimerRef.current) {
      clearTimeout(autoAppStateNonActiveTimerRef.current);
      autoAppStateNonActiveTimerRef.current = null;
    }
    setAutoRecordingEnabled(true);
    setAutoRecordingState("starting");
    setAutoLastEvent("starting");
    resetAutoWaveform();
    playUiSfx("recordStart");
    void startAutoCaptureCycle();
  }, [
    audioLabRecordingRef,
    audioLabRunning,
    audioLabSoundRef,
    autoAboveGapSinceRef,
    autoAirPodsInputRef,
    autoAppStateNonActiveTimerRef,
    autoBargeInDetectedForClipRef,
    autoBargeInEnabled,
    autoBargeInFastProbeAboveSinceRef,
    autoBargeInFastStopAtRef,
    autoBargeInProbeLogAtRef,
    autoBargeInStoppingRef,
    autoFinalizeResolvedAtRef,
    autoInputDetectAtRef,
    autoLastStatusHandledAtRef,
    autoNoCallbackFinalizeAtRef,
    autoPendingUserAnimFrameRef,
    autoPendingUserMessageIdRef,
    autoPendingUserMessageStartedAtRef,
    autoPendingUserMessageVisibleAtRef,
    autoPendingUserVisibleLoggedMessageIdRef,
    autoPlaybackBargeGraceUntilRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    autoProgressIntervalModeRef,
    autoProgressIntervalMsRef,
    autoRecordingEnabledRef,
    autoReplyAfterStt,
    autoSilenceDeadlineAtRef,
    autoSpeakAfterReply,
    autoSpeakerPriorityEnabled,
    autoSpeechStartedDuringTtsRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaitReasonLogAtRef,
    autoWaitReasonRef,
    autoWaveformSkipLogAtRef,
    clearAutoPendingUserAnimationTimer,
    clearAutoPendingUserTimeoutTimer,
    clearAutoRecordingWatchdogTimer,
    faceTrackingNotLookingSinceRef,
    faceTrackingSuppressLogAtRef,
    faceTrackingSuppressedRef,
    logAuto,
    manualRecordingActive,
    playUiSfx,
    reportError,
    resetAutoWaveform,
    setAutoAirPodsInput,
    setAutoInputName,
    setAutoLastEvent,
    setAutoRecordingEnabled,
    setAutoRecordingState,
    setErrorMessage,
    startAutoCaptureCycle,
  ]);

  const stopAutoRecordingMode = useCallback(async () => {
    logAuto("mode_stop_requested", {
      autoSegments,
      state: autoRecordingState,
      lastEvent: autoLastEvent,
    });
    autoRecordingEnabledRef.current = false;
    autoSilenceDeadlineAtRef.current = 0;
    autoNoCallbackFinalizeAtRef.current = 0;
    autoLastStatusHandledAtRef.current = 0;
    autoProgressIntervalMsRef.current = 0;
    autoProgressIntervalModeRef.current = "idle";
    autoUiLatestMeteringRef.current = null;
    autoUiLatestSpeechSampleRef.current = false;
    setAutoInputName("");
    setAutoAirPodsInput(false);
    autoInputNameRef.current = "";
    autoAirPodsInputRef.current = false;
    autoInputDetectAtRef.current = 0;
    autoWaitReasonRef.current = "";
    autoWaitReasonLogAtRef.current = 0;
    autoBargeInProbeLogAtRef.current = 0;
    autoBargeInFastStopAtRef.current = 0;
    autoBargeInFastProbeAboveSinceRef.current = 0;
    autoFinalizeResolvedAtRef.current = 0;
    autoPlaybackBargeGraceUntilRef.current = 0;
    autoAboveGapSinceRef.current = 0;
    faceTrackingSuppressedRef.current = false;
    faceTrackingSuppressLogAtRef.current = 0;
    faceTrackingNotLookingSinceRef.current = 0;
    clearAutoPendingUserTimeoutTimer();
    clearAutoPendingUserAnimationTimer();
    autoPendingUserAnimFrameRef.current = 0;
    autoPendingUserMessageStartedAtRef.current = 0;
    autoPendingUserMessageVisibleAtRef.current = 0;
    autoPendingUserVisibleLoggedMessageIdRef.current = "";
    if (autoPendingUserMessageIdRef.current) {
      removeConversationMessageById(autoPendingUserMessageIdRef.current);
      autoPendingUserMessageIdRef.current = "";
    }
    setAutoRecordingEnabled(false);
    if (autoRestartTimerRef.current) {
      clearTimeout(autoRestartTimerRef.current);
      autoRestartTimerRef.current = null;
    }
    if (autoAppStateNonActiveTimerRef.current) {
      clearTimeout(autoAppStateNonActiveTimerRef.current);
      autoAppStateNonActiveTimerRef.current = null;
    }
    clearAutoRecordingWatchdogTimer();
    const rec = autoRecordingRef.current;
    if (rec) {
      autoRecordingRef.current = null;
      try {
        await releaseRecording(rec);
        const uri = rec.getURI() || "";
        const speechMs = autoSpeechStartedAtRef.current ? Date.now() - autoSpeechStartedAtRef.current : 0;
        const suppressSelfTts = (
          autoSpeechStartedDuringTtsRef.current &&
          !autoPostTtsHumanDetectedRef.current &&
          !autoBargeInDetectedForClipRef.current
        );
        if (uri && speechMs >= autoMinSpeechMs && !suppressSelfTts && faceTrackingAllowsStt(true)) {
          setAutoSegments((v) => v + 1);
          await transcribeRecording(uri);
        } else if (!faceTrackingAllowsStt(true)) {
          setAutoLastEvent("face_not_looking");
        } else if (suppressSelfTts) {
          setAutoLastEvent("suppressed_self_tts");
        }
      } catch (e) {
        reportError(e, "auto:stop-mode");
      } finally {
        rec.setOnRecordingStatusUpdate(null);
      }
    }

    autoFinalizeLockRef.current = false;
    await setAudioModeForPlayback({ reason: "stop_auto_mode" }).catch(() => {});
    autoClipStartedAtRef.current = 0;
    autoSpeechStartedAtRef.current = 0;
    autoAboveSinceRef.current = 0;
    autoAboveGapSinceRef.current = 0;
    autoBelowSinceRef.current = 0;
    autoSilenceDeadlineAtRef.current = 0;
    autoBargeInStoppingRef.current = false;
    autoBargeInDetectedForClipRef.current = false;
    autoBargeInFastStopAtRef.current = 0;
    autoBargeInFastProbeAboveSinceRef.current = 0;
    autoSpeechStartedDuringTtsRef.current = false;
    autoPostTtsAboveSinceRef.current = 0;
    autoPostTtsHumanDetectedRef.current = false;
    setAutoRecordingState("idle");
    setAutoMeteringDb(null);
    setAutoLastEvent("stopped");
    resetAutoWaveform();
    playUiSfx("recordStop");
    logAuto("mode_stopped", { autoSegments });
  }, [
    autoAboveGapSinceRef,
    autoAboveSinceRef,
    autoAirPodsInputRef,
    autoAppStateNonActiveTimerRef,
    autoBargeInDetectedForClipRef,
    autoBargeInFastProbeAboveSinceRef,
    autoBargeInFastStopAtRef,
    autoBargeInProbeLogAtRef,
    autoBargeInStoppingRef,
    autoBelowSinceRef,
    autoClipStartedAtRef,
    autoFinalizeLockRef,
    autoFinalizeResolvedAtRef,
    autoInputDetectAtRef,
    autoInputNameRef,
    autoLastEvent,
    autoLastStatusHandledAtRef,
    autoMinSpeechMs,
    autoNoCallbackFinalizeAtRef,
    autoPendingUserAnimFrameRef,
    autoPendingUserMessageIdRef,
    autoPendingUserMessageStartedAtRef,
    autoPendingUserMessageVisibleAtRef,
    autoPendingUserVisibleLoggedMessageIdRef,
    autoPlaybackBargeGraceUntilRef,
    autoPostTtsAboveSinceRef,
    autoPostTtsHumanDetectedRef,
    autoProgressIntervalModeRef,
    autoProgressIntervalMsRef,
    autoRecordingEnabledRef,
    autoRecordingRef,
    autoRecordingState,
    autoRestartTimerRef,
    autoSegments,
    autoSilenceDeadlineAtRef,
    autoSpeechStartedAtRef,
    autoSpeechStartedDuringTtsRef,
    autoUiLatestMeteringRef,
    autoUiLatestSpeechSampleRef,
    autoWaitReasonLogAtRef,
    autoWaitReasonRef,
    clearAutoPendingUserAnimationTimer,
    clearAutoPendingUserTimeoutTimer,
    clearAutoRecordingWatchdogTimer,
    faceTrackingAllowsStt,
    faceTrackingNotLookingSinceRef,
    faceTrackingSuppressLogAtRef,
    faceTrackingSuppressedRef,
    logAuto,
    playUiSfx,
    releaseRecording,
    removeConversationMessageById,
    reportError,
    resetAutoWaveform,
    setAudioModeForPlayback,
    setAutoAirPodsInput,
    setAutoInputName,
    setAutoLastEvent,
    setAutoMeteringDb,
    setAutoRecordingEnabled,
    setAutoRecordingState,
    setAutoSegments,
    transcribeRecording,
  ]);

  return {
    finalizeAutoCapture,
    startAutoCaptureCycle,
    startAutoRecordingMode,
    stopAutoRecordingMode,
  };
}
