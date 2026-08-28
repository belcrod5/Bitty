import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import { useChatScreen } from "./ChatScreenContext";
import { useConversation } from "./ConversationContext";
import { useRunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketContext";
import { shouldHandleReadyTransition } from "../utils/resumeSync";
import { collectRegisteredDirectorySessions } from "../utils/registeredDirectorySessions";
import {
  fetchSkiaBoard,
  importSkiaBoard,
  postSkiaBoardOps,
  syncSkiaBoardIngestDirectories,
  type SkiaBoardRunnerSnapshot,
} from "../utils/skiaBoardRunnerApi";
import {
  applySkiaBoardOpsLocally,
  type SkiaBoardOp,
} from "../utils/skiaBoardRunnerOps";
import {
  mutatePersistedSettings,
  readPersistedSettingsField,
  SKIA_BOARD_CARD_TEXT_SCALE_FIELD,
  SKIA_BOARD_RUNNER_CACHE_FIELD,
} from "../utils/persistedSettingsFile";
import {
  normalizeSkiaBoardTextScale,
  SKIA_BOARD_DEFAULT_TEXT_SCALE,
  skiaBoardDirectoryId,
  skiaBoardFileId,
  type SkiaBoardFileCard,
  type SkiaBoardState,
  type SkiaBoardSection,
} from "../utils/skiaBoardState";

// Skiaボード配置の正本はランナー(GET /skia-board)が持ち、端末には保存しない。このProviderは
// 1) サーバー正本の取得と skia_board_updated 通知/再接続/フォアグラウンド復帰での再取得
// 2) 操作の楽観反映と POST /skia-board/ops への差分送信(baseRevision楽観ロック、409で正本再採用)
// 3) オフライン起動用の読み取り専用ディスクキャッシュ
// を担う。cardTextScale だけは画面サイズ依存の好みのため端末ローカルに保存する。
// 新セッションの自動カード追加(ingest)はランナー側に一本化されたため、ここでは行わない。
// POST /skia-board/import は未初期化ストアへの最初の編集を初期化する用途にのみ使う。

type SkiaBoardContextValue = {
  state: SkiaBoardState | null;
  loaded: boolean;
  addSession: (sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  hasSession: (sessionId: string) => boolean;
  addDirectory: (target: { directory: string; name?: string }) => void;
  removeDirectory: (directory: string) => void;
  hasDirectory: (directory: string) => boolean;
  addFile: (file: { rootDir: string; path: string; name?: string }) => void;
  removeFile: (rootDir: string, path: string) => void;
  markFileUnavailable: (rootDir: string, path: string) => void;
  renameFile: (rootDir: string, previousPath: string, nextPath: string) => void;
  hasFile: (rootDir: string, path: string) => boolean;
  updateCardAppearance: (
    cardId: string,
    appearance: Pick<SkiaBoardFileCard, "displayNameOverride" | "imagePath">
  ) => void;
  moveCard: (cardId: string, col: number, row: number) => void;
  addSection: (section: SkiaBoardSection) => void;
  updateSection: (sectionId: string, update: Partial<Omit<SkiaBoardSection, "id">>) => void;
  removeSection: (sectionId: string) => void;
  tidyCards: (visibleCardIds: readonly string[]) => void;
  setCardTextScale: (scale: number) => void;
};

const SkiaBoardContext = createContext<SkiaBoardContextValue | null>(null);

const MAX_CONFLICT_RETRIES = 3;

type ServerBoardState = {
  synced: boolean;
  initialized: boolean;
  revision: number;
};

export function SkiaBoardProvider({ children }: { children: ReactNode }) {
  const { runnerUrl, runnerToken } = useChatScreen();
  const runnerWebSocketManager = useRunnerWebSocketManager();
  const { registeredDirectories, directorySessionsById } = useConversation();

  const [state, setState] = useState<SkiaBoardState | null>(null);
  const [loaded, setLoaded] = useState(false);

  const mountedRef = useRef(false);
  const stateRef = useRef<SkiaBoardState | null>(null);
  const loadedRef = useRef(false);
  const cardTextScaleRef = useRef(SKIA_BOARD_DEFAULT_TEXT_SCALE);
  const serverRef = useRef<ServerBoardState>({ synced: false, initialized: false, revision: 0 });
  const pendingOpsRef = useRef<SkiaBoardOp[]>([]);
  const flushInFlightRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const lastReadyGenerationRef = useRef(0);
  const authRef = useRef({ runnerUrl, runnerToken });
  useEffect(() => {
    authRef.current = { runnerUrl, runnerToken };
  }, [runnerUrl, runnerToken]);

  // セッションカード追加時に directory/backendId を補うための逆引き。
  const sessionMetaById = useMemo(() => {
    const map = new Map<string, { directory?: string; backendId?: string }>();
    for (const candidate of collectRegisteredDirectorySessions(registeredDirectories, directorySessionsById)) {
      if (!map.has(candidate.sessionId)) {
        map.set(candidate.sessionId, {
          directory: candidate.directory,
          backendId: candidate.backendId,
        });
      }
    }
    return map;
  }, [directorySessionsById, registeredDirectories]);
  const sessionMetaRef = useRef(sessionMetaById);
  useEffect(() => {
    sessionMetaRef.current = sessionMetaById;
  }, [sessionMetaById]);

  const emptyBoardState = useCallback((): SkiaBoardState => ({
    cards: [],
    sections: [],
    excludedSessionIds: [],
    ingestedUpdatedAtMs: 0,
    cardTextScale: cardTextScaleRef.current,
  }), []);

  const setDisplayState = useCallback((board: SkiaBoardState | null) => {
    const composed = board && board.cardTextScale !== cardTextScaleRef.current
      ? { ...board, cardTextScale: cardTextScaleRef.current }
      : board;
    stateRef.current = composed;
    setState(composed);
  }, []);

  const markLoaded = useCallback(() => {
    loadedRef.current = true;
    setLoaded(true);
  }, []);

  const adoptSnapshot = useCallback((snapshot: SkiaBoardRunnerSnapshot) => {
    // refreshとflushは並行し得るため、遅れて届いた古いスナップショットで
    // 確定済みの新しいrevisionと表示を巻き戻さない(未初期化⇔初期化の遷移は例外)。
    const current = serverRef.current;
    if (
      current.synced
      && snapshot.initialized === current.initialized
      && snapshot.revision < current.revision
    ) return;
    serverRef.current = {
      synced: true,
      initialized: snapshot.initialized,
      revision: snapshot.revision,
    };
    const display = pendingOpsRef.current.length > 0
      ? applySkiaBoardOpsLocally(snapshot.board ?? emptyBoardState(), pendingOpsRef.current)
      : snapshot.board;
    setDisplayState(display);
    markLoaded();
    // オフライン起動時の表示用キャッシュ(読み取り専用)。失敗しても運用には影響しない。
    void mutatePersistedSettings((current) => ({
      ...current,
      [SKIA_BOARD_RUNNER_CACHE_FIELD]: {
        initialized: snapshot.initialized,
        revision: snapshot.revision,
        board: snapshot.board,
      },
    })).catch((error) => {
      console.warn("[skia_board] failed to cache runner board state", error);
    });
  }, [emptyBoardState, markLoaded, setDisplayState]);

  const refreshFromServer = useCallback(async () => {
    const auth = authRef.current;
    if (!auth.runnerUrl.trim() || !auth.runnerToken.trim()) return;
    if (refreshInFlightRef.current) {
      // 実行中に来た要求は握り潰さず、完了後にもう一周して最新を取り直す。
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    try {
      const snapshot = await fetchSkiaBoard(auth);
      if (!mountedRef.current) return;
      adoptSnapshot(snapshot);
    } catch (error) {
      console.warn("[skia_board] failed to load board from runner", error);
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current && mountedRef.current) {
        refreshQueuedRef.current = false;
        void refreshFromServer();
      }
    }
  }, [adoptSnapshot]);

  const flushPendingOps = useCallback(async () => {
    if (flushInFlightRef.current) return;
    flushInFlightRef.current = true;
    try {
      let retryAttempts = 0;
      while (mountedRef.current && pendingOpsRef.current.length > 0) {
        const auth = authRef.current;
        if (!auth.runnerUrl.trim() || !auth.runnerToken.trim()) break;
        const batch = pendingOpsRef.current;
        pendingOpsRef.current = [];
        try {
          if (!serverRef.current.initialized) {
            // 未初期化ボードへの最初の編集は、楽観stateごとimportして初期化する。
            const board = stateRef.current;
            const importable = board && (
              board.cards.length > 0
              || board.sections.length > 0
              || board.excludedSessionIds.length > 0
            );
            if (!importable) {
              console.warn("[skia_board] dropping ops that leave an uninitialized board empty");
              continue;
            }
            const result = await importSkiaBoard(auth, { board });
            if (result.status === "already_initialized") {
              // 他端末が先に初期化していた: 正本を採用し、編集はopとして再送する。
              pendingOpsRef.current = [...batch, ...pendingOpsRef.current];
            }
            adoptSnapshot(result.snapshot);
            continue;
          }
          const result = await postSkiaBoardOps(auth, {
            baseRevision: serverRef.current.revision,
            ops: batch,
          });
          if (result.status === "ok") {
            adoptSnapshot(result.snapshot);
            continue;
          }
          if (result.status === "conflict") {
            // 他端末の変更が先行: 正本を取り込み、同じopを新しいrevisionで再送する。
            retryAttempts += 1;
            if (retryAttempts > MAX_CONFLICT_RETRIES) {
              console.warn("[skia_board] dropping board ops after repeated revision conflicts");
              adoptSnapshot(result.snapshot);
              break;
            }
            pendingOpsRef.current = [...batch, ...pendingOpsRef.current];
            adoptSnapshot(result.snapshot);
            continue;
          }
          // not_initialized: ストアが未初期化へ戻っている(手動リセット等)。importパスへ回す。
          // conflictと同じ上限で打ち切り、病的な往復ループを防ぐ。
          retryAttempts += 1;
          if (retryAttempts > MAX_CONFLICT_RETRIES) {
            console.warn("[skia_board] dropping board ops after repeated initialization races");
            break;
          }
          pendingOpsRef.current = [...batch, ...pendingOpsRef.current];
          serverRef.current = {
            ...serverRef.current,
            initialized: false,
            revision: result.snapshot.revision,
          };
          continue;
        } catch (error) {
          // ネットワーク等の一時失敗: opを保持し、再接続・フォアグラウンド復帰時に再送する。
          pendingOpsRef.current = [...batch, ...pendingOpsRef.current];
          console.warn("[skia_board] failed to send board ops", error);
          break;
        }
      }
    } finally {
      flushInFlightRef.current = false;
    }
  }, [adoptSnapshot]);

  // 起動時: 端末ローカル設定(文字倍率)と読み取り専用キャッシュを読み、サーバー正本を取得する。
  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const [textScaleRaw, cacheRaw] = await Promise.all([
          readPersistedSettingsField(SKIA_BOARD_CARD_TEXT_SCALE_FIELD),
          readPersistedSettingsField(SKIA_BOARD_RUNNER_CACHE_FIELD),
        ]);
        if (!mountedRef.current) return;
        cardTextScaleRef.current = normalizeSkiaBoardTextScale(textScaleRaw);
        // サーバー同期がこの読み込みより先に済んでいた場合は、倍率を表示へ再合成する。
        if (stateRef.current && stateRef.current.cardTextScale !== cardTextScaleRef.current) {
          setDisplayState(stateRef.current);
        }
        if (!serverRef.current.synced) {
          const cache = cacheRaw && typeof cacheRaw === "object" && !Array.isArray(cacheRaw)
            ? cacheRaw as Record<string, unknown>
            : null;
          const cachedBoard = cache && cache.board && typeof cache.board === "object" && !Array.isArray(cache.board)
            ? { ...emptyBoardState(), ...(cache.board as Partial<SkiaBoardState>) }
            : null;
          if (cachedBoard) {
            setDisplayState(cachedBoard);
            markLoaded();
          }
        }
      } catch (error) {
        console.warn("[skia_board] failed to read local board bootstrap data", error);
      }
      await refreshFromServer();
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [emptyBoardState, markLoaded, refreshFromServer, setDisplayState]);

  // 接続先の変更時に取得し直す(設定ロード完了で空→実値になるケースを含む)。
  useEffect(() => {
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    void refreshFromServer();
    void flushPendingOps();
  }, [flushPendingOps, refreshFromServer, runnerToken, runnerUrl]);

  // 自端末の登録ディレクトリをランナーへ送り、自動カード追加(ingest)の対象を
  // 和集合で共有する。同一内容の再送はしない。失敗は次の変化時に再試行される。
  const lastSyncedDirectoriesRef = useRef("");
  useEffect(() => {
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    const directories = Array.from(new Set(
      registeredDirectories
        .map((directory) => String(directory.path || "").trim())
        .filter(Boolean)
    )).sort();
    if (directories.length <= 0) return;
    const key = directories.join("\n");
    if (key === lastSyncedDirectoriesRef.current) return;
    let cancelled = false;
    void syncSkiaBoardIngestDirectories({ runnerUrl, runnerToken }, { directories })
      .then(() => {
        if (!cancelled) lastSyncedDirectoriesRef.current = key;
      })
      .catch((error) => {
        console.warn("[skia_board] failed to sync ingest directories", error);
      });
    return () => {
      cancelled = true;
    };
  }, [registeredDirectories, runnerToken, runnerUrl]);

  // 他デバイスの変更通知。送信中はflush側の409処理に任せる。保留opが残っている
  // (前回送信失敗など)なら、接続が生きている合図なので再送を優先する。
  useEffect(() => runnerWebSocketManager.subscribe(
    { channel: "control", op: "skia_board_updated" },
    (message) => {
      const revision = Number((message.payload as { revision?: unknown } | undefined)?.revision);
      if (Number.isInteger(revision) && revision === serverRef.current.revision) return;
      if (flushInFlightRef.current) return;
      if (pendingOpsRef.current.length > 0) {
        void flushPendingOps();
        return;
      }
      void refreshFromServer();
    }
  ), [flushPendingOps, refreshFromServer, runnerWebSocketManager]);

  // WS再接続(ready遷移1回につき1回)とフォアグラウンド復帰時の再取得・再送。
  useEffect(() => {
    const handleSnapshot = () => {
      const snapshot = runnerWebSocketManager.getSnapshot();
      if (!shouldHandleReadyTransition({
        connectionState: snapshot.connectionState,
        generation: snapshot.generation,
        lastHandledGeneration: lastReadyGenerationRef.current,
      })) return;
      lastReadyGenerationRef.current = snapshot.generation;
      void refreshFromServer();
      void flushPendingOps();
    };
    const unsubscribe = runnerWebSocketManager.subscribeSnapshot(handleSnapshot);
    handleSnapshot();
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      void refreshFromServer();
      void flushPendingOps();
    });
    return () => {
      unsubscribe();
      appStateSubscription.remove();
    };
  }, [flushPendingOps, refreshFromServer, runnerWebSocketManager]);

  const dispatchOps = useCallback((ops: SkiaBoardOp[]) => {
    if (!loadedRef.current) return;
    // サーバー未同期(オフライン起動でキャッシュ表示中)の間は読み取り専用。
    if (!serverRef.current.synced) return;
    const base = stateRef.current ?? emptyBoardState();
    const next = applySkiaBoardOpsLocally(base, ops);
    if (next === base) return;
    setDisplayState(next);
    pendingOpsRef.current = [...pendingOpsRef.current, ...ops];
    void flushPendingOps();
  }, [emptyBoardState, flushPendingOps, setDisplayState]);

  const addSession = useCallback((sessionId: string) => {
    const id = String(sessionId || "").trim();
    if (!id) return;
    const meta = sessionMetaRef.current.get(id) || {};
    dispatchOps([{
      type: "addCard",
      card: {
        kind: "session",
        sessionId: id,
        ...(meta.directory ? { directory: meta.directory } : {}),
        ...(meta.backendId ? { backendId: meta.backendId } : {}),
      },
    }]);
  }, [dispatchOps]);
  const removeSession = useCallback((sessionId: string) => {
    dispatchOps([{ type: "removeCard", cardId: `session:${String(sessionId || "").trim()}` }]);
  }, [dispatchOps]);
  const addDirectory = useCallback((target: { directory: string; name?: string }) => {
    const directory = String(target.directory || "").trim();
    if (!directory) return;
    dispatchOps([{ type: "addCard", card: { kind: "directory", directory } }]);
  }, [dispatchOps]);
  const removeDirectory = useCallback((directory: string) => {
    dispatchOps([{ type: "removeCard", cardId: skiaBoardDirectoryId(directory) }]);
  }, [dispatchOps]);
  const addFile = useCallback((file: { rootDir: string; path: string; name?: string }) => {
    const rootDir = String(file.rootDir || "").trim();
    const path = String(file.path || "").trim().replace(/\\/g, "/");
    if (!rootDir || !path) return;
    dispatchOps([{ type: "addCard", card: { kind: "file", rootDir, path } }]);
  }, [dispatchOps]);
  const removeFile = useCallback((rootDir: string, path: string) => {
    dispatchOps([{ type: "removeCard", cardId: skiaBoardFileId(rootDir, path) }]);
  }, [dispatchOps]);
  const markFileUnavailable = useCallback((rootDir: string, path: string) => {
    dispatchOps([{ type: "setFileCardUnavailable", rootDir, path, unavailable: true }]);
  }, [dispatchOps]);
  const renameFile = useCallback((rootDir: string, previousPath: string, nextPath: string) => {
    dispatchOps([{ type: "renameFileCard", rootDir, previousPath, nextPath }]);
  }, [dispatchOps]);
  const updateCardAppearance = useCallback((
    cardId: string,
    appearance: Pick<SkiaBoardFileCard, "displayNameOverride" | "imagePath">
  ) => {
    dispatchOps([{
      type: "updateCardAppearance",
      cardId,
      displayNameOverride: appearance.displayNameOverride,
      imagePath: appearance.imagePath,
    }]);
  }, [dispatchOps]);
  const moveCard = useCallback((cardId: string, col: number, row: number) => {
    if (!Number.isFinite(col) || !Number.isFinite(row)) return;
    dispatchOps([{ type: "moveCard", cardId, col, row }]);
  }, [dispatchOps]);
  const addSection = useCallback((section: SkiaBoardSection) => {
    dispatchOps([{ type: "upsertSection", section }]);
  }, [dispatchOps]);
  const updateSection = useCallback((
    sectionId: string,
    update: Partial<Omit<SkiaBoardSection, "id">>
  ) => {
    const current = stateRef.current?.sections.find((section) => section.id === sectionId);
    if (!current) return;
    dispatchOps([{ type: "upsertSection", section: { ...current, ...update, id: current.id } }]);
  }, [dispatchOps]);
  const removeSection = useCallback((sectionId: string) => {
    dispatchOps([{ type: "removeSection", sectionId }]);
  }, [dispatchOps]);
  const tidyCards = useCallback((visibleCardIds: readonly string[]) => {
    dispatchOps([{ type: "tidyCards", visibleCardIds: [...visibleCardIds] }]);
  }, [dispatchOps]);

  // 文字倍率は端末ローカル設定。ボードopにはしない。
  const setCardTextScale = useCallback((scale: number) => {
    const next = normalizeSkiaBoardTextScale(scale);
    if (next === cardTextScaleRef.current) return;
    cardTextScaleRef.current = next;
    if (stateRef.current) stateRef.current = { ...stateRef.current, cardTextScale: next };
    setState((current) => (current ? { ...current, cardTextScale: next } : current));
    void mutatePersistedSettings((current) => ({
      ...current,
      [SKIA_BOARD_CARD_TEXT_SCALE_FIELD]: next,
    })).catch((error) => {
      console.warn("[skia_board] failed to persist card text scale", error);
    });
  }, []);

  const sessionIds = useMemo(() => new Set((state?.cards || []).flatMap((card) => (
    card.kind === "session" ? [card.sessionId] : []
  ))), [state]);
  const directoryIds = useMemo(() => new Set((state?.cards || []).flatMap((card) => (
    card.kind === "directory" ? [skiaBoardDirectoryId(card.directory)] : []
  ))), [state]);
  const fileIds = useMemo(() => new Set((state?.cards || []).flatMap((card) => (
    card.kind === "file" && !card.unavailable ? [skiaBoardFileId(card.rootDir, card.path)] : []
  ))), [state]);
  const hasSession = useCallback((sessionId: string) => sessionIds.has(sessionId), [sessionIds]);
  const hasDirectory = useCallback(
    (directory: string) => directoryIds.has(skiaBoardDirectoryId(directory)),
    [directoryIds]
  );
  const hasFile = useCallback(
    (rootDir: string, path: string) => fileIds.has(skiaBoardFileId(rootDir, path)),
    [fileIds]
  );

  const value = useMemo<SkiaBoardContextValue>(() => ({
    state,
    loaded,
    addSession,
    removeSession,
    hasSession,
    addDirectory,
    removeDirectory,
    hasDirectory,
    addFile,
    removeFile,
    markFileUnavailable,
    renameFile,
    hasFile,
    updateCardAppearance,
    moveCard,
    addSection,
    updateSection,
    removeSection,
    tidyCards,
    setCardTextScale,
  }), [
    addDirectory,
    addFile,
    addSession,
    hasDirectory,
    hasFile,
    hasSession,
    loaded,
    markFileUnavailable,
    renameFile,
    moveCard,
    addSection,
    updateSection,
    removeSection,
    removeDirectory,
    removeFile,
    removeSession,
    state,
    updateCardAppearance,
    setCardTextScale,
    tidyCards,
  ]);

  return <SkiaBoardContext.Provider value={value}>{children}</SkiaBoardContext.Provider>;
}

export function useSkiaBoard() {
  const context = useContext(SkiaBoardContext);
  if (!context) throw new Error("useSkiaBoard must be used within SkiaBoardProvider");
  return context;
}
