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
  ingestSkiaBoardSessions,
  moveSkiaBoardCard,
  readPersistedSkiaBoardState,
  removeSkiaBoardSession,
  tidySkiaBoardCards,
  writePersistedSkiaBoardState,
  type SkiaBoardState,
} from "../utils/skiaBoardState";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import type { LlmSessionSource } from "./useLlmSessionExplorer";

// パネルIDはセッションごとに固定(インデックス割当だと並び替えで担当が入れ替わり、
// 全パネルの再hydrateを誘発するため)。
export function skiaMiniChatPanelId(sessionId: string) {
  return `skia_mini_preview_${sessionId}`;
}

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
  col: number;
  row: number;
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
  // 直近まで割当があったパネルの記録。割当が外れたパネルのsnapshotだけを破棄する。
  const assignedPanelIdsRef = useRef<Set<string>>(new Set());
  const hydrationGenerationRef = useRef(0);
  const [hydratingPanelCount, setHydratingPanelCount] = useState(0);
  const [panelHydrationErrorCount, setPanelHydrationErrorCount] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [boardState, setBoardState] = useState<SkiaBoardState | null>(null);
  const [boardStateLoaded, setBoardStateLoaded] = useState(false);
  const lastPersistedBoardStateRef = useRef<SkiaBoardState | null>(null);

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

  // 保存済みボードステートの読み込み(初回マウント時)。
  useEffect(() => {
    let cancelled = false;
    readPersistedSkiaBoardState()
      .then((state) => {
        if (cancelled) return;
        lastPersistedBoardStateRef.current = state;
        setBoardState(state);
      })
      .catch((error) => {
        console.warn("[skia_board] failed to read persisted board state", error);
      })
      .finally(() => {
        if (!cancelled) setBoardStateLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessionCandidates = useMemo(() => (
    collectRegisteredDirectorySessions(registeredDirectories, directorySessionsById)
  ), [
    directorySessionsById,
    registeredDirectories,
  ]);

  // 積み上げ取り込みは同期が完結した状態(全ディレクトリの候補が揃った状態)でのみ行う。
  // 読込途中に取り込むと、ウォーターマークが未読込ディレクトリの新規セッションを
  // 追い越して取りこぼすため。
  const directorySyncSettled = (
    directorySessionSync.phase === "idle"
    || directorySessionSync.phase === "complete"
    || directorySessionSync.phase === "partial_error"
  );
  useEffect(() => {
    if (!boardStateLoaded || !directorySyncSettled) return;
    setBoardState((prev) => ingestSkiaBoardSessions(prev, sessionCandidates));
  }, [boardStateLoaded, directorySyncSettled, sessionCandidates]);

  // ステート変化(追加・移動・整頓・削除)を端末ローカルへ保存する。
  // ドラッグ中はSharedValueのみが動き、ステート更新はドラッグ終了時なので
  // フレーム毎の書き込みは発生しない。
  useEffect(() => {
    if (!boardStateLoaded || !boardState) return;
    if (boardState === lastPersistedBoardStateRef.current) return;
    lastPersistedBoardStateRef.current = boardState;
    void writePersistedSkiaBoardState(boardState).catch((error) => {
      console.warn("[skia_board] failed to persist board state", error);
    });
  }, [boardState, boardStateLoaded]);

  // ボード搭載カードのうち、候補(取得済みセッション)が存在するものだけを表示・
  // hydrate対象にする。取得ウィンドウ外のカードは位置だけ保持して再登場を待つ。
  const assignedSessions = useMemo(() => {
    const candidatesBySessionId = new Map(
      sessionCandidates.map((candidate) => [candidate.sessionId, candidate])
    );
    return (boardState?.cards || []).flatMap((card) => {
      const candidate = candidatesBySessionId.get(card.sessionId);
      return candidate ? [{ card, candidate, panelId: skiaMiniChatPanelId(card.sessionId) }] : [];
    });
  }, [boardState, sessionCandidates]);

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
      return {
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
        markerColor: sessionMarkerColorsById[candidate.sessionId] || "none",
        col: card.col,
        row: card.row,
      };
    })
  ), [
    assignedSessions,
    getSnapshot,
    nowMs,
    sessionMarkerColorsById,
    sessionTitleOverridesById,
  ]);

  const moveBoardCard = useCallback((sessionId: string, col: number, row: number) => {
    setBoardState((prev) => (prev ? moveSkiaBoardCard(prev, sessionId, col, row) : prev));
  }, []);

  const removeBoardSession = useCallback((sessionId: string) => {
    setBoardState((prev) => (prev ? removeSkiaBoardSession(prev, sessionId) : prev));
  }, []);

  const tidyBoard = useCallback(() => {
    setBoardState((prev) => (prev ? tidySkiaBoardCards(prev) : prev));
  }, []);

  return {
    directorySync: directorySessionSync,
    hydratingPanelCount,
    panelHydrationErrorCount,
    sessions,
    moveBoardCard,
    removeBoardSession,
    tidyBoard,
  };
}
