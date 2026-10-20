import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useStreamingSttTransport } from "./useStreamingSttTransport";
import { playVoiceInputSound } from "./voiceInputSounds";
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
  ownership?: { acquire: () => Promise<boolean>; isOwner: () => boolean };
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
  const { setTranscript, onError } = options;
  const [phase, setPhase] = useState<StreamingSttPhase>("idle");
  const recordingRef = useRef(false);
  const readyCueRef = useRef<AbortController | null>(null);
  const releaseFailedRef = useRef(false);
  const releasePendingRef = useRef(false);
  const preservedDraftRef = useRef<string | null>(null);
  const externalDraftRef = useRef(options.transcript);
  if (externalDraftRef.current !== options.transcript) {
    externalDraftRef.current = options.transcript;
    preservedDraftRef.current = null;
  }
  const startIntentRef = useRef(0);
  const sessionRef = useRef<StreamingSttSession | null>(null);
  const pendingReleaseRef = useRef<Promise<void>>(Promise.resolve());
  const sessionVersionRef = useRef(0);
  const transcriptStateRef = useRef<StreamingTranscript>(EMPTY_TRANSCRIPT);
  const draftAtStartRef = useRef("");
  const dictationReadyElapsedRef = useRef(0);
  const dictationReadySinceRef = useRef<number | null>(null);
  const recognitionSegmentSeenRef = useRef(false);
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
  const candidateRef = useRef<{ revision: number; sending: boolean } | null>(null);
  const correctionRequestRef = useRef<{
    draft: string;
    contextKey: string;
    previewDeadlineMs?: number;
    controller: AbortController;
    promise: ReturnType<typeof correctSttTranscript>;
  } | null>(null);
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

  const clearCorrection = useCallback((cancelRequest = true) => {
    if (cancelRequest) {
      correctionRequestRef.current?.controller.abort();
      correctionRequestRef.current = null;
    }
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
    if (latestRef.current.ownership && !latestRef.current.ownership.isOwner()) return;
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
    readyCueRef.current?.abort();
    readyCueRef.current = null;
    recordingRef.current = false;
    candidateRef.current = null;
    correctionRequestRef.current?.controller.abort();
    correctionRequestRef.current = null;
    if (session) {
      releasePendingRef.current = true;
      const queuedAt = Date.now();
      const version = sessionVersionRef.current;
      latestRef.current.onDiagnostic?.("stt_abort_queued", { version });
      pendingReleaseRef.current = pendingReleaseRef.current.catch(() => undefined).then(async () => {
        const startedAt = Date.now();
        latestRef.current.onDiagnostic?.("stt_abort_started", {
          version, queuedMs: startedAt - queuedAt,
        });
        try { await session.abort(); releaseFailedRef.current = false; }
        catch (error) { releaseFailedRef.current = true; throw error; }
        finally { releasePendingRef.current = false; latestRef.current.onDiagnostic?.("stt_abort_completed", {
          version, durationMs: Date.now() - startedAt,
        }); }
      });
      // Background cleanup is handled here; callers can still await the failure.
      void pendingReleaseRef.current.catch(() => undefined);
    }
    return pendingReleaseRef.current;
  }, []);

  const playSendCue = useCallback(() => {
    // The next capture (including a handoff) must wait for playback and its
    // audio-session release, just as it waits for the previous microphone.
    pendingReleaseRef.current = pendingReleaseRef.current.then(() => playVoiceInputSound("send"))
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "voice_input_sound_release_failed") {
          releaseFailedRef.current = true;
          throw error;
        }
      });
    void pendingReleaseRef.current.catch(() => undefined);
  }, []);

  const finishFailure = useCallback((message: string, draft?: string) => {
    sessionVersionRef.current += 1;
    terminalRef.current = true;
    listeningRef.current = false;
    clearReplyCycleWait();
    clearCorrection();
    clearTimer(retryTimerRef);
    pauseDictationIdle();
    void abortSession().catch(() => latestRef.current.onError("マイクの停止を確認できませんでした。"));
    setTranscript(draft ?? displayStreamingTranscript(transcriptStateRef.current));
    setPhase("idle");
    onError(message);
  }, [abortSession, clearCorrection, clearReplyCycleWait, onError, setTranscript]);

  const sendAutoTranscript = useCallback(async (text: string, version: number) => {
    if (version !== sessionVersionRef.current) return;
    const candidate = candidateRef.current;
    if (candidate) {
      if (candidate.sending) return;
      const session = sessionRef.current;
      if (!session?.commit) return;
      candidate.sending = true;
      const commitStartedAt = Date.now();
      try {
        const accepted = await session.commit(candidate.revision);
        latestRef.current.onDiagnostic?.("stt_candidate_commit", {
          version, revision: candidate.revision, accepted, durationMs: Date.now() - commitStartedAt,
        });
        if (version !== sessionVersionRef.current || candidateRef.current !== candidate) return;
        if (!accepted) {
          // A rejected revision means capture continued. Its invalidation event can
          // arrive after this native Promise, so do not depend on their order.
          candidateRef.current = null;
          clearCorrection(false);
          setPhase("recording");
          return;
        }
        terminalRef.current = true;
        autoSendingRef.current = version;
        await abortSession();
        if (version !== sessionVersionRef.current) return;
      } catch {
        if (version === sessionVersionRef.current && candidateRef.current === candidate) {
          finishFailure("音声入力を確定できませんでした。内容を確認して手動で送信してください。", text);
        }
        return;
      }
    }
    autoSendingRef.current = version;
    latestRef.current.onDiagnostic?.("stt_auto_send_dispatch", { version, chars: text.length,
      listening: listeningRef.current });
    if (listeningRef.current) awaitReplyCycle();
    let accepted = false;
    try {
      await latestRef.current.sendTranscript(text, () => {
        latestRef.current.onDiagnostic?.("stt_auto_send_accepted", {
          version, current: version === sessionVersionRef.current,
        });
        if (version !== sessionVersionRef.current || accepted) return;
        accepted = true;
        playSendCue();
        latestRef.current.setTranscript("");
        transcriptStateRef.current = startStreamingTranscript("");
        draftAtStartRef.current = "";
        dictationReadyElapsedRef.current = 0;
        dictationReadySinceRef.current = null;
        recognitionSegmentSeenRef.current = false;
        clearTimer(dictationIdleTimerRef);
        clearTimer(replyCycleTimeoutRef);
        correctionRequestRef.current = null;
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
  }, [abortSession, awaitReplyCycle, clearCorrection, finishFailure, playSendCue, updateReplyCycle]);

  const sendCorrectionPreview = useCallback(() => {
    const preview = previewRef.current;
    if (!preview || preview.sent || preview.version !== sessionVersionRef.current
      || !preview.text.trim()) return;
    preview.sent = true;
    previewRef.current = null;
    clearTimer(previewTimerRef);
    setCorrectionPreview(null);
    if (!candidateRef.current) setPhase("idle");
    void sendAutoTranscript(preview.text, preview.version);
  }, [sendAutoTranscript]);

  const beginCorrectionEdit = useCallback(() => {
    const preview = previewRef.current;
    if (!preview || preview.sent || preview.version !== sessionVersionRef.current || preview.editing) return;
    clearTimer(previewTimerRef);
    // Once the user edits, preserve that draft and leave automatic capture.
    if (candidateRef.current) {
      terminalRef.current = true;
      void abortSession().catch(() => latestRef.current.onError("マイクの停止を確認できませんでした。"));
    }
    preview.editing = true;
    preview.deadlineMs = null;
    setCorrectionPreview((current) => current && previewRef.current === preview
      ? { ...current, editing: true, deadlineMs: null } : current);
  }, [abortSession]);

  const setCorrectionText = useCallback((text: string) => {
    const preview = previewRef.current;
    if (!preview || !preview.editing || preview.sent || preview.version !== sessionVersionRef.current) return;
    preview.text = text;
    setCorrectionPreview((current) => current && previewRef.current === preview
      ? { ...current, text } : current);
  }, []);

  const cancelCorrection = useCallback((restoreDraft = true, manualSubmit = false) => {
    if (candidateRef.current?.sending) {
      if (manualSubmit) return false;
      sessionVersionRef.current += 1;
      listeningRef.current = false;
      terminalRef.current = true;
      clearCorrection();
      clearReplyCycleWait();
      void abortSession().catch(() => latestRef.current.onError("マイクの停止を確認できませんでした。"));
      setPhase("idle");
      return false;
    }
    if (autoSendingRef.current === sessionVersionRef.current) {
      if (manualSubmit) return false;
      sessionVersionRef.current += 1;
      listeningRef.current = false;
      clearReplyCycleWait();
      setPhase("idle");
      return false;
    }
    if (!correctionRequestRef.current && !previewRef.current) return true;
    const preview = previewRef.current;
    sessionVersionRef.current += 1;
    listeningRef.current = false;
    clearCorrection();
    clearReplyCycleWait();
    terminalRef.current = true;
    void abortSession().catch(() => latestRef.current.onError("マイクの停止を確認できませんでした。"));
    if (preview && restoreDraft) latestRef.current.setTranscript(preview.text);
    setPhase("idle");
    return true;
  }, [abortSession, clearCorrection, clearReplyCycleWait]);

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
    if (!latestRef.current.continuousDictation || !recognitionSegmentSeenRef.current
      || !listeningRef.current || !appActiveRef.current || readySince === null
      || displayStreamingTranscript(transcriptStateRef.current).trim() === draftAtStartRef.current.trim()) return;
    dictationIdleTimerRef.current = setTimeout(() => {
      dictationIdleTimerRef.current = null;
      if (!listeningRef.current || !appActiveRef.current || !recognitionSegmentSeenRef.current
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
      void abortSession().catch(() => latestRef.current.onError("マイクの停止を確認できませんでした。"));
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
      if (correctionRequestRef.current?.draft === preview.originalText) {
        correctionRequestRef.current.previewDeadlineMs = deadlineMs;
      }
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
    if (!listeningRef.current || (latestRef.current.ownership && !latestRef.current.ownership.isOwner())) return;
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
    void pendingReleaseRef.current.then(() => {
      if (version !== sessionVersionRef.current || !listeningRef.current || !appActiveRef.current) return;
      latestRef.current.onDiagnostic?.("stt_session_connect", { version });
      let session: StreamingSttSession;
      try {
        session = transport.connect(latestRef.current.runnerUrl, latestRef.current.runnerToken, {
          continueDuringCorrection: latestRef.current.autoReplyAfterStt,
          onMessage: (raw) => {
            if (sessionRef.current === session) handleMessage(raw, session);
          },
          onSample: (rms) => {
            if (sessionRef.current === session) latestRef.current.onSample(rms);
          },
          onDiagnostic: (payload) => {
            if (sessionRef.current === session) latestRef.current.onDiagnostic?.("stt_capture_diagnostic", { ...payload, version });
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
    }).catch(() => fail("マイクの終了を確認できませんでした。音声入力を開始できません。"));
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
    if (message.type === "candidate_invalidated") {
      if (candidateRef.current?.revision === message.revision) {
        candidateRef.current = null;
        latestRef.current.onDiagnostic?.("stt_candidate_invalidated", {
          version: sessionVersionRef.current, revision: message.revision,
        });
        clearCorrection(false);
        setPhase("recording");
      }
      return;
    }
    if (message.type === "segment_start") {
      recognitionSegmentSeenRef.current = true;
      transcriptStateRef.current = startStreamingTranscript(displayStreamingTranscript(transcriptStateRef.current));
      lastPartialCharsRef.current = 0;
      setPhase("recording");
      return;
    }
    if (message.type === "candidate") {
      if (!session.commit || !latestRef.current.autoReplyAfterStt) {
        fail("Private Runnerから予期しない音声確定候補を受信しました。");
        return;
      }
      clearCorrection(false);
      candidateRef.current = { revision: message.revision, sending: false };
      latestRef.current.onDiagnostic?.("stt_candidate_received", {
        version: sessionVersionRef.current, revision: message.revision,
      });
      void correctTranscript(displayStreamingTranscript(transcriptStateRef.current), sessionVersionRef.current);
      return;
    }
    if (message.type === "ready") {
      if (recordingRef.current || readyCueRef.current) return;
      const controller = new AbortController();
      readyCueRef.current = controller;
      const current = () => sessionRef.current === session && !controller.signal.aborted && !terminalRef.current;
      void (async () => {
        // The native microphone is already running. Never feed the cue into STT.
        if (session.setInputMuted && session.playReadyCue) {
          await session.setInputMuted(true);
          if (!current()) return;
          // A missing/unavailable speaker must not prevent voice input.
          await session.playReadyCue(controller.signal).catch((error: unknown) => {
            if (error instanceof Error && error.message === "voice_input_sound_release_failed") throw error;
          });
          if (!current()) return;
          await session.setInputMuted(false);
          if (!current()) return;
        }
        recordingRef.current = true;
        setPhase("recording");
        if (latestRef.current.continuousDictation && recognitionSegmentSeenRef.current) {
          dictationReadySinceRef.current ??= Date.now();
          scheduleDictationIdle();
        }
      })().catch(() => {
        if (current()) fail("音声入力のミュートを切り替えられませんでした。");
      }).finally(() => {
        if (readyCueRef.current === controller) readyCueRef.current = null;
      });
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
      if (correctionRequestRef.current && correctionRequestRef.current.draft !== draft) clearCorrection();
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
      latestRef.current.onError("");
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
        }).catch(() => finishFailure("マイクの停止を確認できませんでした。"));
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

  async function correctTranscript(draft: string, version: number) {
    setPhase("correcting");
    const candidate = candidateRef.current;
    let request = correctionRequestRef.current;
    const context = latestRef.current.correctionContext.slice(-12);
    const contextKey = JSON.stringify(context);
    if (!request || request.draft !== draft || request.contextKey !== contextKey || request.controller.signal.aborted) {
      request?.controller.abort();
      const controller = new AbortController();
      request = {
        draft, contextKey, controller,
        promise: correctSttTranscript(latestRef.current.runnerUrl, latestRef.current.runnerToken,
          draft, context, controller.signal),
      };
      correctionRequestRef.current = request;
    }
    const { controller } = request;
    latestRef.current.onDiagnostic?.("stt_correction_started", {
      version, chars: draft.length, contextMessages: Math.min(12, latestRef.current.correctionContext.length),
    });
    try {
      const result = await request.promise;
      if (version !== sessionVersionRef.current || controller.signal.aborted || candidateRef.current !== candidate) return;
      if (!result.changed) {
        latestRef.current.onDiagnostic?.("stt_correction_result", { version, changed: false });
        if (!candidateRef.current) setPhase("idle");
        await sendAutoTranscript(draft, version);
      } else {
        const parts = diffSttTranscript(draft, result.text);
        latestRef.current.onDiagnostic?.("stt_correction_result", {
          version, changed: true,
          deletedChars: parts.filter((part) => part.kind === "delete")
            .reduce((count, part) => count + part.text.length, 0),
          insertedChars: parts.filter((part) => part.kind === "insert")
            .reduce((count, part) => count + part.text.length, 0),
        });
        const preview = { text: result.text, parts, deadlineMs: request.previewDeadlineMs ?? null, editing: false };
        previewRef.current = { ...preview, originalText: draft, version, sent: false };
        setCorrectionPreview(preview);
        setPhase("preview");
      }
    } catch (error) {
      if (version === sessionVersionRef.current && !controller.signal.aborted && candidateRef.current === candidate) {
        latestRef.current.onDiagnostic?.("stt_correction_failed", {
          version, errorName: error instanceof Error ? error.name : "unknown",
          ...(error instanceof Error && "status" in error && typeof error.status === "number"
            && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
            ? { httpStatus: error.status } : {}),
        });
        finishFailure("文字起こしの補正に失敗しました。内容を確認して手動で送信してください。");
      }
    }
  }

  function finishRecognition(message: DoneMessage) {
    clearCorrection();
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
      const draft = displayStreamingTranscript(transcriptStateRef.current);
      const acceptedText = finalStreamingTranscript(transcriptStateRef.current);
      const hasFinalSpeech = transcriptStateRef.current.finalText.trim().length > 0;
      if (message.reason === "limit_reached") listeningRef.current = false;
      if (message.reason === "recognition_segment_end" && latestRef.current.continuousDictation
        && listeningRef.current) {
        transcriptStateRef.current = startStreamingTranscript(draft);
        latestRef.current.setTranscript(draft);
        recognitionSegmentSeenRef.current = true;
        setPhase("connecting");
        scheduleStart();
        return;
      }
      const completedSegments = (recognitionSegmentSeenRef.current || latestRef.current.continuousDictation)
        && ["no_speech_timeout", "max_duration"].includes(message.reason)
        && acceptedText.trim() !== draftAtStartRef.current.trim();
      if ((message.hasSpeech && hasFinalSpeech) || completedSegments) {
        latestRef.current.setTranscript(draft);
        setPhase("idle");
        if (latestRef.current.autoReplyAfterStt && draft.trim()) {
          await correctTranscript(draft, version);
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
      latestRef.current.setTranscript(draft);
      if (!listeningRef.current || message.reason === "limit_reached") {
        listeningRef.current = false;
        setPhase("idle");
        return;
      }
      transcriptStateRef.current = startStreamingTranscript(draft);
      setPhase("connecting");
      scheduleStart();
    }).catch(() => finishFailure("マイクの停止を確認できませんでした。"));
  }

  const start = useCallback(async () => {
    const intent = ++startIntentRef.current;
    if (!transport.supported) throw new Error("この端末ではストリーミング音声入力を利用できません。");
    if (latestRef.current.canStart === false) throw new Error("現在は音声入力を開始できません。");
    if (listeningRef.current) return;
    if (latestRef.current.ownership && !await latestRef.current.ownership.acquire()) return;
    if (intent !== startIntentRef.current || (!appActiveRef.current && latestRef.current.ownership)) return;
    transcriptStateRef.current = startStreamingTranscript(latestRef.current.transcript);
    draftAtStartRef.current = transcriptStateRef.current.baseText;
    dictationReadyElapsedRef.current = 0;
    dictationReadySinceRef.current = null;
    recognitionSegmentSeenRef.current = false;
    clearTimer(dictationIdleTimerRef);
    errorRetriesRef.current = 0;
    listeningRef.current = true;
    startSession();
  }, [startSession, transport.supported]);

  // Disarm synchronously, including reply/correction waits, before releasing native audio.
  const disarm = useCallback(async () => {
    startIntentRef.current += 1;
    const alreadyStopped = !listeningRef.current && !sessionRef.current && !previewRef.current && !correctionRequestRef.current;
    const draft = previewRef.current?.text
      ?? (listeningRef.current || sessionRef.current ? displayStreamingTranscript(transcriptStateRef.current) : preservedDraftRef.current ?? latestRef.current.transcript);
    listeningRef.current = false;
    terminalRef.current = true;
    sessionVersionRef.current += 1;
    clearReplyCycleWait();
    clearCorrection();
    clearTimer(retryTimerRef);
    pauseDictationIdle();
    if (!alreadyStopped) {
      preservedDraftRef.current = draft;
      latestRef.current.setTranscript(draft);
    }
    setPhase("idle");
    await abortSession();
  }, [abortSession, clearCorrection, clearReplyCycleWait]);

  const stop = useCallback(() => {
    void disarm().catch(() => latestRef.current.onError("マイクの停止を確認できませんでした。"));
  }, [disarm]);

  const sendManualTranscript = useCallback(async (text: string, onAccepted: () => boolean, resumeListening = true) => {
    if (!text.trim()) return;
    if (!cancelCorrection(false, true)) return;
    const version = sessionVersionRef.current;
    let accepted = false;
    try {
      terminalRef.current = true;
      await abortSession();
      if (version !== sessionVersionRef.current) return;
      await latestRef.current.sendTranscript(text, () => {
        if (version !== sessionVersionRef.current || accepted || !onAccepted()) return;
        accepted = true;
        playSendCue();
        transcriptStateRef.current = startStreamingTranscript("");
        draftAtStartRef.current = "";
        dictationReadyElapsedRef.current = 0;
        dictationReadySinceRef.current = null;
        recognitionSegmentSeenRef.current = false;
        clearTimer(dictationIdleTimerRef);
        if (resumeListening) awaitReplyCycle();
        else {
          listeningRef.current = false;
          setPhase("idle");
        }
      });
      if (version === sessionVersionRef.current && !accepted) {
        listeningRef.current = false;
        setPhase("idle");
      } else if (version === sessionVersionRef.current && awaitingReplyCycleRef.current) {
        sawReplyLoadingRef.current = true;
        updateReplyCycle();
      }
    } catch (error) {
      if (version === sessionVersionRef.current) {
        listeningRef.current = false;
        clearReplyCycleWait();
        setPhase("idle");
      }
      throw error;
    }
  }, [abortSession, awaitReplyCycle, cancelCorrection, clearReplyCycleWait, playSendCue, updateReplyCycle]);

  const abort = disarm;

  useEffect(() => {
    if (!listeningRef.current) reportStartWait(null, "cancelled");
  }, [phase, reportStartWait]);

  const isArmed = useCallback(() => listeningRef.current || sessionRef.current !== null, []);
  const isCapturing = useCallback(() => recordingRef.current, []);
  const isSessionOpen = useCallback(() => sessionRef.current !== null, []);
  const getSnapshot = useCallback(() => ({
    desired: listeningRef.current ? "listening" as const : "stopped" as const,
    observed: releaseFailedRef.current || releasePendingRef.current ? "unknown" as const : recordingRef.current ? "recording" as const : sessionRef.current ? "starting" as const
      : listeningRef.current ? "waiting" as const : "stopped" as const,
  }), []);

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
    void abortSession().catch(() => latestRef.current.onError("マイクの停止を確認できませんでした。"));
  }, [abortSession, clearCorrection, clearReplyCycleWait]);

  useEffect(() => updateReplyCycle(), [options.replyLoading, options.ttsPlaybackActive,
    options.voiceInputDuringTtsAllowed, updateReplyCycle]);

  return {
    active: phase !== "idle",
    controlVersion: transport.controlVersion,
    hasPermission: transport.hasPermission,
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
    disarm,
    getSnapshot,
    getDraft: () => previewRef.current?.text ?? (sessionRef.current
      ? displayStreamingTranscript(transcriptStateRef.current) : preservedDraftRef.current ?? latestRef.current.transcript),
    isSessionOpen,
    isArmed,
    isCapturing,
  };
}
