import * as Notifications from "expo-notifications";

// Must exactly match the "aps.category" values the runner sends in APPROVAL_REQUEST_HOOK /
// TURN_COMPLETED push payloads (see docs/PUSH-NOTIFICATIONS-DESIGN.md §6). expo-notifications
// warns against ":"/"-" in category identifiers, hence the SCREAMING_SNAKE_CASE form.
export const TURN_COMPLETED_CATEGORY = "TURN_COMPLETED";
export const APPROVAL_REQUEST_CATEGORY = "APPROVAL_REQUEST";
export const APPROVE_ACTION = "approve";
export const DENY_ACTION = "deny";

// Registers the two notification categories used by push notifications.
// TURN_COMPLETED has no actions -- tap-to-open is handled entirely by the response listener.
// APPROVAL_REQUEST exposes "approve"/"deny" action buttons.
//
// Both actions deliberately use opensAppToForeground: true. Background actions
// (opensAppToForeground: false) are NOT viable with expo-notifications on iOS: the library's
// UNUserNotificationCenter delegate (NotificationCenterManager.swift) invokes the system
// completionHandler synchronously after forwarding the response, without taking a background
// task assertion, so iOS re-suspends the app before our async respond chain (settings read ->
// secure store -> fetch to the runner) can run -- and if the app was killed, the JS runtime is
// never started at all (expo-notifications' iOS background task support only covers
// content-available remote notifications, not action responses). Verified on device: the
// respond request never reached the runner and no fallback notification fired. Foregrounding
// the app makes the respond reliable; iOS already requires the device to be unlocked to
// foreground an app, so no extra isAuthenticationRequired option is needed. The
// "承認にFace IDを要求" setting is enforced by our own action handler
// (pushApprovalActions.ts) after launch, not via category options, so the categories are
// static and only need to be registered once.
export async function registerApprovalNotificationCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(TURN_COMPLETED_CATEGORY, []);
  await Notifications.setNotificationCategoryAsync(APPROVAL_REQUEST_CATEGORY, [
    {
      identifier: APPROVE_ACTION,
      buttonTitle: "承認",
      options: { opensAppToForeground: true },
    },
    {
      identifier: DENY_ACTION,
      buttonTitle: "拒否",
      options: { opensAppToForeground: true },
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
