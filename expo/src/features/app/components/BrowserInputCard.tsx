import { useContext, useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { BrowserSecretInputRequest } from "../hooks/useBrowserSecretInput";
import { BrowserInputContext } from "../contexts/BrowserInputContext";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { formatMessageTimestampLabel } from "../utils/formatting";

const statusText = { filling: "ブラウザへ入力中…", completed: "ブラウザへの入力が完了しました", cancelled: "キャンセルしました",
  expired: "接続が終了したため入力できません", invalidated: "ブラウザの入力先が変わりました", failed: "入力先を準備できませんでした",
  input_status_unknown: "入力結果を確認できません。自動で再送しないでください。" };

export function BrowserInputCard({ request }: { request: BrowserSecretInputRequest }) {
  const controller = useContext(BrowserInputContext);
  const [value, setValue] = useState(() => controller?.drafts.get(request.requestId) || "");
  const { theme } = useVisualTheme();
  const valid = value.length > 0 && value.length <= 4096;
  useEffect(() => { setValue(request.status === "pending" ? controller?.drafts.get(request.requestId) || "" : ""); }, [controller?.drafts, request.requestId, request.status]);
  if (!controller) return null;
  return <View testID={`browser-input-${request.requestId}`} style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.borderStrong }]}>
    <Text style={[styles.title, { color: theme.colors.textPrimary }]}>ブラウザに直接入力 · {formatMessageTimestampLabel(request.createdAt)}</Text>
    <Text style={{ color: theme.colors.textPrimary }}>{request.destinationOrigin}</Text>
    {request.topOrigin !== request.destinationOrigin && <Text style={{ color: theme.colors.textPrimary }}>ページ: {request.topOrigin}</Text>}
    <Text style={{ color: theme.colors.textPrimary }}>{request.label}</Text>
    {request.status === "pending" ? <>
      <TextInput accessibilityLabel="ブラウザへの入力内容" autoCorrect={false} autoCapitalize="none" textContentType="none" autoComplete="off"
        value={value} onChangeText={(next) => { controller.drafts.set(request.requestId, next); setValue(next); }}
        style={[styles.input, { color: theme.colors.textPrimary, borderColor: theme.colors.borderStrong }]} />
      <Text style={{ color: theme.colors.textPrimary }}>入力内容はAIへの回答・会話履歴に送信しません。</Text>
      {value.length > 4096 && <Text style={{ color: theme.colors.textPrimary }}>4096文字以内で入力してください。</Text>}
      <View style={styles.actions}>
        <TouchableOpacity onPress={() => { setValue(""); controller.cancel(request.requestId); }}><Text style={{ color: theme.colors.controlAccent }}>キャンセル</Text></TouchableOpacity>
        <TouchableOpacity disabled={!valid} accessibilityRole="button" accessibilityState={{ disabled: !valid }}
          onPress={() => { if (!valid) return; const input = value; setValue(""); void controller.submit(request.requestId, input); }}>
          <Text style={{ color: theme.colors.controlAccent, opacity: valid ? 1 : 0.4 }}>ブラウザへ入力</Text>
        </TouchableOpacity>
      </View>
    </> : <Text style={{ color: theme.colors.textPrimary }}>{statusText[request.status]}</Text>}
  </View>;
}
const styles = StyleSheet.create({ card: { padding: 16, gap: 12, borderRadius: 12, borderWidth: 1, marginVertical: 8 },
  title: { fontSize: 15, fontWeight: "700" }, input: { borderWidth: 1, borderRadius: 8, padding: 12 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 24 } });
