// The same purpose identifiers are used by the iOS service extension. Keep
// presentation at notification creation, independent of APNs delivery or text.
export const PUSH_NOTIFICATION_CATEGORIES = Object.freeze([
  "TURN_COMPLETED", "VOICE_COMPLETED", "APPROVAL_REQUEST", "SCHEDULE_FAILED", "CODEX_USAGE_LIMIT",
]);

export function pushNotificationPresentation(category) {
  if (!PUSH_NOTIFICATION_CATEGORIES.includes(category)) return { category, sound: "default" };
  return {
    category,
    sound: `bitty-${category.toLowerCase().replaceAll("_", "-")}.wav`,
    "mutable-content": 1,
  };
}
