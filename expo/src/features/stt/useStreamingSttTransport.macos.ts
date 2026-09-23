import { useCallback, useRef } from "react";
import { LIVE_PCM_FORMAT, useLivePcmCapture } from "./useLivePcmCapture.macos";
import { openStreamingSttSocket, parseStreamingSttMessage, pcmRms, sendPcm } from "./streamingSttClient";
import type { StreamingSttSession, StreamingSttTransportCallbacks } from "./streamingSttTransport";

export function useStreamingSttTransport() {
  const currentRef = useRef<{ socket: WebSocket; callbacks: StreamingSttTransportCallbacks; stopping: boolean } | null>(null);
  const pendingCaptureStartRef = useRef<Promise<void> | null>(null);
  const captureActiveRef = useRef(false);
  const capture = useLivePcmCapture((pcm) => {
    const current = currentRef.current;
    if (!current || current.stopping || !captureActiveRef.current || current.socket.readyState !== WebSocket.OPEN) return;
    try {
      sendPcm(current.socket, pcm);
      current.callbacks.onSample(pcmRms(pcm));
    } catch (error) {
      current.callbacks.onError(error instanceof Error && error.message === "backpressure_exceeded"
        ? "音声送信が追いつきませんでした。接続を確認して再試行してください。"
        : "音声の送信に失敗しました。");
    }
  }, () => currentRef.current?.callbacks.onError("マイクの音声データを読み取れませんでした。"));
  const captureStart = capture.start;
  const captureStop = capture.stop;

  const stopCapture = useCallback(async () => {
    if (pendingCaptureStartRef.current) await pendingCaptureStartRef.current.catch(() => undefined);
    if (!captureActiveRef.current) return;
    captureActiveRef.current = false;
    await captureStop().catch(() => undefined);
  }, [captureStop]);

  const connect = useCallback((runnerUrl: string, runnerToken: string, callbacks: StreamingSttTransportCallbacks): StreamingSttSession => {
    const socket = openStreamingSttSocket(runnerUrl, runnerToken);
    const current = { socket, callbacks, stopping: false };
    currentRef.current = current;
    socket.onopen = () => {
      if (currentRef.current !== current) return;
      socket.send(JSON.stringify({ type: "start", sampleRate: LIVE_PCM_FORMAT.sampleRate }));
    };
    socket.onmessage = (event) => {
      if (currentRef.current !== current) return;
      const ready = parseStreamingSttMessage(event.data)?.type === "ready";
      if (!ready) {
        callbacks.onMessage(event.data);
        return;
      }
      if (current.stopping) return;
      const pending = (async () => {
        if (pendingCaptureStartRef.current) await pendingCaptureStartRef.current.catch(() => undefined);
        if (currentRef.current !== current || current.stopping) return;
        await captureStart();
        if (currentRef.current !== current || current.stopping) {
          await captureStop().catch(() => undefined);
          return;
        }
        captureActiveRef.current = true;
        callbacks.onMessage(event.data);
      })();
      pendingCaptureStartRef.current = pending;
      void pending.catch(() => {
        if (currentRef.current === current && !current.stopping) callbacks.onError("マイクを開始できませんでした。");
      }).finally(() => {
        if (pendingCaptureStartRef.current === pending) pendingCaptureStartRef.current = null;
      });
    };
    socket.onerror = () => {
      if (currentRef.current === current) callbacks.onError("Private Runnerとの音声接続が切れました。");
    };
    socket.onclose = () => {
      if (currentRef.current === current) callbacks.onClose();
    };
    const abort = async () => {
      if (currentRef.current !== current) return;
      current.stopping = true;
      currentRef.current = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      await stopCapture();
    };
    return {
      stop: async () => {
        if (currentRef.current !== current) return;
        current.stopping = true;
        await stopCapture();
        if (currentRef.current === current && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "stop" }));
        }
      },
      abort,
    };
  }, [captureStart, captureStop, stopCapture]);

  return { supported: true, connect };
}
