import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversation } from "../contexts/ConversationContext";
import type { DirectoryMarkerColor } from "../types/directorySessions";
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
    directorySessionSync,
    sessionTitleOverridesById,
    sessionMarkerColorsById,
    ensureRegisteredDirectorySessions,
  } = useConversation();
  const { getSnapshot } = usePanelRuntimeStore();
  const { clearPanelSnapshot, hydratePanelFromSessionHistory } = usePanelRuntimeController();
  const clearPanelSnapshotRef = useRef(clearPanelSnapshot);
  const hydratePanelFromSessionHistoryRef = useRef(hydratePanelFromSessionHistory);
  const hydratedSignatureRef = useRef("");
  const hydrationGenerationRef = useRef(0);
  const [hydratingPanelCount, setHydratingPanelCount] = useState(0);
  const [panelHydrationErrorCount, setPanelHydrationErrorCount] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    clearPanelSnapshotRef.current = clearPanelSnapshot;
    hydratePanelFromSessionHistoryRef.current = hydratePanelFromSessionHistory;
  }, [clearPanelSnapshot, hydratePanelFromSessionHistory]);

  useEffect(() => {
    void ensureRegisteredDirectorySessions("screen_mount");
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      hydrationGenerationRef.current += 1;
      clearInterval(timer);
      SKIA_MINI_CHAT_PANEL_IDS.forEach((panelId) => clearPanelSnapshotRef.current(panelId));
    };
  }, [ensureRegisteredDirectorySessions]);

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
    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    if (!sessionSignature) {
      hydratedSignatureRef.current = "";
      setHydratingPanelCount(0);
      setPanelHydrationErrorCount(0);
      SKIA_MINI_CHAT_PANEL_IDS.forEach((panelId) => clearPanelSnapshotRef.current(panelId));
      return;
    }
    if (hydratedSignatureRef.current === sessionSignature) return;
    setHydratingPanelCount(sessionCandidates.length);
    setPanelHydrationErrorCount(0);
    SKIA_MINI_CHAT_PANEL_IDS.slice(sessionCandidates.length)
      .forEach((panelId) => clearPanelSnapshotRef.current(panelId));
    void Promise.all(sessionCandidates.map(async (session, index) => {
      const panelId = SKIA_MINI_CHAT_PANEL_IDS[index];
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
      hydratedSignatureRef.current = sessionSignature;
      setHydratingPanelCount(0);
    });
  }, [sessionCandidates, sessionSignature, sessionTitleOverridesById]);

  // ポップアップで開く直前にJSONLから本文を再同期する(ドロワー経由と同じ鮮度に揃える)。
  // パネルスナップショットはメモリ上の写像でしかなく、relay喪失やバックグラウンド完了で
  // 古いまま残ることがある。ライブ応答中のパネルは上書きしない。
  // 多重呼び出しのdedupは既存のパネルhydration世代ガード(superseded)に委譲する。
  const refreshPanelSessionForPopup = useCallback((panelIdRaw: string) => {
    const panelId = String(panelIdRaw || "").trim();
    const session = sessionCandidates[SKIA_MINI_CHAT_PANEL_IDS.indexOf(panelId)];
    if (!session) return;
    const snapshot = getSnapshot(panelId);
    if (snapshot.selectedSessionId === session.sessionId && snapshot.isResponding) return;
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
    }).catch(() => {
      // 失敗時は既存スナップショットを表示し続ける(hydration側が同一セッションの状態を保持する)。
    });
  }, [getSnapshot, sessionCandidates, sessionTitleOverridesById]);

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

  return {
    directorySync: directorySessionSync,
    hydratingPanelCount,
    panelHydrationErrorCount,
    refreshPanelSessionForPopup,
    sessions,
  };
}
