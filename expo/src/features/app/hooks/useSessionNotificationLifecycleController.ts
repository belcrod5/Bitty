import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { parseOptionalSessionId } from "../utils/llmSession";
import {
  dismissReadDirectoryNotifications,
  dismissReadSessionNotifications,
  notificationFailureReason,
  reconcileReadDirectoryNotifications,
  syncUnreadBadgeCount,
  type UnreadSessionCountSnapshot,
} from "../utils/sessionReadNotifications";
import type { RunnerDirectoryReadResult } from "./useLlmSessionExplorer";

type MarkSessionRead = (params: {
  sessionId: string;
  directory: string;
  source?: "all";
  readTrigger?: "visible_completion";
  restoreRequestSeq: number;
}) => void;

export function useSessionNotificationLifecycleController({
  getPopupSessionTarget,
  getRunnerHttpAuth,
  normalizedLlmDirectoryForRequest,
  registeredDirectoryPaths,
}: {
  getPopupSessionTarget: () => { sessionId: string; directory: string; isHydrating: boolean };
  getRunnerHttpAuth: () => Promise<{ baseUrl: string; token: string }>;
  normalizedLlmDirectoryForRequest: () => string;
  registeredDirectoryPaths: string[];
}) {
  const markSessionReadAsyncRef = useRef<MarkSessionRead | null>(null);
  const [directoryUnreadCountByPath, setDirectoryUnreadCountByPath] = useState<Record<string, number>>({});
  const applyUnreadCountSnapshot = useCallback((snapshot: UnreadSessionCountSnapshot) => {
    setDirectoryUnreadCountByPath(Object.fromEntries(
      snapshot.directoryCounts.map((item) => [item.directory, item.unreadCount])
    ));
  }, []);
  const syncBadge = useCallback(async () => {
    try {
      const { baseUrl, token } = await getRunnerHttpAuth();
      const snapshot = await syncUnreadBadgeCount({
        runnerUrl: baseUrl,
        runnerToken: token,
        directories: registeredDirectoryPaths,
      });
      if (snapshot) {
        applyUnreadCountSnapshot(snapshot);
        console.log("[push] badge snapshot applied", {
          unreadCount: snapshot.unreadCount,
          directoryCount: snapshot.directoryCounts.length,
        });
      }
      return snapshot;
    } catch (error) {
      console.warn("[push] badge sync failed", {
        failureCount: 1,
        reason: notificationFailureReason(error),
      });
      return null;
    }
  }, [applyUnreadCountSnapshot, getRunnerHttpAuth, registeredDirectoryPaths]);

  const handleSessionReadStateCommitted = useCallback((result: {
    sessionId: string;
    directory: string;
    isRead: boolean;
  }) => {
    if (result.isRead) {
      void dismissReadSessionNotifications(result).then((dismissed) => {
        console.log("[push] session notifications dismissed", {
          sessionId: result.sessionId,
          directory: result.directory,
          matchedCount: Number(dismissed?.matchedCount || 0),
          dismissedCount: Number(dismissed?.dismissedCount || 0),
        });
      }).catch((error) => {
        console.warn("[push] delivered notification dismissal failed", {
          failureCount: 1,
          reason: notificationFailureReason(error),
        });
      });
    }
    void syncBadge();
  }, [syncBadge]);

  const handleDirectoryReadStateCommitted = useCallback(async (result: RunnerDirectoryReadResult) => {
    if (result.status === "full") {
      setDirectoryUnreadCountByPath((current) => ({ ...current, [result.directory]: 0 }));
    }
    const cleanup = (async () => {
      if (result.status === "full") {
        await dismissReadDirectoryNotifications(result.directory);
        return;
      }
      const { baseUrl, token } = await getRunnerHttpAuth();
      await reconcileReadDirectoryNotifications({
        runnerUrl: baseUrl,
        runnerToken: token,
        directory: result.directory,
      });
    })().catch((error) => {
      console.warn("[push] directory notification cleanup failed", {
        failureCount: 1,
        reason: notificationFailureReason(error),
      });
    });
    await Promise.all([cleanup, syncBadge()]);
  }, [getRunnerHttpAuth, syncBadge]);

  const handleForegroundSessionCompletion = useCallback(({
    sessionId,
    directory,
  }: {
    sessionId: string;
    directory?: string;
  }) => {
    if (AppState.currentState !== "active") return false;
    const directoryValue = String(directory || "").trim();
    const popupTarget = getPopupSessionTarget();
    const popupDirectory = String(popupTarget.directory || "").trim();
    const visible = (
      !popupTarget.isHydrating
      && parseOptionalSessionId(popupTarget.sessionId) === sessionId
      && (!directoryValue || popupDirectory === directoryValue)
    );
    if (visible && markSessionReadAsyncRef.current) {
      markSessionReadAsyncRef.current({
        sessionId,
        // Older completion events did not include directory. The visible popup owns the read target;
        // the globally selected directory may point at another chat.
        directory: directoryValue || popupDirectory || normalizedLlmDirectoryForRequest(),
        source: "all",
        readTrigger: "visible_completion",
        restoreRequestSeq: Date.now(),
      });
      return true;
    }
    void syncBadge();
    return false;
  }, [
    getPopupSessionTarget,
    normalizedLlmDirectoryForRequest,
    syncBadge,
  ]);

  return {
    applyUnreadCountSnapshot,
    directoryUnreadCountByPath,
    handleForegroundSessionCompletion,
    handleDirectoryReadStateCommitted,
    handleSessionReadStateCommitted,
    markSessionReadAsyncRef,
  };
}
