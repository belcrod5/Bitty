export type SttProvider = "runner" | "ios_native" | "ios_native_direct" | "ios_native_runner";

export const STT_PROVIDERS: readonly SttProvider[] = [
  "runner",
  "ios_native",
  "ios_native_direct",
  "ios_native_runner",
];
export const DEFAULT_STT_PROVIDER: SttProvider = "runner";
export const FORCED_STT_LANGUAGE = "ja";
export const STT_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

export function parseSttProvider(raw: unknown): SttProvider {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "ios_native_runner") return "ios_native_runner";
  if (value === "ios_native_direct") return "ios_native_direct";
  if (value === "ios_native") return "ios_native";
  return "runner";
}

export function sttProviderLabel(provider: SttProvider) {
  if (provider === "ios_native_runner") return "ios_native_runner (recording + runner)";
  if (provider === "ios_native_direct") return "ios_native_direct (SFSpeechRecognizer direct)";
  if (provider === "ios_native") return "ios_native (SFSpeechRecognizer)";
  return "runner (/stt)";
}
