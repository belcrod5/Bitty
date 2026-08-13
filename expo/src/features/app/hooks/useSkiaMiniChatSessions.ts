import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversation } from "../contexts/ConversationContext";
import type { DirectoryMarkerColor } from "../types/directorySessions";
import { collectRegisteredDirectorySessions } from "../utils/registeredDirectorySessions";
import {
  buildPanelHydrationRequestMark,
  decidePanelHydration,
  type PanelHydrationRequestMark,
} from "../utils/panelAssignmentHydration";
import {
  SKIA_BOARD_DEFAULT_TEXT_SCALE,
  skiaBoardCardId,
} from "../utils/skiaBoardState";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import { useSkiaBoard } from "../contexts/SkiaBoardContext";
import type { LlmSessionSource } from "./useLlmSessionExplorer";
import { isLlmSessionUnread } from "../utils/llmSession";
import type { SessionActivity } from "../utils/statusIcons";

// パネルIDはセッションごとに固定(インデックス割当だと並び替えで担当が入れ替わり、
// 全パネルの再hydrateを誘発するため)。
export function skiaMiniChatPanelId(sessionId: string) {
  return `skia_mini_preview_${sessionId}`;
}

export type SkiaMiniChatSession = {
  kind: "session";
  cardId: string;
  panelId: string;
  sessionId: string;
  directory: string;
  source: LlmSessionSource;
  title: string;
  directoryName: string;
  lastMessageContent: string;
  updatedAtLabel: string;
  unread: boolean;
  activityTrail: Array<{ kind: SessionActivity; active: boolean }>;
  subagentLoading: boolean;
  subagentRunningCount: number;
  subagentTotalCount: number;
  markerColor: DirectoryMarkerColor;
  col: number;
  row: number;
};

export type SkiaMiniBoardFile = {
  kind: "file";
  cardId: string;
  rootDir: string;
  path: string;
  name: string;
  unavailable?: boolean;
  col: number;
  row: number;
};

export type SkiaMiniBoardItem = SkiaMiniChatSession | SkiaMiniBoardFile;

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
    loadSessionChildrenBatch,
  } = useConversation();
  const { getSnapshot } = usePanelRuntimeStore();
  const { clearPanelSnapshot, hydratePanelFromSessionHistory } = usePanelRuntimeController();
  const {
    state: boardState,
    moveCard: moveBoardCard,
    removeSession: removeBoardSession,
    removeFile: removeBoardFile,
    hasFile: hasBoardFile,
    markFileUnavailable: markBoardFileUnavailable,
    tidyCards,
    setCardTextScale: setBoardCardTextScale,
    addSection: addBoardSection,
    updateSection: updateBoardSection,
    removeSection: removeBoardSection,
  } = useSkiaBoard();
  const clearPanelSnapshotRef = useRef(clearPanelSnapshot);
  const hydratePanelFromSessionHistoryRef = useRef(hydratePanelFromSessionHistory);
  const getSnapshotRef = useRef(getSnapshot);
  // 同一マウント内で発行済みのhydrate要求(進行中含む)のパネル別記録。
  const lastRequestedHydrationByPanelRef = useRef<Record<string, PanelHydrationRequestMark>>({});
  // 直近まで割当があったパネルの記録。割当が外れたパネルのsnapshotだけを破棄する。
  const assignedPanelIdsRef = useRef<Set<string>>(new Set());
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
  ), [
    directorySessionsById,
    registeredDirectories,
  ]);

  // ボード搭載カードのうち、候補(取得済みセッション)が存在するものだけを表示・
  // hydrate対象にする。取得ウィンドウ外のカードは位置だけ保持して再登場を待つ。
  const assignedSessions = useMemo(() => {
    const candidatesBySessionId = new Map(
      sessionCandidates.map((candidate) => [candidate.sessionId, candidate])
    );
    return (boardState?.cards || []).flatMap((card) => {
      if (card.kind !== "session") return [];
      const candidate = candidatesBySessionId.get(card.sessionId);
      return candidate ? [{ card, candidate, panelId: skiaMiniChatPanelId(card.sessionId) }] : [];
    });
  }, [boardState, sessionCandidates]);

  const childStateByParentId = useMemo(() => new Map(
    Object.values(directorySessionsById).flatMap((state) => (
      Object.entries(state.childrenByParentId)
    ))
  ), [directorySessionsById]);

  useEffect(() => {
    const parentIdsByDirectory = new Map<string, string[]>();
    for (const { candidate } of assignedSessions) {
      if (childStateByParentId.has(candidate.sessionId)) continue;
      const parentIds = parentIdsByDirectory.get(candidate.directory) || [];
      parentIds.push(candidate.sessionId);
      parentIdsByDirectory.set(candidate.directory, parentIds);
    }
    for (const [directory, parentIds] of parentIdsByDirectory) {
      void loadSessionChildrenBatch(parentIds, directory);
    }
  }, [assignedSessions, childStateByParentId, loadSessionChildrenBatch]);

  useEffect(() => {
    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    // 割当が外れたパネルだけsnapshotを破棄する(スナップショットのリーク防止)。
    const nextAssignedPanelIds = new Set(assignedSessions.map(({ panelId }) => panelId));
    for (const panelId of assignedPanelIdsRef.current) {
      if (nextAssignedPanelIds.has(panelId)) continue;
      delete lastRequestedHydrationByPanelRef.current[panelId];
      if (!String(getSnapshotRef.current(panelId).selectedSessionId || "").trim()) continue;
      clearPanelSnapshotRef.current(panelId);
    }
    assignedPanelIdsRef.current = nextAssignedPanelIds;
    if (assignedSessions.length <= 0) {
      setHydratingPanelCount(0);
      setPanelHydrationErrorCount(0);
      return;
    }
    // パネル単位で「割当変化 or updatedAt前進」だけをhydrate対象にする。
    // ライブ応答中や鮮度十分なsnapshotを持つパネルは再取得しない。
    const hydrateTargets = assignedSessions
      .filter(({ candidate, panelId }) => decidePanelHydration({
        panelId,
        candidate,
        lastRequested: lastRequestedHydrationByPanelRef.current[panelId] || null,
        snapshot: getSnapshotRef.current(panelId),
      }).action === "hydrate");
    if (hydrateTargets.length <= 0) {
      setHydratingPanelCount(0);
      return;
    }
    setHydratingPanelCount(hydrateTargets.length);
    setPanelHydrationErrorCount(0);
    void Promise.all(hydrateTargets.map(async ({ candidate, panelId }) => {
      // 発行記録は失敗時も残し、同じupdatedAtのままでのホットリトライを防ぐ。
      lastRequestedHydrationByPanelRef.current[panelId] =
        buildPanelHydrationRequestMark(panelId, candidate);
      try {
        const result = await hydratePanelFromSessionHistoryRef.current({
          panelId,
          sessionId: candidate.sessionId,
          directory: candidate.directory,
          source: candidate.source,
          directoryDisplayName: candidate.directoryDisplayName,
          title: sessionTitleOverridesById[candidate.sessionId] || candidate.firstUserMessage,
          updatedAt: candidate.updatedAt,
          modelRef: candidate.modelRef,
          reasoningEffort: candidate.reasoningEffort,
          contextUsedPct: candidate.contextUsedPct,
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
  }, [assignedSessions, sessionTitleOverridesById]);

  const sessions = useMemo<SkiaMiniChatSession[]>(() => (
    assignedSessions.map(({ card, candidate, panelId }) => {
      const snapshot = getSnapshot(panelId);
      const messages = snapshot.selectedSessionId === candidate.sessionId
        ? snapshot.conversationMessages
        : [];
      const lastMessage = messages[messages.length - 1];
      const childState = childStateByParentId.get(candidate.sessionId);
      const runtimeActivityTrail = snapshot.runtimeActivityTrail || [];
      return {
        kind: "session",
        cardId: skiaBoardCardId(card),
        panelId,
        sessionId: candidate.sessionId,
        directory: candidate.directory,
        source: candidate.source,
        title: String(
          sessionTitleOverridesById[candidate.sessionId]
          || candidate.agentDisplayName
          || candidate.firstUserMessage
          || candidate.sessionId
        ).trim(),
        directoryName: candidate.directoryDisplayName,
        lastMessageContent: snapshot.selectedSessionId === candidate.sessionId
          ? String(lastMessage?.content || "メッセージなし").replace(/\s+/g, " ").trim()
          : "",
        updatedAtLabel: formatSkiaMiniChatUpdatedAt(candidate.updatedAt, nowMs),
        unread: isLlmSessionUnread(candidate),
        activityTrail: runtimeActivityTrail.map((kind, index) => ({
          kind,
          active: snapshot.isResponding && index === runtimeActivityTrail.length - 1,
        })),
        subagentLoading: !childState?.loaded,
        subagentRunningCount: (childState?.entries || []).filter(
          (entry) => entry.threadStatusType === "active"
        ).length,
        subagentTotalCount: childState?.entries.length || 0,
        markerColor: sessionMarkerColorsById[candidate.sessionId] || "none",
        col: card.col,
        row: card.row,
      };
    })
  ), [
    assignedSessions,
    childStateByParentId,
    getSnapshot,
    nowMs,
    sessionMarkerColorsById,
    sessionTitleOverridesById,
  ]);

  const files = useMemo<SkiaMiniBoardFile[]>(() => (boardState?.cards || []).flatMap((card) => (
    card.kind === "file"
      ? [{ ...card, cardId: skiaBoardCardId(card) }]
      : []
  )), [boardState]);
  const items = useMemo<SkiaMiniBoardItem[]>(() => {
    const sessionsByCardId = new Map(sessions.map((session) => [session.cardId, session]));
    const filesByCardId = new Map(files.map((file) => [file.cardId, file]));
    return (boardState?.cards || []).flatMap((card) => {
      const cardId = skiaBoardCardId(card);
      const item = card.kind === "session"
        ? sessionsByCardId.get(cardId)
        : filesByCardId.get(cardId);
      return item ? [item] : [];
    });
  }, [boardState, files, sessions]);
  const tidyBoard = useCallback(() => {
    tidyCards(items.map((item) => item.cardId));
  }, [items, tidyCards]);

  return {
    directorySync: directorySessionSync,
    hydratingPanelCount,
    panelHydrationErrorCount,
    sessions,
    items,
    sections: boardState?.sections || [],
    cardTextScale: boardState?.cardTextScale ?? SKIA_BOARD_DEFAULT_TEXT_SCALE,
    setBoardCardTextScale,
    moveBoardCard,
    addBoardSection,
    updateBoardSection,
    removeBoardSection,
    removeBoardSession,
    removeBoardFile,
    hasBoardFile,
    markBoardFileUnavailable,
    tidyBoard,
  };
}
