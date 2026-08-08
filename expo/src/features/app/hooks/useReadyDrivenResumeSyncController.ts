import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { AppState } from "react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { parseOptionalSessionId } from "../utils/llmSession";
import {
  planResumeSyncTargets,
  shouldHandleReadyTransition,
  type ResumeSyncPanelEntry,
  type ResyncRateLimiter,
} from "../utils/resumeSync";
import type {
  AppScreen,
  SelectSpecificLlmSessionOptions,
  StreamTtsControlState,
} from "../types/appTypes";
import type { PanelRuntimeEntry } from "./usePanelNewSessionController";

// ready遷移後、複数ready通知(再接続フラップ)を1回の再同期にまとめる待ち時間。
const READY_RESUME_SYNC_DEBOUNCE_MS = 250;
// 選択セッションのrestoreが実行中(llmSessionRestoreInFlight/Loading)のときの再試行間隔と上限。
// 旧実装は復帰時にrestore中だと恒久スキップだった(G4)。上限付き再試行で取りこぼしを防ぎつつ、
// restoreスタック時に再取得ループへ落ちないようにする。
const RESUME_SYNC_RESTORE_BUSY_RETRY_MS = 2000;
const RESUME_SYNC_MAX_RESTORE_BUSY_RETRIES = 3;
// バックグラウンド移行時点で応答中だったセッションの記録の有効期限。
const RESPONDING_AT_BACKGROUND_TTL_MS = 15 * 60_000;
// requestSessionResync(G2の完了レース窓クローズ等)がレート制御・restore中に阻まれた場合の
// one-shot遅延リトライの上限と余裕時間。取りこぼし禁止の再同期を、limiter解除時刻まで持ち越す。
const SESSION_RESYNC_RETRY_MAX_ATTEMPTS = 3;
const SESSION_RESYNC_RETRY_SLACK_MS = 50;

type LogSessionDiag = (
  event: string,
  payload?: Record<string, unknown>,
  options?: {
    detailed?: boolean;
    throttleMs?: number;
    throttleKey?: string;
  }
) => void;

type UseReadyDrivenResumeSyncControllerArgs = {
  settingsLoaded: boolean;
  activeScreen: AppScreen;
  codexWsUrl: string;
  drawerSessionPopupPanelId: string;
  runnerWebSocketManager: RunnerWebSocketManager;
  resyncRateLimiter: ResyncRateLimiter;
  codexRelayObserverRef: MutableRefObject<{ threadId: string; panelId?: string; close: () => void } | null>;
  panelRuntimeEntriesByIdRef: MutableRefObject<Record<string, PanelRuntimeEntry>>;
  selectedLlmSessionIdRef: MutableRefObject<string>;
  llmConversationSessionIdRef: MutableRefObject<string>;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  llmSessionRestoreInFlightRef: MutableRefObject<boolean>;
  llmSessionRestoreLoadingRef: MutableRefObject<boolean>;
  startupSessionRestoreAttemptedRef: MutableRefObject<boolean>;
  normalizedLlmDirectoryForRequest: () => string;
  // このクライアントのreply request(turn.tsのHTTP/relayターン)がin-flight
  // (lifecycle=active/suspended)なセッションか。ready駆動再同期のパネルスキップ判定に使う。
  hasActiveClientTurnForSession: (sessionId: string) => boolean;
  selectSpecificLlmSession: (
    nextSessionIdRaw: unknown,
    opts?: SelectSpecificLlmSessionOptions
  ) => Promise<boolean>;
  hydratePanelFromSessionHistoryRef: MutableRefObject<(params: {
    panelId: string;
    sessionId: string;
    directory: string;
    diagnosticCycleId?: string;
  }) => Promise<"applied" | "superseded" | "failed">>;
  fetchLatestSessionIdForDirectory: (directoryRaw?: unknown) => Promise<string>;
  logSessionDiag: LogSessionDiag;
};

// バックグラウンド復帰・runner WS再接続時の一元再同期コントローラ。
//
// トリガーは AppState "active" の瞬間ではなく runner WS の ready遷移(接続generation変化)。
// これにより「WS ready前のHTTP再取得がライブ配信路(relay observer)を壊す」(G1)と
// 「activeの一発勝負+live meta 150ms猶予レース」(G4)を構造的に排除する。
//
// - ライブ配信路が生きているセッションは対象外:
//   - relay observerが生存するセッションはobserver自身がready遷移でlastRelaySeqから
//     relay/resumeを送り、サーバーが差分再送する(第一経路)。
//   - 選択セッションのin-flight turn(replyLoading)はturn.ts自身のws_reconnect_resume
//     (同じくseq resume)が無傷復旧する。ここで全文再取得+quiesceするとTTS切断・
//     ストリームUIリセットが毎フラップ発生してしまう。
//   いずれも resume_miss / relay_closed のときだけ従来のJSONL再同期(#40経路)に
//   フォールバックする。
// - 対象は選択セッション+可視パネル群(ポップアップ・応答中・バックグラウンド移行時点で
//   応答中だったセッション)(G3)。同一セッションの全可視パネルへ反映する。
// - 全対象は共有のグローバルレート制御(resyncRateLimiter)を通す(修正計画§4②)。
//   relay-loss回復(#40経路)も同じlimiterを共有するため、経路間の二重再同期も抑止される(§4③)。
export function useReadyDrivenResumeSyncController({
  settingsLoaded,
  activeScreen,
  codexWsUrl,
  drawerSessionPopupPanelId,
  runnerWebSocketManager,
  resyncRateLimiter,
  codexRelayObserverRef,
  panelRuntimeEntriesByIdRef,
  selectedLlmSessionIdRef,
  llmConversationSessionIdRef,
  replyLoadingRef,
  streamSocketRef,
  streamTtsControlRef,
  llmSessionRestoreInFlightRef,
  llmSessionRestoreLoadingRef,
  startupSessionRestoreAttemptedRef,
  normalizedLlmDirectoryForRequest,
  hasActiveClientTurnForSession,
  selectSpecificLlmSession,
  hydratePanelFromSessionHistoryRef,
  fetchLatestSessionIdForDirectory,
  logSessionDiag,
}: UseReadyDrivenResumeSyncControllerArgs) {
  // 購読コールバック(React外)から最新値を読むためのref群。
  const inputsRef = useRef({ settingsLoaded, activeScreen, codexWsUrl, drawerSessionPopupPanelId });
  useEffect(() => {
    inputsRef.current = { settingsLoaded, activeScreen, codexWsUrl, drawerSessionPopupPanelId };
  }, [settingsLoaded, activeScreen, codexWsUrl, drawerSessionPopupPanelId]);

  const respondingAtBackgroundAtMsBySessionIdRef = useRef<Record<string, number>>({});
  const lastHandledGenerationRef = useRef<number>(Number.NaN);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreBusyRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreBusyRetryCountRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const queuedSyncRef = useRef<{ reason: string; generation: number } | null>(null);
  const sessionResyncRetryTimerBySessionIdRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const collectPanelEntries = useCallback((): ResumeSyncPanelEntry[] => (
    Object.entries(panelRuntimeEntriesByIdRef.current || {}).map(([panelId, entry]) => ({
      panelId,
      sessionId: parseOptionalSessionId(entry?.snapshot?.selectedSessionId || entry?.sessionId),
      directory: String(entry?.snapshot?.selectedDirectoryPath || "").trim(),
      isResponding: entry?.snapshot?.isResponding === true,
    }))
  ), [panelRuntimeEntriesByIdRef]);

  const pruneRespondingAtBackground = useCallback((nowMs: number) => {
    for (const [sessionId, atMs] of Object.entries(respondingAtBackgroundAtMsBySessionIdRef.current)) {
      if (nowMs - atMs > RESPONDING_AT_BACKGROUND_TTL_MS) {
        delete respondingAtBackgroundAtMsBySessionIdRef.current[sessionId];
      }
    }
  }, []);

  const wasRespondingAtBackground = useCallback((sessionIdRaw: unknown) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return false;
    const atMs = respondingAtBackgroundAtMsBySessionIdRef.current[sessionId] || 0;
    return atMs > 0 && Date.now() - atMs <= RESPONDING_AT_BACKGROUND_TTL_MS;
  }, []);

  const consumeRespondingAtBackground = useCallback((sessionIdRaw: unknown) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return;
    delete respondingAtBackgroundAtMsBySessionIdRef.current[sessionId];
  }, []);

  // 「あとで再同期が必要」なセッションとして登録する(バックグラウンド応答中マーカーと同じ扱い)。
  // observer強奪(別セッションのrestoreがrunningでobserverを奪った)時の補償にも使う:
  // clean closeされたセッションはresume_missを出せないため、ここに積んで次のready遷移・
  // 遅延live適用の再取得判定で拾う。
  const markSessionRespondingForResync = useCallback((sessionIdRaw: unknown) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return;
    respondingAtBackgroundAtMsBySessionIdRef.current[sessionId] = Date.now();
  }, []);

  // バックグラウンド移行時点で応答中(ストリーミング中)だったセッションを記録する。
  // 復帰後の再同期対象(G3)と、遅延live適用がidle解決したときの再取得判定(G2)に使う。
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "background" && nextState !== "inactive") return;
      const now = Date.now();
      const record = (sessionIdRaw: unknown) => {
        const sessionId = parseOptionalSessionId(sessionIdRaw);
        if (sessionId) respondingAtBackgroundAtMsBySessionIdRef.current[sessionId] = now;
      };
      if (replyLoadingRef.current) {
        record(selectedLlmSessionIdRef.current || llmConversationSessionIdRef.current);
      }
      record(codexRelayObserverRef.current?.threadId);
      for (const entry of collectPanelEntries()) {
        if (entry.isResponding) record(entry.sessionId);
      }
    });
    return () => {
      sub.remove();
    };
  }, [
    codexRelayObserverRef,
    collectPanelEntries,
    llmConversationSessionIdRef,
    replyLoadingRef,
    selectedLlmSessionIdRef,
  ]);

  const scheduleSyncRef = useRef<(reason: string, generation: number, opts?: { immediate?: boolean }) => void>(() => {});

  const scheduleRestoreBusyRetry = useCallback((reason: string, generation: number) => {
    if (restoreBusyRetryCountRef.current >= RESUME_SYNC_MAX_RESTORE_BUSY_RETRIES) {
      logSessionDiag("resume_sync_restore_busy_gave_up", {
        reason,
        generation,
        retries: restoreBusyRetryCountRef.current,
      }, { throttleMs: 0, throttleKey: `resume_sync_restore_busy_gave_up:${generation}` });
      return;
    }
    if (restoreBusyRetryTimerRef.current) return;
    restoreBusyRetryCountRef.current += 1;
    logSessionDiag("resume_sync_restore_busy_deferred", {
      reason,
      generation,
      attempt: restoreBusyRetryCountRef.current,
    }, { throttleMs: 0, throttleKey: `resume_sync_restore_busy_deferred:${generation}:${restoreBusyRetryCountRef.current}` });
    restoreBusyRetryTimerRef.current = setTimeout(() => {
      restoreBusyRetryTimerRef.current = null;
      scheduleSyncRef.current(`${reason}_retry`, generation, { immediate: true });
    }, RESUME_SYNC_RESTORE_BUSY_RETRY_MS);
  }, [logSessionDiag]);

  const resyncSelectedSession = useCallback((sessionId: string, directory: string, logContext: Record<string, unknown>) => (
    selectSpecificLlmSession(sessionId, {
      source: "all",
      directory,
      preserveLiveObserver: true,
    }).then((restored) => {
      logSessionDiag("resume_sync_selected_done", {
        ...logContext,
        sessionId,
        restored,
      }, { throttleMs: 0, throttleKey: `resume_sync_selected_done:${sessionId}` });
    }).catch((error) => {
      logSessionDiag("resume_sync_selected_failed", {
        ...logContext,
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      }, { throttleMs: 0, throttleKey: `resume_sync_selected_failed:${sessionId}` });
    })
  ), [logSessionDiag, selectSpecificLlmSession]);

  const resyncPanel = useCallback((
    sessionId: string,
    panel: { panelId: string; directory: string },
    diagnosticCycleId: string,
    logContext: Record<string, unknown>
  ) => (
    hydratePanelFromSessionHistoryRef.current({
      panelId: panel.panelId,
      sessionId,
      directory: panel.directory,
      diagnosticCycleId,
    }).then((result) => {
      logSessionDiag("resume_sync_panel_done", {
        ...logContext,
        sessionId,
        panelId: panel.panelId,
        result,
      }, { throttleMs: 0, throttleKey: `resume_sync_panel_done:${sessionId}:${panel.panelId}` });
    }).catch((error) => {
      logSessionDiag("resume_sync_panel_failed", {
        ...logContext,
        sessionId,
        panelId: panel.panelId,
        message: error instanceof Error ? error.message : String(error),
      }, { throttleMs: 0, throttleKey: `resume_sync_panel_failed:${sessionId}:${panel.panelId}` });
    })
  ), [hydratePanelFromSessionHistoryRef, logSessionDiag]);

  const runResumeSyncPass = useCallback(async (reason: string, generation: number) => {
    const inputs = inputsRef.current;
    if (!inputs.settingsLoaded) return;
    if (!inputs.codexWsUrl.trim()) return;
    // チャット(会話)を表示できるボード画面のみ再同期する。
    if (inputs.activeScreen !== "skia_board") return;
    const now = Date.now();
    pruneRespondingAtBackground(now);
    const selectedSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || llmConversationSessionIdRef.current
    );
    const panelEntries = collectPanelEntries();
    // このクライアントのreply request(turn.ts)がin-flightなセッションのパネルは対象から
    // 外す(選択セッションのreplyLoadingスキップと同じ理屈)。ready遷移ではturn.ts自身の
    // ws_reconnect_resume(seq resume)がライブ復旧するため、ここでhydrateすると
    // ストリーミング中の表示を全文再取得で上書きしてしまう。スキップしたセッションの
    // respondingマーカー(G2)は消費しないので、turn完了後の回収経路は保たれる。
    const turnInFlightSessionIds = Array.from(new Set(
      panelEntries.map((entry) => entry.sessionId).filter(Boolean)
    )).filter((sessionId) => hasActiveClientTurnForSession(sessionId));
    const plan = planResumeSyncTargets({
      selectedSessionId,
      observerThreadId: parseOptionalSessionId(codexRelayObserverRef.current?.threadId),
      popupPanelId: inputs.drawerSessionPopupPanelId,
      panelEntries,
      respondingSessionIds: Object.keys(respondingAtBackgroundAtMsBySessionIdRef.current),
      turnInFlightSessionIds,
    });
    logSessionDiag("resume_sync_run", {
      reason,
      generation,
      selectedSessionId: selectedSessionId || undefined,
      targets: plan.targets.map((target) => ({
        sessionId: target.sessionId,
        selected: target.selected,
        panelIds: target.panels.map((panel) => panel.panelId),
      })),
      skipped: plan.skipped,
    }, { throttleMs: 0, throttleKey: `resume_sync_run:${generation}:${reason}` });
    // observerが生きているセッションはライブ経路(seq resume)が回復を担う。
    // ここで再同期済みマークだけ消費しておく。
    for (const skip of plan.skipped) {
      if (skip.reason === "live_observer") consumeRespondingAtBackground(skip.sessionId);
    }
    const directory = normalizedLlmDirectoryForRequest();
    const work: Promise<unknown>[] = [];
    for (const target of plan.targets) {
      if (target.selected) {
        // in-flight turn(replyLoading)が生きている間はturn.ts自身のseq resumeが
        // ライブ復旧を担う。ここで全文再取得+quiesceするとストリームUI・TTSを壊す(High-2)。
        // 失敗時は resume_miss → relay-loss回復(#40)が同じlimiter経由で再同期する。
        if (replyLoadingRef.current) {
          logSessionDiag("resume_sync_skipped_turn_in_flight", {
            reason,
            generation,
            sessionId: target.sessionId,
          }, { throttleMs: 0, throttleKey: `resume_sync_skipped_turn_in_flight:${target.sessionId}` });
          continue;
        }
        if (!startupSessionRestoreAttemptedRef.current) {
          // 起動時リストアが未完了の間は useSessionStartupRecoveryController が
          // ready遷移ごとの復元を担うため、二重restoreを避ける。
          continue;
        }
        if (llmSessionRestoreInFlightRef.current || llmSessionRestoreLoadingRef.current) {
          scheduleRestoreBusyRetry(reason, generation);
          continue;
        }
      }
      if (!resyncRateLimiter.canResync(target.sessionId, now)) {
        logSessionDiag("resume_sync_rate_limited", {
          reason,
          generation,
          sessionId: target.sessionId,
          selected: target.selected,
          panelIds: target.panels.map((panel) => panel.panelId),
        }, { throttleMs: 0, throttleKey: `resume_sync_rate_limited:${target.sessionId}` });
        continue;
      }
      resyncRateLimiter.recordResync(target.sessionId, now);
      consumeRespondingAtBackground(target.sessionId);
      const logContext = { reason, generation };
      if (target.selected) {
        work.push(resyncSelectedSession(target.sessionId, directory, logContext));
      }
      const diagnosticCycleId = `resume-sync-${generation}-${now.toString(36)}`;
      for (const panel of target.panels) {
        work.push(resyncPanel(target.sessionId, panel, diagnosticCycleId, logContext));
      }
    }
    // 選択セッションが無い場合は最新セッションへフォールバック(旧resume経路の互換)。
    if (
      !selectedSessionId &&
      startupSessionRestoreAttemptedRef.current &&
      !replyLoadingRef.current &&
      streamSocketRef.current === null &&
      streamTtsControlRef.current === null &&
      !llmSessionRestoreInFlightRef.current &&
      !llmSessionRestoreLoadingRef.current
    ) {
      work.push((async () => {
        const latestSessionId = await fetchLatestSessionIdForDirectory(directory);
        if (!latestSessionId) return;
        if (!resyncRateLimiter.canResync(latestSessionId)) return;
        resyncRateLimiter.recordResync(latestSessionId);
        const restored = await selectSpecificLlmSession(latestSessionId, {
          source: "all",
          directory,
        });
        logSessionDiag("resume_sync_latest_session_done", {
          reason,
          generation,
          latestSessionId,
          restored,
        }, { throttleMs: 0, throttleKey: `resume_sync_latest_session_done:${latestSessionId}` });
      })().catch((error) => {
        logSessionDiag("resume_sync_latest_session_failed", {
          reason,
          generation,
          message: error instanceof Error ? error.message : String(error),
        }, { throttleMs: 0, throttleKey: "resume_sync_latest_session_failed" });
      }));
    }
    await Promise.all(work);
  }, [
    codexRelayObserverRef,
    collectPanelEntries,
    consumeRespondingAtBackground,
    fetchLatestSessionIdForDirectory,
    hasActiveClientTurnForSession,
    llmConversationSessionIdRef,
    llmSessionRestoreInFlightRef,
    llmSessionRestoreLoadingRef,
    logSessionDiag,
    normalizedLlmDirectoryForRequest,
    pruneRespondingAtBackground,
    replyLoadingRef,
    resyncPanel,
    resyncRateLimiter,
    resyncSelectedSession,
    scheduleRestoreBusyRetry,
    selectSpecificLlmSession,
    selectedLlmSessionIdRef,
    startupSessionRestoreAttemptedRef,
    streamSocketRef,
    streamTtsControlRef,
  ]);

  // タイマー(debounce・各種リトライ)から呼ぶ処理は必ずrefを経由する。
  // runResumeSyncPassの依存には毎レンダー新規生成の関数(selectSpecificLlmSession等)が
  // 含まれるため、直接closureで持つとeffect/タイマーの生存がレンダー頻度に依存してしまう。
  const runCoalescedSyncRef = useRef<(reason: string, generation: number) => Promise<void>>(async () => {});
  const runCoalescedSync = useCallback(async (reason: string, generation: number) => {
    if (syncInFlightRef.current) {
      queuedSyncRef.current = { reason, generation };
      return;
    }
    syncInFlightRef.current = true;
    try {
      await runResumeSyncPass(reason, generation);
    } finally {
      syncInFlightRef.current = false;
      const queued = queuedSyncRef.current;
      queuedSyncRef.current = null;
      if (queued) {
        void runCoalescedSyncRef.current(queued.reason, queued.generation);
      }
    }
  }, [runResumeSyncPass]);
  runCoalescedSyncRef.current = runCoalescedSync;

  // 依存なし(ref経由)で恒久安定。timer callbackも常に最新のrunCoalescedSyncを呼ぶ。
  const scheduleSync = useCallback((reason: string, generation: number, opts?: { immediate?: boolean }) => {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (opts?.immediate === true) {
      void runCoalescedSyncRef.current(reason, generation);
      return;
    }
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      void runCoalescedSyncRef.current(reason, generation);
    }, READY_RESUME_SYNC_DEBOUNCE_MS);
  }, []);
  scheduleSyncRef.current = scheduleSync;

  // 購読effectの依存はmanagerのみ。ready遷移直後は必ず再レンダーが起きるため、
  // ここに毎レンダー変わる関数を依存で持つとcleanupがdebounce/リトライタイマーを
  // 破棄してしまい、ready駆動再同期が実機でほぼ発火しなくなる(generationは消費済みで
  // 再スケジュールされない)。タイマーの生存はレンダー頻度に依存させない。
  useEffect(() => {
    const handleSnapshot = () => {
      const snapshot = runnerWebSocketManager.getSnapshot();
      if (!shouldHandleReadyTransition({
        connectionState: snapshot.connectionState,
        generation: snapshot.generation,
        lastHandledGeneration: lastHandledGenerationRef.current,
      })) return;
      lastHandledGenerationRef.current = snapshot.generation;
      restoreBusyRetryCountRef.current = 0;
      if (restoreBusyRetryTimerRef.current) {
        clearTimeout(restoreBusyRetryTimerRef.current);
        restoreBusyRetryTimerRef.current = null;
      }
      scheduleSyncRef.current("runner_ws_ready", snapshot.generation);
    };
    const unsubscribe = runnerWebSocketManager.subscribeSnapshot(handleSnapshot);
    handleSnapshot();
    return () => {
      unsubscribe();
    };
  }, [runnerWebSocketManager]);

  // タイマー破棄はunmount時のみ(購読effectの再実行では破棄しない)。
  useEffect(() => () => {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (restoreBusyRetryTimerRef.current) {
      clearTimeout(restoreBusyRetryTimerRef.current);
      restoreBusyRetryTimerRef.current = null;
    }
    for (const [sessionId, timer] of Object.entries(sessionResyncRetryTimerBySessionIdRef.current)) {
      clearTimeout(timer);
      delete sessionResyncRetryTimerBySessionIdRef.current[sessionId];
    }
  }, []);

  // 単一セッションの再同期要求(遅延live適用のidle解決=G2などから呼ばれる)。
  // observerが生きているセッションはライブ経路に任せる。
  // レート制御・restore実行中に阻まれた場合は、解除時刻にone-shot遅延リトライを積む:
  // G2が閉じたい完了レース窓は「直前のresyncから数秒以内」に必ず起きるため、
  // 即時拒否だけだと恒常的にドロップしてしまう(High-1)。
  const requestSessionResyncRef = useRef<(sessionIdRaw: unknown, opts: {
    panelId?: string;
    reason: string;
    attempt?: number;
  }) => boolean>(() => false);
  const requestSessionResync = useCallback((sessionIdRaw: unknown, opts: {
    panelId?: string;
    reason: string;
    attempt?: number;
  }) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return false;
    const reason = String(opts?.reason || "session_resync").trim() || "session_resync";
    const attempt = Math.max(0, Math.floor(Number(opts?.attempt) || 0));
    const observerThreadId = parseOptionalSessionId(codexRelayObserverRef.current?.threadId);
    if (observerThreadId && observerThreadId === sessionId) return false;
    const now = Date.now();
    const scheduleRetry = (delayMs: number, blockedBy: string) => {
      if (attempt >= SESSION_RESYNC_RETRY_MAX_ATTEMPTS) {
        logSessionDiag("session_resync_request_gave_up", {
          sessionId,
          reason,
          blockedBy,
          attempt,
        }, { throttleMs: 0, throttleKey: `session_resync_request_gave_up:${sessionId}:${reason}` });
        return false;
      }
      if (sessionResyncRetryTimerBySessionIdRef.current[sessionId]) return false;
      const normalizedDelayMs = Math.max(SESSION_RESYNC_RETRY_SLACK_MS, Math.floor(delayMs) + SESSION_RESYNC_RETRY_SLACK_MS);
      logSessionDiag("session_resync_request_deferred", {
        sessionId,
        reason,
        blockedBy,
        attempt,
        delayMs: normalizedDelayMs,
      }, { throttleMs: 0, throttleKey: `session_resync_request_deferred:${sessionId}:${reason}:${attempt}` });
      sessionResyncRetryTimerBySessionIdRef.current[sessionId] = setTimeout(() => {
        delete sessionResyncRetryTimerBySessionIdRef.current[sessionId];
        requestSessionResyncRef.current(sessionId, {
          ...opts,
          attempt: attempt + 1,
        });
      }, normalizedDelayMs);
      return false;
    };
    if (!resyncRateLimiter.canResync(sessionId, now)) {
      const waitMs = resyncRateLimiter.msUntilAllowed(sessionId, now);
      if (!Number.isFinite(waitMs)) return false;
      return scheduleRetry(waitMs, "rate_limit");
    }
    const panelIdHint = String(opts?.panelId || "").trim();
    const selectedSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || llmConversationSessionIdRef.current
    );
    const isSelected = sessionId === selectedSessionId;
    // 同一セッションを表示する全可視パネルへ反映する(#40経路と同じ扱い)。
    const panelEntries = collectPanelEntries().filter((entry) => (
      entry.sessionId === sessionId && Boolean(entry.directory)
    ));
    if (isSelected && (llmSessionRestoreInFlightRef.current || llmSessionRestoreLoadingRef.current)) {
      return scheduleRetry(RESUME_SYNC_RESTORE_BUSY_RETRY_MS, "restore_busy");
    }
    if (!isSelected && panelEntries.length === 0) return false;
    resyncRateLimiter.recordResync(sessionId, now);
    consumeRespondingAtBackground(sessionId);
    logSessionDiag("session_resync_requested", {
      sessionId,
      reason,
      attempt,
      selected: isSelected,
      panelIdHint: panelIdHint || undefined,
      panelIds: panelEntries.map((entry) => entry.panelId),
    }, { throttleMs: 0, throttleKey: `session_resync_requested:${sessionId}:${reason}` });
    const logContext = { reason, source: "session_resync_request" };
    if (isSelected) {
      void resyncSelectedSession(sessionId, normalizedLlmDirectoryForRequest(), logContext);
    }
    const diagnosticCycleId = `session-resync-${now.toString(36)}`;
    for (const entry of panelEntries) {
      void resyncPanel(sessionId, { panelId: entry.panelId, directory: entry.directory }, diagnosticCycleId, logContext);
    }
    return true;
  }, [
    codexRelayObserverRef,
    collectPanelEntries,
    consumeRespondingAtBackground,
    llmConversationSessionIdRef,
    llmSessionRestoreInFlightRef,
    llmSessionRestoreLoadingRef,
    logSessionDiag,
    normalizedLlmDirectoryForRequest,
    resyncPanel,
    resyncRateLimiter,
    resyncSelectedSession,
    selectedLlmSessionIdRef,
  ]);
  requestSessionResyncRef.current = requestSessionResync;

  return {
    requestSessionResync,
    wasRespondingAtBackground,
    markSessionRespondingForResync,
  };
}
