import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { BrowserSecretInputRequest } from "../hooks/useBrowserSecretInput";
import { AppModal } from "./AppModal";
import { useVisualTheme } from "../theme/VisualThemeContext";

export function BrowserSecretInputModal({ request, sending, onSubmit, onCancel }: {
  request: BrowserSecretInputRequest | null;
  sending: boolean;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const { theme } = useVisualTheme();
  const valid = value.length > 0 && value.length <= 4096;
  useEffect(() => { setValue(""); }, [request]);
  const submit = () => {
    if (!request || sending || !valid) return;
    const input = value;
    setValue("");
    void onSubmit(input);
  };
  return <AppModal visible={!!request} transparent animationType="fade" onRequestClose={onCancel}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.card, { backgroundColor: theme.colors.surface }]}>
        <Text style={[styles.title, { color: theme.colors.textPrimary }]}>ブラウザに直接入力</Text>
        <Text style={{ color: theme.colors.textPrimary }}>{request?.destinationOrigin}</Text>
        {request && request.topOrigin !== request.destinationOrigin && <Text style={{ color: theme.colors.textPrimary }}>ページ: {request.topOrigin}</Text>}
        <Text style={{ color: theme.colors.textPrimary }}>{request?.label}</Text>
        <TextInput accessibilityLabel="秘密の入力内容" secureTextEntry autoCorrect={false} autoCapitalize="none"
          textContentType="none" autoComplete="off" editable={!sending} value={value} onChangeText={setValue}
          style={[styles.input, { color: theme.colors.textPrimary, borderColor: theme.colors.borderStrong }]} />
        <Text style={{ color: theme.colors.textPrimary }}>入力内容はAIへの回答・会話履歴に送信しません。</Text>
        {value.length > 4096 && <Text style={{ color: theme.colors.textPrimary }}>4096文字以内で入力してください。</Text>}
        <View style={styles.actions}>
          <TouchableOpacity onPress={() => { setValue(""); onCancel(); }}><Text style={{ color: theme.colors.controlAccent }}>キャンセル</Text></TouchableOpacity>
          <TouchableOpacity disabled={sending || !valid} onPress={submit} accessibilityRole="button" accessibilityState={{ disabled: sending || !valid }}>
            <Text style={{ color: theme.colors.controlAccent, opacity: sending || !valid ? 0.4 : 1 }}>{sending ? "入力中…" : "入力する"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  </AppModal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.5)" },
  card: { padding: 20, gap: 16, borderRadius: 12 },
  title: { fontSize: 18, fontWeight: "700" },
  input: { borderWidth: 1, borderRadius: 8, padding: 12 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 24 },
});
