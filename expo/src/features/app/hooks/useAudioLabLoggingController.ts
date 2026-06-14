import { useCallback } from "react";

type AudioLabLogEntry = {
  at: string;
  event: string;
  payload: Record<string, unknown>;
};

type AudioLabClientLogsPort = {
  enqueue: (event: string, payload: Record<string, unknown>) => AudioLabLogEntry | null;
  sendNow: () => Promise<void>;
  clearLocal: () => void;
};

type UseAudioLabLoggingControllerOptions = {
  autoDiagnosticsEnabled: boolean;
  audioLabRecentLogMax: number;
  audioLabClientLogs: AudioLabClientLogsPort;
  setAudioLabRecentLogs: (updater: (prev: string[]) => string[]) => void;
  toInlineSummary: (payload: Record<string, unknown>, maxLength?: number) => string;
};

export function useAudioLabLoggingController(options: UseAudioLabLoggingControllerOptions) {
  const {
    autoDiagnosticsEnabled,
    audioLabRecentLogMax,
    audioLabClientLogs,
    setAudioLabRecentLogs,
    toInlineSummary,
  } = options;

  const pushAudioLabRecentLog = useCallback((line: string) => {
    const text = String(line || "").trim();
    if (!text) return;
    setAudioLabRecentLogs((prev) => {
      const next = [...prev, text];
      if (next.length > audioLabRecentLogMax) {
        next.splice(0, next.length - audioLabRecentLogMax);
      }
      return next;
    });
  }, [
    audioLabRecentLogMax,
    setAudioLabRecentLogs,
  ]);

  const logAudioLab = useCallback((event: string, payload: Record<string, unknown> = {}) => {
    if (!autoDiagnosticsEnabled) return;
    console.log("[audio-lab]", event, payload);
    const entry = audioLabClientLogs.enqueue(event, payload);
    if (!entry) return;
    const inline = toInlineSummary(entry.payload, 88);
    const at = entry.at.slice(11, 19);
    pushAudioLabRecentLog(`${at} ${entry.event}${inline ? ` ${inline}` : ""}`);
  }, [
    audioLabClientLogs,
    autoDiagnosticsEnabled,
    pushAudioLabRecentLog,
    toInlineSummary,
  ]);

  const sendAudioLabLogsNow = useCallback(async () => {
    await audioLabClientLogs.sendNow();
  }, [audioLabClientLogs]);

  const clearAudioLabLogsLocal = useCallback(() => {
    audioLabClientLogs.clearLocal();
    setAudioLabRecentLogs(() => []);
  }, [
    audioLabClientLogs,
    setAudioLabRecentLogs,
  ]);

  return {
    logAudioLab,
    sendAudioLabLogsNow,
    clearAudioLabLogsLocal,
  };
}
