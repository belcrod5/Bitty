import { Platform } from "react-native";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

export function createChatMessageStyles(theme: VisualTheme) {
  return {
  chatMessageGroup: {
    gap: 6,
    width: "100%",
    marginBottom: 30,
  },
  chatFindFocusedMessage: {
    backgroundColor: theme.colors.searchHighlight,
    borderRadius: 8,
  },
  chatBubble: {
    borderRadius: 12,
    borderWidth: 0,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
    maxWidth: "92%",
  },
  chatBubbleUser: {
    alignSelf: "flex-end",
    maxWidth: "84%",
    backgroundColor: theme.colors.surfaceMuted,
    borderWidth: 0,
    borderColor: "transparent",
  },
  chatBubbleAssistant: {
    alignSelf: "stretch",
    width: "100%",
    maxWidth: "100%",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
    borderRadius: 0,
    minWidth: 0,
  },
  chatBubbleInheritedFromParent: {
    opacity: 0.52,
  },
  chatSubagentBoundary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 2,
    marginBottom: 18,
  },
  chatSubagentBoundaryLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  chatSubagentBoundaryText: {
    color: theme.colors.textMuted,
    fontSize: theme.typography.caption.fontSize,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  chatBubbleLabel: {
    fontSize: theme.typography.micro.fontSize,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  chatBubbleLabelUser: {
    color: theme.colors.textMuted,
  },
  chatBubbleLabelAssistant: {
    color: theme.colors.textMuted,
  },
  chatBubbleText: {
    fontSize: theme.typography.body.fontSize,
    lineHeight: theme.typography.body.lineHeight,
    flexShrink: 1,
    minWidth: 0,
  },
  chatBubbleTextUser: {
    color: theme.colors.textPrimary,
  },
  chatBubbleTextAssistant: {
    color: theme.colors.textPrimary,
  },
  chatUserMetaRow: {
    marginTop: 2,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  chatUserMetaChip: {
    fontSize: theme.typography.micro.fontSize,
    color: theme.colors.userCodeText,
    backgroundColor: theme.colors.userCodeSurface,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.userMetaBorder,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
  },
  chatUserQueueRow: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
  },
  chatUserQueueText: {
    fontSize: theme.typography.micro.fontSize,
    color: theme.tones.neutral.foreground,
    fontWeight: "700",
  },
  chatUserQueueCancelButton: {
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.border,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: theme.colors.surface,
  },
  chatUserQueueCancelButtonText: {
    fontSize: theme.typography.micro.fontSize,
    color: theme.colors.textSecondary,
    fontWeight: "800",
  },
  markdownRoot: {
    gap: 4,
    minWidth: 0,
  },
  markdownRootUser: {
    alignSelf: "flex-start",
    minWidth: 0,
  },
  markdownRootAssistant: {
    alignSelf: "stretch",
    width: "100%",
    minWidth: 0,
  },
  markdownBlockText: {
    marginVertical: 0,
  },
  markdownHeadingText: {
    fontWeight: "800",
  },
  markdownStrong: {
    fontWeight: "700",
  },
  markdownEm: {
    fontStyle: "italic",
  },
  markdownLinkText: {
    textDecorationLine: "underline",
    color: theme.colors.accentStrong,
  },
  markdownInlineCode: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    borderRadius: 4,
    overflow: "hidden",
    paddingHorizontal: 4,
  },
  markdownInlineCodeUser: {
    backgroundColor: theme.colors.userCodeSurface,
  },
  markdownInlineCodeAssistant: {
    backgroundColor: theme.colors.surfaceSubtle,
  },
  markdownCodeBlock: {
    borderRadius: 8,
    borderWidth: theme.borders.thin,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  markdownCodeBlockUser: {
    borderColor: theme.colors.userCodeBorder,
    backgroundColor: theme.colors.userCodeBlockSurface,
  },
  markdownCodeBlockAssistant: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceRaised,
  },
  markdownCodeBlockText: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  markdownListItemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    minWidth: 0,
  },
  markdownListItemMarker: {
    minWidth: 14,
  },
  markdownListItemText: {
    flex: 1,
    minWidth: 0,
  },
  markdownQuoteWrap: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 8,
    minWidth: 0,
  },
  markdownQuoteBar: {
    width: 3,
    borderRadius: 999,
    backgroundColor: theme.colors.borderStrong,
  },
  markdownQuoteText: {
    flex: 1,
    opacity: 0.92,
    minWidth: 0,
  },
  chatAudioBubble: {
    alignSelf: "flex-start",
    width: "100%",
    maxWidth: "100%",
    borderWidth: 0,
    borderColor: "transparent",
    borderRadius: 0,
    backgroundColor: "transparent",
    paddingHorizontal: 0,
    paddingBottom: 0,
    paddingTop: 0,
  },
  chatTtsWaveformCard: {
    width: "100%",
    minHeight: 44,
    borderWidth: 0,
    borderColor: "transparent",
    borderRadius: 0,
    backgroundColor: "transparent",
    paddingHorizontal: 0,
    paddingVertical: 0,
    position: "relative",
  },
  chatWaveformGif: {
    borderRadius: 6,
  },
  chatTtsRingSvg: {
    position: "absolute",
    left: 0,
    top: 0,
  },
  chatTtsStatusFloatingWrap: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  chatTtsStatusFloatingBadge: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  chatTtsStatusLottie: {
    width: 22,
    height: 22,
  },
  chatTtsPlayFloatingWrap: {
    position: "absolute",
    right: 0,
    top: 0,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  chatTtsGenerationRingWrap: {
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 0,
  },
  chatTtsPlaybackRingWrap: {
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  chatAssistantMetaRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 8,
  },
  chatStatusChip: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: theme.borders.thin,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
    gap: 5,
  },
  chatStatusChipNoIcon: {
    gap: 0,
  },
  chatStatusIcon: {
    fontSize: theme.typography.micro.fontSize,
    fontWeight: "800",
    minWidth: 10,
    textAlign: "center",
  },
  chatStatusLottieWrap: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  chatStatusLottie: {
    width: 28,
    height: 28,
    borderRadius: 999,
    overflow: "hidden",
  },
  chatStatusText: {
    fontSize: theme.typography.caption.fontSize,
    fontWeight: "700",
  },
  chatStatusDetailText: {
    marginTop: 2,
    fontSize: theme.typography.caption.fontSize,
    color: theme.colors.textMuted,
  },
  chatMessageMetaRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  chatMessageMetaRowUser: {
    justifyContent: "flex-end",
  },
  chatMessageMetaRowAssistant: {
    justifyContent: "flex-start",
  },
  chatMessageTimestampText: {
    fontSize: theme.typography.micro.fontSize,
    color: theme.colors.borderStrong,
  },
  chatMessageTimestampTextUser: {
    textAlign: "right",
  },
  chatMessageTimestampTextAssistant: {
    textAlign: "left",
  },
  chatMessageMetaIconButton: {
    width: 20,
    height: 20,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  chatAudioIconButton: {
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  chatAudioIconButtonActive: {
    borderColor: theme.tones.danger.border,
    backgroundColor: theme.tones.danger.background,
  },
  chatSection: {
    gap: 4,
  },
  chatSectionTitle: {
    fontSize: theme.typography.compact.fontSize,
    fontWeight: "700",
    color: theme.colors.textBodyStrong,
  },
  } as const;
}

export const chatMessageStylesByTheme = createStylesByTheme(createChatMessageStyles);
