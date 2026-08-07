import { useEffect, useMemo, useRef, useState } from "react";
import { useConversation } from "../contexts/ConversationContext";
import type { DirectoryMarkerColor } from "../types/directorySessions";
import { collectRegisteredDirectorySessions } from "../utils/registeredDirectorySessions";
import {
  buildPanelHydrationRequestMark,
  decidePanelHydration,
  type PanelHydrationRequestMark,
} from "../utils/panelAssignmentHydration";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import type { LlmSessionSource } from "./useLlmSessionExplorer";

const SKIA_MINI_CHAT_PANEL_IDS = Array.from(
  { length: 6 },
  (_, index) => `skia_mini_preview_${index + 1}`
);

export type SkiaMiniChatSession = {
  panelId: string;
  sessionId: string;
  directory: string;
  source: LlmSessionSource;
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
    directorySessionSync,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    ensureRegisteredDirectorySessions,
  } = useConversation();
  const { getSnapshot } = usePanelRuntimeStore();
  const { clearPanelSnapshot, hydratePanelFromSessionHistory } = usePanelRuntimeController();
  const clearPanelSnapshotRef = useRef(clearPanelSnapshot);
  const hydratePanelFromSessionHistoryRef = useRef(hydratePanelFromSessionHistory);
  const getSnapshotRef = useRef(getSnapshot);
  // 同一マウント内で発行済みのhydrate要求(進行中含む)のパネル別記録。
  const lastRequestedHydrationByPanelRef = useRef<Record<string, PanelHydrationRequestMark>>({});
  const hydrationGenerationRef = useRef(0);
  const [hydratingPanelCount, setHydratingPanelCount] = useState(0);
  const [panelHydrationErrorCount, setPanelHydrationErrorCount] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    clearPanelSnapshotRef.current = clearPanelSnapshot;
    hydratePanelFromSessionHistoryRef.current = hydratePanelFromSessionHistory;
    getSnapshotRef.current = getSnapshot;
  }, [clearPanelSnapshot, getSnapshot, hydratePanelFromSessionHistory]);

  useEffect(() => {
    void ensureRegisteredDirectorySessions("screen_mount");
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      hydrationGenerationRef.current += 1;
      clearInterval(timer);
      // previewパネルの全クリアは廃止(再入場時の全量再取得の原因)。
      // snapshotは共有ストアに保持し、再入場時はdecidePanelHydrationの
      // 条件付き再検証で変化したパネルだけ再取得する。
    };
  }, [ensureRegisteredDirectorySessions]);

  const sessionCandidates = useMemo(() => (
    collectRegisteredDirectorySessions(registeredDirectories, directorySessionsById)
      .slice(0, 6)
  ), [
    directorySessionsById,
    registeredDirectories,
  ]);

  useEffect(() => {
    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    // 割当が外れたパネルだけsnapshotを破棄する(空パネルへの重複クリアも避ける)。
    const clearUnassignedPanelSnapshot = (panelId: string) => {
      delete lastRequestedHydrationByPanelRef.current[panelId];
      if (!String(getSnapshotRef.current(panelId).selectedSessionId || "").trim()) return;
      clearPanelSnapshotRef.current(panelId);
    };
    if (sessionCandidates.length <= 0) {
      setHydratingPanelCount(0);
      setPanelHydrationErrorCount(0);
      SKIA_MINI_CHAT_PANEL_IDS.forEach(clearUnassignedPanelSnapshot);
      return;
    }
    SKIA_MINI_CHAT_PANEL_IDS.slice(sessionCandidates.length).forEach(clearUnassignedPanelSnapshot);
    // パネル単位で「割当変化 or updatedAt前進」だけをhydrate対象にする。
    // ライブ応答中や鮮度十分なsnapshotを持つパネルは再取得しない。
    const hydrateTargets = sessionCandidates
      .map((session, index) => ({ session, panelId: SKIA_MINI_CHAT_PANEL_IDS[index] }))
      .filter(({ session, panelId }) => decidePanelHydration({
        panelId,
        candidate: session,
        lastRequested: lastRequestedHydrationByPanelRef.current[panelId] || null,
        snapshot: getSnapshotRef.current(panelId),
      }).action === "hydrate");
    if (hydrateTargets.length <= 0) {
      setHydratingPanelCount(0);
      return;
    }
    setHydratingPanelCount(hydrateTargets.length);
    setPanelHydrationErrorCount(0);
    void Promise.all(hydrateTargets.map(async ({ session, panelId }) => {
      // 発行記録は失敗時も残し、同じupdatedAtのままでのホットリトライを防ぐ。
      lastRequestedHydrationByPanelRef.current[panelId] =
        buildPanelHydrationRequestMark(panelId, session);
      try {
        const result = await hydratePanelFromSessionHistoryRef.current({
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
        });
        if (hydrationGenerationRef.current !== generation) return;
        if (result === "failed") {
          clearPanelSnapshotRef.current(panelId);
          setPanelHydrationErrorCount((count) => count + 1);
        }
      } catch {
        if (hydrationGenerationRef.current !== generation) return;
        clearPanelSnapshotRef.current(panelId);
        setPanelHydrationErrorCount((count) => count + 1);
      } finally {
        if (hydrationGenerationRef.current === generation) {
          setHydratingPanelCount((count) => Math.max(0, count - 1));
        }
      }
    })).then(() => {
      if (hydrationGenerationRef.current !== generation) return;
      setHydratingPanelCount(0);
    });
  }, [sessionCandidates, sessionTitleOverridesById]);

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
        directory: session.directory,
        source: session.source,
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

  return {
    directorySync: directorySessionSync,
    hydratingPanelCount,
    panelHydrationErrorCount,
    sessions,
  };
}
