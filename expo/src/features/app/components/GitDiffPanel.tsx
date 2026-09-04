import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
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
import { USE_NATIVE_ANIMATION_DRIVER } from "../utils/animationDriver";
import { Ionicons } from "@expo/vector-icons";
import { styles } from "../styles";
import { GitBranchDropdown, type GitBranchOption } from "./GitBranchDropdown";
import { GitDiffRunningJobsSection } from "./GitDiffRunningJobsSection";
import {
  RunnerFileExplorer,
  type RunnerFileExplorerEntry,
  type RunnerFileExplorerRef,
} from "./RunnerFileExplorer";
import { WorkspaceFileRenameDialog } from "./WorkspaceFileRenameDialog";
import { WorkspaceTextFileEditor } from "./WorkspaceTextFileEditor";
import { useWorkspaceFileMutations } from "../hooks/useWorkspaceFileMutations";
import { useSkiaBoard } from "../contexts/SkiaBoardContext";
import { buildGitDiffFileTree, type GitDiffFileTreeNode } from "../utils/gitDiffFileTree";
import { normalizeGitChangedFilePaths } from "../utils/gitChangedFiles";
import {
  buildRunnerMediaItem,
  normalizeRunnerPath,
  openRunnerFileContextMenu,
  type RunnerFileViewerTarget,
  type RunnerMediaFile,
  type RunnerMediaItem,
} from "../utils/runnerFileContextMenu";
import {
  uploadWorkspaceFile,
  type WorkspaceFileTarget,
  type WorkspaceUploadSource,
} from "../utils/workspaceFiles";
import { supportsWorkspaceFilePicking } from "../utils/workspaceUploadPicker";

type GitPanelTab = "diff" | "explorer" | "running";
type GitDiffPanelProps = {
  visible: boolean;
  runnerUrl: string;
  runnerToken: string;
  selectedDirectoryPath: string;
  selectedDirectoryDisplayName: string;
  gitBranchName: string;
  gitBranches: GitBranchOption[];
  gitChangedFilesStaged: unknown[];
  gitChangedFilesUnstaged: unknown[];
  gitChangedFilesLoading: boolean;
  gitChangedFilesError: string;
  onRequestClose: () => void;
  onRefreshGitChangedFiles?: () => void | Promise<void>;
  showInfoToast: (textRaw: unknown) => void;
  onOpenMedia: (media: RunnerMediaFile) => void;
  onOpenFile?: (target: RunnerFileViewerTarget) => void;
  onSpeakText?: (text: string, target: WorkspaceFileTarget) => void;
  logSessionDiag?: (
    event: string,
    payload?: Record<string, unknown>,
    options?: { throttleMs?: number; throttleKey?: string; detailed?: boolean }
  ) => void;
};

function getParentRunnerPath(pathRaw: unknown) {
  const normalizedPath = normalizeRunnerPath(pathRaw).replace(/\/+$/, "");
  if (!normalizedPath || normalizedPath === ".") return ".";
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex < 0) return ".";
  if (separatorIndex === 0) return "/";
  return normalizedPath.slice(0, separatorIndex);
}

export const GitDiffPanel = memo(function GitDiffPanel({
  visible,
  runnerUrl,
  runnerToken,
  selectedDirectoryPath,
  selectedDirectoryDisplayName,
  gitBranchName,
  gitBranches,
  gitChangedFilesStaged,
  gitChangedFilesUnstaged,
  gitChangedFilesLoading,
  gitChangedFilesError,
  onRequestClose,
  onRefreshGitChangedFiles,
  showInfoToast,
  onOpenMedia,
  onOpenFile,
  onSpeakText,
  logSessionDiag,
}: GitDiffPanelProps) {
  const {
    addFile,
    removeFile,
    hasFile,
    loaded: skiaBoardLoaded,
  } = useSkiaBoard();
  const hasEverBeenVisibleRef = useRef(visible);
  if (visible) hasEverBeenVisibleRef.current = true;
  const [gitPanelTab, setGitPanelTab] = useState<GitPanelTab>("diff");
  const [treeExpandedByKey, setTreeExpandedByKey] = useState<Record<string, boolean>>({});
  const [uploadingDirectoryPath, setUploadingDirectoryPath] = useState("");
  const [runningJobsRefreshSignal, setRunningJobsRefreshSignal] = useState(0);
  const [runningJobsLoading, setRunningJobsLoading] = useState(false);
  const panelAnim = useRef(new Animated.Value(0)).current;
  const onRefreshGitChangedFilesRef = useRef(onRefreshGitChangedFiles);
  const fileExplorerRef = useRef<RunnerFileExplorerRef>(null);
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

  const toggleTreeExpanded = useCallback((key: string) => {
    if (!key) return;
    setTreeExpandedByKey((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, []);

  const reloadExplorerDirectory = useCallback((path: string) => (
    fileExplorerRef.current?.reloadDirectory(path) || Promise.resolve()
  ), []);
  const refreshGitChangedFiles = useCallback(() => (
    onRefreshGitChangedFilesRef.current?.()
  ), []);
  const {
    renameTarget,
    requestRename,
    cancelRename,
    renameFile,
    renameFileTarget,
    editTarget,
    requestEdit,
    cancelEdit,
    writeFileContent,
    createFileDirectory,
    requestCreateFile,
    cancelCreateFile,
    createFile,
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
    options?: {
      allowExecute?: boolean;
      allowMutate?: boolean;
      siblings?: RunnerFileExplorerEntry[];
    },
  ) => {
    const filePath = normalizeRunnerPath(filePathRaw);
    const parentPath = getParentRunnerPath(filePath);
    const siblingPaths = options?.siblings?.length
      ? options.siblings
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
      onOpenFile,
      onSpeakText,
      onShellScriptStarted: () => {
        setGitPanelTab("running");
      },
      onRequestRename: requestRename,
      onRequestEdit: requestEdit,
      onRequestDelete: deleteFile,
      onRenameFile: renameFileTarget,
      mediaItems,
      skiaBoard: skiaBoardLoaded
        ? { addFile, removeFile, hasFile }
        : undefined,
    });
  }, [
    addFile,
    getPathLabel,
    hasFile,
    onOpenMedia,
    onOpenFile,
    onSpeakText,
    deleteFile,
    renameFileTarget,
    requestRename,
    requestEdit,
    removeFile,
    runnerToken,
    runnerUrl,
    selectedDirectoryPath,
    showInfoToast,
    skiaBoardLoaded,
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
      await reloadExplorerDirectory(targetDirectory);
      await onRefreshGitChangedFilesRef.current?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert("アップロード失敗", message || "ファイルのアップロードに失敗しました。");
    } finally {
      workspaceUploadInFlightRef.current = false;
      setUploadingDirectoryPath("");
    }
  }, [
    reloadExplorerDirectory,
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
          text: "新規ファイル作成",
          onPress: () => {
            requestCreateFile(targetDirectory);
          },
        },
        ...(supportsWorkspaceFilePicking ? [
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
        ] : []),
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
  }, [getPathLabel, requestCreateFile, uploadFileToDirectory, uploadingDirectoryPath]);

  const stagedTreeNodes = useMemo(() => buildGitDiffFileTree(stagedFiles), [stagedFiles]);
  const unstagedTreeNodes = useMemo(() => buildGitDiffFileTree(unstagedFiles), [unstagedFiles]);
  const explorerFileTreeNodes = useMemo(
    () => buildGitDiffFileTree(Array.from(new Set([...stagedFiles, ...unstagedFiles]))),
    [stagedFiles, unstagedFiles]
  );
  const explorerChangedFileCount = useMemo(
    () => Array.from(new Set([...stagedFiles, ...unstagedFiles])).length,
    [stagedFiles, unstagedFiles]
  );
  useEffect(() => {
    Animated.timing(panelAnim, {
      toValue: visible ? 1 : 0,
      duration: 180,
      useNativeDriver: USE_NATIVE_ANIMATION_DRIVER,
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

  const renderTreeNodes = (
    nodes: GitDiffFileTreeNode[],
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

  if (!hasEverBeenVisibleRef.current) return null;

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
              <GitBranchDropdown
                currentBranchName={gitBranchName}
                branches={gitBranches}
              />
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
                <RunnerFileExplorer
                  ref={fileExplorerRef}
                  active={visible && gitPanelTab === "explorer"}
                  runnerUrl={runnerUrl}
                  runnerToken={runnerToken}
                  rootPath={selectedDirectoryPath}
                  rootDisplayName={selectedDirectoryDisplayName}
                  loadingDirectoryPath={uploadingDirectoryPath}
                  logSessionDiag={logSessionDiag}
                  onFilePress={(entry, siblings) => openFileContextMenu(entry.path, entry.name, {
                    allowExecute: true,
                    allowMutate: true,
                    siblings,
                  })}
                  onDirectoryLongPress={(entry) => openDirectoryUploadMenu(entry.path, entry.name)}
                />
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
      <WorkspaceFileRenameDialog
        target={createFileDirectory ? { path: createFileDirectory, name: "" } : null}
        title="新規ファイル作成"
        submitLabel="作成"
        onCancel={cancelCreateFile}
        onRename={createFile}
      />
      <WorkspaceTextFileEditor
        target={editTarget}
        runnerUrl={runnerUrl}
        runnerToken={runnerToken}
        rootDirectory={selectedDirectoryPath}
        onClose={cancelEdit}
        onSave={writeFileContent}
      />
    </View>
  );
});
