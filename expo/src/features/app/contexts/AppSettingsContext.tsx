import { createContext, useContext, type ReactNode } from "react";
import type { SttProvider } from "../../stt/sttConfig";
import type { VoiceOption } from "../hooks/useTtsVoiceCatalog";
import type {
  RecordingQualityPreset,
  RecordingTuning,
  TtsProvider,
} from "../utils/audioConfig";
import type { ReasoningEffort } from "../utils/settingsParsers";

export type ModelOption = {
  label: string;
  value: string;
};

export type RunnerPairingResult = {
  runnerUrl: string;
  runnerWsUrl: string;
  localRunnerUrl: string;
  localRunnerWsUrl: string;
};

export type AppSettingsContextValue = {
  runnerUrl: string;
  llmDirectory: string;
  codexWsUrl: string;
  codexWsToken: string;
  runnerToken: string;
  cloudflareAccessClientId: string;
  cloudflareAccessEnabled: boolean;
  cloudflareRunnerUrl: string;
  cloudflareRunnerWsUrl: string;
  localRunnerUrl: string;
  localRunnerWsUrl: string;
  executionEnvironment: string;
  isExpoGo: boolean;
  isDev: boolean;
  defaultCodexWsUrl: string;
  codexApprovalPolicy: "on-request" | "never";
  selectedModelLabel: string;
  modelRef: string;
  reasoningEffort: ReasoningEffort;
  modelOptions: readonly ModelOption[];
  thinkOptions: readonly ReasoningEffort[];
  ttsProvider: TtsProvider;
  sttProvider: SttProvider;
  voicesLoading: boolean;
  filteredVoices: VoiceOption[];
  ttsSpeedInput: string;
  ttsSpeed: number;
  voiceFilter: string;
  selectedVoiceId: string;
  recordingQualityPreset: RecordingQualityPreset;
  recordingTuning: RecordingTuning;
  autoTranscribeOnStop: boolean;
  autoReplyAfterStt: boolean;
  autoBargeInEnabled: boolean;
  autoSpeakerPriorityEnabled: boolean;
  autoSpeakAfterReply: boolean;
  changeRunnerUrl: (value: string) => void;
  changeLlmDirectory: (value: string) => void;
  changeCodexWsUrl: (value: string) => void;
  changeCodexWsToken: (value: string) => void;
  changeRunnerToken: (value: string) => void;
  clearCloudflareAccessCredentials: () => Promise<void>;
  applyCloudflareRunnerPairing: (payload: string) => Promise<RunnerPairingResult>;
  selectCodexApprovalPolicy: (value: "on-request" | "never") => void;
  loadVoices: () => void;
  changeTtsSpeedInput: (value: string) => void;
  commitTtsSpeedInput: (value: string) => void;
  decreaseTtsSpeed: () => void;
  increaseTtsSpeed: () => void;
  changeVoiceFilter: (value: string) => void;
  selectVoiceId: (voiceId: string) => void;
  selectTtsProvider: (provider: TtsProvider) => void;
  selectSttProvider: (provider: SttProvider) => void;
  applyRecordingQualityPreset: (preset: RecordingQualityPreset) => void;
  changeRecordingSampleRate: (raw: string) => void;
  changeRecordingBitRate: (raw: string) => void;
  changeRecordingChannels: (raw: string) => void;
  changeRecordingProgressUpdateInterval: (raw: string) => void;
  toggleAutoTranscribeOnStop: (value: boolean) => void;
  toggleAutoReplyAfterStt: (value: boolean) => void;
  toggleAutoBargeInEnabled: (value: boolean) => void;
  toggleAutoSpeakerPriorityEnabled: (value: boolean) => void;
  toggleAutoSpeakAfterReply: (value: boolean) => void;
  openModelSelect: () => void;
  openThinkSelect: () => void;
  modelSelectOpen: boolean;
  thinkSelectOpen: boolean;
  setModelSelectOpen: (open: boolean) => void;
  setThinkSelectOpen: (open: boolean) => void;
  selectModel: (nextModel: string) => void;
  selectThinkOption: (option: ReasoningEffort) => void;
};

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

type AppSettingsProviderProps = {
  value: AppSettingsContextValue;
  children: ReactNode;
};

export function AppSettingsProvider({ value, children }: AppSettingsProviderProps) {
  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings() {
  const context = useContext(AppSettingsContext);
  if (!context) {
    throw new Error("useAppSettings must be used within AppSettingsProvider");
  }
  return context;
}
