import { useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { LlmSessionHistoryEntry, LlmSessionSource } from "../hooks/useLlmSessionExplorer";
import type { DirectorySessionTreeState, RegisteredDirectoryEntry } from "./AppDrawer";
import { styles } from "../styles";
import { getCachedDirectorySessions } from "../utils/sessionHistoryContext";

type ChatSessionSubagentListProps = {
  selectedSessionId: string;
  selectedDirectoryPath: string;
  registeredDirectories: RegisteredDirectoryEntry[];
  directorySessionsById: Record<string, DirectorySessionTreeState>;
  sessionTitleOverridesById: Record<string, string>;
  formatSessionUpdatedAt: (updatedAt: string) => string;
  loadSessionChildren: (sessionId: string, directory: string) => Promise<void>;
  openSessionHistoryEntry: (params: {
    sessionId: string;
    source: LlmSessionSource;
    directory: string;
  }) => void;
  onCloseMenu: () => void;
};

function sessionTitle(
  session: LlmSessionHistoryEntry,
  sessionTitleOverridesById: Record<string, string>
) {
  return (
    String(sessionTitleOverridesById[session.sessionId] || "").trim() ||
    String(session.agentDisplayName || "").trim() ||
    String(session.firstUserMessage || "").trim() ||
    "（ユーザーメッセージなし）"
  );
}

export function ChatSessionSubagentList({
  selectedSessionId,
  selectedDirectoryPath,
  registeredDirectories,
  directorySessionsById,
  sessionTitleOverridesById,
  formatSessionUpdatedAt,
  loadSessionChildren,
  openSessionHistoryEntry,
  onCloseMenu,
}: ChatSessionSubagentListProps) {
  const sessionContext = useMemo(() => {
    const directoryPath = String(selectedDirectoryPath || "").trim();
    const sessionId = String(selectedSessionId || "").trim();
    if (!directoryPath || !sessionId) return null;
    const directory = registeredDirectories.find((item) => {
      const directoryState = directorySessionsById[item.id];
      return getCachedDirectorySessions(directoryState).some((session) => session.sessionId === sessionId);
    });
    const directoryState = directory ? directorySessionsById[directory.id] : undefined;
    if (!directoryState) return null;
    const cachedSessions = getCachedDirectorySessions(directoryState);
    const selectedSession = cachedSessions.find((session) => session.sessionId === sessionId);
    const parentSessionId = String(selectedSession?.parentSessionId || "").trim();
    return {
      childState: directoryState.childrenByParentId?.[sessionId] || null,
      parentSession: parentSessionId
        ? cachedSessions.find((session) => session.sessionId === parentSessionId) || null
        : null,
    };
  }, [
    directorySessionsById,
    registeredDirectories,
    selectedDirectoryPath,
    selectedSessionId,
  ]);
  const childState = sessionContext?.childState || null;
  const parentSession = sessionContext?.parentSession || null;

  useEffect(() => {
    if (!selectedSessionId || !selectedDirectoryPath) return;
    if (childState?.loaded || childState?.loading) return;
    void loadSessionChildren(selectedSessionId, selectedDirectoryPath);
  }, [
    childState?.loaded,
    childState?.loading,
    loadSessionChildren,
    selectedDirectoryPath,
    selectedSessionId,
  ]);

  const children = childState?.entries || [];

  return (
    <View style={styles.chatDirectorySubagentSection}>
      {parentSession ? (
        <>
          <Text style={styles.chatDirectorySubagentSectionTitle}>Parent agent</Text>
          <TouchableOpacity
            style={styles.chatDirectorySubagentOption}
            onPress={() => {
              onCloseMenu();
              openSessionHistoryEntry({
                sessionId: parentSession.sessionId,
                source: parentSession.source,
                directory: parentSession.directory || selectedDirectoryPath,
              });
            }}
          >
            <Text style={styles.chatDirectorySubagentOptionText} numberOfLines={1}>
              {sessionTitle(parentSession, sessionTitleOverridesById)}
            </Text>
            <Text style={styles.chatDirectorySubagentMetaText}>
              {`${formatSessionUpdatedAt(parentSession.updatedAt)} [${parentSession.source.toUpperCase()}]`}
            </Text>
          </TouchableOpacity>
        </>
      ) : null}
      <Text style={styles.chatDirectorySubagentSectionTitle}>Subagents</Text>
      {childState?.loading ? (
        <View style={styles.chatDirectorySubagentStatusRow}>
          <ActivityIndicator size="small" color="#0f766e" />
          <Text style={styles.chatDirectorySubagentMetaText}>取得中</Text>
        </View>
      ) : childState?.error ? (
        <TouchableOpacity onPress={() => void loadSessionChildren(selectedSessionId, selectedDirectoryPath)}>
          <Text style={styles.chatDirectorySubagentErrorText}>{`${childState.error} 再取得`}</Text>
        </TouchableOpacity>
      ) : children.length <= 0 ? (
        <Text style={styles.chatDirectorySubagentMetaText}>直下のサブエージェントはありません。</Text>
      ) : children.map((session) => {
        return (
          <TouchableOpacity
            key={session.sessionId}
            style={styles.chatDirectorySubagentOption}
            onPress={() => {
              onCloseMenu();
              openSessionHistoryEntry({
                sessionId: session.sessionId,
                source: session.source,
                directory: session.directory || selectedDirectoryPath,
              });
            }}
          >
            <Text style={styles.chatDirectorySubagentOptionText} numberOfLines={1}>
              {sessionTitle(session, sessionTitleOverridesById)}
            </Text>
            <Text style={styles.chatDirectorySubagentMetaText}>
              {`${formatSessionUpdatedAt(session.updatedAt)} [${session.source.toUpperCase()}]`}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
