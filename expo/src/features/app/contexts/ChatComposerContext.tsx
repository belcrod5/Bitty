import { createContext, useContext, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import type { ImageSourcePropType, TextInput } from "react-native";
import type { SlashCommandOption } from "../components/SlashCommandSelectMenu";

export type ChatComposerContextValue = {
  composerWaveformVisible: boolean;
  autoWaveformAnimationEnabled: boolean;
  waveformDotGif: ImageSourcePropType;
  autoSpeechDetected: boolean;
  composerDirectSttVisible: boolean;
  directNativeSttPreviewText: string;
  chatComposerInputRef: MutableRefObject<TextInput | null>;
  showComposerFullscreenToggle: boolean;
  openComposerFullscreen: () => void;
  setComposerInputFocused: (focused: boolean) => void;
  isDirectNativeSttProvider: boolean;
  directNativeSttEnabled: boolean;
  autoRecordingEnabled: boolean;
  manualRecording: boolean;
  faceTrackingEnabled: boolean;
  faceTrackingLooking: boolean;
  hasComposerText: boolean;
  canStopLlmTurn: boolean;
  stopDirectNativeStt: () => void;
  stopAutoRecordingMode: () => void;
  stopRecording: () => void;
  stopLlmTurn: () => void;
  startDirectNativeStt: () => void;
  startAutoRecordingMode: () => void;
  setFaceTrackingEnabledWithRef: (enabled: boolean) => void;
  faceTrackingRunning: boolean;
  setSlashCommandSelectOpen: Dispatch<SetStateAction<boolean>>;
  slashCommandOptions: readonly SlashCommandOption[];
  onSelectSlashCommand: (command: string) => void;
};

const ChatComposerContext = createContext<ChatComposerContextValue | null>(null);

type ChatComposerProviderProps = {
  value: ChatComposerContextValue;
  children: ReactNode;
};

export function ChatComposerProvider({ value, children }: ChatComposerProviderProps) {
  return <ChatComposerContext.Provider value={value}>{children}</ChatComposerContext.Provider>;
}

export function useChatComposer() {
  const context = useContext(ChatComposerContext);
  if (!context) {
    throw new Error("useChatComposer must be used within ChatComposerProvider");
  }
  return context;
}
