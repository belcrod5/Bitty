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
import { parseStreamingSttMessage, type StreamingSttServerMessage, type StreamingSttUsage } from "./streamingSttClient";
import { correctSttTranscript, type SttCorrectionContext } from "./sttSettingsClient";
import { diffSttTranscript, type SttCorrectionPreview } from "./sttTranscriptDiff";

export type StreamingSttPhase = "idle" | "connecting" | "recording" | "finalizing" | "correcting" | "preview";

type Options = {
  runnerUrl: string;
  runnerToken: string;
  transcript: string;
  autoReplyAfterStt: boolean;
  continuousDictation?: boolean;
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
const MAX_ERROR_RETRIES = 3;
export const CONTINUOUS_DICTATION_IDLE_MS = 2_000;

type DoneMessage = Extract<StreamingSttServerMessage, { type: "done" }>;

export function useStreamingStt(options: Options) {
  const { transcript, setTranscript, onError } = options;
  const [phase, setPhase] = useState<StreamingSttPhase>("idle");
  const sessionRef = useRef<StreamingSttSession | null>(null);
  const pendingAbortRef = useRef<Promise<void>>(Promise.resolve());
  const sessionVersionRef = useRef(0);
  const transcriptStateRef = useRef<StreamingTranscript>(EMPTY_TRANSCRIPT);
  const draftAtStartRef = useRef("");
  const dictationReadyElapsedRef = useRef(0);
  const dictationReadySinceRef = useRef<number | null>(null);
  const dictationSegmentSeenRef = useRef(false);
  const dictationIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPartialCharsRef = useRef(0);
  const terminalRef = useRef(false);
  const listeningRef = useRef(false);
  const appActiveRef = useRef(AppState.currentState == null || AppState.currentState === "active");
  const startSessionRef = useRef<() => void>(() => {});
  const startWaitRef = useRef<{ reason: string; since: number } | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorRetriesRef = useRef(0);
  const awaitingReplyCycleRef = useRef(false);
  const sawReplyLoadingRef = useRef(false);
  const sawTtsPlaybackRef = useRef(false);
  const replyCycleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const correctionAbortRef = useRef<AbortController | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRef = useRef<(SttCorrectionPreview & { originalText: string; version: number; sent: boolean }) | null>(null);
  const autoSendingRef = useRef<number | null>(null);
  const [correctionPreview, setCorrectionPreview] = useState<SttCorrectionPreview | null>(null);
  const identityRef = useRef(options.correctionIdentity);
  const transport = useStreamingSttTransport();
  const latestRef = useRef(options);
  latestRef.current = options;

  const reportStartWait = useCallback((reason: string | null, outcome = "resolved") => {
    const previous = startWaitRef.current;
    if (previous?.reason === reason) return;
    const now = Date.now();
    if (previous) latestRef.current.onDiagnostic?.("stt_start_wait_ended", {
      version: sessionVersionRef.current, reason: previous.reason, since: previous.since,
      durationMs: now - previous.since, outcome,
    });
    startWaitRef.current = reason ? { reason, since: now } : null;
    if (reason) latestRef.current.onDiagnostic?.("stt_start_wait_started", {
      version: sessionVersionRef.current, reason, since: now,
    });
  }, []);

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
      const queuedAt = Date.now();
      const version = sessionVersionRef.current;
      latestRef.current.onDiagnostic?.("stt_abort_queued", { version });
      pendingAbortRef.current = pendingAbortRef.current.then(async () => {
        const startedAt = Date.now();
        latestRef.current.onDiagnostic?.("stt_abort_started", {
          version, queuedMs: startedAt - queuedAt,
        });
        try { await session.abort(); }
        finally { latestRef.current.onDiagnostic?.("stt_abort_completed", {
          version, durationMs: Date.now() - startedAt,
        }); }
      }).catch(() => undefined);
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
    pauseDictationIdle();
    void abortSession();
    setTranscript(draft ?? displayStreamingTranscript(transcriptStateRef.current));
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
        draftAtStartRef.current = "";
        dictationReadyElapsedRef.current = 0;
        dictationReadySinceRef.current = null;
        dictationSegmentSeenRef.current = false;
        clearTimer(dictationIdleTimerRef);
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

  const discardCorrection = useCallback(() => {
    const preview = previewRef.current;
    if (!preview || !preview.editing || preview.sent || preview.version !== sessionVersionRef.current) return;
    if (cancelCorrection(false)) latestRef.current.setTranscript(preview.originalText);
  }, [cancelCorrection]);

  useEffect(() => {
    if (identityRef.current === options.correctionIdentity) return;
    identityRef.current = options.correctionIdentity;
    cancelCorrection(false);
  }, [options.correctionIdentity, cancelCorrection]);

  function pauseDictationIdle() {
    if (dictationReadySinceRef.current !== null) {
      dictationReadyElapsedRef.current += Date.now() - dictationReadySinceRef.current;
      dictationReadySinceRef.current = null;
    }
    clearTimer(dictationIdleTimerRef);
  }

  function scheduleDictationIdle() {
    clearTimer(dictationIdleTimerRef);
    const readySince = dictationReadySinceRef.current;
    if (!latestRef.current.continuousDictation || !dictationSegmentSeenRef.current
      || !listeningRef.current || !appActiveRef.current || readySince === null
      || displayStreamingTranscript(transcriptStateRef.current).trim() === draftAtStartRef.current.trim()) return;
    dictationIdleTimerRef.current = setTimeout(() => {
      dictationIdleTimerRef.current = null;
      if (!listeningRef.current || !appActiveRef.current || !dictationSegmentSeenRef.current
        || dictationReadySinceRef.current === null) return;
      const draft = displayStreamingTranscript(transcriptStateRef.current);
      if (draft.trim() === draftAtStartRef.current.trim()) return;
      latestRef.current.onDiagnostic?.("stt_dictation_idle_timeout", { version: sessionVersionRef.current });
      transcriptStateRef.current = startStreamingTranscript(draft);
      finishRecognition({ type: "done", reason: "no_speech_timeout", hasSpeech: false });
    }, Math.max(0, CONTINUOUS_DICTATION_IDLE_MS - dictationReadyElapsedRef.current
      - (Date.now() - readySince)));
  }

  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      const wasActive = appActiveRef.current;
      appActiveRef.current = state === "active";
      if (appActiveRef.current) {
        if (!wasActive && listeningRef.current && !awaitingReplyCycleRef.current && !sessionRef.current) {
          latestRef.current.onDiagnostic?.("stt_foreground_resume", { version: sessionVersionRef.current });
          dictationReadyElapsedRef.current = 0;
          dictationReadySinceRef.current = null;
          startSessionRef.current();
        }
        return;
      }
      cancelCorrection();
      if (!wasActive || !listeningRef.current || awaitingReplyCycleRef.current) return;
      latestRef.current.onDiagnostic?.("stt_background_suspend", {
        version: sessionVersionRef.current, sessionOpen: sessionRef.current !== null,
      });
      terminalRef.current = true;
      sessionVersionRef.current += 1;
      clearTimer(retryTimerRef);
      pauseDictationIdle();
      const draft = displayStreamingTranscript(transcriptStateRef.current);
      transcriptStateRef.current = startStreamingTranscript(draft);
      latestRef.current.setTranscript(draft);
      void abortSession();
      setPhase("connecting");
    });
    return () => listener.remove();
  }, [abortSession, cancelCorrection]);

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
    pauseDictationIdle();
    if (!appActiveRef.current || latestRef.current.canStart === false) {
      reportStartWait(appActiveRef.current ? "can_start_false" : "app_inactive");
      setPhase("connecting");
      if (appActiveRef.current) scheduleStart();
      return;
    }
    reportStartWait(null);
    terminalRef.current = false;
    setPhase("connecting");
    const version = ++sessionVersionRef.current;
    lastPartialCharsRef.current = 0;
    latestRef.current.onDiagnostic?.("stt_session_start", { version });
    void pendingAbortRef.current.then(() => {
      if (version !== sessionVersionRef.current || !listeningRef.current || !appActiveRef.current) return;
      latestRef.current.onDiagnostic?.("stt_session_connect", { version });
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
      if (latestRef.current.continuousDictation && dictationSegmentSeenRef.current) {
        dictationReadySinceRef.current ??= Date.now();
        scheduleDictationIdle();
      }
      return;
    }
    if (message.type === "transcript") {
      const previousDraft = displayStreamingTranscript(transcriptStateRef.current);
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
      const draft = displayStreamingTranscript(next);
      if (latestRef.current.continuousDictation && message.text.trim() && draft.trim() !== previousDraft.trim()) {
        dictationReadyElapsedRef.current = 0;
        if (dictationReadySinceRef.current !== null) {
          dictationReadySinceRef.current = Date.now();
          scheduleDictationIdle();
        }
      } else if (latestRef.current.continuousDictation && draft.trim() === draftAtStartRef.current.trim()) {
        pauseDictationIdle();
      }
      if (message.isFinal) latestRef.current.onDiagnostic?.("stt_final_transcript_received", {
        version: sessionVersionRef.current,
        chars: message.text.length,
        finalChars: next.finalText.length,
        lastPartialChars: lastPartialCharsRef.current,
      });
      latestRef.current.setTranscript(draft);
      return;
    }
    if (message.type === "usage") {
      latestRef.current.onUsage(message);
      return;
    }
    if (message.type === "speech_activity_begin") {
      pauseDictationIdle();
      latestRef.current.onSpeechBegin();
      return;
    }
    if (message.type === "speech_activity_end") {
      pauseDictationIdle();
      return;
    }
    if (message.type === "error") {
      pauseDictationIdle();
      latestRef.current.onDiagnostic?.("stt_runner_error", {
        version: sessionVersionRef.current,
        code: /^[a-z][a-z0-9_]{0,63}$/.test(message.code) ? message.code : "unknown",
        retryable: message.retryable,
        retries: errorRetriesRef.current,
      });
      if (message.retryable && listeningRef.current && errorRetriesRef.current < MAX_ERROR_RETRIES) {
        terminalRef.current = true;
        const version = ++sessionVersionRef.current;
        const attempt = ++errorRetriesRef.current;
        const draft = displayStreamingTranscript(transcriptStateRef.current);
        transcriptStateRef.current = startStreamingTranscript(draft);
        latestRef.current.setTranscript(draft);
        setPhase("connecting");
        latestRef.current.onDiagnostic?.("stt_error_retry", { version, attempt });
        void abortSession().then(() => {
          if (version !== sessionVersionRef.current || !listeningRef.current) return;
          scheduleStart(RETRY_DELAY_MS * 2 ** (attempt - 1));
        });
        return;
      }
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
    if (sessionRef.current !== session) return;
    finishRecognition(message);
  }

  function finishRecognition(message: DoneMessage) {
    terminalRef.current = true;
    clearTimer(retryTimerRef);
    pauseDictationIdle();
    errorRetriesRef.current = 0;
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
      if (message.reason === "recognition_segment_end" && latestRef.current.continuousDictation
        && listeningRef.current) {
        const draft = displayStreamingTranscript(transcriptStateRef.current);
        transcriptStateRef.current = startStreamingTranscript(draft);
        latestRef.current.setTranscript(draft);
        dictationSegmentSeenRef.current = true;
        setPhase("connecting");
        scheduleStart();
        return;
      }
      const completedDictation = latestRef.current.continuousDictation
        && message.reason === "no_speech_timeout"
        && finalText.trim() !== draftAtStartRef.current.trim();
      if ((message.hasSpeech && hasFinalSpeech) || completedDictation) {
        latestRef.current.setTranscript(finalText);
        setPhase("idle");
        if (latestRef.current.autoReplyAfterStt && finalText.trim()) {
          setPhase("correcting");
          const controller = new AbortController();
          correctionAbortRef.current = controller;
          latestRef.current.onDiagnostic?.("stt_correction_started", {
            version, chars: finalText.length, contextMessages: Math.min(12, latestRef.current.correctionContext.length),
          });
          try {
            const result = await correctSttTranscript(latestRef.current.runnerUrl, latestRef.current.runnerToken,
              finalText, latestRef.current.correctionContext.slice(-12), controller.signal);
            if (version !== sessionVersionRef.current || controller.signal.aborted) return;
            correctionAbortRef.current = null;
            if (!result.changed) {
              latestRef.current.onDiagnostic?.("stt_correction_result", { version, changed: false });
              setPhase("idle");
              await sendAutoTranscript(finalText, version);
            } else {
              const parts = diffSttTranscript(finalText, result.text);
              latestRef.current.onDiagnostic?.("stt_correction_result", {
                version, changed: true,
                deletedChars: parts.filter((part) => part.kind === "delete")
                  .reduce((count, part) => count + part.text.length, 0),
                insertedChars: parts.filter((part) => part.kind === "insert")
                  .reduce((count, part) => count + part.text.length, 0),
              });
              const preview = { text: result.text, parts, deadlineMs: null, editing: false };
              previewRef.current = { ...preview, originalText: finalText, version, sent: false };
              setCorrectionPreview(preview);
              setPhase("preview");
            }
          } catch (error) {
            if (version === sessionVersionRef.current && !controller.signal.aborted) {
              latestRef.current.onDiagnostic?.("stt_correction_failed", {
                version, errorName: error instanceof Error ? error.name : "unknown",
                ...(error instanceof Error && "status" in error && typeof error.status === "number"
                  && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
                  ? { httpStatus: error.status } : {}),
              });
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
      const draft = displayStreamingTranscript(transcriptStateRef.current);
      latestRef.current.setTranscript(draft);
      if (!listeningRef.current || message.reason === "limit_reached") {
        listeningRef.current = false;
        setPhase("idle");
        return;
      }
      transcriptStateRef.current = startStreamingTranscript(draft);
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
    draftAtStartRef.current = transcriptStateRef.current.baseText;
    dictationReadyElapsedRef.current = 0;
    dictationReadySinceRef.current = null;
    dictationSegmentSeenRef.current = false;
    clearTimer(dictationIdleTimerRef);
    errorRetriesRef.current = 0;
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
    pauseDictationIdle();
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
        draftAtStartRef.current = "";
        dictationReadyElapsedRef.current = 0;
        dictationReadySinceRef.current = null;
        dictationSegmentSeenRef.current = false;
        clearTimer(dictationIdleTimerRef);
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
    pauseDictationIdle();
    await abortSession();
    setTranscript(finalStreamingTranscript(transcriptStateRef.current));
    setPhase("idle");
  }, [abortSession, clearCorrection, clearReplyCycleWait, setTranscript]);

  useEffect(() => {
    if (!listeningRef.current) reportStartWait(null, "cancelled");
  }, [phase, reportStartWait]);

  const isArmed = useCallback(() => listeningRef.current || sessionRef.current !== null, []);
  const isCapturing = useCallback(() => sessionRef.current !== null, []);

  useEffect(() => () => {
    if (listeningRef.current || sessionRef.current) latestRef.current.onDiagnostic?.("stt_unmounted", {
      version: sessionVersionRef.current,
      sessionOpen: sessionRef.current !== null,
      listening: listeningRef.current,
    });
    reportStartWait(null, "unmounted");
    listeningRef.current = false;
    terminalRef.current = true;
    sessionVersionRef.current += 1;
    clearReplyCycleWait();
    clearCorrection();
    clearTimer(retryTimerRef);
    pauseDictationIdle();
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
    discardCorrection,
    cancelCorrection,
    start,
    stop,
    sendManualTranscript,
    abort,
    isArmed,
    isCapturing,
  };
}
