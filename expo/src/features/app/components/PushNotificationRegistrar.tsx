import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { getOrCreatePushDeviceId, registerPushDevice, resolveForegroundNotificationBehavior } from "../utils/pushNotifications";
import { registerApprovalNotificationCategories, setPendingPushSessionId } from "../utils/pushApprovalNotifications";
import { handlePushApprovalAction } from "../utils/pushApprovalActions";

Notifications.setNotificationHandler({
  handleNotification: async () => resolveForegroundNotificationBehavior(),
});

// Registers this device's native APNs push token with the runner once the runner
// WebSocket connection is established, and re-registers whenever the token changes.
// Also owns notification-category registration (re-run whenever the "Face ID required for
// approval" setting changes) and the tap/action response listener. Renders nothing; it only
// needs the runner URL/token (from AppSettingsContext) and the live connection state (from
// RunnerWebSocketContext) for device registration -- the response listener's action handlers
// are intentionally background-safe (see pushApprovalActions.ts) and do not read from context.
export function PushNotificationRegistrar() {
  const { runnerUrl, runnerToken, faceIdRequiredForApproval } = useAppSettings();
  const { connected } = useRunnerWebSocketSnapshot();
  const lastRegisteredKeyRef = useRef("");

  useEffect(() => {
    void registerApprovalNotificationCategories(faceIdRequiredForApproval);
  }, [faceIdRequiredForApproval]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const content = response.notification.request.content;
      const data = (content.data || {}) as Record<string, unknown>;
      const categoryIdentifier = String(content.categoryIdentifier || "");
      const sessionId = String(data.sessionId || "").trim();
      const approvalId = String(data.approvalId || "").trim();

      if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
        // Plain tap: the app is guaranteed to be foregrounded by iOS. Stash the session id for
        // usePendingPushSessionNavigationController (AppRoot.tsx) to pick up once ready.
        if (sessionId) setPendingPushSessionId(sessionId);
        return;
      }

      void handlePushApprovalAction({ categoryIdentifier, actionIdentifier: response.actionIdentifier, approvalId });
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!connected) return;
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    let cancelled = false;

    void (async () => {
      try {
        let permission = await Notifications.getPermissionsAsync();
        if (!permission.granted && permission.canAskAgain) {
          permission = await Notifications.requestPermissionsAsync();
        }
        if (!permission.granted || cancelled) return;

        const deviceId = await getOrCreatePushDeviceId();
        const pushToken = await Notifications.getDevicePushTokenAsync();
        const apnsToken = String(pushToken?.data || "").trim();
        if (!apnsToken || cancelled) return;

        const registrationKey = `${deviceId}:${apnsToken}`;
        if (lastRegisteredKeyRef.current === registrationKey) return;

        await registerPushDevice({ runnerUrl, runnerToken, deviceId, apnsToken });
        if (!cancelled) lastRegisteredKeyRef.current = registrationKey;
      } catch (error) {
        console.warn(
          "[push] device registration failed",
          error instanceof Error ? error.message : error
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected, runnerUrl, runnerToken]);

  return null;
}
