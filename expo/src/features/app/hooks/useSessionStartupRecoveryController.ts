import { useEffect, useRef, useSyncExternalStore, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type {
  ConversationMessage,
  SelectSpecificLlmSessionOptions,
} from "../types/appTypes";

type UseSessionStartupRecoveryControllerArgs = {
  settingsLoaded: boolean;
  runnerWebSocketManager: RunnerWebSocketManager;
  startupSessionRestoreAttemptedRef: MutableRefObject<boolean>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  codexWsUrl: string;
  normalizedLlmDirectoryForRequest: () => string;
  parseOptionalSessionId: (raw: unknown) => string;
  selectedLlmSessionId: string;
  getLlmConversationSessionId: () => string;
  selectSpecificLlmSession: (
    nextSessionIdRaw: unknown,
    opts?: SelectSpecificLlmSessionOptions
  ) => Promise<boolean>;
  fetchLatestSessionForDirectory: (
    directoryRaw?: unknown
  ) => Promise<{ sessionId: string; backendId: string } | null>;
  setLlmSessionRestoreError: Dispatch<SetStateAction<string>>;
};

// 起動時のセッション復元のみを担う。フォアグラウンド復帰・WS再接続時の再同期は
// useReadyDrivenResumeSyncController(ready遷移駆動の一元再同期)が担う。
export function useSessionStartupRecoveryController({
  settingsLoaded,
  runnerWebSocketManager,
  startupSessionRestoreAttemptedRef,
  conversationMessagesRef,
  codexWsUrl,
  normalizedLlmDirectoryForRequest,
  parseOptionalSessionId,
  selectedLlmSessionId,
  getLlmConversationSessionId,
  selectSpecificLlmSession,
  fetchLatestSessionForDirectory,
  setLlmSessionRestoreError,
}: UseSessionStartupRecoveryControllerArgs) {
  // The session restore data rides the runner WebSocket (thread/read) and the
  // authenticated runner HTTP endpoints, so it shares the WS bootstrap barrier:
  // it runs once the connection is ready and re-runs on each later ready
  // transition until one restore pass succeeds (no polling, no free retries).
  const runnerWsConnectionState = useSyncExternalStore(
    runnerWebSocketManager.subscribeSnapshot,
    () => runnerWebSocketManager.getSnapshot().connectionState,
    () => runnerWebSocketManager.getSnapshot().connectionState
  );
  const runnerWsReady = runnerWsConnectionState === "ready";
  const startupSessionRestoreInFlightRef = useRef(false);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (startupSessionRestoreAttemptedRef.current) return;
    if (conversationMessagesRef.current.length > 0) {
      startupSessionRestoreAttemptedRef.current = true;
      return;
    }
    if (!codexWsUrl.trim()) return;
    if (!runnerWsReady) return;
    if (startupSessionRestoreInFlightRef.current) return;
    startupSessionRestoreInFlightRef.current = true;
    const directory = normalizedLlmDirectoryForRequest();
    const preferredSessionId = parseOptionalSessionId(selectedLlmSessionId || getLlmConversationSessionId());
    void (async () => {
      let restored = false;
      if (preferredSessionId) {
        restored = await selectSpecificLlmSession(preferredSessionId, {
          source: "all",
          directory,
        });
      }
      if (!restored) {
        // all-backends一覧の最新セッションはCodexとは限らない。identityの
        // backendIdを明示しないと非Codexセッションの復元が失敗し続ける。
        const latest = await fetchLatestSessionForDirectory(directory);
        if (latest && latest.sessionId !== preferredSessionId) {
          restored = await selectSpecificLlmSession(latest.sessionId, {
            backendId: latest.backendId,
            source: "all",
            directory,
          });
        }
      }
      // A false restore is not proof the session is gone: selectSpecificLlmSession
      // resolves false for deduped concurrent restores, lost latest-request races,
      // and runner errors alike. Keep the selected session so the next ready
      // transition retries it; if it truly no longer exists, the latest-session
      // fallback above replaces the selection once it succeeds.
      if (restored) {
        startupSessionRestoreAttemptedRef.current = true;
      }
    })().catch((err) => {
      setLlmSessionRestoreError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      startupSessionRestoreInFlightRef.current = false;
    });
  }, [
    codexWsUrl,
    runnerWsReady,
    conversationMessagesRef,
    fetchLatestSessionForDirectory,
    getLlmConversationSessionId,
    normalizedLlmDirectoryForRequest,
    parseOptionalSessionId,
    selectSpecificLlmSession,
    selectedLlmSessionId,
    setLlmSessionRestoreError,
    settingsLoaded,
    startupSessionRestoreAttemptedRef,
  ]);
}
