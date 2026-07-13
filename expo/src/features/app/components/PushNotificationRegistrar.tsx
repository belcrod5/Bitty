import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import { getOrCreatePushDeviceId, registerPushDevice, resolveForegroundNotificationBehavior } from "../utils/pushNotifications";

Notifications.setNotificationHandler({
  handleNotification: async () => resolveForegroundNotificationBehavior(),
});

// Registers this device's native APNs push token with the runner once the runner
// WebSocket connection is established, and re-registers whenever the token changes.
// Renders nothing; it only needs the runner URL/token (from AppSettingsContext) and
// the live connection state (from RunnerWebSocketContext).
export function PushNotificationRegistrar() {
  const { runnerUrl, runnerToken } = useAppSettings();
  const { connected } = useRunnerWebSocketSnapshot();
  const lastRegisteredKeyRef = useRef("");

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
