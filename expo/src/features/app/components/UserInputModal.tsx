import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { UserInputRequest, UserInputResponse } from "../../codex/userInput";
import { AppModal } from "./AppModal";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

export function UserInputModal(props: {
  request: UserInputRequest | null;
  onDecide: (response: UserInputResponse | null) => void;
}) {
  const { themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const request = props.request;
  useEffect(() => {
    setAnswers({});
    setNow(Date.now());
    if (!request) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= request.startedAtMs + 60_000) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [request]);
  const remaining = request ? Math.max(0, Math.ceil((request.startedAtMs + 60_000 - now) / 1000)) : 0;
  const canAnswer = !!request?.questions.length && request.questions.every((question) => answers[question.id]?.trim());
  const submit = () => {
    if (!request || !canAnswer || remaining === 0) return;
    props.onDecide({ answers: Object.fromEntries(request.questions.map((question) => [
      question.id, { answers: [answers[question.id].trim()] },
    ])) });
  };
  return (
    <AppModal visible={!!request && remaining > 0} transparent animationType="fade"
      onRequestClose={() => props.onDecide({ answers: {} })}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.card}>
          <Text style={styles.title}>質問 · 残り{remaining}秒</Text>
          <ScrollView keyboardShouldPersistTaps="handled">
            {request?.questions.map((question) => (
              <View key={question.id} style={styles.question}>
                {!!question.header && <Text style={styles.title}>{question.header}</Text>}
                <Text style={styles.body}>{question.question}</Text>
                {question.options?.map((option) => (
                  <TouchableOpacity key={option.label} accessibilityRole="radio"
                    accessibilityState={{ checked: answers[question.id] === option.label }}
                    style={[styles.option, answers[question.id] === option.label && styles.selected]}
                    onPress={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}>
                    <Text style={styles.body}>{option.label}</Text>
                    {!!option.description && <Text style={styles.body}>{option.description}</Text>}
                  </TouchableOpacity>
                ))}
                {(!question.options?.length || question.isOther) && (
                  <TextInput style={styles.input} placeholder="回答を入力" placeholderTextColor={styles.body.color}
                    secureTextEntry={question.isSecret} autoCorrect={!question.isSecret}
                    autoCapitalize="none" value={answers[question.id] || ""}
                    onChangeText={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))} />
                )}
              </View>
            ))}
          </ScrollView>
          <View style={styles.actions}>
            <TouchableOpacity onPress={() => props.onDecide({ answers: {} })}><Text style={styles.action}>見送る</Text></TouchableOpacity>
            <TouchableOpacity disabled={!canAnswer || remaining === 0} onPress={submit}>
              <Text style={[styles.action, !canAnswer && styles.disabled]}>回答する</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </AppModal>
  );
}

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: theme.approval.backdrop },
    card: { maxHeight: "80%", padding: 20, gap: 16, borderRadius: 12, backgroundColor: theme.colors.surface },
    question: { gap: 10, marginBottom: 20 },
    title: { color: theme.colors.textPrimary, fontSize: theme.typography.title.fontSize, fontWeight: "700" },
    body: { color: theme.colors.textPrimary, fontSize: theme.typography.body.fontSize },
    option: { borderWidth: 1, borderColor: theme.colors.borderStrong, borderRadius: 8, padding: 12, gap: 4 },
    selected: { borderColor: theme.colors.controlAccent, borderWidth: 2 },
    input: { color: theme.colors.textPrimary, borderWidth: 1, borderColor: theme.colors.borderStrong, borderRadius: 8, padding: 12 },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: 20 },
    action: { color: theme.colors.controlAccent, fontSize: theme.typography.body.fontSize, fontWeight: "700" },
    disabled: { opacity: 0.4 },
  });
}

const stylesByTheme = createStylesByTheme(createStyles);
