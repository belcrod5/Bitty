import { createContext, useContext, type ReactNode } from "react";

export type AudioLabContextValue = {
  audioLabFlatlineDb: number;
  audioLabRunning: boolean;
  audioLabRecordingActive: boolean;
  audioLabPlaybackActive: boolean;
  audioLabInputName: string;
  audioLabAirPodsInput: boolean;
  audioLabElapsedMs: number;
  audioLabCallbackIntervalMs: number | null;
  audioLabLastDb: number | null;
  audioLabMinDb: number | null;
  audioLabMaxDb: number | null;
  audioLabFlatlineMs: number;
  audioLabPlaybackPositionMs: number;
  audioLabPlaybackStallMs: number;
  audioLabLoopCount: number;
  audioLabUnexpectedStopCount: number;
  audioLabPlaybackRecoverCount: number;
  audioLabLogQueuedCount: number;
  audioLabLogSentCount: number;
  audioLabLogStatus: string;
  audioLabRecentLogs: string[];
  audioLabLogSendDisabled: boolean;
  errorMessage: string;
  startProbe: () => void;
  stopProbe: () => void;
  startPlaybackOnly: () => void;
  stopPlaybackOnly: () => void;
  sendLogs: () => void;
  clearLogs: () => void;
};

const AudioLabContext = createContext<AudioLabContextValue | null>(null);

type AudioLabProviderProps = {
  value: AudioLabContextValue;
  children: ReactNode;
};

export function AudioLabProvider({ value, children }: AudioLabProviderProps) {
  return <AudioLabContext.Provider value={value}>{children}</AudioLabContext.Provider>;
}

export function useAudioLab() {
  const context = useContext(AudioLabContext);
  if (!context) {
    throw new Error("useAudioLab must be used within AudioLabProvider");
  }
  return context;
}
