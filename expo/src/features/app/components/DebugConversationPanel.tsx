import { Image, Text, TouchableOpacity, View } from "react-native";
import { useConversation } from "../contexts/ConversationContext";
import { useDebugConversation } from "../contexts/DebugConversationContext";
import { styles } from "../styles";
import { BouncingDotsIndicator } from "./BouncingDotsIndicator";
import { MarkdownText } from "./MarkdownText";
import { YouTubeVideoList } from "./YouTubeVideoList";

export function DebugConversationPanel() {
  const { conversationMessages, startNewSession, reply } = useConversation();
  const {
    llmVisual,
    llmStatusText,
    llmUiStatusDetail,
    llmPixelIconKey,
    pixelStatusAnimations,
    llmActiveToolCalls,
    llmElapsedLabel,
    llmLastToolCall,
    streamAudioQueueSize,
    streamMode,
    streamLlmNativeDeltaCount,
    streamLlmPseudoDeltaCount,
    streamFirstNativeDeltaOffsetMs,
    ttsDebugStats,
    streamLlmProgress,
    streamLlmDeltas,
    streamSegments,
    trimForInline,
    replyDebug,
    latestAssistantYouTubeVideos,
    youtubePlayerMessageId,
    youtubePlayerVideoId,
    youtubeEmbedHtml,
    youtubePlayerSession,
    youtubeEmbedOrigin,
    onYouTubeWebViewMessage,
    onOpenLatestYouTubeVideo,
    formatYouTubePublishedDate,
    formatYouTubeViewCount,
    canReadReplyAudio,
    ttsLoading,
    synthesizeSpeech,
    hasTtsSound,
    stopTtsPlayback,
    ttsUri,
    history,
  } = useDebugConversation();
  const hasConversation = conversationMessages.length > 0;
  const useBouncingDotsStatus = llmPixelIconKey === "model_generating" || llmPixelIconKey === "model_processing";
  return (
    <>
      <View style={[styles.llmStatusCard, { backgroundColor: llmVisual.bg, borderColor: llmVisual.border }]}>
        <View style={styles.llmStatusHeader}>
          <View style={useBouncingDotsStatus ? styles.llmStatusBadge : [styles.llmStatusBadge, { backgroundColor: llmVisual.border }]}>
            <View style={styles.llmStatusLottieWrap}>
              {useBouncingDotsStatus ? (
                <BouncingDotsIndicator />
              ) : (
                <Image
                  source={pixelStatusAnimations[llmPixelIconKey]}
                  style={styles.llmStatusLottie}
                />
              )}
            </View>
            {useBouncingDotsStatus ? null : (
              <Text style={[styles.llmStatusBadgeText, { color: llmVisual.text }]}>
                {llmStatusText}
              </Text>
            )}
          </View>
        </View>
        <Text style={[styles.llmStatusDetail, { color: llmVisual.text }]}>
          {llmUiStatusDetail || "status detail unavailable"}
        </Text>
        <View style={styles.llmMetaRow}>
          <Text style={styles.llmMetaChip}>tools: {llmActiveToolCalls}</Text>
          <Text style={styles.llmMetaChip}>elapsed: {llmElapsedLabel}</Text>
          {llmLastToolCall ? (
            <Text style={styles.llmMetaChip}>
              {llmLastToolCall.phase === "start" ? "start" : "done"} {llmLastToolCall.toolName}
              {llmLastToolCall.status ? ` (${llmLastToolCall.status})` : ""}
              {llmLastToolCall.durationMs !== null && llmLastToolCall.durationMs !== undefined
                ? ` ${llmLastToolCall.durationMs}ms`
                : ""}
            </Text>
          ) : (
            <Text style={styles.llmMetaChip}>tool: -</Text>
          )}
        </View>
        {llmLastToolCall?.summary ? (
          <Text style={styles.llmSummaryText}>{llmLastToolCall.summary}</Text>
        ) : null}
      </View>
      <Text style={styles.hint}>音声キュー: {streamAudioQueueSize}</Text>
      <Text style={styles.hint}>ストリームモード: {streamMode || "-"}</Text>
      <Text style={styles.hint}>LLM native delta数: {streamLlmNativeDeltaCount}</Text>
      <Text style={styles.hint}>擬似/mock delta数: {streamLlmPseudoDeltaCount}</Text>
      <Text style={styles.hint}>
        first native delta: {streamFirstNativeDeltaOffsetMs !== null ? `+${streamFirstNativeDeltaOffsetMs}ms` : "-"}
      </Text>
      <Text style={styles.hint}>
        TTS DBG synth#{ttsDebugStats.synthRequests} mime={ttsDebugStats.synthMimeType || "-"} det={ttsDebugStats.synthDetected} bytes={ttsDebugStats.synthAudioBytes} wf={ttsDebugStats.synthWaveformBars}
      </Text>
      <Text style={styles.hint}>
        TTS DBG play#{ttsDebugStats.playAttempts} ext={ttsDebugStats.playExt || "-"} det={ttsDebugStats.playDetected} bytes={ttsDebugStats.playAudioBytes} statusErr={ttsDebugStats.playStatusErrors} lastErr={ttsDebugStats.playLastStatusError || "-"}
      </Text>
      <Text style={styles.hint}>
        TTS DBG chunk={ttsDebugStats.streamChunkCount} lastSeq={ttsDebugStats.streamLastSeq} mime={ttsDebugStats.streamLastMimeType || "-"} bytes={ttsDebugStats.streamLastAudioBytes} wf={ttsDebugStats.streamLastWaveformBars} merged={ttsDebugStats.streamMergedWaveformBars}
      </Text>
      {streamLlmProgress.length > 0 ? (
        <View style={styles.streamList}>
          {streamLlmProgress.slice(-8).map((item, idx) => (
            <View key={`${item.stage}-${item.at}-${idx}`} style={styles.streamItem}>
              <Text style={styles.streamStatus}>
                {item.stage}
                {item.round !== null && item.maxToolRounds !== null
                  ? ` [r:${item.round}/${item.maxToolRounds}]`
                  : (item.round !== null ? ` [r:${item.round}]` : "")}
                {item.toolCalls !== null ? ` [tools:${item.toolCalls}]` : ""}
                {item.pendingToolCalls !== null ? ` [pending:${item.pendingToolCalls}]` : ""}
                {item.status ? ` [${item.status}]` : ""}
              </Text>
              {item.message ? <Text style={styles.streamText}>{item.message}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
      {streamLlmDeltas.length > 0 ? (
        <View style={styles.streamList}>
          {streamLlmDeltas.slice(-6).map((item, idx) => (
            <View key={`${item.source}-${idx}`} style={styles.streamItem}>
              <Text style={styles.streamStatus}>LLM {item.source}</Text>
              <Text style={styles.streamText}>{item.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {streamSegments.length > 0 ? (
        <View style={styles.streamList}>
          {streamSegments.slice(-8).map((segment) => (
            <View key={`${segment.messageId}:${segment.seq}`} style={styles.streamItem}>
              <Text style={styles.streamStatus}>
                #{segment.seq + 1} {segment.status}
                {segment.chunkChars !== null && segment.chunkChars !== undefined
                  ? ` [ch:${segment.chunkChars}]`
                  : ""}
                {segment.estimatedDurationMs !== null && segment.estimatedDurationMs !== undefined
                  ? ` [est:${segment.estimatedDurationMs}ms]`
                  : ""}
                {segment.actualDurationMs !== null && segment.actualDurationMs !== undefined
                  ? ` [act:${segment.actualDurationMs}ms]`
                  : ""}
                {segment.status === "played" && segment.playedSinceFirstNativeDeltaMs !== null
                  ? ` (+${segment.playedSinceFirstNativeDeltaMs}ms from first native delta)`
                  : ""}
                {segment.status === "played" && segment.llmNativeDeltaCountAtPlayed !== null
                  ? ` [LLMΔ:${segment.llmNativeDeltaCountAtPlayed}]`
                  : ""}
                {segment.status === "played" && segment.llmNativeDeltaLastAtPlayed
                  ? ` "${trimForInline(segment.llmNativeDeltaLastAtPlayed)}"`
                  : ""}
              </Text>
              <Text style={styles.streamText}>{segment.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.buttonSecondary, !hasConversation && styles.buttonDisabled]}
          onPress={() => startNewSession()}
          disabled={!hasConversation}
        >
          <Text style={styles.buttonText}>Reset Conversation</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.label}>Assistant Reply</Text>
      <View style={styles.replyBox}>
        {reply ? (
          <MarkdownText
            content={reply}
            tone="assistant"
            textStyle={styles.replyText}
          />
        ) : (
          <Text style={styles.replyText}>No response yet.</Text>
        )}
      </View>
      {replyDebug ? <Text style={styles.hint}>Reply Debug: {replyDebug}</Text> : null}
      {latestAssistantYouTubeVideos.length > 0 ? (
        <>
          <Text style={styles.label}>Latest Message YouTube Videos</Text>
          <YouTubeVideoList
            videos={latestAssistantYouTubeVideos}
            isVideoActive={(videoId) => (
              youtubePlayerMessageId === "__latest__" &&
              youtubePlayerVideoId === videoId
            )}
            onOpenVideo={onOpenLatestYouTubeVideo}
            youtubePlayerVideoId={youtubePlayerVideoId}
            youtubePlayerSession={youtubePlayerSession}
            youtubeEmbedHtml={youtubeEmbedHtml}
            youtubeEmbedOrigin={youtubeEmbedOrigin}
            onYouTubeWebViewMessage={onYouTubeWebViewMessage}
            formatYouTubePublishedDate={formatYouTubePublishedDate}
            formatYouTubeViewCount={formatYouTubeViewCount}
          />
          <Text style={styles.hint}>プレイヤー右下の全画面ボタンでフルスクリーン表示できます。</Text>
        </>
      ) : null}
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.buttonSecondary, !canReadReplyAudio && styles.buttonDisabled]}
          onPress={synthesizeSpeech}
          disabled={!canReadReplyAudio}
        >
          <Text style={styles.buttonText}>{ttsLoading ? "Synthesizing..." : "Read Reply (/tts)"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonSecondary, !hasTtsSound && styles.buttonDisabled]}
          onPress={stopTtsPlayback}
          disabled={!hasTtsSound}
        >
          <Text style={styles.buttonText}>Stop Audio</Text>
        </TouchableOpacity>
      </View>
      {ttsUri ? <Text style={styles.hint}>最終TTSファイル: {ttsUri}</Text> : null}

      <Text style={styles.label}>History (latest 10)</Text>
      {history.length === 0 ? (
        <Text style={styles.hint}>履歴はまだありません。</Text>
      ) : (
        history.map((item) => (
          <View key={item.id} style={styles.historyItem}>
            <Text style={styles.historyTime}>{item.createdAt}</Text>
            <Text style={styles.historyBody}>U: {item.transcript}</Text>
            <Text style={styles.historyBody}>A: {item.reply}</Text>
          </View>
        ))
      )}
    </>
  );
}
