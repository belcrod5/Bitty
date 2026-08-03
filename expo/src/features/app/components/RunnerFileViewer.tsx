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

const DRAWIO_VIEWER_URL =
  "https://viewer.diagrams.net/?lightbox=1&chrome=0&layers=1&nav=1&border=10#create=%7B%22type%22%3A%22message%22%7D";

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

  const diagramXml = escapeHtmlAttribute(content);
  const viewerUrl = escapeHtmlAttribute(DRAWIO_VIEWER_URL);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; }
  </style>
</head>
<body>
  <div id="drawio-data" hidden data-xml="${diagramXml}"></div>
  <iframe id="drawio-viewer" title="draw.io viewer"></iframe>
  <script>
    window.addEventListener("message", function(event) {
      if (event.origin !== "https://viewer.diagrams.net") return;

      var message = event.data;
      if (typeof message === "string") {
        try { message = JSON.parse(message); } catch (_) { return; }
      }

      if (message && message.event === "ready") {
        event.source.postMessage({
          action: "create",
          data: {
            type: "xml",
            data: document.getElementById("drawio-data").getAttribute("data-xml")
          }
        }, event.origin);
      }
    });

    document.getElementById("drawio-viewer").src = "${viewerUrl}";
  </script>
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
