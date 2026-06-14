import type { RefObject } from "react";
import { Image, Text, TouchableOpacity, View } from "react-native";
import type { View as RNView } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { styles } from "../styles";

type YouTubeVideoItem = {
  videoId: string;
  thumbnailUrl: string;
  channelTitle: string;
  publishedAt: string;
  viewCount: number | null;
};

type YouTubeVideoListProps = {
  videos: YouTubeVideoItem[];
  isVideoActive: (videoId: string, index: number) => boolean;
  onOpenVideo: (videoId: string, index: number) => void;
  youtubePlayerVideoId: string;
  youtubePlayerSession: number;
  youtubeEmbedHtml: string;
  youtubeEmbedOrigin: string;
  youtubeWebViewRef?: RefObject<WebView | null>;
  onYouTubeWebViewMessage: (event: WebViewMessageEvent) => void;
  formatYouTubePublishedDate: (value: string) => string;
  formatYouTubeViewCount: (value: number) => string;
  showFloatingYouTubePlayer?: boolean;
  setYoutubeInlineAnchor?: (node: RNView | null) => void;
  onUpdateYouTubeInlineLayout?: () => void;
};

export function YouTubeVideoList({
  videos,
  isVideoActive,
  onOpenVideo,
  youtubePlayerVideoId,
  youtubePlayerSession,
  youtubeEmbedHtml,
  youtubeEmbedOrigin,
  youtubeWebViewRef,
  onYouTubeWebViewMessage,
  formatYouTubePublishedDate,
  formatYouTubeViewCount,
  showFloatingYouTubePlayer = false,
  setYoutubeInlineAnchor,
  onUpdateYouTubeInlineLayout,
}: YouTubeVideoListProps) {
  return (
    <View style={styles.youtubeList}>
      {videos.map((video, videoIndex) => {
        const isActive = isVideoActive(video.videoId, videoIndex) && !!youtubeEmbedHtml;
        return (
          <View key={video.videoId} style={styles.youtubeCard}>
            {isActive ? (
              <View
                ref={setYoutubeInlineAnchor}
                style={showFloatingYouTubePlayer ? styles.youtubePlayerInlinePlaceholder : styles.youtubePlayerInline}
                onLayout={onUpdateYouTubeInlineLayout}
              >
                {showFloatingYouTubePlayer ? (
                  <Text style={styles.youtubePlayerInlinePlaceholderText}>
                    再生中（ミニプレイヤー表示中）
                  </Text>
                ) : (
                  <WebView
                    ref={youtubeWebViewRef}
                    key={`${youtubePlayerVideoId}:${youtubePlayerSession}`}
                    source={{ html: youtubeEmbedHtml, baseUrl: youtubeEmbedOrigin }}
                    style={styles.youtubeWebView}
                    javaScriptEnabled
                    allowsInlineMediaPlayback
                    mediaPlaybackRequiresUserAction={false}
                    allowsPictureInPictureMediaPlayback
                    allowsFullscreenVideo
                    onMessage={onYouTubeWebViewMessage}
                  />
                )}
              </View>
            ) : (
              <TouchableOpacity
                style={styles.youtubeCardTouchable}
                onPress={() => onOpenVideo(video.videoId, videoIndex)}
                activeOpacity={0.9}
              >
                <Image
                  source={{ uri: video.thumbnailUrl }}
                  style={styles.youtubeThumb}
                  resizeMode="cover"
                />
                <View style={styles.youtubeMeta}>
                  {video.channelTitle ? <Text style={styles.youtubeTitle}>{video.channelTitle}</Text> : null}
                  {video.publishedAt ? (
                    <Text style={styles.youtubeSub}>公開日: {formatYouTubePublishedDate(video.publishedAt)}</Text>
                  ) : null}
                  {video.viewCount !== null ? (
                    <Text style={styles.youtubeSub}>再生回数: {formatYouTubeViewCount(video.viewCount)} 回</Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );
}
