import { Audio } from "expo-av";

export type TtsProvider = "elevenlabs" | "google" | "aivisspeech";
export type RecordingQualityPreset = "low" | "medium" | "high";
export type RecordingTuning = {
  sampleRate: number;
  numberOfChannels: number;
  bitRate: number;
  progressUpdateIntervalMs: number;
};

export type SelectedVoiceIdByProvider = {
  elevenlabs: string;
  google: string;
  aivisspeech: string;
};

const AUTO_IOS_AUDIO_QUALITY_LOW = 0x20;
const AUTO_RECORDING_PROGRESS_INTERVAL_AUTO_MIN_MS = 120;
const AUTO_RECORDING_PROGRESS_INTERVAL_AUTO_MAX_MS = 140;
const AUTO_RECORDING_PROGRESS_INTERVAL_IDLE_MIN_MS = 200;
const AUTO_RECORDING_PROGRESS_INTERVAL_IDLE_MAX_MS = 240;
const AUTO_RECORDING_PROGRESS_INTERVAL_BARGE_MIN_MS = 100;
const AUTO_RECORDING_PROGRESS_INTERVAL_BARGE_MAX_MS = 120;

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
export const RECORDING_QUALITY_PRESETS: RecordingQualityPreset[] = ["low", "medium", "high"];
export const DEFAULT_RECORDING_QUALITY_PRESET: RecordingQualityPreset = "low";
export const RECORDING_SAMPLE_RATE_MIN = 8000;
export const RECORDING_SAMPLE_RATE_MAX = 48000;
export const RECORDING_BIT_RATE_MIN = 16000;
export const RECORDING_BIT_RATE_MAX = 192000;
export const RECORDING_PROGRESS_UPDATE_INTERVAL_MIN = 60;
export const RECORDING_PROGRESS_UPDATE_INTERVAL_MAX = 400;

const RECORDING_PRESET_TUNING: Record<RecordingQualityPreset, RecordingTuning> = {
  low: {
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
    progressUpdateIntervalMs: 180,
  },
  medium: {
    sampleRate: 24000,
    numberOfChannels: 1,
    bitRate: 64000,
    progressUpdateIntervalMs: 130,
  },
  high: {
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 128000,
    progressUpdateIntervalMs: 100,
  },
};

export function parseTtsProvider(raw: unknown): TtsProvider {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "google") return "google";
  if (value === "aivisspeech") return "aivisspeech";
  return "elevenlabs";
}

export function parseRecordingQualityPreset(raw: unknown): RecordingQualityPreset {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "low" || value === "low_quality" || value === "fast" || value === "高速") return "low";
  if (value === "medium" || value === "mid" || value === "middle" || value === "standard") return "medium";
  if (value === "high" || value === "high_quality") return "high";
  return DEFAULT_RECORDING_QUALITY_PRESET;
}

export function recordingQualityPresetLabel(preset: RecordingQualityPreset) {
  if (preset === "low") return "低（高速）";
  if (preset === "medium") return "中";
  return "高";
}

export function recordingQualityPresetHint(preset: RecordingQualityPreset) {
  if (preset === "low") return "CPU優先。会話用途の最軽量寄り";
  if (preset === "medium") return "バランス重視。通常運用向け";
  return "品質優先。既存HIGH_QUALITY相当";
}

export function recordingTuningFromPreset(preset: RecordingQualityPreset): RecordingTuning {
  const tuning = RECORDING_PRESET_TUNING[preset] || RECORDING_PRESET_TUNING[DEFAULT_RECORDING_QUALITY_PRESET];
  return { ...tuning };
}

export function clampRecordingSampleRate(raw: number) {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value)) return RECORDING_PRESET_TUNING[DEFAULT_RECORDING_QUALITY_PRESET].sampleRate;
  return Math.max(RECORDING_SAMPLE_RATE_MIN, Math.min(RECORDING_SAMPLE_RATE_MAX, value));
}

export function clampRecordingChannels(raw: number) {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value)) return RECORDING_PRESET_TUNING[DEFAULT_RECORDING_QUALITY_PRESET].numberOfChannels;
  return Math.max(1, Math.min(2, value));
}

export function clampRecordingBitRate(raw: number) {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value)) return RECORDING_PRESET_TUNING[DEFAULT_RECORDING_QUALITY_PRESET].bitRate;
  return Math.max(RECORDING_BIT_RATE_MIN, Math.min(RECORDING_BIT_RATE_MAX, value));
}

export function clampRecordingProgressUpdateIntervalMs(raw: number) {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value)) {
    return RECORDING_PRESET_TUNING[DEFAULT_RECORDING_QUALITY_PRESET].progressUpdateIntervalMs;
  }
  return Math.max(RECORDING_PROGRESS_UPDATE_INTERVAL_MIN, Math.min(RECORDING_PROGRESS_UPDATE_INTERVAL_MAX, value));
}

export function resolveAutoRecordingProgressUpdateIntervalMs(
  tuningRaw: RecordingTuning,
  mode: "idle" | "speech" | "barge" = "speech"
) {
  const base = clampRecordingProgressUpdateIntervalMs(Number(tuningRaw?.progressUpdateIntervalMs || 0));
  if (mode === "idle") {
    return Math.max(
      AUTO_RECORDING_PROGRESS_INTERVAL_IDLE_MIN_MS,
      Math.min(AUTO_RECORDING_PROGRESS_INTERVAL_IDLE_MAX_MS, base)
    );
  }
  if (mode === "barge") {
    return Math.max(
      AUTO_RECORDING_PROGRESS_INTERVAL_BARGE_MIN_MS,
      Math.min(AUTO_RECORDING_PROGRESS_INTERVAL_BARGE_MAX_MS, base)
    );
  }
  return Math.max(
    AUTO_RECORDING_PROGRESS_INTERVAL_AUTO_MIN_MS,
    Math.min(AUTO_RECORDING_PROGRESS_INTERVAL_AUTO_MAX_MS, base)
  );
}

export function normalizeRecordingTuning(
  raw: unknown,
  fallbackPreset = DEFAULT_RECORDING_QUALITY_PRESET
): RecordingTuning {
  const base = recordingTuningFromPreset(fallbackPreset);
  const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    sampleRate: clampRecordingSampleRate(Number(payload.sampleRate ?? base.sampleRate)),
    numberOfChannels: clampRecordingChannels(Number(payload.numberOfChannels ?? base.numberOfChannels)),
    bitRate: clampRecordingBitRate(Number(payload.bitRate ?? base.bitRate)),
    progressUpdateIntervalMs: clampRecordingProgressUpdateIntervalMs(
      Number(payload.progressUpdateIntervalMs ?? base.progressUpdateIntervalMs)
    ),
  };
}

export function buildRecordingOptions(tuningRaw: RecordingTuning) {
  const tuning = normalizeRecordingTuning(tuningRaw, DEFAULT_RECORDING_QUALITY_PRESET);
  const base = Audio.RecordingOptionsPresets.HIGH_QUALITY;
  return {
    ...base,
    isMeteringEnabled: true,
    android: {
      ...base.android,
      extension: ".m4a",
      sampleRate: tuning.sampleRate,
      numberOfChannels: tuning.numberOfChannels,
      bitRate: tuning.bitRate,
    },
    ios: {
      ...base.ios,
      extension: ".m4a",
      audioQuality: AUTO_IOS_AUDIO_QUALITY_LOW,
      sampleRate: tuning.sampleRate,
      numberOfChannels: tuning.numberOfChannels,
      bitRate: tuning.bitRate,
    },
    web: {
      ...base.web,
      bitsPerSecond: tuning.bitRate,
    },
  };
}

export function clampTtsSpeed(value: number) {
  return Math.max(TTS_SPEED_MIN, Math.min(TTS_SPEED_MAX, value));
}

export function parseTtsSpeed(raw: unknown) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TTS_SPEED;
  return clampTtsSpeed(value);
}
