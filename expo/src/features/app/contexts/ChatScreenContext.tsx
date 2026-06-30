import { createContext, useContext, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, View } from "react-native";
import type { RunnerRouteSelectionState } from "../hooks/useRunnerRouteSelection";
import type { ConversationMessage, TtsPlaybackTarget } from "../types/appTypes";

export type ChatScreenContextValue = {
  approvalDialogPending: boolean;
  setChatScreenLayout: Dispatch<SetStateAction<{ width: number; height: number }>>;
  setChatViewportHeight: Dispatch<SetStateAction<number>>;
  handleChatScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  chatContentRef: MutableRefObject<View | null>;
  onChatTouchStart: () => void;
  onChatTouchEnd: () => void;
  runnerUrl: string;
  runnerToken: string;
  runnerRouteSelection: RunnerRouteSelectionState;
  isCodexCompactRunning: (threadId: string) => boolean;
  sanitizeTextForTts: (text: string) => string;
  handleAssistantAudioButtonPress: (
    message: ConversationMessage,
    target?: Omit<TtsPlaybackTarget, "messageId">
  ) => Promise<void>;
};

const ChatScreenContext = createContext<ChatScreenContextValue | null>(null);

type ChatScreenProviderProps = {
  value: ChatScreenContextValue;
  children: ReactNode;
};

export function ChatScreenProvider({ value, children }: ChatScreenProviderProps) {
  return <ChatScreenContext.Provider value={value}>{children}</ChatScreenContext.Provider>;
}

export function useChatScreen() {
  const context = useContext(ChatScreenContext);
  if (!context) {
    throw new Error("useChatScreen must be used within ChatScreenProvider");
  }
  return context;
}
