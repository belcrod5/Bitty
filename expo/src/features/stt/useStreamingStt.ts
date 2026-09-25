import { useCallback, useEffect, useRef, useState } from "react";
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

export type StreamingSttPhase = "idle" | "connecting" | "recording" | "finalizing";

type Options = {
  runnerUrl: string;
  runnerToken: string;
  transcript: string;
  autoReplyAfterStt: boolean;
  setTranscript: (text: string) => void;
  sendTranscript: (text: string, onAccepted: () => void) => Promise<void>;
  onUsage: (usage: StreamingSttUsage) => void;
  onSample: (rms: number) => void;
  onError: (message: string) => void;
  canStart: boolean;
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
  const terminalRef = useRef(false);
  const listeningRef = useRef(false);
  const startSessionRef = useRef<() => void>(() => {});
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitingReplyCycleRef = useRef(false);
  const sawReplyLoadingRef = useRef(false);
  const sawTtsPlaybackRef = useRef(false);
  const replyCycleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const settleReplyCycle = useCallback(() => {
    clearReplyCycleWait();
    if (listeningRef.current) startSessionRef.current();
    else setPhase("idle");
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

  const finishFailure = useCallback((message: string) => {
    sessionVersionRef.current += 1;
    terminalRef.current = true;
    listeningRef.current = false;
    clearReplyCycleWait();
    clearTimer(retryTimerRef);
    void abortSession();
    setTranscript(finalStreamingTranscript(transcriptStateRef.current));
    setPhase("idle");
    onError(message);
  }, [abortSession, clearReplyCycleWait, onError, setTranscript]);

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
    if (!latestRef.current.canStart) {
      setPhase("connecting");
      scheduleStart();
      return;
    }
    terminalRef.current = false;
    setPhase("connecting");
    const version = ++sessionVersionRef.current;
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
            if (sessionRef.current === session) fail(message);
          },
          onClose: () => {
            if (sessionRef.current === session && !terminalRef.current) {
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
      fail("Private Runnerから不正な音声認識応答を受信しました。");
      return;
    }
    if (message.type === "ready") {
      setPhase("recording");
      return;
    }
    if (message.type === "transcript") {
      const next = applyStreamingTranscript(
        transcriptStateRef.current,
        message.text,
        message.isFinal
      );
      transcriptStateRef.current = next;
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
      fail(message.message || "音声認識に失敗しました。");
      return;
    }
    if (message.type !== "done") return;

    terminalRef.current = true;
    if (sessionRef.current !== session) return;
    const version = ++sessionVersionRef.current;
    latestRef.current.onUsage(message.usage);
    void abortSession().then(async () => {
      if (version !== sessionVersionRef.current) return;
      const finalText = finalStreamingTranscript(transcriptStateRef.current);
      const hasFinalSpeech = transcriptStateRef.current.finalText.trim().length > 0;
      if (message.reason === "limit_reached") listeningRef.current = false;
      latestRef.current.setTranscript(finalText);
      if (message.hasSpeech && hasFinalSpeech) {
        setPhase("idle");
        if (latestRef.current.autoReplyAfterStt && finalText.trim()) {
          if (listeningRef.current) {
            awaitingReplyCycleRef.current = true;
            sawReplyLoadingRef.current = latestRef.current.replyLoading;
            sawTtsPlaybackRef.current = latestRef.current.ttsPlaybackActive;
            setPhase("connecting");
            replyCycleTimeoutRef.current = setTimeout(() => {
              if (!awaitingReplyCycleRef.current || sawReplyLoadingRef.current) return;
              listeningRef.current = false;
              clearReplyCycleWait();
              setPhase("idle");
            }, REPLY_CYCLE_START_TIMEOUT_MS);
          }
          try {
            await latestRef.current.sendTranscript(finalText, () => {
              transcriptStateRef.current = startStreamingTranscript("");
              clearTimer(replyCycleTimeoutRef);
            });
            if (version === sessionVersionRef.current && awaitingReplyCycleRef.current) {
              // A successful sendTranscript has been accepted even if a fast terminal
              // update never rendered replyLoading=true.
              sawReplyLoadingRef.current = true;
              updateReplyCycle();
            }
          } catch {
            if (version === sessionVersionRef.current) {
              finishFailure("文字起こし結果を送信できませんでした。");
            }
          }
        } else {
          listeningRef.current = false;
        }
        return;
      }
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
    if (!options.canStart) {
      onError("Face Trackingが発話開始を許可していません。");
      return;
    }
    if (phase !== "idle" || listeningRef.current) return;
    transcriptStateRef.current = startStreamingTranscript(transcript);
    listeningRef.current = true;
    startSession();
  }, [onError, options.canStart, phase, startSession, transcript, transport.supported]);

  const stop = useCallback(() => {
    if (phase === "idle" || !listeningRef.current) return;
    listeningRef.current = false;
    terminalRef.current = true;
    sessionVersionRef.current += 1;
    clearReplyCycleWait();
    clearTimer(retryTimerRef);
    void abortSession();
    setTranscript(displayStreamingTranscript(transcriptStateRef.current));
    setPhase("idle");
  }, [abortSession, clearReplyCycleWait, phase, setTranscript]);

  const abort = useCallback(async () => {
    listeningRef.current = false;
    terminalRef.current = true;
    sessionVersionRef.current += 1;
    clearReplyCycleWait();
    clearTimer(retryTimerRef);
    await abortSession();
    setTranscript(finalStreamingTranscript(transcriptStateRef.current));
    setPhase("idle");
  }, [abortSession, clearReplyCycleWait, setTranscript]);

  const isArmed = useCallback(() => listeningRef.current || sessionRef.current !== null, []);
  const isCapturing = useCallback(() => sessionRef.current !== null, []);

  useEffect(() => () => {
    listeningRef.current = false;
    terminalRef.current = true;
    sessionVersionRef.current += 1;
    clearReplyCycleWait();
    clearTimer(retryTimerRef);
    void abortSession();
  }, [abortSession, clearReplyCycleWait]);

  useEffect(() => updateReplyCycle(), [options.replyLoading, options.ttsPlaybackActive,
    options.voiceInputDuringTtsAllowed, updateReplyCycle]);

  return {
    active: phase !== "idle",
    phase,
    start,
    stop,
    abort,
    isArmed,
    isCapturing,
  };
}
