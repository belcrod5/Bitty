import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useStreamingSttTransport } from "./useStreamingSttTransport";
import type { StreamingSttSession } from "./streamingSttTransport";
import {
  applyStreamingTranscript,
  displayStreamingTranscript,
  finalStreamingTranscript,
  startStreamingTranscript,
  type StreamingTranscript,
} from "./streamingTranscript";
import { parseStreamingSttMessage, type StreamingSttUsage } from "./streamingSttClient";
import { correctSttTranscript, type SttCorrectionContext } from "./sttSettingsClient";
import { diffSttTranscript, type SttCorrectionPreview } from "./sttTranscriptDiff";

export type StreamingSttPhase = "idle" | "connecting" | "recording" | "finalizing" | "correcting" | "preview";

type Options = {
  runnerUrl: string;
  runnerToken: string;
  transcript: string;
  autoReplyAfterStt: boolean;
  correctionContext: SttCorrectionContext[];
  correctionIdentity: string;
  setTranscript: (text: string) => void;
  sendTranscript: (text: string, onAccepted: () => void) => Promise<void>;
  onUsage: (usage: StreamingSttUsage) => void;
  onSample: (rms: number) => void;
  onError: (message: string) => void;
  onDiagnostic?: (event: string, payload: Record<string, unknown>) => void;
  canStart?: boolean;
  onSpeechBegin: () => void;
  replyLoading: boolean;
  ttsPlaybackActive: boolean;
  voiceInputDuringTtsAllowed: boolean;
};

const EMPTY_TRANSCRIPT = startStreamingTranscript("");
export const REPLY_CYCLE_START_TIMEOUT_MS = 15_000;
export const TTS_START_GRACE_MS = 500;
const RETRY_DELAY_MS = 250;

export function useStreamingStt(options: Options) {
  const { transcript, setTranscript, onError } = options;
  const [phase, setPhase] = useState<StreamingSttPhase>("idle");
  const sessionRef = useRef<StreamingSttSession | null>(null);
  const pendingAbortRef = useRef<Promise<void>>(Promise.resolve());
  const sessionVersionRef = useRef(0);
  const transcriptStateRef = useRef<StreamingTranscript>(EMPTY_TRANSCRIPT);
  const lastPartialCharsRef = useRef(0);
  const terminalRef = useRef(false);
  const listeningRef = useRef(false);
  const startSessionRef = useRef<() => void>(() => {});
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitingReplyCycleRef = useRef(false);
  const sawReplyLoadingRef = useRef(false);
  const sawTtsPlaybackRef = useRef(false);
  const replyCycleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const correctionAbortRef = useRef<AbortController | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRef = useRef<(SttCorrectionPreview & { version: number; sent: boolean }) | null>(null);
  const autoSendingRef = useRef<number | null>(null);
  const [correctionPreview, setCorrectionPreview] = useState<SttCorrectionPreview | null>(null);
  const identityRef = useRef(options.correctionIdentity);
  const transport = useStreamingSttTransport();
  const latestRef = useRef(options);
  latestRef.current = options;

  const clearTimer = (timerRef: typeof retryTimerRef) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const clearReplyCycleWait = useCallback(() => {
    awaitingReplyCycleRef.current = false;
    sawReplyLoadingRef.current = false;
    sawTtsPlaybackRef.current = false;
    clearTimer(replyCycleTimeoutRef);
    clearTimer(ttsStartTimerRef);
  }, []);

  const clearCorrection = useCallback(() => {
    correctionAbortRef.current?.abort();
    correctionAbortRef.current = null;
    clearTimer(previewTimerRef);
    previewRef.current = null;
    setCorrectionPreview(null);
  }, []);

  const settleReplyCycle = useCallback(() => {
    clearReplyCycleWait();
    if (listeningRef.current) startSessionRef.current();
    else setPhase("idle");
  }, [clearReplyCycleWait]);

  const awaitReplyCycle = useCallback(() => {
    listeningRef.current = true;
    awaitingReplyCycleRef.current = true;
    sawReplyLoadingRef.current = latestRef.current.replyLoading;
    sawTtsPlaybackRef.current = latestRef.current.ttsPlaybackActive;
    setPhase("connecting");
    clearTimer(replyCycleTimeoutRef);
    replyCycleTimeoutRef.current = setTimeout(() => {
      if (!awaitingReplyCycleRef.current || sawReplyLoadingRef.current) return;
      listeningRef.current = false;
      clearReplyCycleWait();
      setPhase("idle");
    }, REPLY_CYCLE_START_TIMEOUT_MS);
  }, [clearReplyCycleWait]);

  const updateReplyCycle = useCallback(() => {
    if (!awaitingReplyCycleRef.current) return;
    const { replyLoading, ttsPlaybackActive, voiceInputDuringTtsAllowed } = latestRef.current;
    if (replyLoading) {
      sawReplyLoadingRef.current = true;
      clearTimer(replyCycleTimeoutRef);
      clearTimer(ttsStartTimerRef);
      return;
    }
    if (!sawReplyLoadingRef.current) return;
    if (ttsPlaybackActive) {
      sawTtsPlaybackRef.current = true;
      clearTimer(ttsStartTimerRef);
      if (!voiceInputDuringTtsAllowed) return;
      settleReplyCycle();
      return;
    }
    if (sawTtsPlaybackRef.current) {
      settleReplyCycle();
      return;
    }
    if (ttsStartTimerRef.current) return;
    ttsStartTimerRef.current = setTimeout(() => {
      ttsStartTimerRef.current = null;
      if (!awaitingReplyCycleRef.current || latestRef.current.replyLoading
        || latestRef.current.ttsPlaybackActive) return;
      settleReplyCycle();
    }, TTS_START_GRACE_MS);
  }, [settleReplyCycle]);

  const abortSession = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      pendingAbortRef.current = pendingAbortRef.current.then(() => session.abort()).catch(() => undefined);
    }
    return pendingAbortRef.current;
  }, []);

  const finishFailure = useCallback((message: string, draft?: string) => {
    sessionVersionRef.current += 1;
    terminalRef.current = true;
    listeningRef.current = false;
    clearReplyCycleWait();
    clearCorrection();
    clearTimer(retryTimerRef);
    void abortSession();
    setTranscript(draft ?? finalStreamingTranscript(transcriptStateRef.current));
    setPhase("idle");
    onError(message);
  }, [abortSession, clearCorrection, clearReplyCycleWait, onError, setTranscript]);

  const sendAutoTranscript = useCallback(async (text: string, version: number) => {
    if (version !== sessionVersionRef.current) return;
    autoSendingRef.current = version;
    latestRef.current.onDiagnostic?.("stt_auto_send_dispatch", { version, chars: text.length,
      listening: listeningRef.current });
    if (listeningRef.current) awaitReplyCycle();
    try {
      await latestRef.current.sendTranscript(text, () => {
        latestRef.current.onDiagnostic?.("stt_auto_send_accepted", {
          version, current: version === sessionVersionRef.current,
        });
        if (version !== sessionVersionRef.current) return;
        latestRef.current.setTranscript("");
        transcriptStateRef.current = startStreamingTranscript("");
        clearTimer(replyCycleTimeoutRef);
      });
      if (version === sessionVersionRef.current && awaitingReplyCycleRef.current) {
        sawReplyLoadingRef.current = true;
        updateReplyCycle();
      }
    } catch {
      latestRef.current.onDiagnostic?.("stt_auto_send_failed", {
        version, current: version === sessionVersionRef.current,
      });
      if (version === sessionVersionRef.current) finishFailure("文字起こし結果を送信できませんでした。", text);
    } finally {
      if (autoSendingRef.current === version) autoSendingRef.current = null;
    }
  }, [awaitReplyCycle, finishFailure, updateReplyCycle]);

  const sendCorrectionPreview = useCallback(() => {
    const preview = previewRef.current;
    if (!preview || preview.sent || preview.version !== sessionVersionRef.current
      || !preview.text.trim()) return;
    preview.sent = true;
    previewRef.current = null;
    clearTimer(previewTimerRef);
    setCorrectionPreview(null);
    setPhase("idle");
    void sendAutoTranscript(preview.text, preview.version);
  }, [sendAutoTranscript]);

  const beginCorrectionEdit = useCallback(() => {
    const preview = previewRef.current;
    if (!preview || preview.sent || preview.version !== sessionVersionRef.current || preview.editing) return;
    clearTimer(previewTimerRef);
    preview.editing = true;
    preview.deadlineMs = null;
    setCorrectionPreview((current) => current && previewRef.current === preview
      ? { ...current, editing: true, deadlineMs: null } : current);
  }, []);

  const setCorrectionText = useCallback((text: string) => {
    const preview = previewRef.current;
    if (!preview || !preview.editing || preview.sent || preview.version !== sessionVersionRef.current) return;
    preview.text = text;
    setCorrectionPreview((current) => current && previewRef.current === preview
      ? { ...current, text } : current);
  }, []);

  const cancelCorrection = useCallback((restoreDraft = true, manualSubmit = false) => {
    if (autoSendingRef.current === sessionVersionRef.current) {
      if (manualSubmit) return false;
      sessionVersionRef.current += 1;
      listeningRef.current = false;
      clearReplyCycleWait();
      setPhase("idle");
      return false;
    }
    if (!correctionAbortRef.current && !previewRef.current) return true;
    const preview = previewRef.current;
    sessionVersionRef.current += 1;
    listeningRef.current = false;
    clearCorrection();
    clearReplyCycleWait();
    if (preview && restoreDraft) latestRef.current.setTranscript(preview.text);
    setPhase("idle");
    return true;
  }, [clearCorrection, clearReplyCycleWait]);

  useEffect(() => {
    if (identityRef.current === options.correctionIdentity) return;
    identityRef.current = options.correctionIdentity;
    cancelCorrection(false);
  }, [options.correctionIdentity, cancelCorrection]);

  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") cancelCorrection();
    });
    return () => listener.remove();
  }, [cancelCorrection]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !correctionPreview || preview.sent || preview.editing) return;
    if (preview.deadlineMs === null) {
      const deadlineMs = Date.now() + 3000;
      preview.deadlineMs = deadlineMs;
      setCorrectionPreview({ ...correctionPreview, deadlineMs });
      return;
    }
    previewTimerRef.current = setTimeout(() => {
      if (previewRef.current === preview && !preview.editing) sendCorrectionPreview();
    }, Math.max(0, preview.deadlineMs - Date.now()));
    return () => clearTimer(previewTimerRef);
  }, [correctionPreview, sendCorrectionPreview]);

  const fail = useCallback((message: string) => {
    if (terminalRef.current) return;
    finishFailure(message);
  }, [finishFailure]);

  const scheduleStart = useCallback((delayMs = RETRY_DELAY_MS) => {
    clearTimer(retryTimerRef);
    retryTimerRef.current = setTimeout(() => startSessionRef.current(), delayMs);
  }, []);

  const startSession = useCallback(() => {
    if (!listeningRef.current) return;
    if (latestRef.current.canStart === false) {
      setPhase("connecting");
      scheduleStart();
      return;
    }
    terminalRef.current = false;
    setPhase("connecting");
    const version = ++sessionVersionRef.current;
    lastPartialCharsRef.current = 0;
    latestRef.current.onDiagnostic?.("stt_session_start", { version });
    void pendingAbortRef.current.then(() => {
      if (version !== sessionVersionRef.current || !listeningRef.current) return;
      let session: StreamingSttSession;
      try {
        session = transport.connect(latestRef.current.runnerUrl, latestRef.current.runnerToken, {
          onMessage: (raw) => {
            if (sessionRef.current === session) handleMessage(raw, session);
          },
          onSample: (rms) => {
            if (sessionRef.current === session) latestRef.current.onSample(rms);
          },
          onError: (message) => {
            if (sessionRef.current === session) {
              latestRef.current.onDiagnostic?.("stt_transport_error", { version });
              fail(message);
            }
          },
          onClose: () => {
            if (sessionRef.current === session && !terminalRef.current) {
              latestRef.current.onDiagnostic?.("stt_transport_closed_before_done", { version });
              fail("Private Runnerとの音声接続が終了しました。");
            }
          },
        });
      } catch {
        fail("Private Runnerへ接続できませんでした。");
        return;
      }
      sessionRef.current = session;
    });
  }, [fail, transport.connect]);
  startSessionRef.current = startSession;

  function handleMessage(raw: unknown, session: StreamingSttSession) {
    const message = parseStreamingSttMessage(raw);
    if (terminalRef.current) return;
    if (!message) {
      latestRef.current.onDiagnostic?.("stt_invalid_runner_response", { version: sessionVersionRef.current });
      fail("Private Runnerから不正な音声認識応答を受信しました。");
      return;
    }
    if (message.type === "ready") {
      setPhase("recording");
      return;
    }
    if (message.type === "transcript") {
      if (!message.isFinal && message.text.trim()) {
        if (lastPartialCharsRef.current === 0) latestRef.current.onDiagnostic?.("stt_partial_transcript_received", {
          version: sessionVersionRef.current,
          chars: message.text.length,
        });
        lastPartialCharsRef.current = message.text.length;
      }
      const next = applyStreamingTranscript(
        transcriptStateRef.current,
        message.text,
        message.isFinal
      );
      transcriptStateRef.current = next;
      if (message.isFinal) latestRef.current.onDiagnostic?.("stt_final_transcript_received", {
        version: sessionVersionRef.current,
        chars: message.text.length,
        finalChars: next.finalText.length,
        lastPartialChars: lastPartialCharsRef.current,
      });
      latestRef.current.setTranscript(displayStreamingTranscript(next));
      return;
    }
    if (message.type === "usage") {
      latestRef.current.onUsage(message);
      return;
    }
    if (message.type === "speech_activity_begin") {
      latestRef.current.onSpeechBegin();
      return;
    }
    if (message.type === "error") {
      latestRef.current.onDiagnostic?.("stt_runner_error", { version: sessionVersionRef.current });
      fail(message.message || "音声認識に失敗しました。");
      return;
    }
    if (message.type !== "done") return;

    latestRef.current.onDiagnostic?.("stt_done_received", {
      version: sessionVersionRef.current,
      reason: message.reason,
      hasSpeech: message.hasSpeech,
      finalChars: transcriptStateRef.current.finalText.length,
      interimChars: transcriptStateRef.current.interimText.length,
      lastPartialChars: lastPartialCharsRef.current,
    });
    terminalRef.current = true;
    if (sessionRef.current !== session) return;
    const version = ++sessionVersionRef.current;
    if (message.usage) latestRef.current.onUsage(message.usage);
    void abortSession().then(async () => {
      if (version !== sessionVersionRef.current) {
        latestRef.current.onDiagnostic?.("stt_done_superseded", { version });
        return;
      }
      const finalText = finalStreamingTranscript(transcriptStateRef.current);
      const hasFinalSpeech = transcriptStateRef.current.finalText.trim().length > 0;
      if (message.reason === "limit_reached") listeningRef.current = false;
      latestRef.current.setTranscript(finalText);
      if (message.hasSpeech && hasFinalSpeech) {
        setPhase("idle");
        if (latestRef.current.autoReplyAfterStt && finalText.trim()) {
          setPhase("correcting");
          const controller = new AbortController();
          correctionAbortRef.current = controller;
          try {
            const result = await correctSttTranscript(latestRef.current.runnerUrl, latestRef.current.runnerToken,
              finalText, latestRef.current.correctionContext.slice(-12), controller.signal);
            if (version !== sessionVersionRef.current || controller.signal.aborted) return;
            correctionAbortRef.current = null;
            if (!result.changed) {
              setPhase("idle");
              await sendAutoTranscript(finalText, version);
            } else {
              const parts = diffSttTranscript(finalText, result.text);
              const preview = { text: result.text, parts, deadlineMs: null, editing: false };
              previewRef.current = { ...preview, version, sent: false };
              setCorrectionPreview(preview);
              setPhase("preview");
            }
          } catch {
            if (version === sessionVersionRef.current && !controller.signal.aborted) {
              finishFailure("文字起こしの補正に失敗しました。内容を確認して手動で送信してください。");
            }
          }
        } else {
          latestRef.current.onDiagnostic?.("stt_auto_send_skipped", {
            version,
            reason: latestRef.current.autoReplyAfterStt ? "empty_text" : "auto_reply_disabled",
          });
          listeningRef.current = false;
        }
        return;
      }
      latestRef.current.onDiagnostic?.("stt_auto_send_skipped", {
        version,
        reason: !message.hasSpeech ? "runner_no_final_speech" : "client_no_final_speech",
        listening: listeningRef.current,
        finalChars: transcriptStateRef.current.finalText.length,
        interimChars: transcriptStateRef.current.interimText.length,
      });
      if (!listeningRef.current || message.reason === "limit_reached") {
        listeningRef.current = false;
        setPhase("idle");
        return;
      }
      transcriptStateRef.current = startStreamingTranscript(finalText);
      setPhase("connecting");
      scheduleStart();
    });
  }

  const start = useCallback(() => {
    if (!transport.supported) {
      onError("この端末ではストリーミング音声入力を利用できません。");
      return;
    }
    if (options.canStart === false) {
      onError("現在は音声入力を開始できません。");
      return;
    }
    if (phase !== "idle" || listeningRef.current) return;
    transcriptStateRef.current = startStreamingTranscript(transcript);
    listeningRef.current = true;
    startSession();
  }, [onError, options.canStart, phase, startSession, transcript, transport.supported]);

  const stop = useCallback(() => {
    if (correctionAbortRef.current || previewRef.current) { cancelCorrection(); return; }
    if (phase === "idle" || !listeningRef.current) return;
    latestRef.current.onDiagnostic?.("stt_stopped", { version: sessionVersionRef.current, phase });
    listeningRef.current = false;
    terminalRef.current = true;
    sessionVersionRef.current += 1;
    clearReplyCycleWait();
    clearTimer(retryTimerRef);
    void abortSession();
    setTranscript(displayStreamingTranscript(transcriptStateRef.current));
    setPhase("idle");
  }, [abortSession, cancelCorrection, clearReplyCycleWait, phase, setTranscript]);

  const sendManualTranscript = useCallback(async (text: string, onAccepted: () => boolean) => {
    if (!text.trim()) return;
    if (!cancelCorrection(false, true)) return;
    const version = sessionVersionRef.current;
    try {
      await latestRef.current.sendTranscript(text, () => {
        if (version !== sessionVersionRef.current || !onAccepted()) return;
        transcriptStateRef.current = startStreamingTranscript("");
        awaitReplyCycle();
      });
      if (version === sessionVersionRef.current && awaitingReplyCycleRef.current) {
        sawReplyLoadingRef.current = true;
        updateReplyCycle();
      }
    } catch (error) {
      if (version === sessionVersionRef.current && awaitingReplyCycleRef.current) {
        listeningRef.current = false;
        clearReplyCycleWait();
        setPhase("idle");
      }
      throw error;
    }
  }, [awaitReplyCycle, cancelCorrection, clearReplyCycleWait, updateReplyCycle]);

  const abort = useCallback(async () => {
    clearCorrection();
    latestRef.current.onDiagnostic?.("stt_aborted", {
      version: sessionVersionRef.current,
      sessionOpen: sessionRef.current !== null,
    });
    listeningRef.current = false;
    terminalRef.current = true;
    sessionVersionRef.current += 1;
    clearReplyCycleWait();
    clearTimer(retryTimerRef);
    await abortSession();
    setTranscript(finalStreamingTranscript(transcriptStateRef.current));
    setPhase("idle");
  }, [abortSession, clearCorrection, clearReplyCycleWait, setTranscript]);

  const isArmed = useCallback(() => listeningRef.current || sessionRef.current !== null, []);
  const isCapturing = useCallback(() => sessionRef.current !== null, []);

  useEffect(() => () => {
    if (listeningRef.current || sessionRef.current) latestRef.current.onDiagnostic?.("stt_unmounted", {
      version: sessionVersionRef.current,
      sessionOpen: sessionRef.current !== null,
      listening: listeningRef.current,
    });
    listeningRef.current = false;
    terminalRef.current = true;
    sessionVersionRef.current += 1;
    clearReplyCycleWait();
    clearCorrection();
    clearTimer(retryTimerRef);
    void abortSession();
  }, [abortSession, clearCorrection, clearReplyCycleWait]);

  useEffect(() => updateReplyCycle(), [options.replyLoading, options.ttsPlaybackActive,
    options.voiceInputDuringTtsAllowed, updateReplyCycle]);

  return {
    active: phase !== "idle",
    phase,
    correctionPreview,
    sendCorrectionPreview,
    beginCorrectionEdit,
    setCorrectionText,
    cancelCorrection,
    start,
    stop,
    sendManualTranscript,
    abort,
    isArmed,
    isCapturing,
  };
}
