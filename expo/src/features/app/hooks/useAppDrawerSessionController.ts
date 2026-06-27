import { useCallback, useMemo } from "react";
import type { AppDrawerProps, DirectorySessionTreeState, RegisteredDirectoryEntry } from "../components/AppDrawer";
import type { PopupChatSourceRect } from "../components/popupChatTypes";
import type { LlmSessionSource } from "./useLlmSessionExplorer";

type UseAppDrawerSessionControllerArgs = {
  selectedDirectoryPath: string;
  selectedLlmSessionId: string;
  registeredDirectories: RegisteredDirectoryEntry[];
  expandedDirectoryIds: string[];
  directorySessionsById: Record<string, DirectorySessionTreeState>;
  sessionTitleOverridesById: Record<string, string>;
  sessionMarkerColorsById: Record<string, RegisteredDirectoryEntry["markerColor"]>;
  llmSessionRestoreLoading: boolean;
  llmSessionRestoreTargetId: string;
  formatSessionUpdatedAt: (updatedAt: string) => string;
  closeDrawer: () => void;
  openDebugScreen: () => void;
  openMiniBoardScreen: () => void;
  openCloudflareTunnelMonitorScreen: () => void;
  openSkiaBoardScreen: () => void;
  openDirectoryExplorer: () => void;
  toggleDirectoryExpanded: (directoryId: string, directoryPath: string) => void;
  loadMoreDirectorySessionTree: (directoryId: string, directoryPath: string) => Promise<void>;
  loadSessionChildTree: (directoryId: string, directoryPath: string, parentSessionId: string) => Promise<void>;
  selectLlmDirectory: (directoryPath: string) => void;
  openNewSessionPopup: (params: { directory: string }) => void;
  openSessionHistoryPopup: (params: {
    sessionId: string;
    source: LlmSessionSource;
    directory?: string;
    sourceRect?: PopupChatSourceRect;
  }) => void;
  markSessionUnread: (params: {
    sessionId: string;
    source: LlmSessionSource;
    directory: string;
  }) => void;
  markSessionRead: (params: {
    sessionId: string;
    source: LlmSessionSource;
    directory: string;
  }) => void;
  markDirectorySessionsRead: (params: {
    directory: string;
  }) => void;
};

export function useAppDrawerSessionController({
  selectedDirectoryPath,
  selectedLlmSessionId,
  registeredDirectories,
  expandedDirectoryIds,
  directorySessionsById,
  sessionTitleOverridesById,
  sessionMarkerColorsById,
  llmSessionRestoreLoading,
  llmSessionRestoreTargetId,
  formatSessionUpdatedAt,
  closeDrawer,
  openDebugScreen,
  openMiniBoardScreen,
  openCloudflareTunnelMonitorScreen,
  openSkiaBoardScreen,
  openDirectoryExplorer,
  toggleDirectoryExpanded,
  loadMoreDirectorySessionTree,
  loadSessionChildTree,
  selectLlmDirectory,
  openNewSessionPopup,
  openSessionHistoryPopup,
  markSessionUnread,
  markSessionRead,
  markDirectorySessionsRead,
}: UseAppDrawerSessionControllerArgs): AppDrawerProps {
  const handleOpenDebug = useCallback(() => {
    closeDrawer();
    openDebugScreen();
  }, [closeDrawer, openDebugScreen]);
  const handleOpenMiniBoard = useCallback(() => {
    closeDrawer();
    openMiniBoardScreen();
  }, [closeDrawer, openMiniBoardScreen]);
  const handleOpenCloudflareTunnelMonitor = useCallback(() => {
    closeDrawer();
    openCloudflareTunnelMonitorScreen();
  }, [closeDrawer, openCloudflareTunnelMonitorScreen]);
  const handleOpenSkiaBoard = useCallback(() => {
    closeDrawer();
    openSkiaBoardScreen();
  }, [closeDrawer, openSkiaBoardScreen]);

  const handleOpenDirectoryExplorer = useCallback(() => {
    closeDrawer();
    openDirectoryExplorer();
  }, [closeDrawer, openDirectoryExplorer]);

  const handleToggleDirectoryExpanded = useCallback((directoryId: string, directoryPath: string) => {
    toggleDirectoryExpanded(directoryId, directoryPath);
  }, [toggleDirectoryExpanded]);

  const handleLoadMoreSessions = useCallback((directoryId: string, directoryPath: string) => {
    void loadMoreDirectorySessionTree(directoryId, directoryPath);
  }, [loadMoreDirectorySessionTree]);

  const handleLoadSessionChildren = useCallback((
    directoryId: string,
    directoryPath: string,
    parentSessionId: string
  ) => {
    void loadSessionChildTree(directoryId, directoryPath, parentSessionId);
  }, [loadSessionChildTree]);

  const handleSelectDirectory = useCallback((directoryPath: string) => {
    selectLlmDirectory(directoryPath);
    closeDrawer();
    openNewSessionPopup({ directory: directoryPath });
  }, [closeDrawer, openNewSessionPopup, selectLlmDirectory]);

  const handleSelectSessionHistoryEntry = useCallback((
    sessionId: string,
    source: LlmSessionSource,
    directoryPath: string,
    sourceRect?: PopupChatSourceRect
  ) => {
    selectLlmDirectory(directoryPath);
    openSessionHistoryPopup({
      sessionId,
      source,
      directory: directoryPath,
      sourceRect,
    });
  }, [
    openSessionHistoryPopup,
    selectLlmDirectory,
  ]);

  const handleMarkSessionUnread = useCallback((
    sessionId: string,
    source: LlmSessionSource,
    directoryPath: string
  ) => {
    markSessionUnread({
      sessionId,
      source,
      directory: directoryPath,
    });
  }, [markSessionUnread]);

  const handleMarkSessionRead = useCallback((
    sessionId: string,
    source: LlmSessionSource,
    directoryPath: string
  ) => {
    markSessionRead({
      sessionId,
      source,
      directory: directoryPath,
    });
  }, [markSessionRead]);

  const handleMarkDirectorySessionsRead = useCallback((directoryPath: string) => {
    markDirectorySessionsRead({
      directory: directoryPath,
    });
  }, [markDirectorySessionsRead]);

  return useMemo(() => ({
    selectedDirectoryPath,
    selectedLlmSessionId,
    registeredDirectories,
    expandedDirectoryIds,
    directorySessionsById,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    llmSessionRestoreLoading,
    llmSessionRestoreTargetId,
    formatSessionUpdatedAt,
    onOpenDebug: handleOpenDebug,
    onOpenMiniBoard: handleOpenMiniBoard,
    onOpenCloudflareTunnelMonitor: handleOpenCloudflareTunnelMonitor,
    onOpenSkiaBoard: handleOpenSkiaBoard,
    onOpenDirectoryExplorer: handleOpenDirectoryExplorer,
    onToggleDirectoryExpanded: handleToggleDirectoryExpanded,
    onLoadMoreSessions: handleLoadMoreSessions,
    onLoadSessionChildren: handleLoadSessionChildren,
    onStartNewSessionInDirectory: handleSelectDirectory,
    onSelectSessionHistoryEntry: handleSelectSessionHistoryEntry,
    onMarkSessionRead: handleMarkSessionRead,
    onMarkSessionUnread: handleMarkSessionUnread,
    onMarkDirectorySessionsRead: handleMarkDirectorySessionsRead,
  }), [
    selectedDirectoryPath,
    selectedLlmSessionId,
    registeredDirectories,
    expandedDirectoryIds,
    directorySessionsById,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    llmSessionRestoreLoading,
    llmSessionRestoreTargetId,
    formatSessionUpdatedAt,
    handleOpenDebug,
    handleOpenMiniBoard,
    handleOpenCloudflareTunnelMonitor,
    handleOpenSkiaBoard,
    handleOpenDirectoryExplorer,
    handleToggleDirectoryExpanded,
    handleLoadMoreSessions,
    handleLoadSessionChildren,
    handleSelectDirectory,
    handleSelectSessionHistoryEntry,
    handleMarkSessionRead,
    handleMarkSessionUnread,
    handleMarkDirectorySessionsRead,
  ]);
}
