import * as Notifications from "expo-notifications";

// Must exactly match the "aps.category" values the runner sends in APPROVAL_REQUEST_HOOK /
// TURN_COMPLETED push payloads (see docs/PUSH-NOTIFICATIONS-DESIGN.md §6). expo-notifications
// warns against ":"/"-" in category identifiers, hence the SCREAMING_SNAKE_CASE form.
export const TURN_COMPLETED_CATEGORY = "TURN_COMPLETED";
export const APPROVAL_REQUEST_CATEGORY = "APPROVAL_REQUEST";
export const APPROVE_ACTION = "approve";
export const DENY_ACTION = "deny";

export type NotificationMetadata = {
  backendId: string;
  sessionId: string;
  directory: string;
  turnId: string;
  approvalId: string;
};

export function normalizeNotificationMetadata(
  request: Pick<Notifications.NotificationRequest, "content" | "trigger">
): NotificationMetadata {
  const contentData = request?.content?.data && typeof request.content.data === "object"
    ? request.content.data as Record<string, unknown>
    : {};
  const trigger = request?.trigger && typeof request.trigger === "object"
    ? request.trigger as unknown as Record<string, unknown>
    : {};
  const triggerPayload = trigger.payload && typeof trigger.payload === "object"
    ? trigger.payload as Record<string, unknown>
    : {};
  const value = (field: keyof NotificationMetadata) => (
    String(contentData[field] || "").trim() || String(triggerPayload[field] || "").trim()
  );
  return {
    backendId: value("backendId"),
    sessionId: value("sessionId"),
    directory: value("directory"),
    turnId: value("turnId"),
    approvalId: value("approvalId"),
  };
}

// Registers (or re-registers) the two notification categories used by push notifications.
// TURN_COMPLETED has no actions -- tap-to-open is handled entirely by the response listener.
// APPROVAL_REQUEST exposes "approve"/"deny" action buttons.
//
// Background actions (opensAppToForeground: false) are handled entirely NATIVELY by the local
// bitty-push-approval module (expo/modules/bitty-push-approval): expo-notifications' own iOS
// delegate (NotificationCenterManager.swift) calls the system completionHandler immediately
// without a background task assertion, so a JS respond chain would be suspended mid-flight
// (and a killed app never starts JS for a background response at all). The native responder
// takes its own UIBackgroundTask assertion and POSTs to the runner directly from Swift, so
// the app never has to open.
//
// Ownership matrix (must stay in sync with PushApprovalNotificationDelegate.swift and
// pushApprovalActions.ts):
//   - deny:                 background action, native responder owns it. No auth option: it
//                           is the safe choice, so it stays one-tap even on a locked device.
//   - approve, Face ID OFF: background action, native responder owns it.
//                           isAuthenticationRequired makes iOS demand device unlock first.
//   - approve, Face ID ON:  foreground action; JS runs Face ID (expo-local-authentication --
//                           biometric UI cannot be shown from the background) and responds.
export async function registerApprovalNotificationCategories(faceIdRequired: boolean): Promise<void> {
  await Notifications.setNotificationCategoryAsync(TURN_COMPLETED_CATEGORY, []);
  await Notifications.setNotificationCategoryAsync(APPROVAL_REQUEST_CATEGORY, [
    {
      identifier: APPROVE_ACTION,
      buttonTitle: "承認",
      options: faceIdRequired
        ? { opensAppToForeground: true }
        : { opensAppToForeground: false, isAuthenticationRequired: true },
    },
    {
      identifier: DENY_ACTION,
      buttonTitle: "拒否",
      options: { opensAppToForeground: false },
    },
  ]);
}

export type PendingPushSessionTarget = {
  backendId?: string;
  sessionId: string;
  directory: string;
  sequence: number;
};

let pendingPushSessionTarget: PendingPushSessionTarget | null = null;
let pendingPushSequence = 0;
const pendingPushListeners = new Set<() => void>();

export function setPendingPushSessionTarget(params: {
  backendId?: unknown;
  sessionId: unknown;
  directory?: unknown;
}): void {
  const sessionId = String(params?.sessionId || "").trim();
  if (!sessionId) return;
  pendingPushSequence += 1;
  pendingPushSessionTarget = {
    ...(String(params?.backendId || "").trim() ? { backendId: String(params.backendId).trim() } : {}),
    sessionId,
    directory: String(params?.directory || "").trim(),
    sequence: pendingPushSequence,
  };
  for (const listener of pendingPushListeners) listener();
}

export function getPendingPushSessionTarget(): PendingPushSessionTarget | null {
  return pendingPushSessionTarget;
}

export function clearPendingPushSessionTarget(target: PendingPushSessionTarget): boolean {
  if (pendingPushSessionTarget?.sequence !== target.sequence) return false;
  pendingPushSessionTarget = null;
  return true;
}

export function subscribePendingPushSessionTarget(listener: () => void): () => void {
  pendingPushListeners.add(listener);
  return () => pendingPushListeners.delete(listener);
}
