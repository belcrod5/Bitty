import { useEffect, useMemo, useRef, useState } from "react";
import { useConversation } from "../contexts/ConversationContext";
import type { DirectoryMarkerColor } from "../components/AppDrawer";
import { collectRegisteredDirectorySessions } from "../utils/registeredDirectorySessions";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";

const SKIA_MINI_CHAT_PANEL_IDS = Array.from(
  { length: 6 },
  (_, index) => `skia_mini_preview_${index + 1}`
);

export type SkiaMiniChatSession = {
  panelId: string;
  sessionId: string;
  title: string;
  directoryName: string;
  lastMessageContent: string;
  updatedAtLabel: string;
  markerColor: DirectoryMarkerColor;
};

export function formatSkiaMiniChatUpdatedAt(raw: unknown, nowMs = Date.now()) {
  const updatedAtMs = new Date(String(raw || "")).getTime();
  if (!Number.isFinite(updatedAtMs)) return "-";
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}秒前`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}分前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}時間前`;
  return `${Math.floor(elapsedHours / 24)}日前`;
}

export function useSkiaMiniChatSessions() {
  const {
    registeredDirectories,
    directorySessionsById,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    refreshRegisteredDirectorySessions,
  } = useConversation();
  const { getSnapshot } = usePanelRuntimeStore();
  const { clearPanelSnapshot, hydratePanelFromSessionHistory } = usePanelRuntimeController();
  const refreshRegisteredDirectorySessionsRef = useRef(refreshRegisteredDirectorySessions);
  const clearPanelSnapshotRef = useRef(clearPanelSnapshot);
  const hydratePanelFromSessionHistoryRef = useRef(hydratePanelFromSessionHistory);
  const hydratedSignatureRef = useRef("");
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    refreshRegisteredDirectorySessionsRef.current = refreshRegisteredDirectorySessions;
    clearPanelSnapshotRef.current = clearPanelSnapshot;
    hydratePanelFromSessionHistoryRef.current = hydratePanelFromSessionHistory;
  }, [clearPanelSnapshot, hydratePanelFromSessionHistory, refreshRegisteredDirectorySessions]);

  useEffect(() => {
    void refreshRegisteredDirectorySessionsRef.current();
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      SKIA_MINI_CHAT_PANEL_IDS.forEach((panelId) => clearPanelSnapshotRef.current(panelId));
    };
  }, []);

  const sessionCandidates = useMemo(() => (
    collectRegisteredDirectorySessions(registeredDirectories, directorySessionsById)
      .slice(0, 6)
  ), [
    directorySessionsById,
    registeredDirectories,
  ]);

  const sessionSignature = sessionCandidates.map((session, index) => (
    `${SKIA_MINI_CHAT_PANEL_IDS[index]}:${session.sessionId}:${session.directory}:${session.updatedAt}`
  )).join("|");

  useEffect(() => {
    if (!sessionSignature) {
      hydratedSignatureRef.current = "";
      SKIA_MINI_CHAT_PANEL_IDS.forEach((panelId) => clearPanelSnapshotRef.current(panelId));
      return;
    }
    if (hydratedSignatureRef.current === sessionSignature) return;
    hydratedSignatureRef.current = sessionSignature;
    sessionCandidates.forEach((session, index) => {
      const panelId = SKIA_MINI_CHAT_PANEL_IDS[index];
      void hydratePanelFromSessionHistoryRef.current({
        panelId,
        sessionId: session.sessionId,
        directory: session.directory,
        source: session.source,
        directoryDisplayName: session.directoryDisplayName,
        title: sessionTitleOverridesById[session.sessionId] || session.firstUserMessage,
        updatedAt: session.updatedAt,
        modelRef: session.modelRef,
        reasoningEffort: session.reasoningEffort,
        contextUsedPct: session.contextUsedPct,
      }).catch(() => clearPanelSnapshotRef.current(panelId));
    });
  }, [sessionCandidates, sessionSignature, sessionTitleOverridesById]);

  const sessions = useMemo<SkiaMiniChatSession[]>(() => (
    sessionCandidates.map((session, index) => {
      const panelId = SKIA_MINI_CHAT_PANEL_IDS[index];
      const snapshot = getSnapshot(panelId);
      const messages = snapshot.selectedSessionId === session.sessionId
        ? snapshot.conversationMessages
        : [];
      const lastMessage = messages[messages.length - 1];
      return {
        panelId,
        sessionId: session.sessionId,
        title: String(
          sessionTitleOverridesById[session.sessionId]
          || session.agentDisplayName
          || session.firstUserMessage
          || session.sessionId
        ).trim(),
        directoryName: session.directoryDisplayName,
        lastMessageContent: snapshot.selectedSessionId === session.sessionId
          ? String(lastMessage?.content || "メッセージなし").replace(/\s+/g, " ").trim()
          : "",
        updatedAtLabel: formatSkiaMiniChatUpdatedAt(session.updatedAt, nowMs),
        markerColor: sessionMarkerColorsById[session.sessionId] || "none",
      };
    })
  ), [
    getSnapshot,
    nowMs,
    sessionCandidates,
    sessionMarkerColorsById,
    sessionTitleOverridesById,
  ]);

  const loading = registeredDirectories.some((directory) => {
    const state = directorySessionsById[directory.id];
    return !state || state.loading || state.loadingMore || !state.loaded;
  });

  return { loading, sessions };
}
