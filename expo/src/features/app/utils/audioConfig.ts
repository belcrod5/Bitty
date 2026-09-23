export type TtsProvider = "elevenlabs" | "google" | "aivisspeech";

export type SelectedVoiceIdByProvider = {
  elevenlabs: string;
  google: string;
  aivisspeech: string;
};

export const TTS_SPEED_MIN = 0.5;
export const TTS_SPEED_MAX = 2.0;
export const TTS_SPEED_STEP = 0.1;
export const TTS_PROVIDERS: TtsProvider[] = ["elevenlabs", "google", "aivisspeech"];
export const DEFAULT_SELECTED_VOICE_IDS: SelectedVoiceIdByProvider = {
  elevenlabs: "",
  google: "",
  aivisspeech: "",
};
export const DEFAULT_TTS_PROVIDER: TtsProvider = "aivisspeech";
export const DEFAULT_TTS_SPEED = 1.6;
export function parseTtsProvider(raw: unknown): TtsProvider {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "google") return "google";
  if (value === "aivisspeech") return "aivisspeech";
  return "elevenlabs";
}

export function clampTtsSpeed(value: number) {
  return Math.max(TTS_SPEED_MIN, Math.min(TTS_SPEED_MAX, value));
}

export function parseTtsSpeed(raw: unknown) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TTS_SPEED;
  return clampTtsSpeed(value);
}
