import { useEffect, useRef, useState, type RefObject } from "react";
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
  type NativeSyntheticEvent,
  type TextInputSubmitEditingEventData,
} from "react-native";
import { KeyboardAvoidingView } from "../keyboardController";
import { AppModal } from "./AppModal";
import type { MACOS_CHAT_SUBMIT_KEY_EVENTS } from "./ChatComposerInput";
import {
  ModalTextInputDraft,
  type ModalTextInputDraftValue,
} from "./ModalTextInputDraft";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

type SubmitKeyEvent = (typeof MACOS_CHAT_SUBMIT_KEY_EVENTS)[number];

type ComposerFullscreenEditorProps = {
  visible: boolean;
  inputRef: RefObject<TextInput | null>;
  value: string;
  history: readonly string[];
  onChangeText: (value: string) => void;
  onSubmit: (value: string, onAccepted: () => void) => Promise<void>;
  submitKeyEvents?: SubmitKeyEvent[];
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
  onSubmit,
  submitKeyEvents,
  onClose,
  onFocus,
  onBlur,
}: ComposerFullscreenEditorProps) {
  return (
    <AppModal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <ModalTextInputDraft value={value} onChangeText={onChangeText}>
        {(draft) => (
          <ComposerFullscreenContent
            inputRef={inputRef}
            draft={draft}
            history={history}
            onSubmit={onSubmit}
            submitKeyEvents={submitKeyEvents}
            onClose={onClose}
            onFocus={onFocus}
            onBlur={onBlur}
          />
        )}
      </ModalTextInputDraft>
    </AppModal>
  );
}

type ComposerFullscreenContentProps = Omit<
  ComposerFullscreenEditorProps,
  "visible" | "value" | "onChangeText"
> & {
  draft: ModalTextInputDraftValue;
};

function ComposerFullscreenContent({
  inputRef,
  draft,
  history,
  onSubmit,
  submitKeyEvents,
  onClose,
  onFocus,
  onBlur,
}: ComposerFullscreenContentProps) {
  const { theme, themeId } = useVisualTheme();
  const componentStyles = componentStylesByTheme[themeId];
  const [historyOpen, setHistoryOpen] = useState(false);
  const submitPendingRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [inputRef]);

  const selectHistoryMessage = (message: string) => {
    draft.changeText(message);
    setHistoryOpen(false);
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  const submit = (event?: NativeSyntheticEvent<TextInputSubmitEditingEventData>) => {
    const submittedDraft = event?.nativeEvent.text ?? draft.getValue();
    if (!submittedDraft.trim() || submitPendingRef.current) return;
    if (submittedDraft !== draft.getValue()) draft.changeText(submittedDraft);
    submitPendingRef.current = true;
    void onSubmit(submittedDraft, () => {
      if (draft.getValue() === submittedDraft) draft.changeText("");
      onClose();
    }).finally(() => {
      submitPendingRef.current = false;
    });
  };

  return (
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
              <Ionicons name="time-outline" size={19} color={theme.colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={componentStyles.headerButton}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="全画面入力を閉じる"
            >
              <Ionicons name="contract-outline" size={18} color={theme.colors.textSecondary} />
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
            testID="composer-fullscreen-input"
            ref={inputRef}
            style={componentStyles.input}
            value={draft.value}
            onChangeText={draft.changeText}
            onSubmitEditing={submitKeyEvents ? submit : undefined}
            {...(submitKeyEvents ? { submitKeyEvents } : {})}
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
  );
}

function createComponentStyles(theme: VisualTheme) {
  return StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface,
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
  title: { ...theme.typography.compact, fontWeight: "700", color: theme.colors.textSecondary },
  headerActions: { flexDirection: "row", gap: 8 },
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  headerButtonActive: { backgroundColor: theme.colors.surfaceSubtle },
  historyPanel: {
    position: "absolute",
    top: 48,
    left: 0,
    right: 0,
    zIndex: 1,
    elevation: 4,
    maxHeight: "45%",
    borderRadius: 12,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.surfaceRaised,
    padding: 10,
    gap: 8,
    shadowColor: theme.colors.textPrimary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
  },
  historyTitle: { color: theme.tones.neutral.foreground, ...theme.typography.small, fontWeight: "700" },
  historyItem: {
    paddingHorizontal: 4,
    paddingVertical: 12,
  },
  historyItemSeparated: { borderTopWidth: theme.borders.thin, borderTopColor: theme.colors.borderStrong },
  historyItemText: { color: theme.colors.textPrimary, ...theme.typography.body },
  emptyHistory: { color: theme.colors.textMuted, ...theme.typography.compact, paddingVertical: 16, textAlign: "center" },
  inputWrap: {
    flex: 1,
    borderRadius: 12,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    minHeight: 200,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: theme.colors.controlTextPrimary,
    fontSize: theme.typography.input.fontSize,
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 80,
    textAlignVertical: "top",
  },
  });
}

const componentStylesByTheme = createStylesByTheme(createComponentStyles);
