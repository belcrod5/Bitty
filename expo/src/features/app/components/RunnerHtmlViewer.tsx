import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import { fetchRunnerTextFileContent } from "../utils/runnerFileContent";
import { RUNNER_FILE_HTTP_TIMEOUT_MS } from "../utils/runnerFileContextMenu";
import type { WorkspaceFileTarget } from "../utils/workspaceFiles";

type RunnerHtmlViewerProps = {
  target: WorkspaceFileTarget | null;
  runnerUrl: string;
  runnerToken: string;
  rootDirectory: string;
  onRequestClose: () => void;
};

export function RunnerHtmlViewer({
  target,
  runnerUrl,
  runnerToken,
  rootDirectory,
  onRequestClose,
}: RunnerHtmlViewerProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [html, setHtml] = useState("");

  const targetPath = target?.path || "";

  useEffect(() => {
    setHtml("");
    setLoadError("");
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
        setHtml(result.content);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(message || "HTMLファイルの読み込みに失敗しました。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootDirectory, runnerToken, runnerUrl, targetPath]);

  if (!target) {
    return null;
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onRequestClose}
    >
      <SafeAreaView style={viewerStyles.root}>
        <View style={viewerStyles.header}>
          <View style={viewerStyles.titleWrap}>
            <Text style={viewerStyles.title} numberOfLines={1}>{target.name || "HTML"}</Text>
            <Text style={viewerStyles.path} numberOfLines={1}>{targetPath}</Text>
          </View>
          <TouchableOpacity
            style={viewerStyles.closeButton}
            onPress={onRequestClose}
            accessibilityRole="button"
            accessibilityLabel="HTMLビューアーを閉じる"
          >
            <Ionicons name="close" size={24} color="#e2e8f0" />
          </TouchableOpacity>
        </View>
        {loading ? (
          <View style={viewerStyles.centerArea}>
            <ActivityIndicator size="large" color="#38bdf8" />
          </View>
        ) : loadError ? (
          <View style={viewerStyles.centerArea}>
            <Text style={viewerStyles.errorText}>{loadError}</Text>
          </View>
        ) : (
          <WebView
            style={viewerStyles.webview}
            originWhitelist={["*"]}
            source={{ html }}
            setSupportMultipleWindows={false}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const viewerStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#020617",
  },
  header: {
    minHeight: 64,
    paddingLeft: 16,
    paddingRight: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#334155",
    flexDirection: "row",
    alignItems: "center",
  },
  titleWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "700",
  },
  path: {
    marginTop: 2,
    color: "#94a3b8",
    fontSize: 11,
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  centerArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  errorText: {
    color: "#fecaca",
    fontSize: 14,
    textAlign: "center",
  },
  webview: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
});
