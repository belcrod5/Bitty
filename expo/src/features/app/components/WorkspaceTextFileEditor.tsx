import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { fetchRunnerTextFileContent } from "../utils/runnerFileContent";
import { RUNNER_FILE_HTTP_TIMEOUT_MS } from "../utils/runnerFileContextMenu";
import type { WorkspaceFileTarget } from "../utils/workspaceFiles";

type WorkspaceTextFileEditorProps = {
  target: WorkspaceFileTarget | null;
  runnerUrl: string;
  runnerToken: string;
  rootDirectory: string;
  onClose: () => void;
  onSave: (target: WorkspaceFileTarget, content: string, expectedVersion: string) => Promise<void>;
};

export function WorkspaceTextFileEditor({
  target,
  runnerUrl,
  runnerToken,
  rootDirectory,
  onClose,
  onSave,
}: WorkspaceTextFileEditorProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [content, setContent] = useState("");
  const [initialContent, setInitialContent] = useState("");
  const [version, setVersion] = useState("");
  const [saving, setSaving] = useState(false);

  const targetPath = target?.path || "";

  useEffect(() => {
    setContent("");
    setInitialContent("");
    setVersion("");
    setLoadError("");
    setSaving(false);
    if (!targetPath) return;
    let cancelled = false;
    setLoading(true);
    fetchRunnerTextFileContent({
      runnerUrl,
      runnerToken,
      rootDir: rootDirectory,
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
  }, [rootDirectory, runnerToken, runnerUrl, targetPath]);

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

  return (
    <Modal
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
                editorStyles.headerButton,
                editorStyles.saveButton,
                (!dirty || saving) ? editorStyles.disabledButton : null,
              ]}
              onPress={save}
              disabled={!dirty || saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={editorStyles.saveButtonText}>保存</Text>
              )}
            </TouchableOpacity>
          </View>
          {loading ? (
            <View style={editorStyles.centerArea}>
              <ActivityIndicator size="large" color="#0f766e" />
            </View>
          ) : loadError ? (
            <View style={editorStyles.centerArea}>
              <Text style={editorStyles.errorText}>{loadError}</Text>
            </View>
          ) : (
            <TextInput
              testID="workspace-text-file-editor-input"
              style={editorStyles.textInput}
              value={content}
              onChangeText={setContent}
              editable={!saving}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              textAlignVertical="top"
            />
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const editorStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#ffffff",
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
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  headerButton: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerCloseText: {
    color: "#334155",
    fontWeight: "600",
  },
  headerTitleArea: {
    flex: 1,
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0f172a",
  },
  headerPath: {
    fontSize: 11,
    color: "#64748b",
  },
  saveButton: {
    minWidth: 64,
    alignItems: "center",
    backgroundColor: "#0f766e",
  },
  saveButtonText: {
    color: "#ffffff",
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
    color: "#b91c1c",
    fontSize: 14,
    textAlign: "center",
  },
  textInput: {
    flex: 1,
    padding: 12,
    fontSize: 14,
    lineHeight: 20,
    color: "#0f172a",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
});
