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
import {
  RUNNER_FILE_HTTP_TIMEOUT_MS,
  type RunnerFileViewerKind,
  type RunnerFileViewerTarget,
} from "../utils/runnerFileContextMenu";

const DRAWIO_VIEWER_SCRIPT_URL =
  "https://viewer.diagrams.net/js/viewer-static.min.js";

type RunnerFileViewerProps = {
  target: RunnerFileViewerTarget | null;
  runnerUrl: string;
  runnerToken: string;
  rootDirectory: string;
  onRequestClose: () => void;
};

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildRunnerFileViewerHtml(kind: RunnerFileViewerKind, content: string) {
  if (kind === "html") return content;

  const viewerConfig = escapeHtmlAttribute(JSON.stringify({
    nav: true,
    resize: true,
    toolbar: "pages layers",
    xml: content,
  }));
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=0.25, maximum-scale=8.0, user-scalable=yes">
  <style>
    html, body { margin: 0; min-width: 100%; min-height: 100%; }
    .drawio-page { position: relative; min-width: 100%; min-height: 100%; }
    .drawio-native-scroll { position: absolute; inset: 0; z-index: 998; }
  </style>
</head>
<body>
  <div class="drawio-page">
    <div class="mxgraph" style="max-width:100%;border:1px solid transparent;" data-mxgraph="${viewerConfig}"></div>
    <div class="drawio-native-scroll" aria-hidden="true"></div>
  </div>
  <script src="${DRAWIO_VIEWER_SCRIPT_URL}"></script>
</body>
</html>`;
}

export function RunnerFileViewer({
  target,
  runnerUrl,
  runnerToken,
  rootDirectory,
  onRequestClose,
}: RunnerFileViewerProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [content, setContent] = useState("");

  const targetPath = target?.path || "";

  useEffect(() => {
    setContent("");
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
        setContent(result.content);
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
            <Text style={viewerStyles.title} numberOfLines={1}>{target.name || "ファイル"}</Text>
            <Text style={viewerStyles.path} numberOfLines={1}>{targetPath}</Text>
          </View>
          <TouchableOpacity
            style={viewerStyles.closeButton}
            onPress={onRequestClose}
            accessibilityRole="button"
            accessibilityLabel="ファイルビューアーを閉じる"
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
            source={{ html: buildRunnerFileViewerHtml(target.kind, content) }}
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
