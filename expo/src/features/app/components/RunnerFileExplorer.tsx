import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";

import { styles } from "../styles";
import { normalizeRunnerPath, RUNNER_FILE_HTTP_TIMEOUT_MS } from "../utils/runnerFileContextMenu";

export type RunnerFileExplorerEntry = {
  kind: "dir" | "file";
  name: string;
  path: string;
};

type ExplorerNode = RunnerFileExplorerEntry & {
  childPaths: string[];
  loaded: boolean;
  loading: boolean;
  error: string;
};

type JsonRecord = Record<string, unknown>;

export type RunnerFileExplorerRef = {
  reloadDirectory: (path: string) => Promise<void>;
};

type Props = {
  active: boolean;
  runnerUrl: string;
  runnerToken: string;
  rootPath: string;
  rootDisplayName: string;
  fileFilter?: (entry: RunnerFileExplorerEntry) => boolean;
  onFilePress: (entry: RunnerFileExplorerEntry, siblings: RunnerFileExplorerEntry[]) => void;
  onDirectoryLongPress?: (entry: RunnerFileExplorerEntry) => void;
  loadingDirectoryPath?: string;
  fileAccessibilityLabel?: (entry: RunnerFileExplorerEntry) => string;
  logSessionDiag?: (
    event: string,
    payload?: Record<string, unknown>,
    options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean },
  ) => void;
};

export const RunnerFileExplorer = forwardRef<RunnerFileExplorerRef, Props>(function RunnerFileExplorer({
  active,
  runnerUrl,
  runnerToken,
  rootPath: rootPathRaw,
  rootDisplayName,
  fileFilter,
  onFilePress,
  onDirectoryLongPress,
  loadingDirectoryPath = "",
  fileAccessibilityLabel = (entry) => `${entry.name}のメニューを表示`,
  logSessionDiag,
}, ref) {
  const [rootPath, setRootPath] = useState("");
  const [nodesByPath, setNodesByPath] = useState<Record<string, ExplorerNode>>({});
  const [expandedByPath, setExpandedByPath] = useState<Record<string, boolean>>({});
  const [globalError, setGlobalError] = useState("");
  const nodesByPathRef = useRef(nodesByPath);
  const rootPathRef = useRef(rootPath);
  const requestSequenceRef = useRef<Record<string, number>>({});
  const controllersRef = useRef<Record<string, AbortController>>({});
  const loadedRootRef = useRef("");
  nodesByPathRef.current = nodesByPath;
  rootPathRef.current = rootPath;

  const getPathLabel = useCallback((pathRaw: unknown) => {
    const path = normalizeRunnerPath(pathRaw);
    if (!path || path === ".") return String(rootDisplayName || "").trim() || "Directory";
    if (path === "/") return "/";
    return path.split("/").filter(Boolean).at(-1) || String(rootDisplayName || "").trim() || "Directory";
  }, [rootDisplayName]);

  const fetchDirectory = useCallback(async (pathRaw: unknown) => {
    const baseUrl = String(runnerUrl || "").trim().replace(/\/+$/, "");
    const token = String(runnerToken || "").trim();
    const targetPath = normalizeRunnerPath(pathRaw);
    if (!baseUrl || !token) throw new Error("Runner URL または Runner Token が未設定です");
    controllersRef.current[targetPath]?.abort();
    const controller = new AbortController();
    controllersRef.current[targetPath] = controller;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    logSessionDiag?.("runner_file_explorer_load_start", { path: targetPath }, { throttleMs: 0 });
    try {
      const url = new URL(`${baseUrl}/directories`);
      url.searchParams.set("path", targetPath);
      const request = fetch(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      }).then(async (response) => ({ response, text: await response.text() }));
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error(`request timeout (${RUNNER_FILE_HTTP_TIMEOUT_MS}ms)`));
        }, RUNNER_FILE_HTTP_TIMEOUT_MS);
      });
      const { response, text } = await Promise.race([request, timeout]);
      let data: JsonRecord = {};
      try {
        data = text ? JSON.parse(text) as JsonRecord : {};
      } catch {}
      if (!response.ok) throw new Error(String(data.message || data.error || `HTTP ${response.status}`));
      const parseEntry = (raw: unknown, fallbackKind?: "dir"): RunnerFileExplorerEntry | null => {
        const value = raw && typeof raw === "object" ? raw as JsonRecord : {};
        const kind = fallbackKind || (value.kind === "file" ? "file" : "dir");
        const name = String(value.name || "").trim();
        const path = normalizeRunnerPath(value.path);
        return name && path ? { kind, name, path } : null;
      };
      const entries = (Array.isArray(data.entries)
        ? data.entries.map((entry) => parseEntry(entry))
        : Array.isArray(data.directories)
          ? data.directories.map((entry) => parseEntry(entry, "dir"))
          : [])
        .filter((entry): entry is RunnerFileExplorerEntry => Boolean(entry))
        .filter((entry) => entry.kind === "dir" || !fileFilter || fileFilter(entry));
      entries.sort((left, right) => left.kind === right.kind
        ? left.name.localeCompare(right.name)
        : left.kind === "dir" ? -1 : 1);
      const basePath = normalizeRunnerPath(data.basePath || targetPath);
      logSessionDiag?.("runner_file_explorer_load_done", {
        requestedPath: targetPath,
        path: basePath,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        entryCount: entries.length,
      }, { throttleMs: 0 });
      return { basePath, entries };
    } catch (error) {
      const aborted = error && typeof error === "object" && "name" in error && error.name === "AbortError";
      const message = aborted
        ? `request timeout (${RUNNER_FILE_HTTP_TIMEOUT_MS}ms)`
        : error instanceof Error ? error.message : String(error);
      logSessionDiag?.("runner_file_explorer_load_error", {
        path: targetPath,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        message,
      }, { throttleMs: 0 });
      throw new Error(message);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (controllersRef.current[targetPath] === controller) delete controllersRef.current[targetPath];
    }
  }, [fileFilter, logSessionDiag, runnerToken, runnerUrl]);

  const loadDirectory = useCallback(async (pathRaw: unknown, force = false) => {
    const requestedPath = normalizeRunnerPath(pathRaw);
    if (!requestedPath) return;
    const current = nodesByPathRef.current[requestedPath];
    if (!force && current?.loaded && !current.error) return;
    const sequence = (requestSequenceRef.current[requestedPath] || 0) + 1;
    requestSequenceRef.current[requestedPath] = sequence;
    setNodesByPath((nodes) => ({
      ...nodes,
      [requestedPath]: {
        kind: "dir",
        name: nodes[requestedPath]?.name || getPathLabel(requestedPath),
        path: requestedPath,
        childPaths: nodes[requestedPath]?.childPaths || [],
        loaded: nodes[requestedPath]?.loaded || false,
        loading: true,
        error: "",
      },
    }));
    try {
      const payload = await fetchDirectory(requestedPath);
      if (requestSequenceRef.current[requestedPath] !== sequence) return;
      const canonicalPath = normalizeRunnerPath(payload.basePath || requestedPath);
      setNodesByPath((nodes) => {
        const next = { ...nodes };
        const childPaths = payload.entries.map((entry) => entry.path);
        for (const entry of payload.entries) {
          const previous = nodes[entry.path];
          next[entry.path] = {
            ...entry,
            childPaths: entry.kind === "file" ? [] : previous?.childPaths || [],
            loaded: entry.kind === "file" || previous?.loaded || false,
            loading: false,
            error: previous?.error || "",
          };
        }
        next[canonicalPath] = {
          kind: "dir",
          name: getPathLabel(canonicalPath),
          path: canonicalPath,
          childPaths,
          loaded: true,
          loading: false,
          error: "",
        };
        if (requestedPath !== canonicalPath) delete next[requestedPath];
        return next;
      });
      if (rootPathRef.current === requestedPath && canonicalPath !== requestedPath) {
        setRootPath(canonicalPath);
        setExpandedByPath((expanded) => ({ ...expanded, [canonicalPath]: true }));
      }
    } catch (error) {
      if (requestSequenceRef.current[requestedPath] !== sequence) return;
      const message = error instanceof Error ? error.message : String(error);
      setNodesByPath((nodes) => ({
        ...nodes,
        [requestedPath]: { ...nodes[requestedPath], loading: false, loaded: false, error: message },
      }));
      throw error;
    }
  }, [fetchDirectory, getPathLabel]);

  useImperativeHandle(ref, () => ({
    reloadDirectory: (path) => loadDirectory(path, true),
  }), [loadDirectory]);

  const cancelRequests = useCallback(() => {
    for (const path of Object.keys(requestSequenceRef.current)) {
      requestSequenceRef.current[path] += 1;
    }
    for (const controller of Object.values(controllersRef.current)) controller.abort();
  }, []);

  useEffect(() => () => cancelRequests(), [cancelRequests]);

  useEffect(() => {
    cancelRequests();
    requestSequenceRef.current = {};
    loadedRootRef.current = "";
    rootPathRef.current = "";
    setRootPath("");
    setNodesByPath({});
    setExpandedByPath({});
    setGlobalError("");
  }, [cancelRequests, runnerToken, runnerUrl]);

  useEffect(() => {
    if (!active) {
      cancelRequests();
      loadedRootRef.current = "";
      return;
    }
    const requestedRoot = normalizeRunnerPath(rootPathRaw);
    if (!requestedRoot) {
      setGlobalError("ディレクトリーが未選択です");
      return;
    }
    setGlobalError("");
    if (rootPathRef.current !== requestedRoot) {
      rootPathRef.current = requestedRoot;
      setRootPath(requestedRoot);
      setNodesByPath((nodes) => ({
        ...nodes,
        [requestedRoot]: nodes[requestedRoot] || {
          kind: "dir",
          name: getPathLabel(requestedRoot),
          path: requestedRoot,
          childPaths: [],
          loaded: false,
          loading: false,
          error: "",
        },
      }));
      setExpandedByPath((expanded) => ({ ...expanded, [requestedRoot]: true }));
    }
    if (loadedRootRef.current === requestedRoot) return;
    loadedRootRef.current = requestedRoot;
    void loadDirectory(requestedRoot, true).catch((error) => {
      setGlobalError(error instanceof Error ? error.message : String(error));
    });
  }, [active, cancelRequests, getPathLabel, loadDirectory, rootPathRaw]);

  const renderNode = (path: string, depth = 0, siblingPaths: string[] = []): ReactElement | null => {
    const node = nodesByPath[path];
    if (!node) return null;
    if (node.kind === "file") {
      const siblings = siblingPaths
        .map((childPath) => nodesByPath[childPath])
        .filter((entry): entry is ExplorerNode => entry?.kind === "file");
      return (
        <View key={node.path} style={styles.gitDiffTreeNodeWrap}>
          <TouchableOpacity
            style={[styles.gitDiffTreeNodeRow, { paddingLeft: 10 + (depth * 14) }]}
            onPress={() => onFilePress(node, siblings)}
            accessibilityRole="button"
            accessibilityLabel={fileAccessibilityLabel(node)}
          >
            <Text style={styles.gitDiffTreeNodeIcon}>・</Text>
            <Text style={styles.gitDiffTreeNodeFileText}>{node.name}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    const expanded = Boolean(expandedByPath[node.path]);
    return (
      <View key={node.path} style={styles.gitDiffTreeNodeWrap}>
        <TouchableOpacity
          style={[styles.gitDiffTreeNodeRow, { paddingLeft: 10 + (depth * 14) }]}
          onPress={() => {
            const nextExpanded = !expanded;
            setExpandedByPath((current) => ({ ...current, [node.path]: nextExpanded }));
            if (nextExpanded) {
              setGlobalError("");
              void loadDirectory(node.path).catch((error) => {
                setGlobalError(error instanceof Error ? error.message : String(error));
              });
            }
          }}
          onLongPress={onDirectoryLongPress ? () => onDirectoryLongPress(node) : undefined}
          accessibilityRole="button"
          accessibilityLabel={`${node.name}フォルダーを開閉`}
          accessibilityHint={onDirectoryLongPress ? "長押しするとファイルをアップロードできます" : undefined}
        >
          <Text style={styles.gitDiffTreeNodeIcon}>{expanded ? "▾" : "▸"}</Text>
          <Text style={styles.gitDiffTreeNodeDirText}>{node.name}</Text>
          {node.loading || normalizeRunnerPath(loadingDirectoryPath) === node.path ? (
            <ActivityIndicator size="small" color="#0f766e" style={styles.gitDiffTreeNodeSpinner} />
          ) : null}
        </TouchableOpacity>
        {node.error ? <Text style={[styles.gitDiffPanelErrorText, styles.gitDiffTreeNodeErrorText]}>{node.error}</Text> : null}
        {expanded && node.loaded && node.childPaths.length === 0 ? (
          <Text style={[styles.gitDiffEmptyText, styles.gitDiffTreeNodeEmptyText]}>フォルダーは空です</Text>
        ) : null}
        {expanded ? node.childPaths.map((childPath) => renderNode(childPath, depth + 1, node.childPaths)) : null}
      </View>
    );
  };

  const root = nodesByPath[rootPath];
  return (
    <>
      {globalError ? <Text style={styles.gitDiffPanelErrorText}>{globalError}</Text> : null}
      {!rootPath ? <Text style={styles.gitDiffEmptyText}>ディレクトリーが未選択です</Text> : null}
      {root?.loading && !root.loaded ? (
        <View style={styles.gitDiffPanelStatusRow}>
          <ActivityIndicator size="small" color="#0f766e" />
          <Text style={styles.gitDiffPanelStatusText}>読み込み中...</Text>
        </View>
      ) : null}
      {root ? renderNode(root.path) : null}
    </>
  );
});
