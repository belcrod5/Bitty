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
// approval" setting changes, since the approve action's foreground/background mode depends
// on it) and the tap/action response listener. Renders nothing; it only needs the runner
// URL/token (from AppSettingsContext) and the live connection state (from
// RunnerWebSocketContext) for device registration -- the response listener's action handler
// is intentionally background-safe (see pushApprovalActions.ts) and does not read from
// context, because on a cold start triggered by a notification action it runs before
// context has loaded. Background actions (deny / Face-ID-OFF approve) are answered natively
// by the bitty-push-approval module; when the app process happens to be alive their events
// still reach the JS listener, but handlePushApprovalAction deliberately no-ops on them.
export function PushNotificationRegistrar() {
  const { runnerUrl, runnerToken, faceIdRequiredForApproval } = useAppSettings();
  const { connected } = useRunnerWebSocketSnapshot();
  const lastRegisteredKeyRef = useRef("");
  // Guards against processing the same response twice: a cold-start Face-ID approve press
  // (foreground action) can surface both through the response listener and through
  // getLastNotificationResponse(), and a double respond would 409 on the runner and fire a
  // misleading failure fallback.
  const processedResponseKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void registerApprovalNotificationCategories(faceIdRequiredForApproval);
  }, [faceIdRequiredForApproval]);

  useEffect(() => {
    const processResponse = (response: Notifications.NotificationResponse) => {
      const request = response.notification.request;
      const responseKey = `${String(request.identifier || "")}:${String(response.actionIdentifier || "")}`;
      if (processedResponseKeysRef.current.has(responseKey)) return;
      processedResponseKeysRef.current.add(responseKey);

      const content = request.content;
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
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(processResponse);
    // Cold start: when an action press launched the app, the native event can fire before
    // this listener exists. The native side retains it as the "last response"; pick it up
    // here and clear it so a later remount cannot replay it.
    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse) {
      processResponse(lastResponse);
      Notifications.clearLastNotificationResponse();
    }
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
