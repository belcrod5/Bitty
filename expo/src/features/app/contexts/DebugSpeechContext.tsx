import { createContext, useContext, type ReactNode } from "react";
import type { ImageSourcePropType } from "react-native";

export type DebugSpeechContextValue = {
  importSettingsJson: () => void;
  logSettingsJson: () => void;
  clearToolAutoApprovals: () => void;
  toolAutoApprovalRuleCount: number;
  isDirectNativeSttProvider: boolean;
  directNativeSttEnabled: boolean;
  directNativeSttActive: boolean;
  directNativeSttPreviewText: string;
  startDirectNativeStt: () => void;
  stopDirectNativeStt: () => void;
  autoRecordingEnabled: boolean;
  startAutoRecordingMode: () => void;
  stopAutoRecordingMode: () => void;
  autoWaveformAnimationEnabled: boolean;
  waveformDotGif: ImageSourcePropType;
  autoSpeechDetected: boolean;
  autoWaveformDebugOverlayEnabled: boolean;
  autoWaveformDebugText: string;
  autoRecordingState: string;
  autoMeteringDb: number | null;
  autoLastEvent: string;
  autoSegments: number;
  autoInputName: string;
  autoAirPodsInput: boolean;
  autoClientLogQueuedCount: number;
  autoClientLogSentCount: number;
  autoClientLogStatus: string;
  sendAutoClientLogs: () => void;
  clearAutoClientLogs: () => void;
  manualRecording: boolean;
  startRecording: () => void;
  stopRecording: () => void;
  recordingUri: string;
  transcribeRecording: () => void;
  recordingSec: number;
  clearRecordedClip: () => void;
};

const DebugSpeechContext = createContext<DebugSpeechContextValue | null>(null);

type DebugSpeechProviderProps = {
  value: DebugSpeechContextValue;
  children: ReactNode;
};

export function DebugSpeechProvider({ value, children }: DebugSpeechProviderProps) {
  return <DebugSpeechContext.Provider value={value}>{children}</DebugSpeechContext.Provider>;
}

export function useDebugSpeech() {
  const context = useContext(DebugSpeechContext);
  if (!context) {
    throw new Error("useDebugSpeech must be used within DebugSpeechProvider");
  }
  return context;
}
