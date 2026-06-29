import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { AppState } from "react-native";
import type {
  AppScreen,
  ConversationMessage,
  LlmBackend,
  SelectSpecificLlmSessionOptions,
  StreamTtsControlState,
} from "../types/appTypes";

type UseSessionStartupRecoveryControllerArgs = {
  settingsLoaded: boolean;
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
  fetchLatestSessionIdForDirectory: (directoryRaw?: unknown) => Promise<string>;
  clearSelectedLlmSession: () => void;
  setLlmSessionRestoreError: Dispatch<SetStateAction<string>>;
  activeScreen: AppScreen;
  llmSessionRestoreLoading: boolean;
  replyLoadingRef: MutableRefObject<boolean>;
  streamSocketRef: MutableRefObject<WebSocket | null>;
  streamTtsControlRef: MutableRefObject<StreamTtsControlState | null>;
  appResumeSessionSyncInFlightRef: MutableRefObject<boolean>;
  appResumeSessionSyncLastAtRef: MutableRefObject<number>;
  setReplyDebug: Dispatch<SetStateAction<string>>;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: {
      detailed?: boolean;
      throttleMs?: number;
      throttleKey?: string;
    }
  ) => void;
  llmDirectory: string;
  llmBackend: LlmBackend;
  codexWsToken: string;
};

type ResumeLatestSessionOnActiveOptions = {
  reason?: string;
  forceCurrentSession?: boolean;
};

export function useSessionStartupRecoveryController({
  settingsLoaded,
  startupSessionRestoreAttemptedRef,
  conversationMessagesRef,
  codexWsUrl,
  normalizedLlmDirectoryForRequest,
  parseOptionalSessionId,
  selectedLlmSessionId,
  getLlmConversationSessionId,
  selectSpecificLlmSession,
  fetchLatestSessionIdForDirectory,
  clearSelectedLlmSession,
  setLlmSessionRestoreError,
  activeScreen,
  llmSessionRestoreLoading,
  replyLoadingRef,
  streamSocketRef,
  streamTtsControlRef,
  appResumeSessionSyncInFlightRef,
  appResumeSessionSyncLastAtRef,
  setReplyDebug,
  logSessionDiag,
  llmDirectory,
  llmBackend,
  codexWsToken,
}: UseSessionStartupRecoveryControllerArgs) {
  useEffect(() => {
    if (!settingsLoaded) return;
    if (startupSessionRestoreAttemptedRef.current) return;
    if (conversationMessagesRef.current.length > 0) {
      startupSessionRestoreAttemptedRef.current = true;
      return;
    }
    if (!codexWsUrl.trim()) return;
    startupSessionRestoreAttemptedRef.current = true;
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
        const latestSessionId = await fetchLatestSessionIdForDirectory(directory);
        if (latestSessionId && latestSessionId !== preferredSessionId) {
          restored = await selectSpecificLlmSession(latestSessionId, {
            source: "all",
            directory,
          });
        }
      }
      if (!restored && preferredSessionId) {
        clearSelectedLlmSession();
      }
    })().catch((err) => {
      setLlmSessionRestoreError(err instanceof Error ? err.message : String(err));
    });
  }, [
    codexWsUrl,
    conversationMessagesRef,
    fetchLatestSessionIdForDirectory,
    getLlmConversationSessionId,
    normalizedLlmDirectoryForRequest,
    parseOptionalSessionId,
    selectSpecificLlmSession,
    selectedLlmSessionId,
    setLlmSessionRestoreError,
    settingsLoaded,
    startupSessionRestoreAttemptedRef,
    clearSelectedLlmSession,
  ]);

  const resumeLatestSessionOnActive = useCallback(async (options?: ResumeLatestSessionOnActiveOptions) => {
    if (!settingsLoaded) return;
    if (activeScreen !== "mini_board") return;
    if (llmSessionRestoreLoading) return;
    if (appResumeSessionSyncInFlightRef.current) return;
    const now = Date.now();
    if (now - appResumeSessionSyncLastAtRef.current < 1500) return;
    if (!codexWsUrl.trim()) return;
    const reason = String(options?.reason || "app_active").trim() || "app_active";
    const forceCurrentSession = options?.forceCurrentSession === true;
    const directory = normalizedLlmDirectoryForRequest();
    const currentSessionId = parseOptionalSessionId(selectedLlmSessionId || getLlmConversationSessionId());
    appResumeSessionSyncInFlightRef.current = true;
    appResumeSessionSyncLastAtRef.current = now;
    try {
      if (forceCurrentSession && currentSessionId) {
        logSessionDiag("resume_current_session_sync_start", {
          reason,
          currentSessionId,
          directory,
          replyLoading: replyLoadingRef.current,
          hasStreamSocket: streamSocketRef.current !== null,
          streamTtsControlAlive: streamTtsControlRef.current !== null,
          messageCount: conversationMessagesRef.current.length,
        }, {
          throttleMs: 0,
          throttleKey: `resume_current_session_sync_start:${currentSessionId}:${now}`,
        });
        const restored = await selectSpecificLlmSession(currentSessionId, {
          source: "all",
          directory,
        });
        logSessionDiag("resume_current_session_sync_done", {
          reason,
          currentSessionId,
          directory,
          restored,
        }, {
          throttleMs: 0,
          throttleKey: `resume_current_session_sync_done:${currentSessionId}:${now}`,
        });
        if (restored) {
          setReplyDebug((prev) => (
            prev
              ? `${prev} | resume_current_session_synced`
              : "resume_current_session_synced"
          ));
        }
        return;
      }
      if (replyLoadingRef.current) return;
      if (streamTtsControlRef.current !== null || streamSocketRef.current !== null) return;
      const latestSessionId = await fetchLatestSessionIdForDirectory(directory);
      if (!latestSessionId) return;
      if (currentSessionId && latestSessionId === currentSessionId && conversationMessagesRef.current.length > 0) {
        setReplyDebug((prev) => (
          prev
            ? `${prev} | resume_latest_session_skipped_same_session`
            : "resume_latest_session_skipped_same_session"
        ));
        return;
      }
      logSessionDiag("resume_latest_session_sync_start", {
        reason,
        currentSessionId: currentSessionId || undefined,
        latestSessionId,
        directory,
      }, {
        throttleMs: 0,
        throttleKey: `resume_latest_session_sync_start:${latestSessionId}:${now}`,
      });
      const restored = await selectSpecificLlmSession(latestSessionId, {
        source: "all",
        directory,
      });
      if (restored) {
        setReplyDebug((prev) => (
          prev
            ? `${prev} | resume_latest_session_synced`
            : "resume_latest_session_synced"
        ));
      }
    } catch (error) {
      logSessionDiag("resume_session_sync_failed", {
        reason,
        currentSessionId: currentSessionId || undefined,
        directory,
        message: error instanceof Error ? error.message : String(error),
      }, {
        throttleMs: 0,
        throttleKey: `resume_session_sync_failed:${currentSessionId || "latest"}:${now}`,
      });
      // Resume flow best-effort: keep UI stable and avoid noisy errors on transient reconnect.
    } finally {
      appResumeSessionSyncInFlightRef.current = false;
    }
  }, [
    settingsLoaded,
    activeScreen,
    llmSessionRestoreLoading,
    llmDirectory,
    llmBackend,
    selectedLlmSessionId,
    codexWsUrl,
    codexWsToken,
    appResumeSessionSyncInFlightRef,
    appResumeSessionSyncLastAtRef,
    conversationMessagesRef,
    fetchLatestSessionIdForDirectory,
    getLlmConversationSessionId,
    logSessionDiag,
    normalizedLlmDirectoryForRequest,
    parseOptionalSessionId,
    replyLoadingRef,
    selectSpecificLlmSession,
    setReplyDebug,
    streamSocketRef,
    streamTtsControlRef,
  ]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      void resumeLatestSessionOnActive({
        reason: "app_state_active",
        forceCurrentSession: true,
      });
    });
    return () => {
      sub.remove();
    };
  }, [resumeLatestSessionOnActive]);
}
