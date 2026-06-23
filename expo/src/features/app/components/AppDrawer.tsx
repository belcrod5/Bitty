import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  InputAccessoryView,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import type { LlmSessionHistoryEntry, LlmSessionSource } from "../hooks/useLlmSessionExplorer";
import type { PopupChatSourceRect } from "./popupChatTypes";
import { styles } from "../styles";
import { isLlmSessionUnread } from "../utils/llmSession";
import { formatModelRefForDisplay } from "../utils/settingsParsers";

export type RegisteredDirectoryEntry = {
  id: string;
  path: string;
  displayName: string;
  markerColor: DirectoryMarkerColor;
};

export type DirectoryMarkerColor = "none" | "gray" | "red" | "yellow" | "green" | "black";

export type SessionChildTreeState = {
  loading: boolean;
  loaded: boolean;
  error: string;
  entries: LlmSessionHistoryEntry[];
};

export type DirectorySessionTreeState = {
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  fetchedAtMs: number;
  error: string;
  latestSessionId: string;
  nextCursor: string;
  hasMore: boolean;
  entries: LlmSessionHistoryEntry[];
  childrenByParentId: Record<string, SessionChildTreeState>;
};

export type AppDrawerProps = {
  selectedDirectoryPath: string;
  selectedLlmSessionId: string;
  registeredDirectories: RegisteredDirectoryEntry[];
  expandedDirectoryIds: string[];
  directorySessionsById: Record<string, DirectorySessionTreeState>;
  sessionTitleOverridesById: Record<string, string>;
  sessionMarkerColorsById: Record<string, DirectoryMarkerColor>;
  llmSessionRestoreLoading: boolean;
  llmSessionRestoreTargetId: string;
  formatSessionUpdatedAt: (updatedAt: string) => string;
  onOpenDebug: () => void;
  onOpenMiniBoard: () => void;
  onOpenDirectoryExplorer: () => void;
  onToggleDirectoryExpanded: (directoryId: string, directoryPath: string) => void;
  onLoadMoreSessions: (directoryId: string, directoryPath: string) => void;
  onLoadSessionChildren: (directoryId: string, directoryPath: string, parentSessionId: string) => void;
  onStartNewSessionInDirectory: (directoryPath: string) => void;
  onSelectSessionHistoryEntry: (
    sessionId: string,
    source: LlmSessionSource,
    directoryPath: string,
    sourceRect?: PopupChatSourceRect
  ) => void;
  onMarkSessionRead: (sessionId: string, source: LlmSessionSource, directoryPath: string) => void;
  onMarkSessionUnread: (sessionId: string, source: LlmSessionSource, directoryPath: string) => void;
  onMarkDirectorySessionsRead: (directoryPath: string) => void;
};

const APP_DRAWER_SEARCH_INPUT_ACCESSORY_ID = "appDrawerSearchKeyboardAccessory";

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

export function AppDrawer({
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
  onOpenDebug,
  onOpenMiniBoard,
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
  const expandedSet = useMemo(() => new Set(expandedDirectoryIds), [expandedDirectoryIds]);
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedSearchQuery = normalizeDrawerSearchText(searchQuery);
  const [expandedSessionIds, setExpandedSessionIds] = useState<string[]>([]);
  const expandedSessionSet = useMemo(() => new Set(expandedSessionIds), [expandedSessionIds]);
  const [sessionContextMenuTarget, setSessionContextMenuTarget] = useState<{
    sessionId: string;
    source: LlmSessionSource;
    directoryPath: string;
  } | null>(null);
  const [directoryContextMenuTarget, setDirectoryContextMenuTarget] = useState<{
    directoryPath: string;
  } | null>(null);
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
    const directoryLabel = String(directory.displayName || "").trim() || directory.path;
    const sessionEntries = sessionState?.entries || [];
    const baseVisibleSessionEntries = expanded
      ? sessionEntries
      : sessionEntries.filter((session) => isLlmSessionUnread(session));
    const directoryMatches = drawerSearchIncludes(normalizedSearchQuery, [
      directoryLabel,
      directory.path,
    ]);
    const matchingSessionEntries = !normalizedSearchQuery
      ? baseVisibleSessionEntries
      : sessionEntries.filter((session) => {
        const titleOverride = String(sessionTitleOverridesById[session.sessionId] || "").trim();
        return drawerSearchIncludes(normalizedSearchQuery, [
          titleOverride,
          session.firstUserMessage,
          session.sessionId,
          session.source,
          session.modelRef,
          session.reasoningEffort,
        ]);
      });
    const visibleSessionEntries = directoryMatches && normalizedSearchQuery
      ? sessionEntries
      : matchingSessionEntries;

    if (normalizedSearchQuery && !directoryMatches && matchingSessionEntries.length <= 0) return [];

    return [{
      directory,
      directoryLabel,
      expanded,
      selectedDirectory,
      showLoadMoreSessions: expanded || (!!normalizedSearchQuery && directoryMatches),
      sessionState,
      visibleSessionEntries,
      shouldShowSessionBlock: (
        expanded ||
        visibleSessionEntries.length > 0 ||
        !!normalizedSearchQuery
      ),
    }];
  }), [
    directorySessionsById,
    expandedSet,
    normalizedSearchQuery,
    registeredDirectories,
    selectedDirectoryPath,
    sessionTitleOverridesById,
  ]);

  const renderSessionEntry = (
    directory: RegisteredDirectoryEntry,
    sessionState: DirectorySessionTreeState | undefined,
    session: LlmSessionHistoryEntry,
    depth: number
  ): ReactNode => {
    const selected = selectedLlmSessionId === session.sessionId;
    const titleOverride = String(sessionTitleOverridesById[session.sessionId] || "").trim();
    const sessionPrimaryTitle = (
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
              session.sessionId,
              session.source,
              session.directory || directory.path,
              eventToPopupSourceRect(event)
            )
          )}
          onLongPress={() => {
            setDirectoryContextMenuTarget(null);
            setSessionContextMenuTarget({
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
      <ScrollView
        style={styles.appDrawerScroll}
        contentContainerStyle={styles.appDrawerContent}
        keyboardShouldPersistTaps="handled"
        stickyHeaderIndices={[0]}
      >
        <View style={styles.appDrawerSearchSticky}>
          <View style={styles.appDrawerSearchBox}>
            <TextInput
              style={styles.appDrawerSearchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="ディレクトリ・履歴を検索"
              placeholderTextColor="#94a3b8"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="never"
              inputAccessoryViewID={Platform.OS === "ios" ? APP_DRAWER_SEARCH_INPUT_ACCESSORY_ID : undefined}
              onSubmitEditing={Keyboard.dismiss}
              returnKeyType="search"
              submitBehavior="blurAndSubmit"
            />
            {searchQuery ? (
              <TouchableOpacity
                style={styles.appDrawerSearchClearButton}
                onPress={() => setSearchQuery("")}
                accessibilityRole="button"
                accessibilityLabel="検索をクリア"
              >
                <Text style={styles.appDrawerSearchClearButtonText}>×</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
        <Text style={styles.appDrawerTitle}>メニュー</Text>
        <TouchableOpacity style={styles.menuNavButton} onPress={onOpenDebug}>
          <Text style={styles.menuNavTitle}>Current Settings</Text>
          <Text style={styles.menuNavValue}>Debug設定画面を開く</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuNavButton} onPress={onOpenMiniBoard}>
          <Text style={styles.menuNavTitle}>Mini Board</Text>
          <Text style={styles.menuNavValue}>ミニボードを開く</Text>
        </TouchableOpacity>

        <View style={styles.appDrawerSection}>
          <View style={styles.appDrawerSectionHeader}>
            <Text style={styles.appDrawerSectionTitle}>Directories</Text>
            <TouchableOpacity style={styles.appDrawerAddButton} onPress={onOpenDirectoryExplorer}>
              <Text style={styles.appDrawerAddButtonText}>+ 追加</Text>
            </TouchableOpacity>
          </View>
          {registeredDirectories.length <= 0 ? (
            <Text style={styles.hint}>登録ディレクトリはありません。追加ボタンから登録してください。</Text>
          ) : directoryViews.length <= 0 ? (
            <Text style={styles.hint}>一致するディレクトリまたは履歴はありません。</Text>
          ) : (
            directoryViews.map(({
              directory,
              directoryLabel,
              expanded,
              selectedDirectory,
              showLoadMoreSessions,
              sessionState,
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
                    <View style={styles.appDrawerLoadingIndicatorWrap}>
                      {sessionState?.loading ? <ActivityIndicator size="small" color="#0f766e" /> : null}
                    </View>
                    <TouchableOpacity
                      style={styles.appDrawerExpandButton}
                      onPress={() => onToggleDirectoryExpanded(directory.id, directory.path)}
                    >
                      <DrawerChevron expanded={expanded} />
                    </TouchableOpacity>
                  </View>
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
                            (sessionState.loading || sessionState.loadingMore || llmSessionRestoreLoading) && styles.buttonDisabled,
                          ]}
                          disabled={sessionState.loading || sessionState.loadingMore || llmSessionRestoreLoading}
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
        <Modal
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
            </Pressable>
          </Pressable>
        </Modal>
        <Modal
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
            </Pressable>
          </Pressable>
        </Modal>
      </ScrollView>
      {Platform.OS === "ios" ? (
        <InputAccessoryView nativeID={APP_DRAWER_SEARCH_INPUT_ACCESSORY_ID} backgroundColor="#f8fafc">
          <View style={styles.appDrawerKeyboardAccessory}>
            <TouchableOpacity
              style={styles.appDrawerKeyboardDismissButton}
              onPress={Keyboard.dismiss}
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
}
