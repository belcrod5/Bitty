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
// - ライブrelay observerが生存しているセッションは対象外: observer自身がready遷移で
//   lastRelaySeqからのrelay/resumeを送り、サーバーが差分再送する(第一経路)。
//   resume_miss / relay_closed のときだけ従来のJSONL再同期(#40経路)にフォールバックする。
// - 対象は選択セッション+可視パネル群(ポップアップ・応答中・バックグラウンド移行時点で
//   応答中だったセッション)(G3)。
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

  const runResumeSyncPass = useCallback(async (reason: string, generation: number) => {
    const inputs = inputsRef.current;
    if (!inputs.settingsLoaded) return;
    if (!inputs.codexWsUrl.trim()) return;
    // チャット(会話)を表示できるボード画面のみ再同期する。
    if (inputs.activeScreen !== "mini_board" && inputs.activeScreen !== "skia_board") return;
    const now = Date.now();
    pruneRespondingAtBackground(now);
    const selectedSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || llmConversationSessionIdRef.current
    );
    const plan = planResumeSyncTargets({
      selectedSessionId,
      observerThreadId: parseOptionalSessionId(codexRelayObserverRef.current?.threadId),
      popupPanelId: inputs.drawerSessionPopupPanelId,
      panelEntries: collectPanelEntries(),
      respondingSessionIds: Object.keys(respondingAtBackgroundAtMsBySessionIdRef.current),
    });
    logSessionDiag("resume_sync_run", {
      reason,
      generation,
      selectedSessionId: selectedSessionId || undefined,
      targets: plan.targets.map((target) => (
        target.kind === "selected"
          ? { kind: target.kind, sessionId: target.sessionId }
          : { kind: target.kind, sessionId: target.sessionId, panelId: target.panelId }
      )),
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
      if (target.kind === "selected") {
        if (!startupSessionRestoreAttemptedRef.current) {
          // 起動時リストアが未完了の間は useSessionStartupRecoveryController が
          // ready遷移ごとの復元を担うため、二重restoreを避ける。
          continue;
        }
        if (llmSessionRestoreInFlightRef.current || llmSessionRestoreLoadingRef.current) {
          scheduleRestoreBusyRetry(reason, generation);
          continue;
        }
        if (!resyncRateLimiter.canResync(target.sessionId, now)) {
          logSessionDiag("resume_sync_rate_limited", {
            reason,
            generation,
            sessionId: target.sessionId,
            kind: target.kind,
          }, { throttleMs: 0, throttleKey: `resume_sync_rate_limited:${target.sessionId}` });
          continue;
        }
        resyncRateLimiter.recordResync(target.sessionId, now);
        consumeRespondingAtBackground(target.sessionId);
        work.push(
          selectSpecificLlmSession(target.sessionId, {
            source: "all",
            directory,
            preserveLiveObserver: true,
          }).then((restored) => {
            logSessionDiag("resume_sync_selected_done", {
              reason,
              generation,
              sessionId: target.sessionId,
              restored,
            }, { throttleMs: 0, throttleKey: `resume_sync_selected_done:${target.sessionId}` });
          }).catch((error) => {
            logSessionDiag("resume_sync_selected_failed", {
              reason,
              generation,
              sessionId: target.sessionId,
              message: error instanceof Error ? error.message : String(error),
            }, { throttleMs: 0, throttleKey: `resume_sync_selected_failed:${target.sessionId}` });
          })
        );
        continue;
      }
      if (!resyncRateLimiter.canResync(target.sessionId, now)) {
        logSessionDiag("resume_sync_rate_limited", {
          reason,
          generation,
          sessionId: target.sessionId,
          panelId: target.panelId,
          kind: target.kind,
        }, { throttleMs: 0, throttleKey: `resume_sync_rate_limited:${target.sessionId}` });
        continue;
      }
      resyncRateLimiter.recordResync(target.sessionId, now);
      consumeRespondingAtBackground(target.sessionId);
      work.push(
        hydratePanelFromSessionHistoryRef.current({
          panelId: target.panelId,
          sessionId: target.sessionId,
          directory: target.directory,
          diagnosticCycleId: `resume-sync-${generation}-${now.toString(36)}`,
        }).then((result) => {
          logSessionDiag("resume_sync_panel_done", {
            reason,
            generation,
            sessionId: target.sessionId,
            panelId: target.panelId,
            result,
          }, { throttleMs: 0, throttleKey: `resume_sync_panel_done:${target.sessionId}:${target.panelId}` });
        }).catch((error) => {
          logSessionDiag("resume_sync_panel_failed", {
            reason,
            generation,
            sessionId: target.sessionId,
            panelId: target.panelId,
            message: error instanceof Error ? error.message : String(error),
          }, { throttleMs: 0, throttleKey: `resume_sync_panel_failed:${target.sessionId}:${target.panelId}` });
        })
      );
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
    hydratePanelFromSessionHistoryRef,
    llmConversationSessionIdRef,
    llmSessionRestoreInFlightRef,
    llmSessionRestoreLoadingRef,
    logSessionDiag,
    normalizedLlmDirectoryForRequest,
    pruneRespondingAtBackground,
    replyLoadingRef,
    resyncRateLimiter,
    scheduleRestoreBusyRetry,
    selectSpecificLlmSession,
    selectedLlmSessionIdRef,
    startupSessionRestoreAttemptedRef,
    streamSocketRef,
    streamTtsControlRef,
  ]);

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
        void runCoalescedSync(queued.reason, queued.generation);
      }
    }
  }, [runResumeSyncPass]);

  const scheduleSync = useCallback((reason: string, generation: number, opts?: { immediate?: boolean }) => {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (opts?.immediate === true) {
      void runCoalescedSync(reason, generation);
      return;
    }
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      void runCoalescedSync(reason, generation);
    }, READY_RESUME_SYNC_DEBOUNCE_MS);
  }, [runCoalescedSync]);
  scheduleSyncRef.current = scheduleSync;

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
      scheduleSync("runner_ws_ready", snapshot.generation);
    };
    const unsubscribe = runnerWebSocketManager.subscribeSnapshot(handleSnapshot);
    handleSnapshot();
    return () => {
      unsubscribe();
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      if (restoreBusyRetryTimerRef.current) {
        clearTimeout(restoreBusyRetryTimerRef.current);
        restoreBusyRetryTimerRef.current = null;
      }
    };
  }, [runnerWebSocketManager, scheduleSync]);

  // 単一セッションの再同期要求(遅延live適用のidle解決=G2などから呼ばれる)。
  // グローバルレート制御を通し、observerが生きているセッションはライブ経路に任せる。
  const requestSessionResync = useCallback((sessionIdRaw: unknown, opts: { panelId?: string; reason: string }) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return false;
    const reason = String(opts?.reason || "session_resync").trim() || "session_resync";
    const observerThreadId = parseOptionalSessionId(codexRelayObserverRef.current?.threadId);
    if (observerThreadId && observerThreadId === sessionId) return false;
    const now = Date.now();
    if (!resyncRateLimiter.canResync(sessionId, now)) {
      logSessionDiag("session_resync_request_rate_limited", {
        sessionId,
        reason,
      }, { throttleMs: 0, throttleKey: `session_resync_request_rate_limited:${sessionId}` });
      return false;
    }
    const panelId = String(opts?.panelId || "").trim();
    const selectedSessionId = parseOptionalSessionId(
      selectedLlmSessionIdRef.current || llmConversationSessionIdRef.current
    );
    if (!panelId && sessionId === selectedSessionId) {
      if (llmSessionRestoreInFlightRef.current || llmSessionRestoreLoadingRef.current) return false;
      resyncRateLimiter.recordResync(sessionId, now);
      consumeRespondingAtBackground(sessionId);
      logSessionDiag("session_resync_requested", {
        sessionId,
        reason,
        scope: "selected",
      }, { throttleMs: 0, throttleKey: `session_resync_requested:${sessionId}:${reason}` });
      void selectSpecificLlmSession(sessionId, {
        source: "all",
        directory: normalizedLlmDirectoryForRequest(),
        preserveLiveObserver: true,
      }).catch(() => {});
      return true;
    }
    const panelEntries = collectPanelEntries().filter((entry) => (
      entry.sessionId === sessionId &&
      (!panelId || entry.panelId === panelId) &&
      Boolean(entry.directory)
    ));
    if (panelEntries.length === 0) return false;
    resyncRateLimiter.recordResync(sessionId, now);
    consumeRespondingAtBackground(sessionId);
    logSessionDiag("session_resync_requested", {
      sessionId,
      reason,
      scope: "panel",
      panelIds: panelEntries.map((entry) => entry.panelId),
    }, { throttleMs: 0, throttleKey: `session_resync_requested:${sessionId}:${reason}` });
    for (const entry of panelEntries) {
      void hydratePanelFromSessionHistoryRef.current({
        panelId: entry.panelId,
        sessionId,
        directory: entry.directory,
        diagnosticCycleId: `session-resync-${now.toString(36)}`,
      }).catch(() => {});
    }
    return true;
  }, [
    codexRelayObserverRef,
    collectPanelEntries,
    consumeRespondingAtBackground,
    hydratePanelFromSessionHistoryRef,
    llmConversationSessionIdRef,
    llmSessionRestoreInFlightRef,
    llmSessionRestoreLoadingRef,
    logSessionDiag,
    normalizedLlmDirectoryForRequest,
    resyncRateLimiter,
    selectSpecificLlmSession,
    selectedLlmSessionIdRef,
  ]);

  return {
    requestSessionResync,
    wasRespondingAtBackground,
  };
}
