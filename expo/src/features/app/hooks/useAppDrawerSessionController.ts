import { useCallback, useMemo } from "react";
import type {
  AppDrawerProps,
} from "../components/AppDrawer";
import type {
  DirectoryReadProgress,
  DirectorySessionSyncState,
  DirectorySessionTreeState,
  RegisteredDirectoryEntry,
} from "../types/directorySessions";
import type { PopupChatSourceRect } from "../components/popupChatTypes";
import type { LlmSessionSource } from "./useLlmSessionExplorer";

type UseAppDrawerSessionControllerArgs = {
  selectedDirectoryPath: string;
  highlightedSessionId: string;
  registeredDirectories: RegisteredDirectoryEntry[];
  expandedDirectoryIds: string[];
  directorySessionsById: Record<string, DirectorySessionTreeState>;
  directoryReadProgressByPath: Record<string, DirectoryReadProgress>;
  directoryUnreadCountByPath: Record<string, number>;
  directorySessionSync: DirectorySessionSyncState;
  sessionTitleOverridesById: Record<string, string>;
  sessionMarkerColorsById: Record<string, RegisteredDirectoryEntry["markerColor"]>;
  llmSessionRestoreLoading: boolean;
  llmSessionRestoreTargetId: string;
  formatSessionUpdatedAt: (updatedAt: string) => string;
  closeDrawer: () => void;
  openSettingsScreen: () => void;
  openDirectoryExplorer: () => void;
  toggleDirectoryExpanded: (directoryId: string, directoryPath: string) => void;
  loadMoreDirectorySessionTree: (directoryId: string, directoryPath: string) => Promise<void>;
  watchSessionChildren: (sessionIds: string[], directory: string) => () => void;
  selectLlmDirectory: (directoryPath: string) => void;
  openNewSessionPopup: (params: { directory: string }) => void;
  openSessionHistoryPopup: (params: {
    backendId: string;
    sessionId: string;
    source: LlmSessionSource;
    directory?: string;
    sourceRect?: PopupChatSourceRect;
  }) => void;
  markDirectorySessionsRead: (params: {
    directory: string;
  }) => void;
};

export function useAppDrawerSessionController({
  selectedDirectoryPath,
  highlightedSessionId,
  registeredDirectories,
  expandedDirectoryIds,
  directorySessionsById,
  directoryReadProgressByPath,
  directoryUnreadCountByPath,
  directorySessionSync,
  sessionTitleOverridesById,
  sessionMarkerColorsById,
  llmSessionRestoreLoading,
  llmSessionRestoreTargetId,
  formatSessionUpdatedAt,
  closeDrawer,
  openSettingsScreen,
  openDirectoryExplorer,
  toggleDirectoryExpanded,
  loadMoreDirectorySessionTree,
  watchSessionChildren,
  selectLlmDirectory,
  openNewSessionPopup,
  openSessionHistoryPopup,
  markDirectorySessionsRead,
}: UseAppDrawerSessionControllerArgs): AppDrawerProps {
  const handleOpenSettings = useCallback(() => {
    closeDrawer();
    openSettingsScreen();
  }, [closeDrawer, openSettingsScreen]);
  const handleOpenDirectoryExplorer = useCallback(() => {
    closeDrawer();
    openDirectoryExplorer();
  }, [closeDrawer, openDirectoryExplorer]);

  const handleToggleDirectoryExpanded = useCallback((directoryId: string, directoryPath: string) => {
    toggleDirectoryExpanded(directoryId, directoryPath);
  }, [toggleDirectoryExpanded]);

  const handleLoadMoreSessions = useCallback((directoryId: string, directoryPath: string) => {
    const state = directorySessionsById[directoryId];
    if (state?.loading || state?.refreshing || state?.loadingMore) return;
    void loadMoreDirectorySessionTree(directoryId, directoryPath);
  }, [directorySessionsById, loadMoreDirectorySessionTree]);

  const handleSelectDirectory = useCallback((directoryPath: string) => {
    selectLlmDirectory(directoryPath);
    closeDrawer();
    openNewSessionPopup({ directory: directoryPath });
  }, [closeDrawer, openNewSessionPopup, selectLlmDirectory]);

  const handleSelectSessionHistoryEntry = useCallback((
    backendId: string,
    sessionId: string,
    source: LlmSessionSource,
    directoryPath: string,
    sourceRect?: PopupChatSourceRect
  ) => {
    selectLlmDirectory(directoryPath);
    openSessionHistoryPopup({
      backendId,
      sessionId,
      source,
      directory: directoryPath,
      sourceRect,
    });
  }, [
    openSessionHistoryPopup,
    selectLlmDirectory,
  ]);

  const handleMarkDirectorySessionsRead = useCallback((directoryPath: string) => {
    markDirectorySessionsRead({
      directory: directoryPath,
    });
  }, [markDirectorySessionsRead]);

  return useMemo(() => ({
    selectedDirectoryPath,
    highlightedSessionId,
    registeredDirectories,
    expandedDirectoryIds,
    directorySessionsById,
    directoryReadProgressByPath,
    directoryUnreadCountByPath,
    directorySessionSync,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    llmSessionRestoreLoading,
    llmSessionRestoreTargetId,
    formatSessionUpdatedAt,
    onOpenSettings: handleOpenSettings,
    onOpenDirectoryExplorer: handleOpenDirectoryExplorer,
    onToggleDirectoryExpanded: handleToggleDirectoryExpanded,
    onLoadMoreSessions: handleLoadMoreSessions,
    watchSessionChildren,
    onStartNewSessionInDirectory: handleSelectDirectory,
    onSelectSessionHistoryEntry: handleSelectSessionHistoryEntry,
    onMarkDirectorySessionsRead: handleMarkDirectorySessionsRead,
  }), [
    selectedDirectoryPath,
    highlightedSessionId,
    registeredDirectories,
    expandedDirectoryIds,
    directorySessionsById,
    directoryReadProgressByPath,
    directoryUnreadCountByPath,
    directorySessionSync,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    llmSessionRestoreLoading,
    llmSessionRestoreTargetId,
    formatSessionUpdatedAt,
    handleOpenSettings,
    handleOpenDirectoryExplorer,
    handleToggleDirectoryExpanded,
    handleLoadMoreSessions,
    watchSessionChildren,
    handleSelectDirectory,
    handleSelectSessionHistoryEntry,
    handleMarkDirectorySessionsRead,
  ]);
}
