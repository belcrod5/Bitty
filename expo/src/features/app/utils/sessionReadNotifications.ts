import * as Notifications from "expo-notifications";
import {
  normalizeNotificationMetadata,
  TURN_COMPLETED_CATEGORY,
} from "./pushApprovalNotifications";
import {
  fetchSessionUnreadState,
  notificationFailureReason,
  syncUnreadSessionCounts,
  type UnreadSessionCountSnapshot,
} from "./sessionUnreadState";

let badgeApplyQueue = Promise.resolve();

async function dismissPresentedNotifications(
  operation: string,
  matches: (notification: Notifications.Notification) => boolean
) {
  const presented = await Notifications.getPresentedNotificationsAsync();
  const identifiers = presented.filter(matches).map((notification) => notification.request.identifier);
  const results = await Promise.allSettled(
    identifiers.map((identifier) => Notifications.dismissNotificationAsync(identifier))
  );
  const failures = results.flatMap((result) => (
    result.status === "rejected" ? [notificationFailureReason(result.reason)] : []
  ));
  if (failures.length > 0) {
    console.warn("[push] delivered notification dismissal failures", {
      operation,
      failureCount: failures.length,
      reasons: Array.from(new Set(failures)),
    });
  }
  return {
    matchedCount: identifiers.length,
    dismissedCount: identifiers.length - failures.length,
    failureCount: failures.length,
  };
}

export async function dismissReadSessionNotifications({
  backendId: backendIdRaw,
  sessionId: sessionIdRaw,
  directory: directoryRaw,
}: {
  backendId?: unknown;
  sessionId: unknown;
  directory: unknown;
}) {
  const backendId = String(backendIdRaw || "codex").trim() || "codex";
  const sessionId = String(sessionIdRaw || "").trim();
  const directory = String(directoryRaw || "").trim();
  if (!sessionId || !directory) return { matchedCount: 0, dismissedCount: 0, failureCount: 0 };
  return await dismissPresentedNotifications("session_read", (notification) => {
    if (notification.request.content.categoryIdentifier !== TURN_COMPLETED_CATEGORY) return false;
    const metadata = normalizeNotificationMetadata(notification.request);
    return (metadata.backendId || "codex") === backendId
      && metadata.sessionId === sessionId && metadata.directory === directory;
  });
}

export async function dismissReadDirectoryNotifications(directoryRaw: unknown) {
  const directory = String(directoryRaw || "").trim();
  if (!directory) return { matchedCount: 0, dismissedCount: 0, failureCount: 0 };
  return await dismissPresentedNotifications("directory_read", (notification) => (
    notification.request.content.categoryIdentifier === TURN_COMPLETED_CATEGORY
    && normalizeNotificationMetadata(notification.request).directory === directory
  ));
}

export async function reconcileReadDirectoryNotifications({
  runnerUrl,
  runnerToken,
  directory: directoryRaw,
}: {
  runnerUrl: string;
  runnerToken: string;
  directory: string;
}) {
  const directory = String(directoryRaw || "").trim();
  if (!directory) return { matchedCount: 0, dismissedCount: 0, failureCount: 0 };
  const presented = await Notifications.getPresentedNotificationsAsync();
  const notificationsBySession = new Map<string, {
    backendId: string;
    sessionId: string;
    notifications: Notifications.Notification[];
  }>();
  for (const notification of presented) {
    if (notification.request.content.categoryIdentifier !== TURN_COMPLETED_CATEGORY) continue;
    const metadata = normalizeNotificationMetadata(notification.request);
    if (!metadata.sessionId || metadata.directory !== directory) continue;
    const backendId = metadata.backendId || "codex";
    const identity = JSON.stringify([backendId, metadata.sessionId]);
    const entry = notificationsBySession.get(identity) || { backendId, sessionId: metadata.sessionId, notifications: [] };
    entry.notifications.push(notification);
    notificationsBySession.set(identity, entry);
  }
  const failures: string[] = [];
  let dismissedCount = 0;
  await Promise.all([...notificationsBySession.values()].map(async ({ backendId, sessionId, notifications }) => {
    try {
      const state = await fetchSessionUnreadState({ runnerUrl, runnerToken, backendId, sessionId, directory });
      if (!state.found || state.unread) return;
      const results = await Promise.allSettled(notifications.map((notification) => (
        Notifications.dismissNotificationAsync(notification.request.identifier)
      )));
      for (const result of results) {
        if (result.status === "fulfilled") dismissedCount += 1;
        else failures.push(notificationFailureReason(result.reason));
      }
    } catch (error) {
      failures.push(notificationFailureReason(error));
    }
  }));
  if (failures.length > 0) {
    console.warn("[push] directory notification reconcile failures", {
      failureCount: failures.length,
      reasons: Array.from(new Set(failures)),
    });
  }
  return {
    matchedCount: [...notificationsBySession.values()].reduce((sum, entry) => sum + entry.notifications.length, 0),
    dismissedCount,
    failureCount: failures.length,
  };
}

export async function syncUnreadBadgeCount(
  params: Parameters<typeof syncUnreadSessionCounts>[0]
): Promise<UnreadSessionCountSnapshot | null> {
  const snapshot = await syncUnreadSessionCounts(params);
  if (!snapshot) return null;
  await setUnreadBadgeCount(snapshot.unreadCount);
  return snapshot;
}

export async function setUnreadBadgeCount(unreadCount: number): Promise<void> {
  const apply = badgeApplyQueue.then(() => Notifications.setBadgeCountAsync(unreadCount));
  badgeApplyQueue = apply.then(() => undefined, () => undefined);
  await apply;
}

export async function reconcileReceivedSessionNotification({
  notification,
  runnerUrl,
  runnerToken,
  directories,
}: {
  notification: Notifications.Notification;
  runnerUrl: string;
  runnerToken: string;
  directories: string[];
}): Promise<UnreadSessionCountSnapshot | null> {
  const { backendId, sessionId, directory } = normalizeNotificationMetadata(notification.request);
  if (notification.request.content.categoryIdentifier !== TURN_COMPLETED_CATEGORY) return null;
  const badgeSync = syncUnreadBadgeCount({ runnerUrl, runnerToken, directories });
  const work: Promise<unknown>[] = [badgeSync];
  if (sessionId && directory) {
    work.push(fetchSessionUnreadState({
      runnerUrl,
      runnerToken,
      backendId: backendId || "codex",
      sessionId,
      directory,
    }).then(async (state) => {
      if (state.found && !state.unread) {
        await Notifications.dismissNotificationAsync(notification.request.identifier);
      }
    }));
  }
  const results = await Promise.allSettled(work);
  const failures = results.flatMap((result) => (
    result.status === "rejected" ? [notificationFailureReason(result.reason)] : []
  ));
  if (failures.length > 0) {
    console.warn("[push] foreground notification reconcile failures", {
      failureCount: failures.length,
      reasons: Array.from(new Set(failures)),
    });
  }
  const badgeResult = results[0];
  return badgeResult?.status === "fulfilled"
    ? badgeResult.value as UnreadSessionCountSnapshot | null
    : null;
}
