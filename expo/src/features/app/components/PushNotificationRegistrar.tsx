import { useEffect, useMemo, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useConversation } from "../contexts/ConversationContext";
import { useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { getOrCreatePushDeviceId, registerPushDevice, resolveForegroundNotificationBehavior } from "../utils/pushNotifications";
import {
  APPROVAL_REQUEST_CATEGORY,
  normalizeNotificationMetadata,
  registerApprovalNotificationCategories,
  setPendingPushSessionTarget,
} from "../utils/pushApprovalNotifications";
import { handlePushApprovalAction } from "../utils/pushApprovalActions";
import {
  reconcileReceivedSessionNotification,
} from "../utils/sessionReadNotifications";
import { notificationFailureReason } from "../utils/sessionUnreadState";
import type { PushNotificationRegistrarProps } from "./PushNotificationRegistrar.contract";

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
export function PushNotificationRegistrar({
  onUnreadCountSnapshot,
}: PushNotificationRegistrarProps) {
  const { runnerUrl, runnerToken, faceIdRequiredForApproval } = useAppSettings();
  const { registeredDirectories } = useConversation();
  const { connected } = useRunnerWebSocketSnapshot();
  const directories = useMemo(() => Array.from(new Set(
    registeredDirectories.map((directory) => String(directory.path || "").trim()).filter(Boolean)
  )).sort(), [registeredDirectories]);
  const directoriesKey = directories.join("\u0000");
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
    const processResponse = (response: Notifications.NotificationResponse): boolean => {
      const request = response.notification.request;
      const responseKey = `${String(request.identifier || "")}:${String(response.actionIdentifier || "")}`;
      const { sessionId, directory, approvalId } = normalizeNotificationMetadata(request);
      const categoryIdentifier = String(request.content.categoryIdentifier || "");

      if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
        if (!sessionId) return false;
        if (processedResponseKeysRef.current.has(responseKey)) return true;
        processedResponseKeysRef.current.add(responseKey);
        // Plain tap: the app is guaranteed to be foregrounded by iOS. Stash the session id for
        // usePendingPushSessionNavigationController (AppRoot.tsx) to pick up once ready.
        setPendingPushSessionTarget({ sessionId, directory });
        return true;
      }

      if (categoryIdentifier !== APPROVAL_REQUEST_CATEGORY || !approvalId) return false;
      if (processedResponseKeysRef.current.has(responseKey)) return true;
      processedResponseKeysRef.current.add(responseKey);
      void handlePushApprovalAction({ categoryIdentifier, actionIdentifier: response.actionIdentifier, approvalId });
      return true;
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(processResponse);
    // Cold start: when an action press launched the app, the native event can fire before
    // this listener exists. The native side retains it as the "last response"; pick it up
    // here and clear it so a later remount cannot replay it.
    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse && processResponse(lastResponse)) {
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

        const registrationKey = `${deviceId}:${apnsToken}:${directoriesKey}`;
        if (lastRegisteredKeyRef.current === registrationKey) return;

        await registerPushDevice({ runnerUrl, runnerToken, deviceId, apnsToken, directories });
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
  }, [connected, directories, directoriesKey, runnerUrl, runnerToken]);

  useEffect(() => {
    if (!runnerUrl.trim() || !runnerToken.trim()) return;
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      void reconcileReceivedSessionNotification({
        notification,
        runnerUrl,
        runnerToken,
        directories,
      }).then(
        (snapshot) => {
          if (snapshot) onUnreadCountSnapshot?.(snapshot);
        },
        (error) => {
          console.warn("[push] foreground notification reconcile failed", {
            failureCount: 1,
            reason: notificationFailureReason(error),
          });
        });
    });
    return () => subscription.remove();
  }, [directories, onUnreadCountSnapshot, runnerToken, runnerUrl]);

  return null;
}
