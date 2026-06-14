import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { type SttProvider } from "../../stt/sttConfig";
import { sanitizeSttTranscript, shouldIgnoreSttTranscript } from "../../stt/sttTranscript";
import { startIosNativeDirectSttSession } from "../../stt/iosNativeSttClient";
import { isAbortError } from "../utils/statusText";
import {
  isAudioSessionInterruptedError,
  isBackgroundAudioSessionError,
} from "../utils/audioSession";

type DirectNativeSttMeta = {
  source: "native_direct";
  sttProvider?: SttProvider;
  sttRoundtripMs?: number;
};

type UseDirectNativeSttControllerOptions = {
  sttProvider: SttProvider;
  sttProviderRef: MutableRefObject<SttProvider>;
  manualRecordingActive: boolean;
  audioLabRunning: boolean;
  audioLabRecordingActive: boolean;
  audioLabPlaybackActive: boolean;
  faceTrackingEnabled: boolean;
  faceTrackingLooking: boolean;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  appStateRef: MutableRefObject<string>;
  autoReplyAfterSttRef: MutableRefObject<boolean>;
  autoSpeakAfterReplyRef: MutableRefObject<boolean>;
  autoBargeInEnabledRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  ttsPlaybackMessageIdRef: MutableRefObject<string>;
  sttLoadingRef: MutableRefObject<boolean>;
  ttsLoading: boolean;
  runnerUrl: string;
  runnerToken: string;
  ensureMicReady: () => Promise<void>;
  faceTrackingAllowsStt: (forceFresh?: boolean) => boolean;
  stopAutoRecordingMode: () => Promise<void>;
  stopTtsPlayback: (options?: { interruptStream?: boolean }) => Promise<void>;
  waitForReplyIdle: () => Promise<void>;
  sendReplyTranscript: (
    transcript: string,
    options?: { sttMeta?: DirectNativeSttMeta }
  ) => Promise<void>;
  sendReplyRequest: (
    transcript: string,
    options?: { sttMeta?: DirectNativeSttMeta }
  ) => Promise<void>;
  setTranscript: (text: string) => void;
  setErrorMessage: (message: string) => void;
  setSttLoading: (loading: boolean) => void;
  setAudioModeForPlayback: (options?: { force?: boolean; reason?: string; allowsRecordingIOS?: boolean }) => Promise<void>;
  playUiSfx: (key: "recordStart" | "recordStop") => void;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  reportError: (raw: unknown, scope?: string) => void;
};

const FORCED_STT_LANGUAGE = "ja-JP";
const DIRECT_NATIVE_STT_TIMEOUT_MS = 25000;

export function useDirectNativeSttController(options: UseDirectNativeSttControllerOptions) {
  const {
    sttProvider,
    sttProviderRef,
    manualRecordingActive,
    audioLabRunning,
    audioLabRecordingActive,
    audioLabPlaybackActive,
    faceTrackingEnabled,
    faceTrackingLooking,
    autoRecordingEnabledRef,
    appStateRef,
    autoReplyAfterSttRef,
    autoSpeakAfterReplyRef,
    autoBargeInEnabledRef,
    replyLoadingRef,
    ttsPlayingRef,
    streamSocketRef,
    ttsPlaybackMessageIdRef,
    sttLoadingRef,
    ttsLoading,
    runnerUrl,
    runnerToken,
    ensureMicReady,
    faceTrackingAllowsStt,
    stopAutoRecordingMode,
    stopTtsPlayback,
    waitForReplyIdle,
    sendReplyTranscript,
    sendReplyRequest,
    setTranscript,
    setErrorMessage,
    setSttLoading,
    setAudioModeForPlayback,
    playUiSfx,
    logAuto,
    reportError,
  } = options;

  const [directNativeSttEnabled, setDirectNativeSttEnabled] = useState(false);
  const [directNativeSttActive, setDirectNativeSttActive] = useState(false);
  const [directNativeSttInterimText, setDirectNativeSttInterimText] = useState("");

  const directNativeSttEnabledRef = useRef(false);
  const directNativeSttSessionRef = useRef<{
    stop: () => void;
    abort: () => void;
    done: Promise<string>;
  } | null>(null);
  const directNativeSttAbortControllerRef = useRef<AbortController | null>(null);
  const directNativeSttLatestTranscriptRef = useRef("");

  const setDirectNativeSttEnabledWithRef = useCallback((enabled: boolean) => {
    directNativeSttEnabledRef.current = enabled;
    setDirectNativeSttEnabled(enabled);
  }, []);

  const cleanupDirectNativeStt = useCallback(() => {
    directNativeSttEnabledRef.current = false;
    const session = directNativeSttSessionRef.current;
    if (session) {
      session.abort();
      directNativeSttSessionRef.current = null;
    }
    const abortController = directNativeSttAbortControllerRef.current;
    if (abortController) {
      abortController.abort();
      directNativeSttAbortControllerRef.current = null;
    }
    setDirectNativeSttEnabled(false);
    setDirectNativeSttActive(false);
    setDirectNativeSttInterimText("");
    setSttLoading(false);
    sttLoadingRef.current = false;
  }, [setSttLoading, sttLoadingRef]);

  const finalizeDirectNativeStt = useCallback(async (rawTranscript: string, elapsedMs: number) => {
    if (!faceTrackingAllowsStt(true)) {
      setDirectNativeSttInterimText("");
      setTranscript("");
      return;
    }
    const nextTranscript = sanitizeSttTranscript(rawTranscript);
    setDirectNativeSttInterimText(nextTranscript);
    if (shouldIgnoreSttTranscript(rawTranscript)) {
      return;
    }
    if (!nextTranscript.trim()) {
      return;
    }
    const sttMessageMeta: DirectNativeSttMeta = {
      source: "native_direct",
      sttProvider: sttProviderRef.current,
      sttRoundtripMs: elapsedMs,
    };
    if (!autoReplyAfterSttRef.current) {
      setTranscript(nextTranscript);
      return;
    }
    if (!runnerUrl.trim() || !runnerToken.trim()) {
      setTranscript(nextTranscript);
      return;
    }
    const shouldInterruptForBargeIn = (
      autoBargeInEnabledRef.current &&
      (
        ttsPlayingRef.current ||
        ttsLoading ||
        replyLoadingRef.current ||
        streamSocketRef.current !== null ||
        ttsPlaybackMessageIdRef.current === "__stream__"
      )
    );
    if (shouldInterruptForBargeIn) {
      await stopTtsPlayback({ interruptStream: true }).catch(() => {});
    }
    setTranscript("");
    if (replyLoadingRef.current) {
      await waitForReplyIdle().catch(() => {});
    }
    if (replyLoadingRef.current) {
      setTranscript(nextTranscript);
      return;
    }
    if (autoSpeakAfterReplyRef.current) {
      await sendReplyTranscript(nextTranscript, { sttMeta: sttMessageMeta });
      return;
    }
    await sendReplyRequest(nextTranscript, { sttMeta: sttMessageMeta });
  }, [
    autoBargeInEnabledRef,
    autoReplyAfterSttRef,
    autoSpeakAfterReplyRef,
    replyLoadingRef,
    runnerToken,
    runnerUrl,
    sendReplyRequest,
    sendReplyTranscript,
    setTranscript,
    stopTtsPlayback,
    streamSocketRef,
    faceTrackingAllowsStt,
    sttProviderRef,
    ttsLoading,
    ttsPlaybackMessageIdRef,
    ttsPlayingRef,
    waitForReplyIdle,
  ]);

  const runDirectNativeSttLoop = useCallback(async () => {
    while (directNativeSttEnabledRef.current && sttProviderRef.current === "ios_native_direct") {
      if (!faceTrackingAllowsStt()) {
        directNativeSttLatestTranscriptRef.current = "";
        setDirectNativeSttInterimText("");
        setTranscript("");
        setDirectNativeSttActive(false);
        sttLoadingRef.current = false;
        setSttLoading(false);
        await new Promise((resolve) => setTimeout(resolve, 180));
        continue;
      }
      const startedAt = Date.now();
      const abortController = new AbortController();
      directNativeSttAbortControllerRef.current = abortController;
      directNativeSttLatestTranscriptRef.current = "";
      setDirectNativeSttInterimText("");
      setTranscript("");
      setErrorMessage("");
      setDirectNativeSttActive(true);
      sttLoadingRef.current = true;
      setSttLoading(true);

      try {
        let interruptRequested = false;
        await ensureMicReady();
        if (!directNativeSttEnabledRef.current || sttProviderRef.current !== "ios_native_direct") {
          break;
        }
        const session = await startIosNativeDirectSttSession({
          language: FORCED_STT_LANGUAGE,
          timeoutMs: DIRECT_NATIVE_STT_TIMEOUT_MS,
          signal: abortController.signal,
          onInterimTranscript: (text) => {
            if (!faceTrackingAllowsStt()) return;
            const next = sanitizeSttTranscript(text);
            directNativeSttLatestTranscriptRef.current = next;
            setDirectNativeSttInterimText(next);
            setTranscript(next);
            if (
              !interruptRequested &&
              next &&
              autoBargeInEnabledRef.current &&
              (
                ttsPlayingRef.current ||
                ttsLoading ||
                replyLoadingRef.current ||
                streamSocketRef.current !== null ||
                ttsPlaybackMessageIdRef.current === "__stream__"
              )
            ) {
              interruptRequested = true;
              void stopTtsPlayback({ interruptStream: true }).catch(() => {});
            }
          },
          onFinalTranscript: (text) => {
            if (!faceTrackingAllowsStt()) return;
            const next = sanitizeSttTranscript(text);
            directNativeSttLatestTranscriptRef.current = next;
            setDirectNativeSttInterimText(next);
            setTranscript(next);
          },
        });
        directNativeSttSessionRef.current = session;
        if (!directNativeSttEnabledRef.current || sttProviderRef.current !== "ios_native_direct") {
          session.abort();
        }
        const doneTranscript = await session.done;
        if (directNativeSttSessionRef.current === session) {
          directNativeSttSessionRef.current = null;
        }
        const mergedTranscript = String(
          doneTranscript || directNativeSttLatestTranscriptRef.current || ""
        ).trim();
        await finalizeDirectNativeStt(mergedTranscript, Math.max(0, Date.now() - startedAt));
      } catch (error) {
        const isAbort = isAbortError(error);
        const isBackground = isBackgroundAudioSessionError(error);
        const isInterrupted = isAudioSessionInterruptedError(error);
        const recoverable = isAbort || isBackground || isInterrupted;
        const partialTranscript = sanitizeSttTranscript(directNativeSttLatestTranscriptRef.current || "");

        if (recoverable) {
          if (
            !isAbort &&
            partialTranscript &&
            directNativeSttEnabledRef.current &&
            sttProviderRef.current === "ios_native_direct"
          ) {
            await finalizeDirectNativeStt(
              partialTranscript,
              Math.max(0, Date.now() - startedAt)
            ).catch(() => {});
          }
          if (isBackground || isInterrupted) {
            const message = error instanceof Error ? error.message : String(error);
            logAuto("direct_stt_recoverable_error", {
              message,
              recoverableType: isBackground ? "background_audio" : "audio_session_interrupted",
              partialTranscriptChars: partialTranscript.length,
            });
          }
        } else {
          reportError(error, "stt:direct");
          setDirectNativeSttEnabledWithRef(false);
        }
      } finally {
        if (directNativeSttAbortControllerRef.current === abortController) {
          directNativeSttAbortControllerRef.current = null;
        }
        directNativeSttSessionRef.current = null;
        setDirectNativeSttActive(false);
        sttLoadingRef.current = false;
        setSttLoading(false);
        await setAudioModeForPlayback({ reason: "stop_direct_native_stt" }).catch(() => {});
      }

      if (!directNativeSttEnabledRef.current || sttProviderRef.current !== "ios_native_direct") {
        break;
      }
      const shouldBackoff = appStateRef.current !== "active";
      await new Promise((resolve) => setTimeout(resolve, shouldBackoff ? 900 : 120));
    }
  }, [
    appStateRef,
    autoBargeInEnabledRef,
    ensureMicReady,
    faceTrackingAllowsStt,
    finalizeDirectNativeStt,
    logAuto,
    reportError,
    replyLoadingRef,
    setAudioModeForPlayback,
    setErrorMessage,
    setSttLoading,
    setTranscript,
    stopTtsPlayback,
    streamSocketRef,
    sttLoadingRef,
    sttProviderRef,
    ttsLoading,
    ttsPlaybackMessageIdRef,
    ttsPlayingRef,
  ]);

  const startDirectNativeStt = useCallback(async () => {
    if (sttProvider !== "ios_native_direct") return;
    if (directNativeSttEnabledRef.current) return;
    if (audioLabRecordingActive || audioLabPlaybackActive || audioLabRunning) {
      reportError("Audio Lab実行中はDirect STTを開始できません。", "stt:direct:start");
      return;
    }
    if (manualRecordingActive) {
      reportError("手動録音を停止してからDirect STTを開始してください。", "stt:direct:start");
      return;
    }
    if (autoRecordingEnabledRef.current) {
      await stopAutoRecordingMode().catch(() => {});
    }
    setErrorMessage("");
    setDirectNativeSttEnabledWithRef(true);
    playUiSfx("recordStart");
    void runDirectNativeSttLoop();
  }, [
    audioLabPlaybackActive,
    audioLabRecordingActive,
    audioLabRunning,
    autoRecordingEnabledRef,
    manualRecordingActive,
    playUiSfx,
    reportError,
    runDirectNativeSttLoop,
    setErrorMessage,
    setDirectNativeSttEnabledWithRef,
    stopAutoRecordingMode,
    sttProvider,
  ]);

  const stopDirectNativeStt = useCallback(async () => {
    const wasEnabled = directNativeSttEnabledRef.current;
    setDirectNativeSttEnabledWithRef(false);
    setDirectNativeSttActive(false);
    const session = directNativeSttSessionRef.current;
    if (session) {
      session.stop();
      try {
        await session.done;
      } catch {}
    } else {
      const abortController = directNativeSttAbortControllerRef.current;
      if (abortController) {
        abortController.abort();
      }
    }
    sttLoadingRef.current = false;
    setSttLoading(false);
    void setAudioModeForPlayback({ reason: "stop_direct_native_stt_manual" }).catch(() => {});
    if (wasEnabled) {
      playUiSfx("recordStop");
    }
  }, [playUiSfx, setAudioModeForPlayback, setDirectNativeSttEnabledWithRef, setSttLoading, sttLoadingRef]);

  useEffect(() => {
    if (sttProvider === "ios_native_direct") return;
    const session = directNativeSttSessionRef.current;
    const wasEnabled = directNativeSttEnabledRef.current;
    setDirectNativeSttEnabledWithRef(false);
    if (session) {
      session.abort();
      directNativeSttSessionRef.current = null;
    }
    const abortController = directNativeSttAbortControllerRef.current;
    if (abortController) {
      abortController.abort();
      directNativeSttAbortControllerRef.current = null;
    }
    setDirectNativeSttActive(false);
    setDirectNativeSttInterimText("");
    sttLoadingRef.current = false;
    setSttLoading(false);
    if (wasEnabled) {
      playUiSfx("recordStop");
    }
  }, [playUiSfx, setDirectNativeSttEnabledWithRef, setSttLoading, sttLoadingRef, sttProvider]);

  useEffect(() => {
    if (!faceTrackingEnabled || faceTrackingLooking) return;
    if (sttProviderRef.current !== "ios_native_direct" || !directNativeSttEnabledRef.current) return;
    directNativeSttLatestTranscriptRef.current = "";
    setDirectNativeSttInterimText("");
    setTranscript("");
    const session = directNativeSttSessionRef.current;
    if (session) {
      session.abort();
      return;
    }
    const abortController = directNativeSttAbortControllerRef.current;
    if (abortController) {
      abortController.abort();
    }
  }, [faceTrackingEnabled, faceTrackingLooking, setTranscript, sttProviderRef]);

  return {
    directNativeSttEnabled,
    directNativeSttActive,
    directNativeSttInterimText,
    startDirectNativeStt,
    stopDirectNativeStt,
    cleanupDirectNativeStt,
  };
}
