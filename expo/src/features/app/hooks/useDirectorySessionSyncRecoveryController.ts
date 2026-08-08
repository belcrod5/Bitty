import { useEffect, useRef } from "react";
import type {
  DirectorySessionSyncReason,
  DirectorySessionSyncState,
} from "../types/directorySessions";
import { shouldHandleReadyTransition } from "../utils/resumeSync";

type RunnerWsSnapshotSource = {
  getSnapshot: () => { connectionState: string; generation: number };
  subscribeSnapshot: (handler: () => void) => () => void;
};

type UseDirectorySessionSyncRecoveryControllerArgs = {
  runnerWebSocketManager: RunnerWsSnapshotSource;
  directorySessionSync: DirectorySessionSyncState;
  ensureRegisteredDirectorySessions: (reason: DirectorySessionSyncReason) => Promise<void>;
  logSessionDiag: (
    event: string,
    payload: Record<string, unknown>,
    options?: { throttleMs?: number; throttleKey?: string }
  ) => void;
};

// 失敗確定したディレクトリ同期(error / partial_error)の自動回復コントローラ。
//
// 起動直後のensureはrunner WSのready前に走って全滅し得る(コールド起動では
// AppStateが"inactive"のためconnect()がrunner_ws_inactiveで即時rejectする)。
// 失敗ツリーはTTL固定されない(hasUsableTreeが偽)ため、再ensureさえ起きれば
// 失敗ディレクトリだけが再取得される。ここではその再ensure契機を保証する:
// - runner WSのready遷移(初回接続・再接続)で失敗が残っていれば即再試行
// - WS readyのまま失敗が確定した場合(サイクル途中でreadyになった等)は
//   少数回だけ遅延再試行(恒常的なサーバー障害での無限ループを防ぐ)
// ensureモードはTTL内の成功済みディレクトリをスキップするため、通信量削減の
// 意図(全量再取得の禁止)は保たれる。
const SETTLED_FAILURE_RETRY_MAX_ATTEMPTS = 2;
const SETTLED_FAILURE_RETRY_DELAY_MS = 4000;

function isFailedSyncPhase(phase: DirectorySessionSyncState["phase"]) {
  return phase === "error" || phase === "partial_error";
}

export function useDirectorySessionSyncRecoveryController({
  runnerWebSocketManager,
  directorySessionSync,
  ensureRegisteredDirectorySessions,
  logSessionDiag,
}: UseDirectorySessionSyncRecoveryControllerArgs) {
  const syncPhaseRef = useRef(directorySessionSync.phase);
  syncPhaseRef.current = directorySessionSync.phase;
  const ensureRef = useRef(ensureRegisteredDirectorySessions);
  ensureRef.current = ensureRegisteredDirectorySessions;
  const logSessionDiagRef = useRef(logSessionDiag);
  logSessionDiagRef.current = logSessionDiag;
  const lastHandledGenerationRef = useRef(Number.NaN);
  const settledRetryCountRef = useRef(0);
  const settledRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleSnapshot = () => {
      const snapshot = runnerWebSocketManager.getSnapshot();
      if (!shouldHandleReadyTransition({
        connectionState: snapshot.connectionState,
        generation: snapshot.generation,
        lastHandledGeneration: lastHandledGenerationRef.current,
      })) return;
      lastHandledGenerationRef.current = snapshot.generation;
      settledRetryCountRef.current = 0;
      if (!isFailedSyncPhase(syncPhaseRef.current)) return;
      logSessionDiagRef.current("directory_sync_retry_on_ws_ready", {
        phase: syncPhaseRef.current,
        generation: snapshot.generation,
      }, { throttleMs: 0 });
      void ensureRef.current("auth_recovery");
    };
    const unsubscribe = runnerWebSocketManager.subscribeSnapshot(handleSnapshot);
    handleSnapshot();
    return () => {
      unsubscribe();
    };
  }, [runnerWebSocketManager]);

  useEffect(() => {
    if (!isFailedSyncPhase(directorySessionSync.phase)) {
      if (directorySessionSync.phase === "complete") settledRetryCountRef.current = 0;
      return;
    }
    if (runnerWebSocketManager.getSnapshot().connectionState !== "ready") return;
    if (settledRetryCountRef.current >= SETTLED_FAILURE_RETRY_MAX_ATTEMPTS) return;
    settledRetryCountRef.current += 1;
    const attempt = settledRetryCountRef.current;
    settledRetryTimerRef.current = setTimeout(() => {
      settledRetryTimerRef.current = null;
      if (!isFailedSyncPhase(syncPhaseRef.current)) return;
      if (runnerWebSocketManager.getSnapshot().connectionState !== "ready") return;
      logSessionDiagRef.current("directory_sync_retry_after_settled_failure", {
        phase: syncPhaseRef.current,
        attempt,
      }, { throttleMs: 0 });
      void ensureRef.current("auth_recovery");
    }, SETTLED_FAILURE_RETRY_DELAY_MS);
    return () => {
      if (settledRetryTimerRef.current) {
        clearTimeout(settledRetryTimerRef.current);
        settledRetryTimerRef.current = null;
      }
    };
  }, [directorySessionSync.cycleId, directorySessionSync.phase, runnerWebSocketManager]);
}
