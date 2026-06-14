import { useCallback, type MutableRefObject } from "react";
import { Audio } from "expo-av";
import type { AudioModeSwitchOptions } from "../types/appTypes";
import { isAirPodsInputName } from "../utils/audioSession";

type UseAudioInputRouteControllerOptions = {
  autoRecordingRef: MutableRefObject<Audio.Recording | null>;
  autoAirPodsInputRef: MutableRefObject<boolean>;
  autoInputNameRef: MutableRefObject<string>;
  autoInputDetectErrorLogAtRef: MutableRefObject<number>;
  autoAudioModeSkipLogAtRef: MutableRefObject<number>;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  ttsLoading: boolean;
  autoInputErrorLogThrottleMs: number;
  autoAudioModeSkipLogThrottleMs: number;
  setAutoInputName: (value: string) => void;
  setAutoAirPodsInput: (value: boolean) => void;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
};

export function useAudioInputRouteController(options: UseAudioInputRouteControllerOptions) {
  const {
    autoRecordingRef,
    autoAirPodsInputRef,
    autoInputNameRef,
    autoInputDetectErrorLogAtRef,
    autoAudioModeSkipLogAtRef,
    autoRecordingEnabledRef,
    ttsPlayingRef,
    replyLoadingRef,
    ttsLoading,
    autoInputErrorLogThrottleMs,
    autoAudioModeSkipLogThrottleMs,
    setAutoInputName,
    setAutoAirPodsInput,
    logAuto,
  } = options;

  const detectAutoAirPodsInput = useCallback(async (rec?: Audio.Recording | null) => {
    const target = rec || autoRecordingRef.current;
    if (!target) return autoAirPodsInputRef.current;
    try {
      const input = await target.getCurrentInput();
      const inputName = String(input?.name || "").trim();
      const isAirPods = isAirPodsInputName(inputName);
      const prevInputName = autoInputNameRef.current;
      const prevAirPods = autoAirPodsInputRef.current;
      if (prevInputName !== inputName || prevAirPods !== isAirPods) {
        logAuto("input_changed", {
          inputName,
          isAirPods,
          prevInputName,
          prevAirPods,
        });
      }
      setAutoInputName(inputName);
      setAutoAirPodsInput(isAirPods);
      autoInputNameRef.current = inputName;
      autoAirPodsInputRef.current = isAirPods;
      return isAirPods;
    } catch (err) {
      const now = Date.now();
      if (now - autoInputDetectErrorLogAtRef.current >= autoInputErrorLogThrottleMs) {
        autoInputDetectErrorLogAtRef.current = now;
        logAuto("input_detect_error", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      setAutoInputName("");
      setAutoAirPodsInput(false);
      autoInputNameRef.current = "";
      autoAirPodsInputRef.current = false;
      return false;
    }
  }, [
    autoAirPodsInputRef,
    autoInputDetectErrorLogAtRef,
    autoInputErrorLogThrottleMs,
    autoInputNameRef,
    autoRecordingRef,
    logAuto,
    setAutoAirPodsInput,
    setAutoInputName,
  ]);

  const setAudioModeForPlayback = useCallback(async (audioModeOptions?: AudioModeSwitchOptions) => {
    const force = Boolean(audioModeOptions?.force);
    const reason = String(audioModeOptions?.reason || "unspecified");
    const allowsRecordingIOS = audioModeOptions?.allowsRecordingIOS ?? false;
    if (!force && autoRecordingEnabledRef.current) {
      const now = Date.now();
      if (now - autoAudioModeSkipLogAtRef.current >= autoAudioModeSkipLogThrottleMs) {
        autoAudioModeSkipLogAtRef.current = now;
        logAuto("audio_mode_playback_skip", {
          reason,
          autoEnabled: autoRecordingEnabledRef.current,
          autoRecordingActive: Boolean(autoRecordingRef.current),
          ttsPlaying: ttsPlayingRef.current,
          ttsLoading,
          replyLoading: replyLoadingRef.current,
          requestedAllowsRecordingIOS: allowsRecordingIOS,
        });
      }
      return;
    }
    await Audio.setAudioModeAsync({
      allowsRecordingIOS,
      playsInSilentModeIOS: true,
      playThroughEarpieceAndroid: false,
      shouldDuckAndroid: true,
    });
  }, [
    autoAudioModeSkipLogAtRef,
    autoAudioModeSkipLogThrottleMs,
    autoRecordingEnabledRef,
    autoRecordingRef,
    logAuto,
    replyLoadingRef,
    ttsLoading,
    ttsPlayingRef,
  ]);

  return {
    detectAutoAirPodsInput,
    setAudioModeForPlayback,
  };
}
