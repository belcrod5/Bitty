import { useCallback, useState } from "react";
import { Alert } from "react-native";
import {
  mutateWorkspaceFile,
  writeWorkspaceTextFile,
  type WorkspaceFileMutationResult,
  type WorkspaceFileTarget,
} from "../utils/workspaceFiles";

type UseWorkspaceFileMutationsParams = {
  runnerUrl: string;
  runnerToken: string;
  rootDirectory: string;
  reloadDirectory?: (path: string) => Promise<void>;
  refreshChangedFiles: () => void | Promise<void>;
  showInfoToast: (textRaw: unknown) => void;
};

function getParentPath(pathRaw: unknown) {
  const normalizedPath = String(pathRaw || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex < 0) return ".";
  if (separatorIndex === 0) return "/";
  return normalizedPath.slice(0, separatorIndex);
}

export function useWorkspaceFileMutations({
  runnerUrl,
  runnerToken,
  rootDirectory,
  reloadDirectory,
  refreshChangedFiles,
  showInfoToast,
}: UseWorkspaceFileMutationsParams) {
  const [renameTarget, setRenameTarget] = useState<WorkspaceFileTarget | null>(null);
  const [editTarget, setEditTarget] = useState<WorkspaceFileTarget | null>(null);

  const refreshAfterMutation = useCallback(async (result: WorkspaceFileMutationResult) => {
    const pathsToReload = new Set([
      result.previousDirectory || getParentPath(result.previousPath || result.path),
      result.directory || getParentPath(result.path),
      String(rootDirectory || "").trim(),
    ]);
    if (reloadDirectory) {
      for (const path of pathsToReload) {
        if (!path) continue;
        await reloadDirectory(path);
      }
    }
    await refreshChangedFiles();
  }, [refreshChangedFiles, reloadDirectory, rootDirectory]);

  const refreshAfterMutationWithAlert = useCallback(async (result: WorkspaceFileMutationResult) => {
    try {
      await refreshAfterMutation(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert("再読み込み失敗", message || "ファイル一覧の更新に失敗しました。");
    }
  }, [refreshAfterMutation]);

  const renameFileTarget = useCallback(async (
    target: WorkspaceFileTarget,
    nextName: string,
  ) => {
    try {
      const result = await mutateWorkspaceFile({
        runnerUrl,
        runnerToken,
        rootDirectory,
        path: target.path,
        operation: "rename",
        name: nextName,
      });
      setRenameTarget(null);
      showInfoToast(`名前を変更しました: ${result.path}`);
      await refreshAfterMutationWithAlert(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert("名前変更失敗", message || "ファイル名の変更に失敗しました。");
      throw err;
    }
  }, [
    refreshAfterMutationWithAlert,
    rootDirectory,
    runnerToken,
    runnerUrl,
    showInfoToast,
  ]);

  const renameFile = useCallback(async (nextName: string) => {
    const target = renameTarget;
    if (!target) return;
    await renameFileTarget(target, nextName);
  }, [renameFileTarget, renameTarget]);

  const writeFileContent = useCallback(async (
    target: WorkspaceFileTarget,
    content: string,
  ) => {
    try {
      const result = await writeWorkspaceTextFile({
        runnerUrl,
        runnerToken,
        rootDirectory,
        path: target.path,
        content,
      });
      showInfoToast(`保存しました: ${result.path || target.path}`);
      await refreshAfterMutationWithAlert(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert("保存失敗", message || "ファイルの保存に失敗しました。");
      throw err;
    }
  }, [
    refreshAfterMutationWithAlert,
    rootDirectory,
    runnerToken,
    runnerUrl,
    showInfoToast,
  ]);

  const deleteFile = useCallback(async (target: WorkspaceFileTarget) => {
    try {
      const result = await mutateWorkspaceFile({
        runnerUrl,
        runnerToken,
        rootDirectory,
        path: target.path,
        operation: "delete",
      });
      showInfoToast(`削除しました: ${result.path || target.path}`);
      await refreshAfterMutationWithAlert(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert("削除失敗", message || "ファイルの削除に失敗しました。");
    }
  }, [
    refreshAfterMutationWithAlert,
    rootDirectory,
    runnerToken,
    runnerUrl,
    showInfoToast,
  ]);

  return {
    renameTarget,
    requestRename: setRenameTarget,
    cancelRename: () => setRenameTarget(null),
    renameFile,
    renameFileTarget,
    editTarget,
    requestEdit: setEditTarget,
    cancelEdit: () => setEditTarget(null),
    writeFileContent,
    deleteFile,
  };
}
