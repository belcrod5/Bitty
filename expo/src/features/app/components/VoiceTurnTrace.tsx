import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVisualTheme } from "../theme/VisualThemeContext";

export type VoiceTurnTraceData = {
  messages: { id: string; phase: string | null; text: string; truncated?: boolean }[];
  tools: { id: string; type: string; name: string; status: string; input?: string; output?: string; exitCode?: number; inputTruncated?: boolean; outputTruncated?: boolean }[];
};
const monospace = Platform.select({ ios: "Menlo", default: "monospace" });
const labels: Record<string, string> = { commandExecution: "コマンド", webSearch: "Web検索", fileChange: "ファイル編集",
  mcpToolCall: "外部ツール", dynamicToolCall: "ツール", collabAgentToolCall: "エージェント" };

// Public native commentary and tool evidence, never reasoning or peer context.
export function VoiceTurnTrace({ trace, live = false }: { trace: VoiceTurnTraceData; live?: boolean }) {
  const { theme } = useVisualTheme();
  const [expanded, setExpanded] = useState(false);
  const commentary = trace.messages.filter((item) => item.phase === "commentary" && item.text.trim());
  if (!trace.tools.length && !commentary.length) return null;
  const running = trace.tools.findLast((tool) => tool.status === "running" || tool.status === "inProgress");
  const uncertain = trace.tools.some((tool) => ["failed", "declined", "interrupted", "cancelled", "canceled", "unknown"].includes(tool.status));
  const title = running ? `${labels[running.type] || running.name}を実行中` : live ? "作業の様子" : "作業の記録";
  return <View style={{ gap: 10, marginTop: 10 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }}
      onPress={() => setExpanded((value) => !value)} style={{ flexDirection: "row", alignItems: "center", gap: 7, minHeight: 32 }}>
      <Ionicons name={running ? "radio-button-on" : uncertain ? "alert-circle-outline" : "checkmark-circle-outline"} size={15} color={theme.colors.textSecondary} />
      <Text style={{ color: theme.colors.textSecondary, fontSize: 12, flex: 1 }}>{title}{trace.tools.length ? ` · ${trace.tools.length}件` : ""}</Text>
      <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={14} color={theme.colors.textSecondary} />
    </Pressable>
    {live && commentary.length && !expanded ? <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 }}>
      {commentary.at(-1)?.text.trim()}{commentary.at(-1)?.truncated ? "\n（途中表示は一部省略）" : ""}</Text> : null}
    {expanded ? <View style={{ gap: 14, paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: theme.colors.border }}>
      {commentary.map((item) => <Text key={item.id} selectable style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 }}>{item.text.trim()}{item.truncated ? "\n（途中表示は一部省略）" : ""}</Text>)}
      {trace.tools.map((tool) => <View key={tool.id} style={{ gap: 5 }}>
        <Text style={{ color: theme.colors.textPrimary, fontSize: 12, fontWeight: "600" }}>{labels[tool.type] || tool.name}{tool.name !== tool.type ? ` · ${tool.name}` : ""}
          {tool.status === "running" || tool.status === "inProgress" ? " · 実行中" : tool.status === "failed" ? " · 失敗" : tool.status === "declined" ? " · 拒否"
            : ["interrupted", "cancelled", "canceled"].includes(tool.status) ? " · 中断" : tool.status === "unknown" ? " · 結果未確認" : " · 終了"}
          {tool.exitCode !== undefined ? ` (${tool.exitCode})` : ""}</Text>
        {tool.input ? <Text selectable style={{ color: theme.colors.textSecondary, fontFamily: monospace, fontSize: 12, lineHeight: 18 }}>{tool.input}{tool.inputTruncated ? "\n（入力の表示は一部省略）" : ""}</Text> : null}
        {tool.output ? <Text selectable style={{ color: theme.colors.textSecondary, fontFamily: monospace, fontSize: 12, lineHeight: 18 }}>{tool.output}{tool.outputTruncated ? "\n（出力の表示は一部省略）" : ""}</Text> : null}
      </View>)}
    </View> : null}
  </View>;
}
