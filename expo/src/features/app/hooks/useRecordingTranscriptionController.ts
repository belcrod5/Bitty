import { useCallback, useRef, type MutableRefObject } from "react";
import * as FileSystem from "expo-file-system/legacy";
import { transcribeWithConfiguredProvider } from "../../stt/sttService";
import {
  FORCED_STT_LANGUAGE,
  STT_REQUEST_TIMEOUT_MS,
  type SttProvider,
} from "../../stt/sttConfig";
import { sanitizeSttTranscript, shouldIgnoreSttTranscript } from "../../stt/sttTranscript";
import { toFiniteNumber } from "../utils/formatting";
import { isAbortError } from "../utils/statusText";

export type RecordingSttMessageMeta = {
  source: "recording_uri";
  sttProvider?: SttProvider;
  durationMs?: number;
  speechMs?: number;
  silenceTrimmedMs?: number;
  speechRatio?: number;
  mimeType?: string;
  payloadBytes?: number;
  segmentSeq?: number;
  sttRoundtripMs?: number;
  profile?: string;
};

type UseRecordingTranscriptionControllerOptions = {
  sttProvider: SttProvider;
  runnerUrl: string;
  runnerToken: string;
  recordingUri: string;
  nearUnlimitedTimeoutMs: number;
  sttLoadingRef: MutableRefObject<boolean>;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  autoReplyAfterSttRef: MutableRefObject<boolean>;
  autoSpeakAfterReplyRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  autoLastBargeInDetectedAtRef: MutableRefObject<number>;
  autoLastTtsStopRequestedAtRef: MutableRefObject<number>;
  autoLastTtsStoppedAtRef: MutableRefObject<number>;
  autoPendingUserMessageVisibleAtRef: MutableRefObject<number>;
  setSttLoading: (loading: boolean) => void;
  setTranscript: (text: string) => void;
  setErrorMessage: (message: string) => void;
  getBaseUrl: () => string;
  startAutoPendingUserMessage: () => void;
  resolveAutoPendingUserMessage: (
    finalTranscript: string,
    sttMeta?: RecordingSttMessageMeta
  ) => void;
  waitForReplyIdle: (timeoutMs?: number) => Promise<void>;
  sendReplyTranscript: (
    transcript: string,
    options?: { sttMeta?: RecordingSttMessageMeta }
  ) => Promise<void>;
  sendReplyRequest: (
    transcript: string,
    options?: { sttMeta?: RecordingSttMessageMeta }
  ) => Promise<void>;
  faceTrackingAllowsStt: (forceFresh?: boolean) => boolean;
  elapsedSinceMs: (startedAtMs: number) => number | null;
  logAuto: (event: string, payload?: Record<string, unknown>) => void;
  reportError: (raw: unknown, scope?: string) => void;
};

type TranscribeRecordedAudioOptions = {
  mimeType: string;
  fileName: string;
  source: "recording_uri";
  recordingUri?: string;
  audioBytes?: number;
  sourceReason?: string;
  hasUriOverride?: boolean;
  fileReadMs?: number;
  sttMeta?: Record<string, unknown>;
};

export function useRecordingTranscriptionController(options: UseRecordingTranscriptionControllerOptions) {
  const {
    sttProvider,
    runnerUrl,
    runnerToken,
    recordingUri,
    nearUnlimitedTimeoutMs,
    sttLoadingRef,
    autoRecordingEnabledRef,
    autoReplyAfterSttRef,
    autoSpeakAfterReplyRef,
    replyLoadingRef,
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    autoPendingUserMessageVisibleAtRef,
    setSttLoading,
    setTranscript,
    setErrorMessage,
    getBaseUrl,
    startAutoPendingUserMessage,
    resolveAutoPendingUserMessage,
    waitForReplyIdle,
    sendReplyTranscript,
    sendReplyRequest,
    faceTrackingAllowsStt,
    elapsedSinceMs,
    logAuto,
    reportError,
  } = options;

  const sttRequestSeqRef = useRef(0);
  const sttAbortControllerRef = useRef<AbortController | null>(null);
  const sttRequestTimeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTranscribeChainRef = useRef<Promise<void>>(Promise.resolve());

  const cleanupRecordingTranscription = useCallback(() => {
    if (sttRequestTimeoutTimerRef.current) {
      clearTimeout(sttRequestTimeoutTimerRef.current);
      sttRequestTimeoutTimerRef.current = null;
    }
    const sttAbortController = sttAbortControllerRef.current;
    if (sttAbortController) {
      sttAbortController.abort();
      sttAbortControllerRef.current = null;
    }
  }, []);

  const waitForSttIdle = useCallback(async (timeoutMs = nearUnlimitedTimeoutMs) => {
    const startedAt = Date.now();
    while (sttLoadingRef.current) {
      if (Date.now() - startedAt > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return true;
  }, [nearUnlimitedTimeoutMs, sttLoadingRef]);

  const transcribeRecordedAudio = useCallback(async (transcribeOptions: TranscribeRecordedAudioOptions) => {
    const activeSttProvider: SttProvider = (
      sttProvider === "ios_native_runner" ? "runner" : sttProvider
    );
    if (sttLoadingRef.current) return;
    if (activeSttProvider === "ios_native_direct") return;
    if (activeSttProvider === "runner" && !String(transcribeOptions.recordingUri || "").trim()) return;
    if (activeSttProvider === "ios_native" && !String(transcribeOptions.recordingUri || "").trim()) return;
    const sttStartedAt = Date.now();
    const sttRequestId = sttRequestSeqRef.current + 1;
    sttRequestSeqRef.current = sttRequestId;
    const shouldShowPendingUserMessage = (
      autoRecordingEnabledRef.current &&
      autoReplyAfterSttRef.current
    );
    if (shouldShowPendingUserMessage) {
      startAutoPendingUserMessage();
    }
    const abortController = new AbortController();
    sttAbortControllerRef.current = abortController;
    if (sttRequestTimeoutTimerRef.current) {
      clearTimeout(sttRequestTimeoutTimerRef.current);
      sttRequestTimeoutTimerRef.current = null;
    }
    let timeoutFired = false;
    sttRequestTimeoutTimerRef.current = setTimeout(() => {
      timeoutFired = true;
      abortController.abort();
      logAuto("stt_request_timeout", {
        requestId: sttRequestId,
        timeoutMs: STT_REQUEST_TIMEOUT_MS,
        elapsedMs: Math.max(0, Date.now() - sttStartedAt),
        source: transcribeOptions.source,
      });
    }, STT_REQUEST_TIMEOUT_MS);
    logAuto("stt_request_start", {
      requestId: sttRequestId,
      timeoutMs: STT_REQUEST_TIMEOUT_MS,
      source: transcribeOptions.source,
      sourceReason: transcribeOptions.sourceReason || "",
      hasUriOverride: Boolean(transcribeOptions.hasUriOverride),
      audioBytes: Number.isFinite(Number(transcribeOptions.audioBytes))
        ? Number(transcribeOptions.audioBytes)
        : undefined,
      mimeType: transcribeOptions.mimeType,
      fileName: transcribeOptions.fileName,
      sttProvider: activeSttProvider,
      sttProviderRequested: sttProvider,
      autoMode: autoRecordingEnabledRef.current,
      autoReplyAfterStt: autoReplyAfterSttRef.current,
      pendingUserMessage: shouldShowPendingUserMessage,
      sinceBargeInDetectedMs: elapsedSinceMs(autoLastBargeInDetectedAtRef.current),
      sinceTtsStopRequestedMs: elapsedSinceMs(autoLastTtsStopRequestedAtRef.current),
      sinceTtsStoppedMs: elapsedSinceMs(autoLastTtsStoppedAtRef.current),
      sincePendingUserVisibleMs: elapsedSinceMs(autoPendingUserMessageVisibleAtRef.current),
      ...(transcribeOptions.sttMeta || {}),
    });
    sttLoadingRef.current = true;
    setSttLoading(true);
    setErrorMessage("");

    const fileReadMs = Math.max(0, Number(transcribeOptions.fileReadMs || 0));
    try {
      console.log("[stt] start", {
        sttProvider: activeSttProvider,
        sttProviderRequested: sttProvider,
        runnerUrl: activeSttProvider === "runner" ? `${getBaseUrl()}/stt` : undefined,
        source: transcribeOptions.source,
        mimeType: transcribeOptions.mimeType,
      });
      const rawTranscript = await transcribeWithConfiguredProvider({
        provider: activeSttProvider,
        recordingUri: transcribeOptions.recordingUri,
        language: FORCED_STT_LANGUAGE,
        timeoutMs: STT_REQUEST_TIMEOUT_MS,
        signal: abortController.signal,
        mimeType: transcribeOptions.mimeType,
        fileName: transcribeOptions.fileName,
        baseUrl: getBaseUrl(),
        runnerToken,
        sttMeta: transcribeOptions.sttMeta,
      });
      console.log("[stt] success", {
        source: transcribeOptions.source,
        sttProvider: activeSttProvider,
        sttProviderRequested: sttProvider,
        transcript: rawTranscript,
      });
      const nextTranscript = sanitizeSttTranscript(rawTranscript);
      const elapsedMs = Math.max(0, Date.now() - sttStartedAt);
      const rawSttMeta = transcribeOptions.sttMeta || {};
      const segmentSeqRaw = toFiniteNumber(rawSttMeta.segmentSeq);
      const optionAudioBytes = Number(transcribeOptions.audioBytes);
      const sttMessageMeta: RecordingSttMessageMeta = {
        source: transcribeOptions.source,
        sttProvider: activeSttProvider,
        mimeType: String(transcribeOptions.mimeType || "").trim() || undefined,
        payloadBytes: (
          Number.isFinite(optionAudioBytes) && optionAudioBytes > 0
            ? optionAudioBytes
            : toFiniteNumber(rawSttMeta.payloadBytes)
        ),
        sttRoundtripMs: elapsedMs,
        durationMs: toFiniteNumber(rawSttMeta.durationMs),
        speechMs: toFiniteNumber(rawSttMeta.speechMs),
        silenceTrimmedMs: toFiniteNumber(rawSttMeta.silenceTrimmedMs),
        speechRatio: toFiniteNumber(rawSttMeta.speechRatio),
        segmentSeq: Number.isFinite(segmentSeqRaw) ? Math.max(0, Math.floor(Number(segmentSeqRaw))) : undefined,
        profile: String(rawSttMeta.profile || "").trim() || undefined,
      };
      logAuto("stt_request_done", {
        requestId: sttRequestId,
        elapsedMs,
        fileReadMs,
        source: transcribeOptions.source,
        sourceReason: transcribeOptions.sourceReason || "",
        sttProvider: activeSttProvider,
        sttProviderRequested: sttProvider,
        transcriptChars: nextTranscript.length,
        rawTranscriptChars: rawTranscript.length,
        ...(transcribeOptions.sttMeta || {}),
      });
      if (shouldIgnoreSttTranscript(rawTranscript)) {
        console.log("[stt] ignored known false-positive transcript", {
          transcript: rawTranscript,
          sanitizedTranscript: nextTranscript,
        });
        logAuto("stt_request_ignored", {
          requestId: sttRequestId,
          reason: "known_false_positive",
          elapsedMs,
          source: transcribeOptions.source,
          sttProvider: activeSttProvider,
          rawTranscriptChars: rawTranscript.length,
          transcriptChars: nextTranscript.length,
        });
        resolveAutoPendingUserMessage("", sttMessageMeta);
        return;
      }
      const shouldAutoReply = autoReplyAfterSttRef.current && !!nextTranscript.trim();
      if (!shouldAutoReply) {
        setTranscript(nextTranscript);
        resolveAutoPendingUserMessage(nextTranscript, sttMessageMeta);
        return;
      }
      if (!runnerUrl.trim() || !runnerToken.trim()) {
        setTranscript(nextTranscript);
        resolveAutoPendingUserMessage(nextTranscript, sttMessageMeta);
        return;
      }
      setTranscript("");
      if (replyLoadingRef.current) {
        await waitForReplyIdle().catch(() => {});
      }
      if (replyLoadingRef.current) {
        console.log("[stt] auto-reply skipped: reply is still busy");
        logAuto("auto_reply_dispatch_skip_busy", {
          elapsedMs,
          source: transcribeOptions.source,
          sttProvider: activeSttProvider,
          transcriptChars: nextTranscript.length,
        });
        setTranscript(nextTranscript);
        resolveAutoPendingUserMessage(nextTranscript, sttMessageMeta);
      } else if (autoSpeakAfterReplyRef.current) {
        logAuto("auto_reply_dispatch", {
          mode: "reply_transcript_auto_tts",
          source: transcribeOptions.source,
          elapsedMs,
          sttProvider: activeSttProvider,
          transcriptChars: nextTranscript.length,
        });
        await sendReplyTranscript(nextTranscript, { sttMeta: sttMessageMeta });
      } else {
        logAuto("auto_reply_dispatch", {
          mode: "reply",
          source: transcribeOptions.source,
          elapsedMs,
          sttProvider: activeSttProvider,
          transcriptChars: nextTranscript.length,
        });
        await sendReplyRequest(nextTranscript, { sttMeta: sttMessageMeta });
      }
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - sttStartedAt);
      const wasAbort = isAbortError(error);
      const message = timeoutFired
        ? `stt request timeout (${STT_REQUEST_TIMEOUT_MS}ms)`
        : (error instanceof Error ? error.message : String(error));
      if (wasAbort && !timeoutFired) {
        logAuto("stt_request_cancelled", {
          requestId: sttRequestId,
          elapsedMs,
          fileReadMs,
          source: transcribeOptions.source,
          sttProvider: activeSttProvider,
        });
        resolveAutoPendingUserMessage("");
        return;
      }
      console.error("[stt] error", error);
      logAuto("stt_request_error", {
        requestId: sttRequestId,
        elapsedMs,
        fileReadMs,
        timeout: timeoutFired,
        source: transcribeOptions.source,
        sttProvider: activeSttProvider,
        sttProviderRequested: sttProvider,
        message,
      });
      resolveAutoPendingUserMessage("");
      reportError(message, "stt");
    } finally {
      if (sttRequestTimeoutTimerRef.current) {
        clearTimeout(sttRequestTimeoutTimerRef.current);
        sttRequestTimeoutTimerRef.current = null;
      }
      if (sttAbortControllerRef.current === abortController) {
        sttAbortControllerRef.current = null;
      }
      sttLoadingRef.current = false;
      setSttLoading(false);
    }
  }, [
    autoLastBargeInDetectedAtRef,
    autoLastTtsStopRequestedAtRef,
    autoLastTtsStoppedAtRef,
    autoPendingUserMessageVisibleAtRef,
    autoRecordingEnabledRef,
    autoReplyAfterSttRef,
    autoSpeakAfterReplyRef,
    elapsedSinceMs,
    getBaseUrl,
    logAuto,
    replyLoadingRef,
    reportError,
    resolveAutoPendingUserMessage,
    runnerToken,
    runnerUrl,
    sendReplyRequest,
    sendReplyTranscript,
    setErrorMessage,
    setSttLoading,
    setTranscript,
    startAutoPendingUserMessage,
    sttLoadingRef,
    sttProvider,
    waitForReplyIdle,
  ]);

  const transcribeRecording = useCallback(async (uriOverride?: string) => {
    const uri = uriOverride || recordingUri;
    if (!uri) return;
    try {
      const fileInfo = await FileSystem.getInfoAsync(uri).catch(() => null);
      const audioBytes = (
        fileInfo && "exists" in fileInfo && fileInfo.exists
          ? toFiniteNumber((fileInfo as { size?: unknown }).size)
          : undefined
      );
      const activeSttProvider: SttProvider = (
        sttProvider === "ios_native_runner" ? "runner" : sttProvider
      );
      if (activeSttProvider === "ios_native_direct") {
        reportError("ios_native_direct は録音ファイル文字起こしに対応していません。", "stt:direct");
        return;
      }
      if (activeSttProvider === "ios_native") {
        await transcribeRecordedAudio({
          recordingUri: uri,
          audioBytes,
          mimeType: "audio/m4a",
          fileName: "recording.m4a",
          source: "recording_uri",
          sourceReason: "recording_uri",
          hasUriOverride: Boolean(uriOverride),
          fileReadMs: 0,
        });
        return;
      }
      await transcribeRecordedAudio({
        recordingUri: uri,
        audioBytes,
        mimeType: "audio/m4a",
        fileName: "recording.m4a",
        source: "recording_uri",
        sourceReason: "recording_uri",
        hasUriOverride: Boolean(uriOverride),
        fileReadMs: 0,
      });
    } catch (error) {
      reportError(error, "stt:read");
    }
  }, [recordingUri, reportError, sttProvider, transcribeRecordedAudio]);

  const enqueueAutoTranscribe = useCallback((uri: string, sourceReason: string) => {
    const safeUri = String(uri || "").trim();
    if (!safeUri) return;
    const enqueuedAt = Date.now();
    logAuto("auto_transcribe_enqueued", {
      sourceReason,
    });
    autoTranscribeChainRef.current = autoTranscribeChainRef.current
      .catch(() => {})
      .then(async () => {
        const queueWaitMs = Math.max(0, Date.now() - enqueuedAt);
        if (!faceTrackingAllowsStt(true)) {
          logAuto("auto_transcribe_skip_face_not_looking", {
            sourceReason,
            queueWaitMs,
          });
          return;
        }
        logAuto("auto_transcribe_start", {
          sourceReason,
          queueWaitMs,
        });
        const sttIdle = await waitForSttIdle();
        if (!sttIdle) {
          logAuto("auto_transcribe_skip_busy", {
            sourceReason,
            queueWaitMs,
          });
          return;
        }
        await transcribeRecording(safeUri);
        logAuto("auto_transcribe_done", {
          sourceReason,
          elapsedMs: Math.max(0, Date.now() - enqueuedAt),
        });
      })
      .catch((error) => {
        logAuto("auto_transcribe_error", {
          sourceReason,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [faceTrackingAllowsStt, logAuto, transcribeRecording, waitForSttIdle]);

  return {
    transcribeRecording,
    enqueueAutoTranscribe,
    cleanupRecordingTranscription,
  };
}
