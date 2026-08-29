import { useEffect, useState, type RefObject } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "../keyboardController";
import { AppModal } from "./AppModal";

type ComposerFullscreenEditorProps = {
  visible: boolean;
  inputRef: RefObject<TextInput | null>;
  value: string;
  history: readonly string[];
  onChangeText: (value: string) => void;
  onClose: () => void;
  onFocus: () => void;
  onBlur: () => void;
};

export function ComposerFullscreenEditor({
  visible,
  inputRef,
  value,
  history,
  onChangeText,
  onClose,
  onFocus,
  onBlur,
}: ComposerFullscreenEditorProps) {
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (!visible) {
      setHistoryOpen(false);
      return undefined;
    }
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [inputRef, visible]);

  const selectHistoryMessage = (message: string) => {
    onChangeText(message);
    setHistoryOpen(false);
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  return (
    <AppModal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={componentStyles.root}>
        <KeyboardAvoidingView
          style={componentStyles.keyboardAvoiding}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          automaticOffset={Platform.OS === "ios"}
        >
          <View style={componentStyles.header}>
            <Text style={componentStyles.title}>Input Editor</Text>
            <View style={componentStyles.headerActions}>
              <TouchableOpacity
                style={[componentStyles.headerButton, historyOpen && componentStyles.headerButtonActive]}
                onPress={() => {
                  inputRef.current?.blur();
                  setHistoryOpen((open) => !open);
                }}
                accessibilityRole="button"
                accessibilityLabel="送信履歴を開く"
                accessibilityState={{ expanded: historyOpen }}
                testID="composer-history-button"
              >
                <Ionicons name="time-outline" size={19} color="#334155" />
              </TouchableOpacity>
              <TouchableOpacity
                style={componentStyles.headerButton}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="全画面入力を閉じる"
              >
                <Ionicons name="contract-outline" size={18} color="#334155" />
              </TouchableOpacity>
            </View>
          </View>
          {historyOpen ? (
            <View style={componentStyles.historyPanel} testID="composer-history-list">
              <Text style={componentStyles.historyTitle}>送信履歴</Text>
              {history.length > 0 ? (
                <ScrollView keyboardShouldPersistTaps="handled">
                  {history.map((message, index) => (
                    <TouchableOpacity
                      key={`${index}:${message}`}
                      style={[
                        componentStyles.historyItem,
                        index > 0 && componentStyles.historyItemSeparated,
                      ]}
                      onPress={() => selectHistoryMessage(message)}
                      accessibilityRole="button"
                      accessibilityLabel={`送信履歴 ${index + 1}: ${message}`}
                      accessibilityHint="入力欄に反映"
                    >
                      <Text style={componentStyles.historyItemText} numberOfLines={5}>
                        {message}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              ) : (
                <Text style={componentStyles.emptyHistory}>送信履歴はまだありません</Text>
              )}
            </View>
          ) : null}
          <View style={componentStyles.inputWrap}>
            <TextInput
              ref={inputRef}
              style={componentStyles.input}
              value={value}
              onChangeText={onChangeText}
              placeholder="メッセージを入力"
              multiline
              scrollEnabled
              textAlignVertical="top"
              autoCorrect={false}
              autoCapitalize="none"
              onFocus={onFocus}
              onBlur={onBlur}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </AppModal>
  );
}

const componentStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#ffffff",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
  },
  keyboardAvoiding: { flex: 1, gap: 8 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 40,
  },
  title: { fontSize: 13, fontWeight: "700", color: "#334155" },
  headerActions: { flexDirection: "row", gap: 8 },
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  headerButtonActive: { backgroundColor: "#e2e8f0" },
  historyPanel: {
    position: "absolute",
    top: 48,
    left: 0,
    right: 0,
    zIndex: 1,
    elevation: 4,
    maxHeight: "45%",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#94a3b8",
    backgroundColor: "#f8fafc",
    padding: 10,
    gap: 8,
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
  },
  historyTitle: { color: "#475569", fontSize: 12, fontWeight: "700" },
  historyItem: {
    paddingHorizontal: 4,
    paddingVertical: 12,
  },
  historyItemSeparated: { borderTopWidth: 1, borderTopColor: "#94a3b8" },
  historyItemText: { color: "#0f172a", fontSize: 14, lineHeight: 20 },
  emptyHistory: { color: "#64748b", fontSize: 13, paddingVertical: 16, textAlign: "center" },
  inputWrap: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#ffffff",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    minHeight: 200,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "#111827",
    fontSize: 15,
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 80,
    textAlignVertical: "top",
  },
});
