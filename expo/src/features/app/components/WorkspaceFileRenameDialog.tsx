import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { WorkspaceFileTarget } from "../utils/workspaceFiles";
import { KeyboardAvoidingView } from "../keyboardController";
import { AppModal } from "./AppModal";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { VISUAL_THEMES, type VisualTheme, type VisualThemeId } from "../theme/visualThemes";

type WorkspaceFileRenameDialogProps = {
  target: WorkspaceFileTarget | null;
  title?: string;
  submitLabel?: string;
  onCancel: () => void;
  onRename: (name: string) => Promise<void>;
};

export function WorkspaceFileRenameDialog({
  target,
  title = "ファイル名を変更",
  submitLabel = "変更",
  onCancel,
  onRename,
}: WorkspaceFileRenameDialogProps) {
  const { theme, themeId } = useVisualTheme();
  const dialogStyles = dialogStylesByTheme[themeId];
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    setName(target?.name || "");
    setSaving(false);
    if (!target) return;
    const timeout = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timeout);
  }, [target]);

  const submit = () => {
    const nextName = name.trim();
    if (!target || !nextName || saving) return;
    setSaving(true);
    void onRename(nextName).catch(() => {
      setSaving(false);
    });
  };

  return (
    <AppModal
      visible={target !== null}
      transparent
      animationType="fade"
      onRequestClose={saving ? undefined : onCancel}
    >
      <Pressable style={dialogStyles.backdrop} onPress={saving ? undefined : onCancel}>
        <KeyboardAvoidingView
          style={dialogStyles.keyboardAvoiding}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          automaticOffset={Platform.OS === "ios"}
        >
          <Pressable style={dialogStyles.card} onPress={() => {}}>
            <Text style={dialogStyles.title}>{title}</Text>
            <Text style={dialogStyles.path} numberOfLines={2}>{target?.path || ""}</Text>
            <TextInput
              ref={inputRef}
              style={dialogStyles.input}
              value={name}
              onChangeText={setName}
              onSubmitEditing={submit}
              editable={!saving}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              selectTextOnFocus
            />
            <View style={dialogStyles.actions}>
              <TouchableOpacity
                style={dialogStyles.secondaryButton}
                onPress={onCancel}
                disabled={saving}
              >
                <Text style={dialogStyles.secondaryButtonText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  dialogStyles.primaryButton,
                  (!name.trim() || saving) ? dialogStyles.disabledButton : null,
                ]}
                onPress={submit}
                disabled={!name.trim() || saving}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={theme.colors.textOnAccent} />
                ) : (
                  <Text style={dialogStyles.primaryButtonText}>{submitLabel}</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </AppModal>
  );
}

function createWorkspaceFileRenameDialogStyles(theme: VisualTheme) {
  return StyleSheet.create({
  backdrop: {
    flex: 1,
    padding: 24,
    backgroundColor: theme.colors.backdropStrong,
  },
  keyboardAvoiding: { flex: 1, justifyContent: "center" },
  card: {
    borderRadius: 12,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.borderSubtle,
    backgroundColor: theme.colors.surface,
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: theme.typography.control.fontSize,
    fontWeight: "700",
    color: theme.colors.textPrimary,
  },
  path: {
    fontSize: theme.typography.small.fontSize,
    color: theme.colors.textMuted,
  },
  input: {
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: theme.typography.input.fontSize,
    color: theme.colors.textPrimary,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  secondaryButton: {
    borderRadius: 8,
    borderWidth: theme.borders.thin,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  secondaryButtonText: {
    color: theme.colors.textSecondary,
    fontWeight: "600",
  },
  primaryButton: {
    minWidth: 72,
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: theme.colors.primaryAction,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  primaryButtonText: {
    color: theme.colors.textOnAccent,
    fontWeight: "700",
  },
  disabledButton: {
    opacity: 0.5,
  },
  });
}

const dialogStylesByTheme: Record<VisualThemeId, ReturnType<typeof createWorkspaceFileRenameDialogStyles>> = {
  standard: createWorkspaceFileRenameDialogStyles(VISUAL_THEMES.standard),
  highLegibility: createWorkspaceFileRenameDialogStyles(VISUAL_THEMES.highLegibility),
};
