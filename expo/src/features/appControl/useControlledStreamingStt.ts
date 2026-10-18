import { useCallback, useEffect, useRef } from "react";
import { useStreamingStt } from "../stt/useStreamingStt";
import { useRunnerWebSocketManager } from "../runnerWs/RunnerWebSocketContext";
import { getVoiceControl, type VoiceSurface, type VoiceTarget } from "./voiceControl";

type Options = Parameters<typeof useStreamingStt>[0] & {
  target: VoiceTarget;
  panelId?: string;
  busy: boolean;
  announce?: (signal: AbortSignal) => Promise<void>;
  readyCue?: () => Promise<void>;
};

// Both screens, including their manual/initial/reply/retry starts, share one microphone lease.
export function useControlledStreamingStt(options: Options) {
  const manager = useRunnerWebSocketManager();
  const control = getVoiceControl(manager);
  const id = useRef(`voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).current;
  const stt = useStreamingStt({ ...options, ownership: {
    acquire: () => control.isOwner(id) ? Promise.resolve(true) : control.acquire(id),
    isOwner: () => control.isOwner(id),
  } });
  const latest = useRef({ options, stt });
  latest.current = { options, stt };
  useEffect(() => {
    const surface: VoiceSurface = {
      id, panelId: options.panelId,
      target: () => latest.current.options.target,
      snapshot: () => latest.current.stt.getSnapshot(),
      draft: () => latest.current.stt.getDraft(),
      busy: () => latest.current.options.busy,
      canStart: () => latest.current.options.canStart !== false && !latest.current.options.ttsPlaybackActive,
      controlVersion: () => latest.current.stt.controlVersion ?? 0,
      hasPermission: () => latest.current.stt.hasPermission?.() ?? Promise.resolve(false),
      disarm: () => latest.current.stt.disarm(),
      start: () => latest.current.stt.start(),
      announce: (signal) => latest.current.options.announce?.(signal) ?? control.announce(latest.current.options.target, latest.current.options.panelId, signal),
      readyCue: async () => {
        await latest.current.stt.setInputMuted(true);
        try { await (latest.current.options.readyCue?.() ?? control.readyCue()); }
        finally { await latest.current.stt.setInputMuted(false); }
      },
      notice: (message) => latest.current.options.onError(message),
    };
    return control.register(surface);
  }, [control, id, options.panelId]);
  const start = useCallback(() => {
    void latest.current.stt.start().catch((error: unknown) => latest.current.options.onError(error instanceof Error ? error.message : "音声入力を開始できませんでした。"));
  }, []);
  const claim = useCallback(() => control.acquire(id), [control, id]);
  const abort = useCallback(() => control.stopSurface(id), [control, id]);
  const stop = useCallback(() => { void abort().catch(() => latest.current.options.onError("マイクの停止を確認できませんでした。")); }, [abort]);
  const remotePending = useCallback(() => control.pendingTarget(latest.current.options.target), [control]);
  const allowsSpeech = useCallback(() => control.allowsSpeech(id, latest.current.options.target), [control, id]);
  return { ...stt, surfaceId: id, remotePending, allowsSpeech, claim, start, stop, abort };
}
