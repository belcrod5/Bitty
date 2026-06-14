import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { styles } from "../styles";
import { GitDiffRunningJobsSection } from "./GitDiffRunningJobsSection";
import {
  WorkspaceFileRenameDialog,
} from "./WorkspaceFileRenameDialog";
import { useWorkspaceFileMutations } from "../hooks/useWorkspaceFileMutations";
import { normalizeGitChangedFilePaths } from "../utils/gitChangedFiles";
import {
  buildRunnerMediaItem,
  normalizeRunnerPath,
  openRunnerFileContextMenu,
  RUNNER_FILE_HTTP_TIMEOUT_MS,
  type RunnerMediaFile,
  type RunnerMediaItem,
} from "../utils/runnerFileContextMenu";
import {
  uploadWorkspaceFile,
  type WorkspaceUploadSource,
} from "../utils/workspaceFiles";

type GitPanelTab = "diff" | "explorer" | "running";
type ExplorerEntryKind = "dir" | "file";
type ExplorerEntry = {
  kind: ExplorerEntryKind;
  name: string;
  path: string;
};
type ExplorerNode = {
  kind: ExplorerEntryKind;
  name: string;
  path: string;
  childPaths: string[];
  loaded: boolean;
  loading: boolean;
  error: string;
};
type JsonRecord = Record<string, unknown>;
type FileTreeDraftNode = {
  name: string;
  fullPath: string;
  kind: "dir" | "file";
  children: Record<string, FileTreeDraftNode>;
};
type FileTreeNode = {
  name: string;
  fullPath: string;
  kind: "dir" | "file";
  children: FileTreeNode[];
};

type GitDiffPanelProps = {
  visible: boolean;
  runnerUrl: string;
  runnerToken: string;
  selectedDirectoryPath: string;
  selectedDirectoryDisplayName: string;
  gitChangedFilesStaged: unknown[];
  gitChangedFilesUnstaged: unknown[];
  gitChangedFilesLoading: boolean;
  gitChangedFilesError: string;
  onRequestClose: () => void;
  onRefreshGitChangedFiles?: () => void | Promise<void>;
  showInfoToast: (textRaw: unknown) => void;
  onOpenMedia: (media: RunnerMediaFile) => void;
  logSessionDiag?: (
    event: string,
    payload?: Record<string, unknown>,
    options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean }
  ) => void;
};

function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeDraftNode = {
    name: "",
    fullPath: "",
    kind: "dir",
    children: {},
  };
  for (const rawPath of paths) {
    const normalizedPath = normalizeRunnerPath(rawPath);
    if (!normalizedPath) continue;
    const parts = normalizedPath.split("/").filter(Boolean);
    if (parts.length <= 0) continue;
    let cursor = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = i === parts.length - 1;
      if (!cursor.children[part]) {
        cursor.children[part] = {
          name: part,
          fullPath: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: {},
        };
      } else if (isLeaf) {
        cursor.children[part].kind = "file";
      }
      cursor = cursor.children[part];
    }
  }
  const sortNodes = (node: FileTreeDraftNode): FileTreeNode[] => {
    const entries = Object.values(node.children);
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries.map((item) => ({
      name: item.name,
      fullPath: item.fullPath,
      kind: item.kind,
      children: item.kind === "dir" ? sortNodes(item) : [],
    }));
  };
  return sortNodes(root);
}

function getParentRunnerPath(pathRaw: unknown) {
  const normalizedPath = normalizeRunnerPath(pathRaw).replace(/\/+$/, "");
  if (!normalizedPath || normalizedPath === ".") return ".";
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex < 0) return ".";
  if (separatorIndex === 0) return "/";
  return normalizedPath.slice(0, separatorIndex);
}

export function GitDiffPanel({
  visible,
  runnerUrl,
  runnerToken,
  selectedDirectoryPath,
  selectedDirectoryDisplayName,
  gitChangedFilesStaged,
  gitChangedFilesUnstaged,
  gitChangedFilesLoading,
  gitChangedFilesError,
  onRequestClose,
  onRefreshGitChangedFiles,
  showInfoToast,
  onOpenMedia,
  logSessionDiag,
}: GitDiffPanelProps) {
  const [gitPanelTab, setGitPanelTab] = useState<GitPanelTab>("diff");
  const [treeExpandedByKey, setTreeExpandedByKey] = useState<Record<string, boolean>>({});
  const [explorerRootPath, setExplorerRootPath] = useState("");
  const [explorerNodesByPath, setExplorerNodesByPath] = useState<Record<string, ExplorerNode>>({});
  const [explorerGlobalError, setExplorerGlobalError] = useState("");
  const [uploadingDirectoryPath, setUploadingDirectoryPath] = useState("");
  const [runningJobsRefreshSignal, setRunningJobsRefreshSignal] = useState(0);
  const [runningJobsLoading, setRunningJobsLoading] = useState(false);
  const panelAnim = useRef(new Animated.Value(0)).current;
  const onRefreshGitChangedFilesRef = useRef(onRefreshGitChangedFiles);
  const workspaceUploadInFlightRef = useRef(false);
  const { width: screenWidth } = useWindowDimensions();

  const getPathLabel = useCallback((pathRaw: unknown) => {
    const normalized = normalizeRunnerPath(pathRaw);
    const fallbackLabel = String(selectedDirectoryDisplayName || "").trim() || "Directory";
    if (!normalized || normalized === ".") return fallbackLabel;
    if (normalized === "/") return "/";
    const parts = normalized
      .split("/")
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .filter((part) => part !== ".");
    return parts[parts.length - 1] || fallbackLabel;
  }, [selectedDirectoryDisplayName]);

  const setTreeExpanded = useCallback((key: string, expanded: boolean) => {
    if (!key) return;
    setTreeExpandedByKey((prev) => {
      if (prev[key] === expanded) return prev;
      return {
        ...prev,
        [key]: expanded,
      };
    });
  }, []);

  const toggleTreeExpanded = useCallback((key: string) => {
    if (!key) return;
    setTreeExpandedByKey((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, []);

  const fetchDirectories = useCallback(async (pathRaw: unknown) => {
    const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
    const token = String(runnerToken || "").trim();
    const targetPath = normalizeRunnerPath(pathRaw);
    if (!baseUrl || !token) {
      logSessionDiag?.("runner_file_explorer_load_error", {
        path: targetPath,
        message: "Runner URL または Runner Token が未設定です",
      }, { throttleMs: 0 });
      throw new Error("Runner URL または Runner Token が未設定です");
    }
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    logSessionDiag?.("runner_file_explorer_load_start", {
      path: targetPath,
    }, { throttleMs: 0 });
    try {
      const url = new URL(`${baseUrl}/directories`);
      url.searchParams.set("path", targetPath);
      const request = fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      }).then(async (response) => ({
        response,
        text: await response.text(),
      }));
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
      } catch {
        data = {};
      }
      if (!response.ok) {
        throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
      }
      const basePath = normalizeRunnerPath(data?.basePath || targetPath);
      const entries = Array.isArray(data?.entries)
        ? data.entries
          .map((entryRaw: unknown): ExplorerEntry | null => {
            const entry = entryRaw && typeof entryRaw === "object" ? entryRaw as JsonRecord : {};
            const kindRaw = String(entry.kind || "").trim().toLowerCase();
            const kind: ExplorerEntryKind = kindRaw === "file" ? "file" : "dir";
            const name = String(entry.name || "").trim();
            const path = normalizeRunnerPath(entry.path);
            if (!name || !path) return null;
            return { kind, name, path };
          })
          .filter((entry: ExplorerEntry | null): entry is ExplorerEntry => Boolean(entry))
        : (
          Array.isArray(data?.directories)
            ? data.directories
              .map((entryRaw: unknown): ExplorerEntry | null => {
                const entry = entryRaw && typeof entryRaw === "object" ? entryRaw as JsonRecord : {};
                const name = String(entry.name || "").trim();
                const path = normalizeRunnerPath(entry.path);
                if (!name || !path) return null;
                return { kind: "dir", name, path };
              })
              .filter((entry: ExplorerEntry | null): entry is ExplorerEntry => Boolean(entry))
            : []
        );
      entries.sort((a: ExplorerEntry, b: ExplorerEntry) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      logSessionDiag?.("runner_file_explorer_load_done", {
        requestedPath: targetPath,
        path: basePath,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        entryCount: entries.length,
      }, { throttleMs: 0 });
      return {
        basePath,
        entries,
      };
    } catch (err: unknown) {
      const isAbortError = err && typeof err === "object" && "name" in err && (err as { name?: unknown }).name === "AbortError";
      const message = isAbortError
        ? `request timeout (${RUNNER_FILE_HTTP_TIMEOUT_MS}ms)`
        : err instanceof Error ? err.message : String(err);
      logSessionDiag?.("runner_file_explorer_load_error", {
        path: targetPath,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        message,
      }, { throttleMs: 0 });
      if (isAbortError) {
        throw new Error(`request timeout (${RUNNER_FILE_HTTP_TIMEOUT_MS}ms)`);
      }
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }, [logSessionDiag, runnerToken, runnerUrl]);

  const mergeExplorerNode = useCallback((
    path: string,
    update: Partial<{
      kind: ExplorerEntryKind;
      name: string;
      childPaths: string[];
      loaded: boolean;
      loading: boolean;
      error: string;
    }>,
  ) => {
    const normalizedPath = normalizeRunnerPath(path);
    if (!normalizedPath) return;
    setExplorerNodesByPath((prev) => {
      const current = prev[normalizedPath];
      const nextNode = {
        kind: update.kind ?? current?.kind ?? "dir",
        name: update.name ?? current?.name ?? getPathLabel(normalizedPath),
        path: normalizedPath,
        childPaths: update.childPaths ?? current?.childPaths ?? [],
        loaded: update.loaded ?? current?.loaded ?? false,
        loading: update.loading ?? current?.loading ?? false,
        error: update.error ?? current?.error ?? "",
      };
      return {
        ...prev,
        [normalizedPath]: nextNode,
      };
    });
  }, [getPathLabel]);

  const loadExplorerChildren = useCallback(async (pathRaw: unknown, forceReload = false) => {
    const targetPath = normalizeRunnerPath(pathRaw);
    if (!targetPath) return;
    const current = explorerNodesByPath[targetPath];
    if (!forceReload && current?.loaded && !current.error) return;
    mergeExplorerNode(targetPath, { loading: true, error: "" });
    try {
      const payload = await fetchDirectories(targetPath);
      const childPaths: string[] = [];
      for (const entry of payload.entries) {
        const childPath = normalizeRunnerPath(entry.path);
        if (!childPath) continue;
        childPaths.push(childPath);
        mergeExplorerNode(childPath, {
          kind: entry.kind,
          name: entry.name,
          loaded: entry.kind === "file" ? true : (explorerNodesByPath[childPath]?.loaded ?? false),
          loading: false,
          error: explorerNodesByPath[childPath]?.error ?? "",
          childPaths: entry.kind === "file"
            ? []
            : (explorerNodesByPath[childPath]?.childPaths ?? []),
        });
      }
      mergeExplorerNode(targetPath, {
        kind: "dir",
        name: getPathLabel(targetPath),
        childPaths,
        loaded: true,
        loading: false,
        error: "",
      });
    } catch (err) {
      mergeExplorerNode(targetPath, {
        loading: false,
        loaded: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }, [explorerNodesByPath, fetchDirectories, getPathLabel, mergeExplorerNode]);

  const reloadExplorerDirectory = useCallback((path: string) => (
    loadExplorerChildren(path, true)
  ), [loadExplorerChildren]);
  const refreshGitChangedFiles = useCallback(() => (
    onRefreshGitChangedFilesRef.current?.()
  ), []);
  const {
    renameTarget,
    requestRename,
    cancelRename,
    renameFile,
    renameFileTarget,
    deleteFile,
  } = useWorkspaceFileMutations({
    runnerUrl,
    runnerToken,
    rootDirectory: selectedDirectoryPath,
    reloadDirectory: reloadExplorerDirectory,
    refreshChangedFiles: refreshGitChangedFiles,
    showInfoToast,
  });

  const stagedFiles = useMemo(
    () => normalizeGitChangedFilePaths(gitChangedFilesStaged),
    [gitChangedFilesStaged]
  );
  const unstagedFiles = useMemo(
    () => normalizeGitChangedFilePaths(gitChangedFilesUnstaged),
    [gitChangedFilesUnstaged]
  );

  const openFileContextMenu = useCallback((
    filePathRaw: unknown,
    fileNameRaw: unknown,
    options?: { allowExecute?: boolean; allowMutate?: boolean },
  ) => {
    const filePath = normalizeRunnerPath(filePathRaw);
    const parentPath = getParentRunnerPath(filePath);
    const parentNode = explorerNodesByPath[parentPath];
    const siblingNodes = parentNode?.childPaths.length
      ? parentNode.childPaths
        .map((childPath) => explorerNodesByPath[normalizeRunnerPath(childPath)])
        .filter((node): node is ExplorerNode => Boolean(node))
      : Object.values(explorerNodesByPath)
        .filter((node) => node.kind === "file" && getParentRunnerPath(node.path) === parentPath);
    const siblingPaths = siblingNodes.length > 0
      ? siblingNodes.map((node) => ({ path: node.path, name: node.name }))
      : Array.from(new Set([...stagedFiles, ...unstagedFiles]))
        .filter((path) => getParentRunnerPath(path) === parentPath)
        .map((path) => ({ path, name: getPathLabel(path) }));
    const mediaItems: RunnerMediaItem[] = siblingPaths
      .map((item) => buildRunnerMediaItem({
        runnerUrl,
        rootDir: selectedDirectoryPath,
        path: item.path,
        name: item.name,
      }))
      .filter((item): item is RunnerMediaItem => Boolean(item));
    openRunnerFileContextMenu({
      filePathRaw: filePath,
      fileNameRaw,
      runnerUrl,
      runnerToken,
      rootDir: selectedDirectoryPath,
      allowExecute: options?.allowExecute,
      allowMutate: options?.allowMutate,
      getPathLabel,
      showInfoToast,
      onOpenMedia,
      onShellScriptStarted: () => {
        setGitPanelTab("running");
      },
      onRequestRename: requestRename,
      onRequestDelete: deleteFile,
      onRenameFile: renameFileTarget,
      mediaItems,
    });
  }, [
    explorerNodesByPath,
    getPathLabel,
    onOpenMedia,
    deleteFile,
    renameFileTarget,
    requestRename,
    runnerToken,
    runnerUrl,
    selectedDirectoryPath,
    showInfoToast,
    stagedFiles,
    unstagedFiles,
  ]);

  const uploadFileToDirectory = useCallback(async (
    targetDirectoryRaw: unknown,
    source: WorkspaceUploadSource,
  ) => {
    const targetDirectory = normalizeRunnerPath(targetDirectoryRaw);
    if (!targetDirectory || workspaceUploadInFlightRef.current) return;
    workspaceUploadInFlightRef.current = true;
    setUploadingDirectoryPath(targetDirectory);
    try {
      const result = await uploadWorkspaceFile({
        runnerUrl,
        runnerToken,
        rootDirectory: selectedDirectoryPath,
        targetDirectory,
        source,
      });
      if (!result) {
        if (source === "clipboard") {
          Alert.alert("貼り付けできません", "クリップボードに画像またはテキストがありません。");
        }
        return;
      }
      showInfoToast(`アップロードしました: ${result.path || result.name}`);
      await loadExplorerChildren(targetDirectory, true);
      await onRefreshGitChangedFilesRef.current?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert("アップロード失敗", message || "ファイルのアップロードに失敗しました。");
    } finally {
      workspaceUploadInFlightRef.current = false;
      setUploadingDirectoryPath("");
    }
  }, [
    loadExplorerChildren,
    runnerToken,
    runnerUrl,
    selectedDirectoryPath,
    showInfoToast,
  ]);

  const openDirectoryUploadMenu = useCallback((
    targetDirectoryRaw: unknown,
    directoryNameRaw: unknown,
  ) => {
    const targetDirectory = normalizeRunnerPath(targetDirectoryRaw);
    if (!targetDirectory || uploadingDirectoryPath) return;
    const directoryName = String(directoryNameRaw || "").trim()
      || getPathLabel(targetDirectory)
      || targetDirectory;
    Alert.alert(
      directoryName,
      `アップロード先: ${targetDirectory}`,
      [
        {
          text: "写真からアップロード",
          onPress: () => {
            void uploadFileToDirectory(targetDirectory, "photos");
          },
        },
        {
          text: "ファイルからアップロード",
          onPress: () => {
            void uploadFileToDirectory(targetDirectory, "files");
          },
        },
        {
          text: "クリップボードから貼り付け",
          onPress: () => {
            void uploadFileToDirectory(targetDirectory, "clipboard");
          },
        },
        {
          text: "キャンセル",
          style: "cancel",
        },
      ]
    );
  }, [getPathLabel, uploadFileToDirectory, uploadingDirectoryPath]);

  const stagedTreeNodes = useMemo(() => buildFileTree(stagedFiles), [stagedFiles]);
  const unstagedTreeNodes = useMemo(() => buildFileTree(unstagedFiles), [unstagedFiles]);
  const explorerFileTreeNodes = useMemo(
    () => buildFileTree(Array.from(new Set([...stagedFiles, ...unstagedFiles]))),
    [stagedFiles, unstagedFiles]
  );
  const explorerChangedFileCount = useMemo(
    () => Array.from(new Set([...stagedFiles, ...unstagedFiles])).length,
    [stagedFiles, unstagedFiles]
  );
  const collectTreeDirectoryKeys = useCallback((nodes: FileTreeNode[], treeKeyPrefix: string): string[] => {
    const keys: string[] = [];
    const visit = (items: FileTreeNode[]) => {
      for (const item of items) {
        if (item.kind !== "dir") continue;
        keys.push(`${treeKeyPrefix}:${item.fullPath}`);
        visit(item.children);
      }
    };
    visit(nodes);
    return keys;
  }, []);

  useEffect(() => {
    Animated.timing(panelAnim, {
      toValue: visible ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [panelAnim, visible]);

  useEffect(() => {
    onRefreshGitChangedFilesRef.current = onRefreshGitChangedFiles;
  }, [onRefreshGitChangedFiles]);

  useEffect(() => {
    if (!visible) return;
    logSessionDiag?.("git_diff_panel_opened", {
      selectedDirectoryPath,
      gitChangedFilesLoading,
      gitChangedFilesError,
      stagedCount: stagedFiles.length,
      unstagedCount: unstagedFiles.length,
    }, { throttleMs: 0 });
    void onRefreshGitChangedFilesRef.current?.();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    if (gitPanelTab !== "explorer") return;
    const rootPath = normalizeRunnerPath(selectedDirectoryPath);
    if (!rootPath) {
      setExplorerGlobalError("ディレクトリーが未選択です");
      return;
    }
    setExplorerGlobalError("");
    if (rootPath !== explorerRootPath) {
      setExplorerRootPath(rootPath);
      setExplorerNodesByPath((prev) => ({
        ...prev,
        [rootPath]: prev[rootPath] || {
          kind: "dir",
          name: getPathLabel(rootPath),
          path: rootPath,
          childPaths: [],
          loaded: false,
          loading: false,
          error: "",
        },
      }));
      setTreeExpanded(`explorer:${rootPath}`, true);
    }
  }, [
    explorerRootPath,
    getPathLabel,
    gitPanelTab,
    selectedDirectoryPath,
    setTreeExpanded,
    visible,
  ]);

  useEffect(() => {
    if (!visible) return;
    if (gitPanelTab !== "explorer") return;
    const rootPath = normalizeRunnerPath(explorerRootPath);
    if (!rootPath) return;
    const rootNode = explorerNodesByPath[rootPath];
    if (rootNode?.loaded || rootNode?.loading) return;
    setExplorerGlobalError("");
    void loadExplorerChildren(rootPath).catch((err) => {
      setExplorerGlobalError(err instanceof Error ? err.message : String(err));
    });
  }, [
    explorerNodesByPath,
    explorerRootPath,
    gitPanelTab,
    loadExplorerChildren,
    visible,
  ]);

  useEffect(() => {
    const nextKeys = [
      ...collectTreeDirectoryKeys(stagedTreeNodes, "diff:staged"),
      ...collectTreeDirectoryKeys(unstagedTreeNodes, "diff:unstaged"),
      ...collectTreeDirectoryKeys(explorerFileTreeNodes, "explorer-files"),
    ];
    if (nextKeys.length <= 0) return;
    setTreeExpandedByKey((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of nextKeys) {
        if (next[key] === undefined) {
          next[key] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [collectTreeDirectoryKeys, explorerFileTreeNodes, stagedTreeNodes, unstagedTreeNodes]);

  const renderTreeNodes = (
    nodes: FileTreeNode[],
    options: {
      depth?: number;
      treeKeyPrefix: string;
      onDirPress?: (fullPath: string) => void;
    },
  ): ReactElement[] => {
    const depth = Number.isFinite(options.depth) ? Number(options.depth) : 0;
    const { treeKeyPrefix, onDirPress } = options;
    return nodes.map((node) => (
      <View key={node.fullPath || node.name} style={styles.gitDiffTreeNodeWrap}>
        {node.kind === "dir" ? (
          <TouchableOpacity
            style={[styles.gitDiffTreeNodeRow, { paddingLeft: 10 + (depth * 14) }]}
            onPress={() => {
              const key = `${treeKeyPrefix}:${node.fullPath}`;
              toggleTreeExpanded(key);
              onDirPress?.(node.fullPath);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${node.name}フォルダーを開閉`}
          >
            <Text style={styles.gitDiffTreeNodeIcon}>
              {treeExpandedByKey[`${treeKeyPrefix}:${node.fullPath}`] ? "▾" : "▸"}
            </Text>
            <Text style={styles.gitDiffTreeNodeDirText}>{node.name}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.gitDiffTreeNodeRow, { paddingLeft: 10 + (depth * 14) }]}
            onPress={() => openFileContextMenu(node.fullPath, node.name, { allowExecute: false })}
            accessibilityRole="button"
            accessibilityLabel={`${node.name}のメニューを表示`}
          >
            <Text style={styles.gitDiffTreeNodeIcon}>・</Text>
            <Text style={styles.gitDiffTreeNodeFileText}>{node.name}</Text>
          </TouchableOpacity>
        )}
        {node.kind === "dir" && treeExpandedByKey[`${treeKeyPrefix}:${node.fullPath}`]
          ? renderTreeNodes(node.children, {
            depth: depth + 1,
            treeKeyPrefix,
            onDirPress,
          })
          : null}
      </View>
    ));
  };

  const renderExplorerNodeByPath = (path: string, depth = 0): ReactElement | null => {
    const normalizedPath = normalizeRunnerPath(path);
    if (!normalizedPath) return null;
    const node = explorerNodesByPath[normalizedPath];
    if (!node) return null;
    if (node.kind === "file") {
      return (
        <View key={normalizedPath} style={styles.gitDiffTreeNodeWrap}>
          <TouchableOpacity
            style={[styles.gitDiffTreeNodeRow, { paddingLeft: 10 + (depth * 14) }]}
            onPress={() => openFileContextMenu(node.path, node.name, {
              allowExecute: true,
              allowMutate: true,
            })}
            accessibilityRole="button"
            accessibilityLabel={`${node.name}のメニューを表示`}
          >
            <Text style={styles.gitDiffTreeNodeIcon}>・</Text>
            <Text style={styles.gitDiffTreeNodeFileText}>{node.name}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    const key = `explorer:${normalizedPath}`;
    const expanded = !!treeExpandedByKey[key];
    return (
      <View key={normalizedPath} style={styles.gitDiffTreeNodeWrap}>
        <TouchableOpacity
          style={[styles.gitDiffTreeNodeRow, { paddingLeft: 10 + (depth * 14) }]}
          onPress={() => {
            const nextExpanded = !expanded;
            setTreeExpanded(key, nextExpanded);
            if (nextExpanded) {
              setExplorerGlobalError("");
              void loadExplorerChildren(normalizedPath).catch((err) => {
                setExplorerGlobalError(err instanceof Error ? err.message : String(err));
              });
            }
          }}
          onLongPress={() => openDirectoryUploadMenu(node.path, node.name)}
          accessibilityRole="button"
          accessibilityLabel={`${node.name}フォルダーを開閉`}
          accessibilityHint="長押しするとファイルをアップロードできます"
        >
          <Text style={styles.gitDiffTreeNodeIcon}>
            {expanded ? "▾" : "▸"}
          </Text>
          <Text style={styles.gitDiffTreeNodeDirText}>{node.name}</Text>
          {node.loading || uploadingDirectoryPath === normalizedPath ? (
            <ActivityIndicator size="small" color="#0f766e" style={styles.gitDiffTreeNodeSpinner} />
          ) : null}
        </TouchableOpacity>
        {node.error ? (
          <Text style={[styles.gitDiffPanelErrorText, styles.gitDiffTreeNodeErrorText]}>{node.error}</Text>
        ) : null}
        {expanded && node.loaded && node.childPaths.length <= 0 ? (
          <Text style={[styles.gitDiffEmptyText, styles.gitDiffTreeNodeEmptyText]}>フォルダーは空です</Text>
        ) : null}
        {expanded && node.childPaths.length > 0
          ? node.childPaths.map((childPath) => renderExplorerNodeByPath(childPath, depth + 1))
          : null}
      </View>
    );
  };

  const explorerRootNode = explorerRootPath ? explorerNodesByPath[explorerRootPath] : null;
  const panelWidth = Math.min(420, Math.max(260, Math.floor(screenWidth * 0.86)));
  const overlayOpacity = panelAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const translateX = panelAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [panelWidth + 20, 0],
  });

  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      style={styles.gitDiffPanelOverlayWrap}
    >
      <Animated.View style={[styles.gitDiffPanelBackdrop, { opacity: overlayOpacity }]}>
        <Pressable style={styles.gitDiffPanelBackdropTouch} onPress={onRequestClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.gitDiffPanel,
          {
            width: panelWidth,
            transform: [{ translateX }],
          },
        ]}
      >
        <View style={styles.gitDiffPanelHeader}>
          <Text style={styles.gitDiffPanelTitle}>Git差分</Text>
          <View style={styles.gitDiffPanelHeaderActions}>
            <TouchableOpacity
              style={styles.gitDiffPanelHeaderButton}
              onPress={() => {
                if (gitPanelTab === "running") {
                  setRunningJobsRefreshSignal((prev) => prev + 1);
                  return;
                }
                void onRefreshGitChangedFiles?.();
              }}
              disabled={gitPanelTab === "running" ? runningJobsLoading : !!gitChangedFilesLoading}
              accessibilityRole="button"
              accessibilityLabel={gitPanelTab === "running" ? "実行ジョブを再読み込み" : "差分を再読み込み"}
            >
              <Ionicons name="refresh" size={15} color="#0f172a" />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.gitDiffPanelHeaderButton}
              onPress={onRequestClose}
              accessibilityRole="button"
              accessibilityLabel="差分パネルを閉じる"
            >
              <Ionicons name="close" size={16} color="#0f172a" />
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.gitDiffPanelTabRow}>
          <TouchableOpacity
            style={[
              styles.gitDiffPanelTabButton,
              gitPanelTab === "diff" ? styles.gitDiffPanelTabButtonActive : null,
            ]}
            onPress={() => setGitPanelTab("diff")}
            accessibilityRole="button"
            accessibilityLabel="Git差分タブを表示"
          >
            <Text
              style={[
                styles.gitDiffPanelTabButtonText,
                gitPanelTab === "diff" ? styles.gitDiffPanelTabButtonTextActive : null,
              ]}
            >
              Git差分
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.gitDiffPanelTabButton,
              gitPanelTab === "explorer" ? styles.gitDiffPanelTabButtonActive : null,
            ]}
            onPress={() => setGitPanelTab("explorer")}
            accessibilityRole="button"
            accessibilityLabel="File Explorerタブを表示"
          >
            <Text
              style={[
                styles.gitDiffPanelTabButtonText,
                gitPanelTab === "explorer" ? styles.gitDiffPanelTabButtonTextActive : null,
              ]}
            >
              File Explorer
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.gitDiffPanelTabButton,
              gitPanelTab === "running" ? styles.gitDiffPanelTabButtonActive : null,
            ]}
            onPress={() => setGitPanelTab("running")}
            accessibilityRole="button"
            accessibilityLabel="実行中タブを表示"
          >
            <Text
              style={[
                styles.gitDiffPanelTabButtonText,
                gitPanelTab === "running" ? styles.gitDiffPanelTabButtonTextActive : null,
              ]}
            >
              実行中
            </Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.gitDiffPanelScroll} contentContainerStyle={styles.gitDiffPanelScrollContent}>
          {(gitPanelTab !== "running" && gitChangedFilesLoading) ? (
            <View style={styles.gitDiffPanelStatusRow}>
              <ActivityIndicator size="small" color="#0f766e" />
              <Text style={styles.gitDiffPanelStatusText}>差分を読み込み中...</Text>
            </View>
          ) : null}
          {(gitPanelTab !== "running" && gitChangedFilesError) ? (
            <Text style={styles.gitDiffPanelErrorText}>{gitChangedFilesError}</Text>
          ) : null}
          {gitPanelTab === "running" ? (
            <GitDiffRunningJobsSection
              active={visible && gitPanelTab === "running"}
              runnerUrl={runnerUrl}
              runnerToken={runnerToken}
              refreshSignal={runningJobsRefreshSignal}
              showInfoToast={showInfoToast}
              onLoadingChange={setRunningJobsLoading}
            />
          ) : null}
          {gitPanelTab === "diff" ? (
            <>
              <View style={styles.gitDiffSectionCard}>
                <Text style={styles.gitDiffSectionTitle}>{`staged (${stagedFiles.length})`}</Text>
                {stagedTreeNodes.length > 0 ? (
                  <View style={styles.gitDiffTreeWrap}>
                    {renderTreeNodes(stagedTreeNodes, { treeKeyPrefix: "diff:staged" })}
                  </View>
                ) : (
                  <Text style={styles.gitDiffEmptyText}>変更ファイルはありません</Text>
                )}
              </View>
              <View style={styles.gitDiffSectionCard}>
                <Text style={styles.gitDiffSectionTitle}>{`unstaged (${unstagedFiles.length})`}</Text>
                <Text style={styles.gitDiffSectionHint}>untracked を含みます</Text>
                {unstagedTreeNodes.length > 0 ? (
                  <View style={styles.gitDiffTreeWrap}>
                    {renderTreeNodes(unstagedTreeNodes, { treeKeyPrefix: "diff:unstaged" })}
                  </View>
                ) : (
                  <Text style={styles.gitDiffEmptyText}>変更ファイルはありません</Text>
                )}
              </View>
            </>
          ) : gitPanelTab === "explorer" ? (
            <>
              <View style={styles.gitDiffSectionCard}>
                <Text style={styles.gitDiffSectionTitle}>{`changed files (${explorerChangedFileCount})`}</Text>
                <Text style={styles.gitDiffSectionHint}>Git差分と同じツリー表示</Text>
                {explorerFileTreeNodes.length > 0 ? (
                  <View style={styles.gitDiffTreeWrap}>
                    {renderTreeNodes(explorerFileTreeNodes, { treeKeyPrefix: "explorer-files" })}
                  </View>
                ) : (
                  <Text style={styles.gitDiffEmptyText}>変更ファイルはありません</Text>
                )}
              </View>
              <View style={styles.gitDiffSectionCard}>
                {explorerGlobalError ? (
                  <Text style={styles.gitDiffPanelErrorText}>{explorerGlobalError}</Text>
                ) : null}
                {explorerRootPath ? (
                  <>
                    {explorerRootNode?.loading && !explorerRootNode.loaded ? (
                      <View style={styles.gitDiffPanelStatusRow}>
                        <ActivityIndicator size="small" color="#0f766e" />
                        <Text style={styles.gitDiffPanelStatusText}>読み込み中...</Text>
                      </View>
                    ) : null}
                    {explorerRootNode ? renderExplorerNodeByPath(explorerRootPath, 0) : null}
                  </>
                ) : (
                  <Text style={styles.gitDiffEmptyText}>ディレクトリーが未選択です</Text>
                )}
              </View>
            </>
          ) : null}
        </ScrollView>
      </Animated.View>
      <WorkspaceFileRenameDialog
        target={renameTarget}
        onCancel={cancelRename}
        onRename={renameFile}
      />
    </View>
  );
}
