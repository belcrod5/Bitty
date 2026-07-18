import { createContext, useContext, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import type { Animated, ImageSourcePropType } from "react-native";
import type { LlmUiStatus } from "../hooks/useLlmRequestStatus";
import type { ChatBottomToast } from "../hooks/useChatBottomToast";
import type { SttMessageMeta } from "../types/appTypes";
import type { PixelStatusIconKey } from "../utils/statusIcons";

type LlmVisual = {
  icon: string;
  bg: string;
  border: string;
  text: string;
};

type TtsSegmentProgress = {
  total: number;
  playedNow: number;
  generated: number;
  playbackRatio: number;
  generationRatio: number;
};

export type ChatVisualContextValue = {
  isRobotAnimating: boolean;
  pixelRobotImage: ImageSourcePropType;
  pixelRobotImageStatic: ImageSourcePropType;
  chatContextUsedPct: number | null;
  chatContextRingProgress: number;
  chatContextRingTrackColor: string;
  chatContextRingProgressColor: string;
  formatElapsedHhMmSs: (elapsedMs: number) => string;
  llmStatusVisual: (status: LlmUiStatus) => LlmVisual;
  llmStatusLabel: (status: LlmUiStatus) => string;
  resolvePixelStatusIconKey: (status: LlmUiStatus, detail: string) => PixelStatusIconKey;
  buildSttMetaChips: (meta: SttMessageMeta | undefined) => string[];
  ttsPlaybackMessageId: string;
  isTtsPlaybackActive: boolean;
  ttsSegmentProgress: TtsSegmentProgress;
  pixelStatusAnimations: Record<PixelStatusIconKey, ImageSourcePropType>;
  showChatThinkingPanel: boolean;
  chatThinkingCurrentMessage: string;
  llmElapsedLiveMs: number;
  chatThinkingLogLines: string[];
  setChatThinkingLogExpanded: (expanded: SetStateAction<boolean>) => void;
  chatThinkingLogExpanded: boolean;
  stopWaveformPlayback: () => void;
  error: string;
  chatBottomToast: ChatBottomToast | null;
  chatBottomToastAnimRef: MutableRefObject<Animated.Value>;
};

const ChatVisualContext = createContext<ChatVisualContextValue | null>(null);

type ChatVisualProviderProps = {
  value: ChatVisualContextValue;
  children: ReactNode;
};

export function ChatVisualProvider({ value, children }: ChatVisualProviderProps) {
  return <ChatVisualContext.Provider value={value}>{children}</ChatVisualContext.Provider>;
}

export function useChatVisual() {
  const context = useContext(ChatVisualContext);
  if (!context) {
    throw new Error("useChatVisual must be used within ChatVisualProvider");
  }
  return context;
}
