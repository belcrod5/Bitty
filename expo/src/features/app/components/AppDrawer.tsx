import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import type { LlmSessionHistoryEntry, LlmSessionSource } from "../hooks/useLlmSessionExplorer";
import type { PopupChatSourceRect } from "./popupChatTypes";
import { styles } from "../styles";
import { formatLlmSessionDisplayTitle, isLlmSessionUnread } from "../utils/llmSession";
import { formatModelRefForDisplay } from "../utils/settingsParsers";
import { AppModal } from "./AppModal";
import type {
  DirectoryMarkerColor,
  DirectoryReadProgress,
  DirectorySessionSyncState,
  DirectorySessionTreeState,
  RegisteredDirectoryEntry,
  SessionChildTreeState,
} from "../types/directorySessions";
import { useSkiaBoard } from "../contexts/SkiaBoardContext";
import {
  AppDrawerSearch,
  APP_DRAWER_SEARCH_INPUT_ACCESSORY_ID,
} from "./AppDrawerSearch";

export type {
  DirectoryMarkerColor,
  DirectoryReadProgress,
  DirectorySessionTreeState,
  RegisteredDirectoryEntry,
  SessionChildTreeState,
} from "../types/directorySessions";

export type AppDrawerProps = {
  selectedDirectoryPath: string;
  // ハイライト対象のセッション（最後に開いたセッション。メインチャットの選択とは別系統）
  highlightedSessionId: string;
  registeredDirectories: RegisteredDirectoryEntry[];
  expandedDirectoryIds: string[];
  directorySessionsById: Record<string, DirectorySessionTreeState>;
  directoryReadProgressByPath: Record<string, DirectoryReadProgress>;
  directoryUnreadCountByPath: Record<string, number>;
  directorySessionSync: DirectorySessionSyncState;
  sessionTitleOverridesById: Record<string, string>;
  sessionMarkerColorsById: Record<string, DirectoryMarkerColor>;
  llmSessionRestoreLoading: boolean;
  llmSessionRestoreTargetId: string;
  formatSessionUpdatedAt: (updatedAt: string) => string;
  onOpenSettings: () => void;
  onOpenCloudflareTunnelMonitor: () => void;
  onOpenSkiaBoard: () => void;
  onOpenDirectoryExplorer: () => void;
  onToggleDirectoryExpanded: (directoryId: string, directoryPath: string) => void;
  onLoadMoreSessions: (directoryId: string, directoryPath: string) => void;
  onLoadSessionChildren: (directoryId: string, directoryPath: string, parentSessionId: string) => void;
  onStartNewSessionInDirectory: (directoryPath: string) => void;
  onSelectSessionHistoryEntry: (
    backendId: string,
    sessionId: string,
    source: LlmSessionSource,
    directoryPath: string,
    sourceRect?: PopupChatSourceRect
  ) => void;
  onMarkSessionRead: (backendId: string, sessionId: string, source: LlmSessionSource, directoryPath: string) => void;
  onMarkSessionUnread: (backendId: string, sessionId: string, source: LlmSessionSource, directoryPath: string) => void;
  onMarkDirectorySessionsRead: (directoryPath: string) => void;
};

function DrawerChevron({ expanded }: { expanded: boolean }) {
  const path = expanded ? "M4 6L8 10L12 6" : "M10 4L6 8L10 12";
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d={path} stroke="#475569" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function eventToPopupSourceRect(event: GestureResponderEvent): PopupChatSourceRect {
  const { pageX, pageY } = event.nativeEvent;
  return {
    x: Math.max(0, Number(pageX || 0) - 34),
    y: Math.max(0, Number(pageY || 0) - 24),
    width: 68,
    height: 48,
  };
}

function normalizeDrawerSearchText(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function drawerSearchIncludes(query: string, values: unknown[]): boolean {
  if (!query) return true;
  return values.some((value) => normalizeDrawerSearchText(value).includes(query));
}

export const AppDrawer = memo(function AppDrawer({
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
  onOpenSettings,
  onOpenCloudflareTunnelMonitor,
  onOpenSkiaBoard,
  onOpenDirectoryExplorer,
  onToggleDirectoryExpanded,
  onLoadMoreSessions,
  onLoadSessionChildren,
  onStartNewSessionInDirectory,
  onSelectSessionHistoryEntry,
  onMarkSessionRead,
  onMarkSessionUnread,
  onMarkDirectorySessionsRead,
}: AppDrawerProps) {
  const {
    addDirectory,
    removeDirectory,
    hasDirectory,
    addSession,
    removeSession,
    hasSession,
    loaded: skiaBoardLoaded,
  } = useSkiaBoard();
  const expandedSet = useMemo(() => new Set(expandedDirectoryIds), [expandedDirectoryIds]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [searchViewportBottom, setSearchViewportBottom] = useState<number | null>(null);
  const normalizedSearchQuery = normalizeDrawerSearchText(searchQuery);
  const [expandedSessionIds, setExpandedSessionIds] = useState<string[]>([]);
  const expandedSessionSet = useMemo(() => new Set(expandedSessionIds), [expandedSessionIds]);
  const [sessionContextMenuTarget, setSessionContextMenuTarget] = useState<{
    backendId: string;
    sessionId: string;
    source: LlmSessionSource;
    directoryPath: string;
  } | null>(null);
  const [directoryContextMenuTarget, setDirectoryContextMenuTarget] = useState<{
    directoryPath: string;
    directoryName: string;
  } | null>(null);
  const updateSearchViewportBottom = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setSearchViewportBottom(y + height);
  }, []);
  const formatThinkTag = (reasoningEffortRaw: unknown) => {
    const reasoningEffort = String(reasoningEffortRaw || "").trim().toLowerCase();
    if (!reasoningEffort) return "-";
    return reasoningEffort;
  };
  const parseSessionMarkerColor = (raw: unknown): DirectoryMarkerColor => {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "gray" || value === "red" || value === "yellow" || value === "green" || value === "black") return value;
    return "none";
  };
  const markerColorToDotHex = (color: DirectoryMarkerColor): string | null => {
    if (color === "gray") return "#94a3b8";
    if (color === "red") return "#ef4444";
    if (color === "yellow") return "#eab308";
    if (color === "green") return "#16a34a";
    if (color === "black") return "#111827";
    return null;
  };
  const toggleSessionChildren = useCallback((
    directoryId: string,
    directoryPath: string,
    sessionId: string,
    childState?: SessionChildTreeState
  ) => {
    const expanding = !expandedSessionSet.has(sessionId);
    setExpandedSessionIds((prev) => (
      prev.includes(sessionId)
        ? prev.filter((id) => id !== sessionId)
        : [...prev, sessionId]
    ));
    if (expanding && !childState?.loading) {
      onLoadSessionChildren(directoryId, directoryPath, sessionId);
    }
  }, [expandedSessionSet, onLoadSessionChildren]);
  const directoryViews = useMemo(() => registeredDirectories.flatMap((directory) => {
    const expanded = expandedSet.has(directory.id);
    const selectedDirectory = selectedDirectoryPath === directory.path;
    const sessionState = directorySessionsById[directory.id];
    const readProgress = directoryReadProgressByPath[directory.path];
    const unreadCount = directoryUnreadCountByPath[directory.path] || 0;
    const directoryLabel = String(directory.displayName || "").trim() || directory.path;
    const sessionEntries = sessionState?.entries || [];
    const baseVisibleSessionEntries = expanded
      ? sessionEntries
      : sessionEntries.filter((session) => isLlmSessionUnread(session));
    const directoryMatches = drawerSearchIncludes(normalizedSearchQuery, [
      directoryLabel,
      directory.path,
    ]);
    if (!directoryMatches) return [];

    return [{
      directory,
      directoryLabel,
      expanded,
      selectedDirectory,
      showLoadMoreSessions: expanded,
      sessionState,
      readProgress,
      unreadCount,
      visibleSessionEntries: baseVisibleSessionEntries,
      shouldShowSessionBlock: (
        expanded ||
        baseVisibleSessionEntries.length > 0
      ),
    }];
  }), [
    directorySessionsById,
    directoryReadProgressByPath,
    directoryUnreadCountByPath,
    expandedSet,
    normalizedSearchQuery,
    registeredDirectories,
    selectedDirectoryPath,
  ]);

  const renderSessionEntry = (
    directory: RegisteredDirectoryEntry,
    sessionState: DirectorySessionTreeState | undefined,
    session: LlmSessionHistoryEntry,
    depth: number
  ): ReactNode => {
    const selected = highlightedSessionId === session.sessionId;
    const titleOverride = String(sessionTitleOverridesById[session.sessionId] || "").trim();
    const sessionPrimaryTitle = formatLlmSessionDisplayTitle(
      titleOverride ||
      String(session.agentDisplayName || "").trim() ||
      String(session.firstUserMessage || "").trim() ||
      "（ユーザーメッセージなし）"
    );
    const sessionMarkerColor = parseSessionMarkerColor(sessionMarkerColorsById[session.sessionId]);
    const sessionMarkerColorHex = markerColorToDotHex(sessionMarkerColor);
    const restoringThisSession = (
      llmSessionRestoreLoading &&
      llmSessionRestoreTargetId === session.sessionId
    );
    const contextUsedPctText = session.contextUsedPct !== null ? `${session.contextUsedPct}%` : "-";
    const modelTag = formatModelRefForDisplay(session.modelRef);
    const thinkTag = formatThinkTag(session.reasoningEffort);
    const hasUnread = isLlmSessionUnread(session);
    const childState = sessionState?.childrenByParentId?.[session.sessionId];
    const childrenExpanded = expandedSessionSet.has(session.sessionId);
    return (
      <View
        key={`${directory.id}-${session.sessionId}`}
        style={[styles.appDrawerSessionTreeNode, depth > 0 && { marginLeft: Math.min(52, depth * 14) }]}
      >
        <TouchableOpacity
          style={[
            styles.appDrawerSessionItem,
            selected && styles.appDrawerSessionItemSelected,
            llmSessionRestoreLoading && styles.buttonDisabled,
          ]}
          disabled={llmSessionRestoreLoading}
          onPress={(event) => (
            onSelectSessionHistoryEntry(
              session.backendId,
              session.sessionId,
              session.source,
              session.directory || directory.path,
              eventToPopupSourceRect(event)
            )
          )}
          onLongPress={() => {
            setDirectoryContextMenuTarget(null);
            setSessionContextMenuTarget({
              backendId: session.backendId,
              sessionId: session.sessionId,
              source: session.source,
              directoryPath: session.directory || directory.path,
            });
          }}
        >
          <View style={styles.appDrawerSessionPrimaryRow}>
            <TouchableOpacity
              style={styles.appDrawerSessionChildToggle}
              disabled={llmSessionRestoreLoading}
              onPress={(event) => {
                event.stopPropagation?.();
                toggleSessionChildren(directory.id, directory.path, session.sessionId, childState);
              }}
              accessibilityRole="button"
              accessibilityLabel={childrenExpanded ? "サブエージェントを閉じる" : "サブエージェントを開く"}
            >
              {childState?.loading ? <ActivityIndicator size="small" color="#64748b" /> : (
                <DrawerChevron expanded={childrenExpanded} />
              )}
            </TouchableOpacity>
            {sessionMarkerColorHex ? (
              <View
                style={[
                  styles.appDrawerSessionMarkerDot,
                  { backgroundColor: sessionMarkerColorHex },
                ]}
              />
            ) : null}
            <Text
              style={[
                styles.appDrawerSessionPrimary,
                selected && styles.appDrawerSessionPrimarySelected,
              ]}
              numberOfLines={1}
            >
              {sessionPrimaryTitle}
            </Text>
            {restoringThisSession ? <ActivityIndicator size="small" color="#0f766e" /> : null}
            <Text style={styles.appDrawerSessionContextPct}>{contextUsedPctText}</Text>
          </View>
          {hasUnread ? <View style={styles.appDrawerSessionUnreadDot} /> : null}
          <Text style={styles.appDrawerSessionMetaText}>
            {`${formatSessionUpdatedAt(session.updatedAt)} [${session.source.toUpperCase()}] model:${modelTag} think:${thinkTag}`}
          </Text>
        </TouchableOpacity>
        {childrenExpanded ? (
          <View style={styles.appDrawerSessionChildrenBlock}>
            {childState?.error ? <Text style={styles.errorText}>{childState.error}</Text> : null}
            {childState?.loaded && !childState.error && childState.entries.length <= 0 ? (
              <Text style={styles.hint}>サブエージェントはありません。</Text>
            ) : null}
            {(childState?.entries || []).map((child) => renderSessionEntry(directory, sessionState, child, depth + 1))}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.appDrawerRoot}>
      <AppDrawerSearch
        directoryQuery={searchQuery}
        onChangeDirectoryQuery={setSearchQuery}
        active={searchActive}
        onActiveChange={setSearchActive}
        directoryMatchCount={directoryViews.length}
        registeredDirectories={registeredDirectories}
        viewportBottom={searchViewportBottom}
        onSelectChatResult={(result, event) => onSelectSessionHistoryEntry(
          result.sessionRef.backendId,
          result.sessionRef.nativeSessionId,
          "all",
          result.canonicalCwd,
          eventToPopupSourceRect(event)
        )}
      />
      <ScrollView
        style={styles.appDrawerScroll}
        contentContainerStyle={styles.appDrawerContent}
        keyboardShouldPersistTaps="handled"
        onLayout={updateSearchViewportBottom}
        testID="app-drawer-scroll"
        onTouchStart={() => {
          if (searchActive) {
            setSearchActive(false);
            Keyboard.dismiss();
          }
        }}
      >
        <Text style={styles.appDrawerTitle}>メニュー</Text>
        <TouchableOpacity style={styles.menuNavButton} onPress={onOpenSettings}>
          <Text style={styles.menuNavTitle}>設定</Text>
          <Text style={styles.menuNavValue}>接続・モデル・音声を設定</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuNavButton} onPress={onOpenCloudflareTunnelMonitor}>
          <Text style={styles.menuNavTitle}>Cloudflare Tunnel</Text>
          <Text style={styles.menuNavValue}>Tunnel接続ログを開く</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuNavButton} onPress={onOpenSkiaBoard}>
          <Text style={styles.menuNavTitle}>Board</Text>
          <Text style={styles.menuNavValue}>ボードを開く</Text>
        </TouchableOpacity>

        <View style={styles.appDrawerSection}>
          <View style={styles.appDrawerSectionHeader}>
            <Text style={styles.appDrawerSectionTitle}>Directories</Text>
            <TouchableOpacity style={styles.appDrawerAddButton} onPress={onOpenDirectoryExplorer}>
              <Text style={styles.appDrawerAddButtonText}>+ 追加</Text>
            </TouchableOpacity>
          </View>
          {directorySessionSync.phase === "loading" || directorySessionSync.phase === "refreshing" ? (
            <View
              style={styles.appDrawerSessionSync}
              accessibilityRole="progressbar"
              accessibilityLabel="登録ディレクトリのセッション同期"
              accessibilityValue={{
                min: 0,
                max: directorySessionSync.totalCount,
                now: directorySessionSync.completedCount,
                text: `${directorySessionSync.completedCount}/${directorySessionSync.totalCount}`,
              }}
            >
              <View style={styles.appDrawerSessionSyncTrack}>
                <View
                  style={[
                    styles.appDrawerSessionSyncFill,
                    { width: `${Math.round(directorySessionSync.progress * 100)}%` },
                  ]}
                />
              </View>
              <Text style={styles.appDrawerSessionSyncText}>
                {`${directorySessionSync.phase === "loading" ? "セッション同期中" : "セッション更新中"} ${directorySessionSync.completedCount}/${directorySessionSync.totalCount}`}
              </Text>
            </View>
          ) : directorySessionSync.phase === "partial_error" || directorySessionSync.phase === "error" ? (
            <Text
              style={[
                styles.appDrawerSessionSyncError,
                directorySessionSync.phase === "error" && styles.appDrawerSessionSyncFatalError,
              ]}
              accessibilityRole="alert"
            >
              {directorySessionSync.phase === "error"
                ? `セッション同期失敗 ${directorySessionSync.failedCount}/${directorySessionSync.totalCount}`
                : `一部更新失敗 ${directorySessionSync.failedCount}/${directorySessionSync.totalCount}`}
            </Text>
          ) : null}
          {registeredDirectories.length <= 0 ? (
            <Text style={styles.hint}>登録ディレクトリはありません。追加ボタンから登録してください。</Text>
          ) : directoryViews.length <= 0 ? (
            <Text style={styles.hint}>一致するディレクトリはありません。</Text>
          ) : (
            directoryViews.map(({
              directory,
              directoryLabel,
              expanded,
              selectedDirectory,
              showLoadMoreSessions,
              sessionState,
              readProgress,
              unreadCount,
              visibleSessionEntries,
              shouldShowSessionBlock,
            }) => {
              return (
                <View
                  key={directory.id}
                  style={[styles.appDrawerDirectoryItem, selectedDirectory && styles.appDrawerDirectoryItemSelected]}
                >
                  <View style={styles.appDrawerDirectoryHeader}>
                    <TouchableOpacity
                      style={styles.appDrawerDirectorySelectButton}
                      onPress={() => onStartNewSessionInDirectory(directory.path)}
                      onLongPress={() => {
                        setSessionContextMenuTarget(null);
                        setDirectoryContextMenuTarget({
                          directoryPath: directory.path,
                          directoryName: directoryLabel,
                        });
                      }}
                    >
                      <Text
                        style={[styles.appDrawerDirectoryName, selectedDirectory && styles.appDrawerDirectoryNameSelected]}
                        numberOfLines={1}
                      >
                        {directoryLabel}
                      </Text>
                      <Text
                        style={[styles.appDrawerDirectoryPath, selectedDirectory && styles.appDrawerDirectoryPathSelected]}
                        numberOfLines={1}
                      >
                        {directory.path}
                      </Text>
                    </TouchableOpacity>
                    {unreadCount > 0 ? (
                      <View
                        style={styles.appDrawerUnreadCountBadge}
                        accessibilityLabel={`${directoryLabel}の未読 ${unreadCount}件`}
                      >
                        <Text style={styles.appDrawerUnreadCountText}>{unreadCount}</Text>
                      </View>
                    ) : null}
                    <TouchableOpacity
                      style={styles.appDrawerExpandButton}
                      onPress={() => onToggleDirectoryExpanded(directory.id, directory.path)}
                    >
                      <DrawerChevron expanded={expanded} />
                    </TouchableOpacity>
                  </View>
                  {readProgress ? (
                    <View style={styles.appDrawerDirectoryReadProgress}>
                      <View style={styles.appDrawerDirectoryReadProgressTrack}>
                        <View
                          style={[
                            styles.appDrawerDirectoryReadProgressFill,
                            {
                              width: `${
                                readProgress.total > 0
                                  ? Math.round((readProgress.completed / readProgress.total) * 100)
                                  : 0
                              }%`,
                            },
                          ]}
                        />
                      </View>
                      <Text style={styles.appDrawerDirectoryReadProgressText}>
                        {readProgress.total > 0
                          ? `既読にしています ${readProgress.completed}/${readProgress.total}`
                          : "未読を確認しています…"}
                      </Text>
                    </View>
                  ) : null}
                  {shouldShowSessionBlock ? (
                    <View style={styles.appDrawerSessionBlock}>
                      {sessionState?.error ? <Text style={styles.errorText}>{sessionState.error}</Text> : null}
                      {!sessionState?.loading && !sessionState?.error && visibleSessionEntries.length <= 0 ? (
                        <Text style={styles.hint}>履歴はありません。</Text>
                      ) : null}
                      {visibleSessionEntries.map((session) => renderSessionEntry(directory, sessionState, session, 0))}
                      {showLoadMoreSessions && sessionState?.hasMore ? (
                        <TouchableOpacity
                          style={[
                            styles.appDrawerSessionLoadMoreButton,
                            (sessionState.loading || sessionState.refreshing || sessionState.loadingMore || llmSessionRestoreLoading) && styles.buttonDisabled,
                          ]}
                          disabled={sessionState.loading || sessionState.refreshing || sessionState.loadingMore || llmSessionRestoreLoading}
                          onPress={() => onLoadMoreSessions(directory.id, directory.path)}
                        >
                          {sessionState.loadingMore ? <ActivityIndicator size="small" color="#1e40af" /> : null}
                          <Text style={styles.appDrawerSessionLoadMoreButtonText}>もっと読み込む</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </View>
        <AppModal
          visible={directoryContextMenuTarget !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setDirectoryContextMenuTarget(null)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setDirectoryContextMenuTarget(null)}>
            <Pressable style={styles.modalCard} onPress={() => {}}>
              <TouchableOpacity
                style={styles.modalOption}
                onPress={() => {
                  if (directoryContextMenuTarget) {
                    onMarkDirectorySessionsRead(directoryContextMenuTarget.directoryPath);
                  }
                  setDirectoryContextMenuTarget(null);
                }}
              >
                <Text style={styles.modalOptionText}>このディレクトリの未読をすべて既読にする</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="app-drawer-skia-board-directory-action"
                style={[styles.modalOption, !skiaBoardLoaded && styles.buttonDisabled]}
                disabled={!skiaBoardLoaded}
                onPress={() => {
                  if (directoryContextMenuTarget) {
                    const { directoryPath, directoryName } = directoryContextMenuTarget;
                    if (hasDirectory(directoryPath)) {
                      removeDirectory(directoryPath);
                    } else {
                      addDirectory({ directory: directoryPath, name: directoryName });
                    }
                  }
                  setDirectoryContextMenuTarget(null);
                }}
              >
                <Text style={styles.modalOptionText}>
                  {directoryContextMenuTarget && hasDirectory(directoryContextMenuTarget.directoryPath)
                    ? "Skiaボードから除外"
                    : "Skiaボードへ追加"}
                </Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </AppModal>
        <AppModal
          visible={sessionContextMenuTarget !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setSessionContextMenuTarget(null)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setSessionContextMenuTarget(null)}>
            <Pressable style={styles.modalCard} onPress={() => {}}>
              <TouchableOpacity
                style={styles.modalOption}
                onPress={() => {
                  if (sessionContextMenuTarget) {
                    onMarkSessionRead(
                      sessionContextMenuTarget.backendId,
                      sessionContextMenuTarget.sessionId,
                      sessionContextMenuTarget.source,
                      sessionContextMenuTarget.directoryPath
                    );
                  }
                  setSessionContextMenuTarget(null);
                }}
              >
                <Text style={styles.modalOptionText}>既読にする</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalOption}
                onPress={() => {
                  if (sessionContextMenuTarget) {
                    onMarkSessionUnread(
                      sessionContextMenuTarget.backendId,
                      sessionContextMenuTarget.sessionId,
                      sessionContextMenuTarget.source,
                      sessionContextMenuTarget.directoryPath
                    );
                  }
                  setSessionContextMenuTarget(null);
                }}
              >
                <Text style={styles.modalOptionText}>未読にする</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="app-drawer-skia-board-session-action"
                style={[styles.modalOption, !skiaBoardLoaded && styles.buttonDisabled]}
                disabled={!skiaBoardLoaded}
                onPress={() => {
                  if (sessionContextMenuTarget) {
                    const sessionId = sessionContextMenuTarget.sessionId;
                    if (hasSession(sessionId)) {
                      removeSession(sessionId);
                    } else {
                      addSession(sessionId);
                    }
                  }
                  setSessionContextMenuTarget(null);
                }}
              >
                <Text style={styles.modalOptionText}>
                  {sessionContextMenuTarget && hasSession(sessionContextMenuTarget.sessionId)
                    ? "Skiaボードから除外"
                    : "Skiaボードへ追加"}
                </Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </AppModal>
      </ScrollView>
      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID={APP_DRAWER_SEARCH_INPUT_ACCESSORY_ID} backgroundColor="#f8fafc">
          <View style={styles.appDrawerKeyboardAccessory}>
            <TouchableOpacity
              style={styles.appDrawerKeyboardDismissButton}
              onPress={() => {
                setSearchActive(false);
                Keyboard.dismiss();
              }}
              accessibilityRole="button"
              accessibilityLabel="キーボードを閉じる"
            >
              <Text style={styles.appDrawerKeyboardDismissButtonText}>閉じる</Text>
            </TouchableOpacity>
          </View>
        </InputAccessoryView>
      ) : null}
    </SafeAreaView>
  );
});
