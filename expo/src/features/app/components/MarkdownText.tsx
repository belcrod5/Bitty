import { useCallback, useMemo } from "react";
import {
  Alert,
  Linking,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
  type TextContextMenuItem,
} from "react-native-enriched-markdown";
import * as Clipboard from "expo-clipboard";
import { styles } from "../styles";
import {
  prepareMarkdownForDisplay,
  splitMarkdownForMermaid,
} from "../utils/markdownDisplay";
import { MermaidCodeBlock } from "./MermaidCodeBlock";

const MONOSPACE_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});
const MERMAID_FENCE_PATTERN = /(?:^|\n) {0,3}(?:`{3,}|~{3,})\s*mermaid\b/i;
const HEADING_SCALE_MAP: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 1.32,
  2: 1.24,
  3: 1.16,
  4: 1.1,
  5: 1.04,
  6: 1,
};

function normalizeExternalUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  return /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
}

function normalizeLocalFileLink(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return "";
  if (/^www\./i.test(trimmed)) return "";
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (schemeMatch && schemeMatch[1].toLowerCase() !== "file") return "";
  const withoutScheme = trimmed.replace(/^file:\/\//i, "");
  let decoded = withoutScheme;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {}
  return decoded.replace(/:\d+(?::\d+)?$/, "").trim();
}

export type MarkdownTextProps = {
  content: string;
  tone: "user" | "assistant";
  textStyle: StyleProp<TextStyle>;
  onLocalFileLinkPress?: (path: string) => void;
  onSelectedTextTtsPress?: (text: string) => void;
};

export function MarkdownText(props: MarkdownTextProps) {
  const { content, tone, textStyle, onLocalFileLinkPress, onSelectedTextTtsPress } = props;
  const markdown = useMemo(
    () => prepareMarkdownForDisplay(content),
    [content]
  );
  const hasMermaidFence = useMemo(
    () => MERMAID_FENCE_PATTERN.test(markdown),
    [markdown]
  );
  const mermaidSegments = useMemo(
    () => (hasMermaidFence ? splitMarkdownForMermaid(content) : null),
    [content, hasMermaidFence]
  );
  const flattenedTextStyle = useMemo(
    () => (StyleSheet.flatten(textStyle) || {}) as TextStyle,
    [textStyle]
  );

  const markdownStyle = useMemo<MarkdownStyle>(() => {
    const baseFontSize =
      typeof flattenedTextStyle.fontSize === "number"
        ? flattenedTextStyle.fontSize
        : 14;
    const baseLineHeight =
      typeof flattenedTextStyle.lineHeight === "number"
        ? flattenedTextStyle.lineHeight
        : 20;
    const baseColor =
      typeof flattenedTextStyle.color === "string"
        ? flattenedTextStyle.color
        : "#0f172a";
    const baseFontFamily =
      typeof flattenedTextStyle.fontFamily === "string"
        ? flattenedTextStyle.fontFamily
        : undefined;
    const baseFontWeight =
      typeof flattenedTextStyle.fontWeight === "string"
        ? flattenedTextStyle.fontWeight
        : undefined;

    const sharedBlockStyle = {
      fontSize: baseFontSize,
      lineHeight: baseLineHeight,
      color: baseColor,
      fontFamily: baseFontFamily,
      fontWeight: baseFontWeight,
      marginTop: 0,
      marginBottom: 0,
    };

    const codeBackgroundColor =
      tone === "user" ? "rgba(15, 23, 42, 0.28)" : "#e2e8f0";
    const codeBlockBackgroundColor =
      tone === "user" ? "rgba(15, 23, 42, 0.24)" : "#f8fafc";
    const codeBlockBorderColor =
      tone === "user" ? "rgba(226, 232, 240, 0.4)" : "#cbd5e1";

    return {
      paragraph: {
        ...sharedBlockStyle,
      },
      h1: {
        ...sharedBlockStyle,
        fontSize: Math.round(baseFontSize * HEADING_SCALE_MAP[1]),
        fontWeight: "800",
      },
      h2: {
        ...sharedBlockStyle,
        fontSize: Math.round(baseFontSize * HEADING_SCALE_MAP[2]),
        fontWeight: "800",
      },
      h3: {
        ...sharedBlockStyle,
        fontSize: Math.round(baseFontSize * HEADING_SCALE_MAP[3]),
        fontWeight: "800",
      },
      h4: {
        ...sharedBlockStyle,
        fontSize: Math.round(baseFontSize * HEADING_SCALE_MAP[4]),
        fontWeight: "800",
      },
      h5: {
        ...sharedBlockStyle,
        fontSize: Math.round(baseFontSize * HEADING_SCALE_MAP[5]),
        fontWeight: "800",
      },
      h6: {
        ...sharedBlockStyle,
        fontSize: Math.round(baseFontSize * HEADING_SCALE_MAP[6]),
        fontWeight: "800",
      },
      strong: {
        color: baseColor,
        fontWeight: "bold",
      },
      em: {
        color: baseColor,
        fontStyle: "italic",
      },
      link: {
        color: "#1d4ed8",
        underline: true,
      },
      code: {
        fontFamily: MONOSPACE_FONT,
        fontSize: baseFontSize,
        color: baseColor,
        backgroundColor: codeBackgroundColor,
        borderColor: "transparent",
      },
      codeBlock: {
        ...sharedBlockStyle,
        fontFamily: MONOSPACE_FONT,
        backgroundColor: codeBlockBackgroundColor,
        borderColor: codeBlockBorderColor,
        borderRadius: 8,
        borderWidth: 1,
        padding: 8,
      },
      blockquote: {
        ...sharedBlockStyle,
        borderColor: "#94a3b8",
        borderWidth: 3,
        gapWidth: 8,
      },
      list: {
        ...sharedBlockStyle,
        markerColor: baseColor,
        gapWidth: 6,
        marginLeft: 0,
      },
    };
  }, [flattenedTextStyle, tone]);

  const containerStyle = useMemo<ViewStyle>(
    () => ({
      ...(styles.markdownRoot as ViewStyle),
      ...(tone === "assistant"
        ? (styles.markdownRootAssistant as ViewStyle)
        : (styles.markdownRootUser as ViewStyle)),
    }),
    [tone]
  );

  const handleOpenLink = useCallback((rawUrl: string) => {
    const localFilePath = normalizeLocalFileLink(rawUrl);
    if (localFilePath && typeof onLocalFileLinkPress === "function") {
      onLocalFileLinkPress(localFilePath);
      return;
    }
    const url = normalizeExternalUrl(rawUrl);
    if (!url) return;
    void Linking.openURL(url).catch((error) => {
      console.warn("[chat] failed to open external url", { url, error });
    });
  }, [onLocalFileLinkPress]);

  const copySelectedText = useCallback((selectedTextRaw: unknown) => {
    const selectedText = String(selectedTextRaw || "");
    if (!selectedText.trim()) return;
    void Clipboard.setStringAsync(selectedText).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      Alert.alert("コピー失敗", message || "選択したテキストをコピーできませんでした。");
    });
  }, []);

  const readSelectedText = useCallback((selectedTextRaw: unknown) => {
    const selectedText = String(selectedTextRaw || "").trim();
    if (!selectedText) return;
    onSelectedTextTtsPress?.(selectedText);
  }, [onSelectedTextTtsPress]);

  const contextMenuItems = useMemo<TextContextMenuItem[]>(() => {
    const items: TextContextMenuItem[] = [
      {
        text: "コピー",
        icon: "doc.on.doc",
        onPress: ({ text }) => copySelectedText(text),
      },
    ];
    if (onSelectedTextTtsPress) {
      items.unshift({
        text: "読み上げ",
        icon: "speaker.wave.2",
        onPress: ({ text }) => readSelectedText(text),
      });
    }
    return items;
  }, [copySelectedText, onSelectedTextTtsPress, readSelectedText]);

  if (!mermaidSegments || (mermaidSegments.length === 1 && mermaidSegments[0]?.type === "markdown")) {
    return (
      <EnrichedMarkdownText
        markdown={markdown}
        selectable
        flavor="github"
        allowTrailingMargin={false}
        containerStyle={containerStyle}
        markdownStyle={markdownStyle}
        contextMenuItems={contextMenuItems}
        onLinkPress={({ url }) => {
          handleOpenLink(url);
        }}
      />
    );
  }

  return (
    <View style={containerStyle}>
      {mermaidSegments.map((segment, index) => {
        if (segment.type === "mermaid") {
          return (
            <MermaidCodeBlock
              key={`mermaid-${index}`}
              chart={segment.chart}
              codeBlockStyle={markdownStyle.codeBlock ?? {}}
            />
          );
        }

        return (
          <EnrichedMarkdownText
            key={`markdown-${index}`}
            markdown={segment.markdown}
            selectable
            flavor="github"
            allowTrailingMargin={false}
            containerStyle={styles.markdownRoot}
            markdownStyle={markdownStyle}
            contextMenuItems={contextMenuItems}
            onLinkPress={({ url }) => {
              handleOpenLink(url);
            }}
          />
        );
      })}
    </View>
  );
}
