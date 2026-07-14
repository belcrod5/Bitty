import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const PUSH_DEVICE_ID_KEY = "bitty.pushDeviceId";

// Cryptographically secure (expo-crypto wraps the platform CSPRNG): the device id is a
// long-lived identifier in the runner's device registry, so it must not be guessable the
// way a Math.random()-based id would be.
function generateDeviceId() {
  return `push_${Crypto.randomUUID()}`;
}

// Stable per-install identifier for the runner's push-device registry. Generated once
// and persisted in secure storage so re-registration (e.g. after an APNs token change)
// updates the same device record instead of creating a new one.
export async function getOrCreatePushDeviceId(): Promise<string> {
  try {
    const existing = String((await SecureStore.getItemAsync(PUSH_DEVICE_ID_KEY)) || "").trim();
    if (existing) return existing;
  } catch {}
  const deviceId = generateDeviceId();
  try {
    await SecureStore.setItemAsync(PUSH_DEVICE_ID_KEY, deviceId);
  } catch {}
  return deviceId;
}

export async function registerPushDevice({
  runnerUrl,
  runnerToken,
  deviceId,
  apnsToken,
}: {
  runnerUrl: string;
  runnerToken: string;
  deviceId: string;
  apnsToken: string;
}): Promise<boolean> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  if (!baseUrl || !token || !deviceId || !apnsToken) return false;
  const response = await fetch(`${baseUrl}/push/devices`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ deviceId, apnsToken }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
  }
  return Boolean(data?.ok);
}

// iOS notification presentation while the app is in the foreground. Foreground push is
// intentionally suppressed here because the in-app notification card
// (LlmCompletionNotifications) already shows completion state while the app is open.
export function resolveForegroundNotificationBehavior() {
  return {
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  };
}
