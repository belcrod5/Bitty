import * as LocalAuthentication from "expo-local-authentication";
import * as Notifications from "expo-notifications";
import { loadSecureRunnerCredentials } from "./secureRunnerCredentials";
import { buildCloudflareAccessHeaders, normalizeCloudflareAccessCredentials } from "./cloudflareAccess";
import { readPersistedSettingsField } from "./persistedSettingsFile";
import { APPROVAL_REQUEST_CATEGORY, APPROVE_ACTION, DENY_ACTION } from "./pushApprovalNotifications";

// Notification action handlers can run while the app is freshly launched in the background,
// before AppSettingsContext's async settings-file load has had a chance to run -- so nothing
// in this module may rely on React context (or on the global fetch patch installed by
// configureCloudflareAccessFetch, whose credentials come from React state). Settings are
// read straight from the persisted settings file (persistedSettingsFile.ts) and secrets
// from expo-secure-store.

export async function readRunnerUrlFromDisk(): Promise<string> {
  return String((await readPersistedSettingsField("runnerUrl")) || "").trim();
}

export async function readFaceIdRequiredFromDisk(): Promise<boolean> {
  return (await readPersistedSettingsField("faceIdRequiredForApproval")) === true;
}

// POSTs the user's approve/deny decision back to the runner. Mirrors registerPushDevice()'s
// fetch/error-handling style in pushNotifications.ts. approvalId is an opaque string (format
// "<relayId>:<rpcId>" internally per the runner, but callers must not parse it -- just echo
// whatever arrived in the push payload, URL-encoded).
export async function respondToPushApproval({
  runnerUrl,
  runnerToken,
  approvalId,
  approved,
  cloudflareAccessClientId,
  cloudflareAccessClientSecret,
}: {
  runnerUrl: string;
  runnerToken: string;
  approvalId: string;
  approved: boolean;
  cloudflareAccessClientId?: string;
  cloudflareAccessClientSecret?: string;
}): Promise<boolean> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  const id = String(approvalId || "").trim();
  if (!baseUrl || !token || !id) return false;
  // Cloudflare Access headers are normally injected by the global fetch patch
  // (configureCloudflareAccessFetch), but that patch's credentials come from React state
  // loaded asynchronously -- not yet available on a background launch. Attach them
  // explicitly here instead; the request only ever targets the user's own runner URL, and
  // buildCloudflareAccessHeaders returns {} when no credentials are configured. If the
  // global patch is active it skips keys that are already set, so there is no duplication.
  const response = await fetch(`${baseUrl}/push/approvals/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...buildCloudflareAccessHeaders(normalizeCloudflareAccessCredentials(
        cloudflareAccessClientId,
        cloudflareAccessClientSecret
      )),
    },
    body: JSON.stringify({ approved }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
  }
  return Boolean(data?.ok);
}

// Lightweight, un-fancy fallback per the design's "過剰に作り込まない" note: no retry, no
// custom UI, just a local notification nudging the user to open the app and try again.
async function scheduleApprovalRespondFailureFallback(): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "承認の送信に失敗しました",
        body: "アプリを開いて再度お試しください。",
      },
      trigger: null,
    });
  } catch {}
}

// Loads runnerUrl/runnerToken from the background-safe sources (disk-persisted settings file +
// secure store) and responds to the approval. Network failure, a 409 (already answered /
// expired), or any other non-2xx are all treated the same from the UX side: not a hard failure,
// just fire the fallback notification and move on.
async function respondInBackground({
  approvalId,
  approved,
}: {
  approvalId: string;
  approved: boolean;
}): Promise<void> {
  try {
    const [runnerUrl, credentials] = await Promise.all([
      readRunnerUrlFromDisk(),
      loadSecureRunnerCredentials(),
    ]);
    const ok = await respondToPushApproval({
      runnerUrl,
      runnerToken: credentials.runnerToken,
      approvalId,
      approved,
      cloudflareAccessClientId: credentials.cloudflareAccessClientId,
      cloudflareAccessClientSecret: credentials.cloudflareAccessClientSecret,
    });
    if (!ok) throw new Error("push approval respond returned ok=false");
  } catch (error) {
    console.warn(
      "[push] approval respond failed",
      error instanceof Error ? error.message : error
    );
    await scheduleApprovalRespondFailureFallback();
  }
}

// hasHardwareAsync/isEnrolledAsync + authenticateAsync, all best-effort: any failure/cancel
// just resolves to false (no auto-retry, no custom UI beyond the shared fallback notification).
async function authenticateWithFaceId(): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return false;
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    if (!isEnrolled) return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "承認にFace IDで認証してください",
    });
    return Boolean(result?.success);
  } catch {
    return false;
  }
}

// Entry point called by the notification response listener (PushNotificationRegistrar.tsx) for
// non-default actionIdentifiers. Deliberately takes only primitive strings, not React context,
// since this can run before the settings/runner context has finished its async load.
export async function handlePushApprovalAction({
  categoryIdentifier,
  actionIdentifier,
  approvalId,
}: {
  categoryIdentifier: string;
  actionIdentifier: string;
  approvalId: string;
}): Promise<void> {
  if (categoryIdentifier !== APPROVAL_REQUEST_CATEGORY) return;
  if (!approvalId) return;

  if (actionIdentifier === DENY_ACTION) {
    await respondInBackground({ approvalId, approved: false });
    return;
  }

  if (actionIdentifier === APPROVE_ACTION) {
    const faceIdRequired = await readFaceIdRequiredFromDisk();
    if (faceIdRequired) {
      const authenticated = await authenticateWithFaceId();
      if (!authenticated) return;
    }
    await respondInBackground({ approvalId, approved: true });
  }
}
