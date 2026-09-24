import { createContext, useContext, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import type { TextInput } from "react-native";
import type { SlashCommandOption } from "../components/SlashCommandSelectMenu";
import type { ComposerDraft } from "../hooks/useComposerPersistence";

export type ChatComposerContextValue = {
  composerMessageHistory: readonly string[];
  composerDrafts: readonly ComposerDraft[];
  composerDraftsLoaded: boolean;
  setComposerDraft: (sessionId: string, text: string) => void;
  chatComposerInputRef: MutableRefObject<TextInput | null>;
  showComposerFullscreenToggle: boolean;
  setComposerInputFocused: (focused: boolean) => void;
  faceTrackingEnabled: boolean;
  faceTrackingLooking: boolean;
  voiceInputAllowed: boolean;
  onVoiceSpeechBegin: () => void;
  voiceInputDuringTtsAllowed: boolean;
  registerVoiceInputSession: (controller: {
    isArmed: () => boolean;
    isCapturing: () => boolean;
    abort: () => Promise<void>;
  }) => () => void;
  hasComposerText: boolean;
  canStopLlmTurn: boolean;
  stopLlmTurn: () => void;
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
