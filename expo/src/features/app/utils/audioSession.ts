export function isAirPodsInputName(raw: unknown): boolean {
  const normalized = String(raw || "").trim().toLowerCase();
  return normalized.includes("airpods");
}

export function buildAutoClientLogSessionId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function isBackgroundAudioSessionError(raw: unknown): boolean {
  const message = raw instanceof Error ? raw.message : String(raw || "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("currently in the background") ||
    normalized.includes("audio session could not be activated")
  );
}

export function isRecordingNotAllowedError(raw: unknown): boolean {
  const message = raw instanceof Error ? raw.message : String(raw || "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("recording not allowed") ||
    normalized.includes("enable with audio.setaudiomodeasync")
  );
}

export function isAudioSessionInterruptedError(raw: unknown): boolean {
  const message = raw instanceof Error ? raw.message : String(raw || "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("audio session was interrupted") ||
    normalized.includes("session was interrupted")
  );
}

export function isRecorderNotPreparedError(raw: unknown): boolean {
  const message = raw instanceof Error ? raw.message : String(raw || "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("recorder not prepared") ||
    normalized.includes("not prepared") ||
    normalized.includes("prepare encountered an error")
  );
}
