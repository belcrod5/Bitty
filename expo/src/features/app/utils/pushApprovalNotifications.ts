import * as Notifications from "expo-notifications";

// Must exactly match the "aps.category" values the runner sends in APPROVAL_REQUEST_HOOK /
// TURN_COMPLETED push payloads (see docs/PUSH-NOTIFICATIONS-DESIGN.md §6). expo-notifications
// warns against ":"/"-" in category identifiers, hence the SCREAMING_SNAKE_CASE form.
export const TURN_COMPLETED_CATEGORY = "TURN_COMPLETED";
export const APPROVAL_REQUEST_CATEGORY = "APPROVAL_REQUEST";
export const APPROVE_ACTION = "approve";
export const DENY_ACTION = "deny";

// Registers (or re-registers) the two notification categories used by push notifications.
// TURN_COMPLETED has no actions -- tap-to-open is handled entirely by the response listener.
// APPROVAL_REQUEST exposes "approve"/"deny" action buttons whose iOS-level behavior depends on
// the "承認にFace IDを要求" setting:
//   - faceIdRequired ON:  "approve" foregrounds the app so our own code can run
//     expo-local-authentication explicitly; iOS's built-in isAuthenticationRequired is left off
//     since it only enforces a generic device unlock, not Face ID specifically.
//   - faceIdRequired OFF: "approve" fires in the background immediately, but iOS is asked to
//     require the device to be unlocked first (isAuthenticationRequired) as a minimal safeguard.
// "deny" is always an immediate, unauthenticated background action regardless of the setting --
// it's the safe (non-destructive) choice, so there is no reason to gate it.
export async function registerApprovalNotificationCategories(faceIdRequired: boolean): Promise<void> {
  await Notifications.setNotificationCategoryAsync(TURN_COMPLETED_CATEGORY, []);
  await Notifications.setNotificationCategoryAsync(APPROVAL_REQUEST_CATEGORY, [
    {
      identifier: APPROVE_ACTION,
      buttonTitle: "承認",
      options: faceIdRequired
        ? { opensAppToForeground: true, isAuthenticationRequired: false }
        : { opensAppToForeground: false, isAuthenticationRequired: true },
    },
    {
      identifier: DENY_ACTION,
      buttonTitle: "拒否",
      options: { opensAppToForeground: false, isAuthenticationRequired: false },
    },
  ]);
}

// Module-level holder for "which session should we navigate to once the app is ready" set by
// the notification response listener's default-tap branch (see PushNotificationRegistrar.tsx).
// A plain variable (not React state) because the tap can happen before any provider has
// mounted -- see usePendingPushSessionNavigationController.ts, which polls this on settings-load
// and app-foreground.
let pendingPushSessionId = "";

export function setPendingPushSessionId(sessionId: string): void {
  pendingPushSessionId = String(sessionId || "").trim();
}

export function consumePendingPushSessionId(): string {
  const sessionId = pendingPushSessionId;
  pendingPushSessionId = "";
  return sessionId;
}
