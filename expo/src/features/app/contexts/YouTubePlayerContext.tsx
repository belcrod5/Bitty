import { createContext, useContext, type MutableRefObject, type ReactNode } from "react";
import type { Animated, PanResponderInstance, View } from "react-native";
import type { WebView, WebViewMessageEvent } from "react-native-webview";
import type { YouTubeVideoMeta } from "../types/appTypes";

type YouTubeVideoListItem = {
  videoId: string;
  thumbnailUrl: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number | null;
};

export type YouTubePlayerContextValue = {
  activeYouTubeQueuePositionLabel: string;
  youtubeVideoMetaById: Record<string, YouTubeVideoMeta>;
  conversationInlineAnchorMessageId: string;
  showFloatingYouTubePlayer: boolean;
  setYoutubeInlineAnchor: (node: View | null) => void;
  youtubePlayerVideoId: string;
  youtubeEmbedHtml: string;
  youtubeWebViewRef: MutableRefObject<WebView | null>;
  youtubePlayerSession: number;
  youtubeEmbedOrigin: string;
  handleYouTubeWebViewMessage: (event: WebViewMessageEvent) => void;
  openYouTubeVideo: (
    videoId: string,
    messageId: string,
    options?: { queueVideoIds?: string[]; queueIndex?: number }
  ) => void;
  formatYouTubePublishedDate: (value: string) => string;
  formatYouTubeViewCount: (value: number) => string;
  updateYouTubeInlineLayoutFromAnchor: () => void;
  streamReplyYouTubeVideos: YouTubeVideoListItem[];
  youtubePlayerMessageId: string;
  streamReplyYouTubeVideoIds: string[];
  showYouTubeOverlayPlayer: boolean;
  youtubeFloatingAnimatedPosition: Animated.ValueXY;
  markYouTubeFloatingControlInteraction: () => void;
  youtubeFloatingInteractionMode: "control" | "drag";
  youtubeFloatingPanResponder: PanResponderInstance;
  closeYouTubePlayer: () => void;
};

const YouTubePlayerContext = createContext<YouTubePlayerContextValue | null>(null);

type YouTubePlayerProviderProps = {
  value: YouTubePlayerContextValue;
  children: ReactNode;
};

export function YouTubePlayerProvider({ value, children }: YouTubePlayerProviderProps) {
  return <YouTubePlayerContext.Provider value={value}>{children}</YouTubePlayerContext.Provider>;
}

export function useYouTubePlayer() {
  const context = useContext(YouTubePlayerContext);
  if (!context) {
    throw new Error("useYouTubePlayer must be used within YouTubePlayerProvider");
  }
  return context;
}
