import { useCallback, useEffect, useRef, useState } from "react";
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
  View,
} from "react-native";
import { fetchRunnerTextFileContent } from "../utils/runnerFileContent";
import { RUNNER_FILE_HTTP_TIMEOUT_MS, type RunnerFileTarget } from "../utils/runnerFileContextMenu";
import type {
  WorkspaceFileTarget,
  WorkspaceFileWriteResult,
} from "../utils/workspaceFiles";
import { AppModal } from "./AppModal";
import { FileViewerHeader } from "./FileViewerHeader";
import { MarkdownText } from "./MarkdownText";
import { ModalTextInputDraft } from "./ModalTextInputDraft";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../theme/visualThemes";

type WorkspaceTextFileEditorProps = {
  target: RunnerFileTarget | null;
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
  const [fileActionBusy, setFileActionBusy] = useState(false);
  const contentRef = useRef("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");

  const targetPath = target?.path || "";
  const targetRootDirectory = target?.rootDirectory || rootDirectory;
  const isMarkdown = /\.md$/iu.test(targetPath);

  useEffect(() => {
    contentRef.current = "";
    setContent("");
    setInitialContent("");
    setVersion("");
    setLoadError("");
    setSaving(false);
    setFileActionBusy(false);
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
        contentRef.current = result.content;
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
    if (saving || fileActionBusy) return;
    if (contentRef.current === initialContent) {
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
  }, [fileActionBusy, initialContent, onClose, saving]);

  const save = useCallback(() => {
    if (!target || !dirty || saving || fileActionBusy) return;
    setSaving(true);
    onSave(target, contentRef.current, version)
      .then(() => onClose())
      .catch(() => {
        setSaving(false);
      });
  }, [dirty, fileActionBusy, onClose, onSave, saving, target, version]);

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
          {target ? (
            <FileViewerHeader
              key={`${targetRootDirectory}\0${targetPath}`}
              target={target}
              saving={saving}
              onClose={onClose}
              onRequestClose={requestClose}
              onBusyChange={setFileActionBusy}
              beforeMutation={() => {
                if (loading || loadError) return false;
                if (contentRef.current === initialContent) return true;
                Alert.alert("変更を保存してください", "名前変更・削除の前に、編集中の内容を保存してください。");
                return false;
              }}
              actions={[
                {
                  icon: mode === "edit" ? "eye-outline" : "create-outline",
                  label: mode === "edit" ? "プレビューを表示" : "編集モードに戻る",
                  onPress: toggleMode,
                  disabled: loading || Boolean(loadError) || fileActionBusy,
                  testID: "workspace-text-file-editor-mode-toggle",
                },
                {
                  icon: "save-outline",
                  label: "保存",
                  onPress: save,
                  disabled: !dirty || fileActionBusy,
                  primary: true,
                },
              ]}
            />
          ) : null}
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
              onChangeText={(value) => {
                contentRef.current = value;
                setContent(value);
              }}
            >
              {(draft) =>
                mode === "edit" ? (
                  <TextInput
                    testID="workspace-text-file-editor-input"
                    style={editorStyles.textInput}
                    value={draft.value}
                    onChangeText={draft.changeText}
                    editable={!saving && !fileActionBusy}
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
  return StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface,
  },
  body: {
    flex: 1,
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
    fontSize: theme.typography.bodyRelaxed.fontSize,
    lineHeight: theme.typography.bodyRelaxed.lineHeight,
    color: theme.colors.textPrimary,
  },
  });
}

const editorStylesByTheme = createStylesByTheme(createWorkspaceTextFileEditorStyles);
