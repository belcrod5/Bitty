import { useCallback, useEffect } from "react";
import { AppState } from "react-native";
import { consumePendingPushSessionId } from "../utils/pushApprovalNotifications";
import type { SelectSpecificLlmSessionOptions } from "../types/appTypes";

type UsePendingPushSessionNavigationControllerArgs = {
  settingsLoaded: boolean;
  normalizedLlmDirectoryForRequest: () => string;
  selectSpecificLlmSession: (
    nextSessionIdRaw: unknown,
    opts?: SelectSpecificLlmSessionOptions
  ) => Promise<boolean>;
};

// Consumes the pending session id set by PushNotificationRegistrar's notification response
// listener on a default tap (see pushApprovalNotifications.ts's setPendingPushSessionId) and
// navigates to it via the same selectSpecificLlmSession entry point used by
// openSessionHistoryEntryFromContext (AppRoot.tsx). Modeled on
// useSessionStartupRecoveryController.ts's shape: a settings-loaded-gated effect for cold start
// (app launched by tapping the notification) plus an AppState "active" listener for warm start
// (tap arrives while the app is already running in the background).
export function usePendingPushSessionNavigationController({
  settingsLoaded,
  normalizedLlmDirectoryForRequest,
  selectSpecificLlmSession,
}: UsePendingPushSessionNavigationControllerArgs) {
  const consumeAndNavigate = useCallback(() => {
    if (!settingsLoaded) return;
    const pendingSessionId = consumePendingPushSessionId();
    if (!pendingSessionId) return;
    void selectSpecificLlmSession(pendingSessionId, {
      source: "notification",
      directory: normalizedLlmDirectoryForRequest(),
    });
  }, [settingsLoaded, normalizedLlmDirectoryForRequest, selectSpecificLlmSession]);

  useEffect(() => {
    consumeAndNavigate();
  }, [consumeAndNavigate]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      consumeAndNavigate();
    });
    return () => subscription.remove();
  }, [consumeAndNavigate]);
}
