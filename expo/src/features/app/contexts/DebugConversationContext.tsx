import { createContext, useContext, type ReactNode } from "react";
import type { ImageSourcePropType } from "react-native";
import type { WebViewMessageEvent } from "react-native-webview";
import type {
  HistoryEntry,
  LlmDeltaEntry,
  LlmProgressEntry,
  StreamSegment,
  ToolCallEntry,
  TtsDebugStats,
} from "../types/appTypes";
import type { PixelStatusIconKey } from "../utils/statusIcons";

type LlmVisual = {
  bg: string;
  border: string;
  text: string;
};

type DebugYouTubeVideoMeta = {
  videoId: string;
  thumbnailUrl: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number | null;
};

export type DebugConversationContextValue = {
  llmVisual: LlmVisual;
  llmStatusText: string;
  llmUiStatusDetail: string;
  llmPixelIconKey: PixelStatusIconKey;
  pixelStatusAnimations: Record<PixelStatusIconKey, ImageSourcePropType>;
  llmActiveToolCalls: number;
  llmElapsedLabel: string;
  llmLastToolCall: ToolCallEntry | null;
  streamAudioQueueSize: number;
  streamMode: string;
  streamLlmNativeDeltaCount: number;
  streamLlmPseudoDeltaCount: number;
  streamFirstNativeDeltaOffsetMs: number | null;
  ttsDebugStats: TtsDebugStats;
  streamLlmProgress: LlmProgressEntry[];
  streamLlmDeltas: LlmDeltaEntry[];
  streamSegments: StreamSegment[];
  trimForInline: (text: string) => string;
  replyDebug: string;
  latestAssistantYouTubeVideos: DebugYouTubeVideoMeta[];
  youtubePlayerMessageId: string;
  youtubePlayerVideoId: string;
  youtubeEmbedHtml: string;
  youtubePlayerSession: number;
  youtubeEmbedOrigin: string;
  onYouTubeWebViewMessage: (event: WebViewMessageEvent) => void;
  onOpenLatestYouTubeVideo: (videoId: string, queueIndex: number) => void;
  formatYouTubePublishedDate: (value: string) => string;
  formatYouTubeViewCount: (value: number) => string;
  canReadReplyAudio: boolean;
  ttsLoading: boolean;
  synthesizeSpeech: () => void;
  hasTtsSound: boolean;
  stopTtsPlayback: () => void;
  ttsUri: string;
  history: HistoryEntry[];
};

const DebugConversationContext = createContext<DebugConversationContextValue | null>(null);

type DebugConversationProviderProps = {
  value: DebugConversationContextValue;
  children: ReactNode;
};

export function DebugConversationProvider({ value, children }: DebugConversationProviderProps) {
  return <DebugConversationContext.Provider value={value}>{children}</DebugConversationContext.Provider>;
}

export function useDebugConversation() {
  const context = useContext(DebugConversationContext);
  if (!context) {
    throw new Error("useDebugConversation must be used within DebugConversationProvider");
  }
  return context;
}
