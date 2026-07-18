import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";

type UseAutoRecordingWatchdogResetControllerOptions = {
  autoRecordingWatchdogTimerRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  autoRecordingWatchdogInFlightRef: MutableRefObject<boolean>;
  autoRecordingWatchdogInFlightTokenRef: MutableRefObject<number>;
  autoRecordingWatchdogKickAtRef: MutableRefObject<number>;
  autoRecordingWatchdogRestartAtRef: MutableRefObject<number>;
  autoRecordingWatchdogLogAtRef: MutableRefObject<number>;
  autoRecordingWatchdogErrorLogAtRef: MutableRefObject<number>;
  autoProgressIntervalMsRef: MutableRefObject<number>;
  autoProgressIntervalModeRef: MutableRefObject<"idle" | "speech" | "barge">;
  autoNoCallbackFinalizeAtRef: MutableRefObject<number>;
  autoLastStatusHandledAtRef: MutableRefObject<number>;
  autoStatusReadInFlightRef: MutableRefObject<Promise<Audio.RecordingStatus> | null>;
  autoStatusReadOwnerRef: MutableRefObject<"watchdog" | "">;
  autoStatusReadStartedAtRef: MutableRefObject<number>;
  autoStatusReadSkipLogAtRef: MutableRefObject<number>;
  autoShadowStatusTimerRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  autoShadowStatusInFlightRef: MutableRefObject<boolean>;
  autoShadowStatusLastAtRef: MutableRefObject<number>;
  autoShadowStatusLastMeteringRef: MutableRefObject<number | null>;
  autoShadowStatusLastDurationMsRef: MutableRefObject<number | null>;
  autoShadowStatusLogAtRef: MutableRefObject<number>;
  autoShadowStatusErrorLogAtRef: MutableRefObject<number>;
};

export function useAutoRecordingWatchdogResetController(
  options: UseAutoRecordingWatchdogResetControllerOptions,
) {
  const {
    autoRecordingWatchdogTimerRef,
    autoRecordingWatchdogInFlightRef,
    autoRecordingWatchdogInFlightTokenRef,
    autoRecordingWatchdogKickAtRef,
    autoRecordingWatchdogRestartAtRef,
    autoRecordingWatchdogLogAtRef,
    autoRecordingWatchdogErrorLogAtRef,
    autoProgressIntervalMsRef,
    autoProgressIntervalModeRef,
    autoNoCallbackFinalizeAtRef,
    autoLastStatusHandledAtRef,
    autoStatusReadInFlightRef,
    autoStatusReadOwnerRef,
    autoStatusReadStartedAtRef,
    autoStatusReadSkipLogAtRef,
    autoShadowStatusTimerRef,
    autoShadowStatusInFlightRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastMeteringRef,
    autoShadowStatusLastDurationMsRef,
    autoShadowStatusLogAtRef,
    autoShadowStatusErrorLogAtRef,
  } = options;

  const clearAutoShadowStatusMonitorTimer = useCallback(() => {
    if (autoShadowStatusTimerRef.current) {
      clearInterval(autoShadowStatusTimerRef.current);
    }
    autoShadowStatusTimerRef.current = null;
    autoShadowStatusInFlightRef.current = false;
    autoShadowStatusLastAtRef.current = 0;
    autoShadowStatusLastMeteringRef.current = null;
    autoShadowStatusLastDurationMsRef.current = null;
    autoShadowStatusLogAtRef.current = 0;
    autoShadowStatusErrorLogAtRef.current = 0;
  }, [
    autoShadowStatusErrorLogAtRef,
    autoShadowStatusInFlightRef,
    autoShadowStatusLastAtRef,
    autoShadowStatusLastDurationMsRef,
    autoShadowStatusLastMeteringRef,
    autoShadowStatusLogAtRef,
    autoShadowStatusTimerRef,
  ]);

  const clearAutoRecordingWatchdogTimer = useCallback(() => {
    if (autoRecordingWatchdogTimerRef.current) {
      clearInterval(autoRecordingWatchdogTimerRef.current);
    }
    autoRecordingWatchdogTimerRef.current = null;
    autoRecordingWatchdogInFlightRef.current = false;
    autoRecordingWatchdogInFlightTokenRef.current = 0;
    autoRecordingWatchdogKickAtRef.current = 0;
    autoRecordingWatchdogRestartAtRef.current = 0;
    autoRecordingWatchdogLogAtRef.current = 0;
    autoRecordingWatchdogErrorLogAtRef.current = 0;
    autoProgressIntervalMsRef.current = 0;
    autoProgressIntervalModeRef.current = "idle";
    autoNoCallbackFinalizeAtRef.current = 0;
    autoLastStatusHandledAtRef.current = 0;
    autoStatusReadInFlightRef.current = null;
    autoStatusReadOwnerRef.current = "";
    autoStatusReadStartedAtRef.current = 0;
    autoStatusReadSkipLogAtRef.current = 0;
    clearAutoShadowStatusMonitorTimer();
  }, [
    autoLastStatusHandledAtRef,
    autoNoCallbackFinalizeAtRef,
    autoProgressIntervalModeRef,
    autoProgressIntervalMsRef,
    autoRecordingWatchdogErrorLogAtRef,
    autoRecordingWatchdogInFlightRef,
    autoRecordingWatchdogInFlightTokenRef,
    autoRecordingWatchdogKickAtRef,
    autoRecordingWatchdogLogAtRef,
    autoRecordingWatchdogRestartAtRef,
    autoRecordingWatchdogTimerRef,
    autoStatusReadInFlightRef,
    autoStatusReadOwnerRef,
    autoStatusReadSkipLogAtRef,
    autoStatusReadStartedAtRef,
    clearAutoShadowStatusMonitorTimer,
  ]);

  return {
    clearAutoRecordingWatchdogTimer,
    clearAutoShadowStatusMonitorTimer,
  };
}
