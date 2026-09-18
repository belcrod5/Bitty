import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { fetchRunnerTextFileContent } from "../utils/runnerFileContent";
import { RUNNER_FILE_HTTP_TIMEOUT_MS } from "../utils/runnerFileContextMenu";
import type {
  WorkspaceFileTarget,
  WorkspaceFileWriteResult,
} from "../utils/workspaceFiles";
import { AppModal } from "./AppModal";
import { MarkdownText } from "./MarkdownText";
import { ModalTextInputDraft } from "./ModalTextInputDraft";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { VISUAL_THEMES, type VisualTheme, type VisualThemeId } from "../theme/visualThemes";

type WorkspaceTextFileEditorProps = {
  target: WorkspaceFileTarget | null;
  runnerUrl: string;
  runnerToken: string;
  rootDirectory: string;
  onClose: () => void;
  onSave: (
    target: WorkspaceFileTarget,
    content: string,
    expectedVersion: string,
  ) => Promise<WorkspaceFileWriteResult>;
};

export function WorkspaceTextFileEditor({
  target,
  runnerUrl,
  runnerToken,
  rootDirectory,
  onClose,
  onSave,
}: WorkspaceTextFileEditorProps) {
  const { theme, themeId } = useVisualTheme();
  const editorStyles = editorStylesByTheme[themeId];
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [content, setContent] = useState("");
  const [initialContent, setInitialContent] = useState("");
  const [version, setVersion] = useState("");
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("edit");

  const targetPath = target?.path || "";
  const targetRootDirectory = target?.rootDirectory || rootDirectory;
  const isMarkdown = /\.md$/iu.test(targetPath);

  useEffect(() => {
    setContent("");
    setInitialContent("");
    setVersion("");
    setLoadError("");
    setSaving(false);
    setMode("edit");
    if (!targetPath) return;
    let cancelled = false;
    setLoading(true);
    fetchRunnerTextFileContent({
      runnerUrl,
      runnerToken,
      rootDir: targetRootDirectory,
      path: targetPath,
      timeoutMs: RUNNER_FILE_HTTP_TIMEOUT_MS,
    })
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setInitialContent(result.content);
        setVersion(result.version);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(message || "ファイルの読み込みに失敗しました。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runnerToken, runnerUrl, targetPath, targetRootDirectory]);

  const dirty = !loading && !loadError && content !== initialContent;

  const requestClose = useCallback(() => {
    if (saving) return;
    if (!dirty) {
      onClose();
      return;
    }
    Alert.alert(
      "変更を破棄しますか？",
      "保存していない変更があります。",
      [
        { text: "編集を続ける", style: "cancel" },
        { text: "破棄する", style: "destructive", onPress: onClose },
      ]
    );
  }, [dirty, onClose, saving]);

  const save = useCallback(() => {
    if (!target || !dirty || saving) return;
    setSaving(true);
    onSave(target, content, version)
      .then(() => onClose())
      .catch(() => {
        setSaving(false);
      });
  }, [content, dirty, onClose, onSave, saving, target, version]);

  const toggleMode = useCallback(() => {
    setMode((currentMode) => {
      if (currentMode === "edit") Keyboard.dismiss();
      return currentMode === "edit" ? "preview" : "edit";
    });
  }, []);

  return (
    <AppModal
      visible={target !== null}
      animationType="slide"
      onRequestClose={requestClose}
    >
      <SafeAreaView style={editorStyles.root}>
        <KeyboardAvoidingView
          style={editorStyles.body}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={editorStyles.header}>
            <TouchableOpacity
              style={editorStyles.headerButton}
              onPress={requestClose}
              disabled={saving}
            >
              <Text style={editorStyles.headerCloseText}>閉じる</Text>
            </TouchableOpacity>
            <View style={editorStyles.headerTitleArea}>
              <Text style={editorStyles.headerTitle} numberOfLines={1}>
                {target?.name || ""}
              </Text>
              <Text style={editorStyles.headerPath} numberOfLines={1}>
                {targetPath}
              </Text>
            </View>
            <TouchableOpacity
              style={[
                editorStyles.modeButton,
                (loading || loadError || saving) ? editorStyles.disabledButton : null,
              ]}
              onPress={toggleMode}
              disabled={loading || Boolean(loadError) || saving}
              accessibilityRole="button"
              accessibilityLabel={mode === "edit" ? "プレビューを表示" : "編集モードに戻る"}
              testID="workspace-text-file-editor-mode-toggle"
            >
              <Ionicons
                name={mode === "edit" ? "eye-outline" : "create-outline"}
                size={20}
                color={theme.colors.textSecondary}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                editorStyles.headerButton,
                editorStyles.saveButton,
                (!dirty || saving) ? editorStyles.disabledButton : null,
              ]}
              onPress={save}
              disabled={!dirty || saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color={theme.colors.textOnAccent} />
              ) : (
                <Text style={editorStyles.saveButtonText}>保存</Text>
              )}
            </TouchableOpacity>
          </View>
          {loading ? (
            <View style={editorStyles.centerArea}>
              <ActivityIndicator size="large" color={theme.colors.primaryAction} />
            </View>
          ) : loadError ? (
            <View style={editorStyles.centerArea}>
              <Text style={editorStyles.errorText}>{loadError}</Text>
            </View>
          ) : (
            <ModalTextInputDraft
              key={`${targetRootDirectory}\0${targetPath}\0${version}`}
              value={content}
              onChangeText={setContent}
            >
              {(draft) =>
                mode === "edit" ? (
                  <TextInput
                    testID="workspace-text-file-editor-input"
                    style={editorStyles.textInput}
                    value={draft.value}
                    onChangeText={draft.changeText}
                    editable={!saving}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    textAlignVertical="top"
                  />
                ) : (
                  <ScrollView
                    style={editorStyles.previewScroll}
                    contentContainerStyle={editorStyles.previewContent}
                    testID="workspace-text-file-editor-preview"
                  >
                    {isMarkdown ? (
                      <MarkdownText
                        content={draft.value}
                        tone="assistant"
                        textStyle={editorStyles.previewText}
                      />
                    ) : (
                      <Text style={editorStyles.previewText} selectable>{draft.value}</Text>
                    )}
                  </ScrollView>
                )
              }
            </ModalTextInputDraft>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </AppModal>
  );
}

function createWorkspaceTextFileEditorStyles(theme: VisualTheme) {
  const compactControlSize = theme.id === "highLegibility" ? 44 : 36;
  return StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface,
  },
  body: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: theme.borders.thin,
    borderBottomColor: theme.colors.borderSubtle,
  },
  headerButton: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerCloseText: {
    color: theme.colors.textSecondary,
    fontWeight: "600",
  },
  headerTitleArea: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
  },
  headerTitle: {
    fontSize: theme.typography.input.fontSize,
    fontWeight: "700",
    color: theme.colors.textPrimary,
  },
  headerPath: {
    fontSize: theme.typography.caption.fontSize,
    color: theme.colors.textMuted,
  },
  saveButton: {
    minWidth: 64,
    alignItems: "center",
    backgroundColor: theme.colors.primaryAction,
  },
  modeButton: {
    width: compactControlSize,
    height: compactControlSize,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceMuted,
  },
  saveButtonText: {
    color: theme.colors.textOnAccent,
    fontWeight: "700",
  },
  disabledButton: {
    opacity: 0.5,
  },
  centerArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  errorText: {
    color: theme.tones.danger.foreground,
    fontSize: theme.typography.body.fontSize,
    textAlign: "center",
  },
  textInput: {
    flex: 1,
    padding: 12,
    fontSize: theme.typography.body.fontSize,
    lineHeight: theme.typography.body.lineHeight,
    color: theme.colors.textPrimary,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  previewScroll: {
    flex: 1,
  },
  previewContent: {
    flexGrow: 1,
    padding: 16,
  },
  previewText: {
    fontSize: theme.typography.body.fontSize,
    lineHeight: theme.id === "standard" ? 22 : theme.typography.body.lineHeight,
    color: theme.colors.textPrimary,
  },
  });
}

const editorStylesByTheme: Record<VisualThemeId, ReturnType<typeof createWorkspaceTextFileEditorStyles>> = {
  standard: createWorkspaceTextFileEditorStyles(VISUAL_THEMES.standard),
  highLegibility: createWorkspaceTextFileEditorStyles(VISUAL_THEMES.highLegibility),
};
