import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View, type StyleProp, type TextStyle } from "react-native";
import { MarkdownText } from "./MarkdownText";

type InternalContextMessageProps = {
  content: string;
  unclassified?: boolean;
  // 既定のCODEX CONTEXT以外の見出し(subagent会話等)を出したい時に指定する。
  title?: string;
  textStyle: StyleProp<TextStyle>;
  onLocalFileLinkPress?: (path: string) => void;
  onSelectedTextTtsPress?: (text: string) => void;
};

export function InternalContextMessage(props: InternalContextMessageProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={componentStyles.container}>
      <TouchableOpacity
        style={componentStyles.header}
        onPress={() => setExpanded((current) => !current)}
        accessibilityRole="button"
        accessibilityLabel={`Codex情報を${expanded ? "折りたたむ" : "展開"}`}
        accessibilityState={{ expanded }}
      >
        <Text style={componentStyles.title}>
          {props.title ?? (props.unclassified ? "CODEX CONTEXT · 未分類" : "CODEX CONTEXT")}
        </Text>
        <Text style={componentStyles.action}>{expanded ? "折りたたむ ▴" : "内容を表示 ▾"}</Text>
      </TouchableOpacity>
      {expanded ? (
        <MarkdownText
          content={props.content}
          tone="assistant"
          textStyle={props.textStyle}
          onLocalFileLinkPress={props.onLocalFileLinkPress}
          onSelectedTextTtsPress={props.onSelectedTextTtsPress}
        />
      ) : null}
    </View>
  );
}

const componentStyles = StyleSheet.create({
  container: {
    borderLeftWidth: 2,
    borderLeftColor: "#cbd5e1",
    paddingLeft: 10,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 32,
  },
  title: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  action: {
    color: "#475569",
    fontSize: 11,
    fontWeight: "700",
  },
});
