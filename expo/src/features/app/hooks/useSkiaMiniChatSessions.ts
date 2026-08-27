import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatScreen } from "../contexts/ChatScreenContext";
import { useConversation } from "../contexts/ConversationContext";
import type { DirectoryMarkerColor } from "../types/directorySessions";
import { collectRegisteredDirectorySessions } from "../utils/registeredDirectorySessions";
import { fetchSkiaBoardSessionSummaries } from "../utils/skiaBoardRunnerApi";
import { parseContextUsageUsedPct } from "../utils/formatting";
import {
  buildPanelHydrationRequestMark,
  decidePanelHydration,
  type PanelHydrationRequestMark,
} from "../utils/panelAssignmentHydration";
import {
  SKIA_BOARD_DEFAULT_TEXT_SCALE,
  skiaBoardCardDisplayName,
  skiaBoardCardId,
} from "../utils/skiaBoardState";
import { usePanelRuntimeController } from "../contexts/PanelRuntimeControllerContext";
import { usePanelRuntimeStore } from "../contexts/PanelRuntimeStoreContext";
import { useSkiaBoard } from "../contexts/SkiaBoardContext";
import type { LlmSessionHistoryEntry, LlmSessionSource } from "./useLlmSessionExplorer";
import { formatLlmSessionDisplayTitle, isLlmSessionUnread } from "../utils/llmSession";
import type { SessionActivity } from "../utils/statusIcons";

// パネルIDはセッションごとに固定(インデックス割当だと並び替えで担当が入れ替わり、
// 全パネルの再hydrateを誘発するため)。
export function skiaMiniChatPanelId(sessionId: string) {
  return `skia_mini_preview_${sessionId}`;
}

export type SkiaMiniChatSession = {
  kind: "session";
  backendId: string;
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
  displayNameOverride?: string;
  imagePath?: string;
  unavailable?: boolean;
  col: number;
  row: number;
};

export type SkiaMiniBoardDirectory = {
  kind: "directory";
  cardId: string;
  directory: string;
  name: string;
  displayNameOverride?: string;
  imagePath?: string;
  col: number;
  row: number;
};

export type SkiaMiniBoardItem =
  | SkiaMiniChatSession
  | SkiaMiniBoardFile
  | SkiaMiniBoardDirectory;

export function formatSkiaMiniChatUpdatedAt(raw: unknown, nowMs = Date.now()) {
  const updatedAtMs = new Date(String(raw || "")).getTime();
  if (!Number.isFinite(updatedAtMs)) return "-";
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  // 秒表示はラベルが毎秒変わり、カードの再レンダリング(Picture再生成)を毎秒
  // 引き起こすため分単位に丸める(tickも60秒間隔)。
  if (elapsedSeconds < 60) return "1分未満";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}分前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}時間前`;
  return `${Math.floor(elapsedHours / 24)}日前`;
}

// tickによる再構築時、内容が同一のカードは同じオブジェクトを使い回すための比較。
// activityTrail(毎回新しい配列)だけ内容比較し、他のフィールドは浅い比較で足りる。
function sameBoardSession(a: SkiaMiniChatSession, b: SkiaMiniChatSession) {
  return (Object.keys(a) as Array<keyof SkiaMiniChatSession>).every((key) => (
    key === "activityTrail"
      ? a.activityTrail.length === b.activityTrail.length
        && a.activityTrail.every((activity, index) => (
          activity.kind === b.activityTrail[index].kind
          && activity.active === b.activityTrail[index].active
        ))
      : a[key] === b[key]
  ));
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
    removeDirectory: removeBoardDirectory,
    removeFile: removeBoardFile,
    hasFile: hasBoardFile,
    updateCardAppearance: updateBoardCardAppearance,
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
    // ラベルは分単位なので60秒間隔で十分。1秒tickは毎秒の全体再レンダリングで
    // ボードを周期的にガクつかせていた。
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
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

  // ドロワーの取得ウィンドウ外のセッションカードは、カードが持つ出所情報
  // (directory/backendId)を使ってランナーのサマリAPIから直接表示情報を取得する。
  // これにより「配置済みなのに読み込みウィンドウ外で非表示」が構造的に消える(設計書 Step 3)。
  const { runnerUrl, runnerToken } = useChatScreen();
  const missingSummaryKey = useMemo(() => {
    const candidateIds = new Set(sessionCandidates.map((candidate) => candidate.sessionId));
    const byDirectory = new Map<string, string[]>();
    for (const card of boardState?.cards || []) {
      if (card.kind !== "session" || candidateIds.has(card.sessionId)) continue;
      const directory = String(card.directory || "").trim();
      // 出所情報の無い旧カードは従来どおりウィンドウ外では非表示(位置は保持)。
      if (!directory) continue;
      const sessionIds = byDirectory.get(directory) || [];
      sessionIds.push(card.sessionId);
      byDirectory.set(directory, sessionIds);
    }
    return JSON.stringify(
      Array.from(byDirectory, ([directory, sessionIds]) => [directory, sessionIds.sort()])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  }, [boardState, sessionCandidates]);

  type SummaryCandidate = LlmSessionHistoryEntry & {
    directory: string;
    cwd: string;
    directoryDisplayName: string;
  };
  const [summaryCandidates, setSummaryCandidates] = useState<SummaryCandidate[]>([]);
  const summaryFetchGenerationRef = useRef(0);
  useEffect(() => {
    const generation = summaryFetchGenerationRef.current + 1;
    summaryFetchGenerationRef.current = generation;
    const groups = JSON.parse(missingSummaryKey) as Array<[string, string[]]>;
    if (groups.length <= 0) {
      setSummaryCandidates([]);
      return;
    }
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    const directoryNames = new Map(registeredDirectories.map((directory) => [
      String(directory.path || "").trim(),
      String(directory.displayName || "").trim(),
    ]));
    void (async () => {
      try {
        const collected: SummaryCandidate[] = [];
        for (const [directory, sessionIds] of groups) {
          const summaries = await fetchSkiaBoardSessionSummaries(
            { runnerUrl, runnerToken },
            { directory, sessionIds }
          );
          for (const summary of summaries) {
            collected.push({
              // backendId はサマリ応答に無いため、assignedSessions側でカードの値を優先する。
              backendId: "codex",
              sessionId: summary.sessionId,
              parentSessionId: summary.parentSessionId,
              directory,
              updatedAt: summary.updatedAt,
              lastReadAt: summary.lastReadAt,
              source: (summary.source || "unknown") as LlmSessionSource,
              cwd: summary.cwd || directory,
              firstUserMessage: summary.firstUserMessage,
              agentRole: "",
              agentDisplayName: "",
              contextUsedPct: parseContextUsageUsedPct(summary.contextUsage),
              modelRef: summary.modelRef,
              reasoningEffort: summary.reasoningEffort,
              directoryDisplayName: directoryNames.get(directory)
                || directory.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop()
                || directory,
            });
          }
        }
        if (summaryFetchGenerationRef.current !== generation) return;
        setSummaryCandidates(collected);
      } catch (error) {
        console.warn("[skia_board] failed to fetch session summaries for board cards", error);
      }
    })();
    // cycleId: ドロワー同期の各サイクル完了時にサマリの鮮度(未読・updatedAt)を追随させる。
  }, [directorySessionSync.cycleId, missingSummaryKey, registeredDirectories, runnerToken, runnerUrl]);

  // ボード搭載カードのうち、候補(ウィンドウ内セッション、またはサマリ取得済み)が
  // 存在するものを表示・hydrate対象にする。どちらにも無いカードは位置だけ保持する。
  const assignedSessions = useMemo(() => {
    const candidatesBySessionId = new Map(
      sessionCandidates.map((candidate) => [candidate.sessionId, candidate])
    );
    const summariesBySessionId = new Map(
      summaryCandidates.map((candidate) => [candidate.sessionId, candidate])
    );
    return (boardState?.cards || []).flatMap((card) => {
      if (card.kind !== "session") return [];
      const windowCandidate = candidatesBySessionId.get(card.sessionId);
      const summaryCandidate = windowCandidate
        ? undefined
        : summariesBySessionId.get(card.sessionId);
      const candidate = windowCandidate
        ?? (summaryCandidate
          ? { ...summaryCandidate, backendId: card.backendId || summaryCandidate.backendId }
          : undefined);
      if (!candidate) return [];
      return [{
        card,
        candidate,
        panelId: skiaMiniChatPanelId(card.sessionId),
        title: formatLlmSessionDisplayTitle(
          sessionTitleOverridesById[candidate.sessionId]
          || candidate.agentDisplayName
          || candidate.firstUserMessage
          || candidate.sessionId
        ),
      }];
    });
  }, [boardState, sessionCandidates, sessionTitleOverridesById, summaryCandidates]);

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
    void Promise.all(hydrateTargets.map(async ({ candidate, panelId, title }) => {
      // 発行記録は失敗時も残し、同じupdatedAtのままでのホットリトライを防ぐ。
      lastRequestedHydrationByPanelRef.current[panelId] =
        buildPanelHydrationRequestMark(panelId, candidate);
      try {
        const result = await hydratePanelFromSessionHistoryRef.current({
          panelId,
          backendId: candidate.backendId,
          sessionId: candidate.sessionId,
          directory: candidate.directory,
          source: candidate.source,
          directoryDisplayName: candidate.directoryDisplayName,
          title,
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
  }, [assignedSessions]);

  // 再構築時、内容が変わっていないカードは前回のオブジェクト(と配列)を使い回す。
  // itemのidentityが保たれることで、React.memoされたカードの再レンダリングと
  // Picture再生成が「内容が実際に変わったカードだけ」に限定される。
  const sessionReuseRef = useRef<{ byCardId: Map<string, SkiaMiniChatSession>; list: SkiaMiniChatSession[] }>({
    byCardId: new Map(),
    list: [],
  });
  const sessions = useMemo<SkiaMiniChatSession[]>(() => {
    const previous = sessionReuseRef.current;
    const nextByCardId = new Map<string, SkiaMiniChatSession>();
    const list = assignedSessions.map(({ card, candidate, panelId, title }) => {
      const snapshot = getSnapshot(panelId);
      const messages = snapshot.selectedSessionId === candidate.sessionId
        ? snapshot.conversationMessages
        : [];
      const lastMessage = messages[messages.length - 1];
      const childState = childStateByParentId.get(candidate.sessionId);
      const runtimeActivityTrail = snapshot.runtimeActivityTrail || [];
      const built: SkiaMiniChatSession = {
        kind: "session",
        backendId: candidate.backendId,
        cardId: skiaBoardCardId(card),
        panelId,
        sessionId: candidate.sessionId,
        directory: candidate.directory,
        source: candidate.source,
        title,
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
      const cached = previous.byCardId.get(built.cardId);
      const reused = cached && sameBoardSession(cached, built) ? cached : built;
      nextByCardId.set(built.cardId, reused);
      return reused;
    });
    const sameList = previous.list.length === list.length
      && list.every((session, index) => session === previous.list[index]);
    const result = sameList ? previous.list : list;
    sessionReuseRef.current = { byCardId: nextByCardId, list: result };
    return result;
  }, [
    assignedSessions,
    childStateByParentId,
    getSnapshot,
    nowMs,
    sessionMarkerColorsById,
  ]);

  // file/directoryカードも、元のboardStateカードが同一参照なら同じitemを使い回す。
  const boardItemReuseRef = useRef(new Map<
    string,
    { source: unknown; name: string; item: SkiaMiniBoardItem }
  >());
  const items = useMemo<SkiaMiniBoardItem[]>(() => {
    const sessionsByCardId = new Map(sessions.map((session) => [session.cardId, session]));
    const previous = boardItemReuseRef.current;
    const next = new Map<string, { source: unknown; name: string; item: SkiaMiniBoardItem }>();
    const list = (boardState?.cards || []).flatMap((card) => {
      const cardId = skiaBoardCardId(card);
      if (card.kind === "session") {
        const item = sessionsByCardId.get(cardId);
        return item ? [item] : [];
      }
      const name = skiaBoardCardDisplayName(card, registeredDirectories);
      const cached = previous.get(cardId);
      const item: SkiaMiniBoardItem = cached && cached.source === card && cached.name === name
        ? cached.item
        : { ...card, cardId, name };
      next.set(cardId, { source: card, name, item });
      return [item];
    });
    boardItemReuseRef.current = next;
    return list;
  }, [boardState, registeredDirectories, sessions]);
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
    removeBoardDirectory,
    removeBoardFile,
    hasBoardFile,
    updateBoardCardAppearance,
    tidyBoard,
  };
}
