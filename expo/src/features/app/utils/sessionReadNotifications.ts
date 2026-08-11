import * as Notifications from "expo-notifications";
import {
  normalizeNotificationMetadata,
  TURN_COMPLETED_CATEGORY,
} from "./pushApprovalNotifications";

let badgeSyncSequence = 0;
let badgeApplyQueue = Promise.resolve();

export type UnreadSessionCountSnapshot = {
  unreadCount: number;
  directoryCounts: Array<{ directory: string; unreadCount: number }>;
};

export function notificationFailureReason(error: unknown): string {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = String(candidate.code || "").trim().toLowerCase();
  if (/^[a-z0-9_]{1,64}$/.test(code)) return code;
  const name = String(candidate.name || "").trim().toLowerCase();
  return /^[a-z0-9_]{1,64}$/.test(name) ? name : "notification_error";
}

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
  sessionId: sessionIdRaw,
  directory: directoryRaw,
}: {
  sessionId: unknown;
  directory: unknown;
}) {
  const sessionId = String(sessionIdRaw || "").trim();
  const directory = String(directoryRaw || "").trim();
  if (!sessionId || !directory) return { matchedCount: 0, dismissedCount: 0, failureCount: 0 };
  return await dismissPresentedNotifications("session_read", (notification) => {
    if (notification.request.content.categoryIdentifier !== TURN_COMPLETED_CATEGORY) return false;
    const metadata = normalizeNotificationMetadata(notification.request);
    return metadata.sessionId === sessionId && metadata.directory === directory;
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

export async function fetchUnreadSessionCounts({
  runnerUrl,
  runnerToken,
  directories,
}: {
  runnerUrl: string;
  runnerToken: string;
  directories: string[];
}): Promise<UnreadSessionCountSnapshot> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  const normalizedDirectories = Array.from(new Set(
    (Array.isArray(directories) ? directories : [])
      .map((directory) => String(directory || "").trim())
      .filter(Boolean)
  ));
  if (!baseUrl || !token) throw new Error("Runner URL またはRunner Tokenが未設定です");
  const response = await fetch(`${baseUrl}/sessions/unread-count`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ directories: normalizedDirectories }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
  }
  const unreadCount = Number(data?.unreadCount);
  if (!Number.isInteger(unreadCount) || unreadCount < 0) {
    throw new Error("Runnerから正しい未読件数が返されませんでした");
  }
  const rawDirectoryCounts = Array.isArray(data?.directoryCounts) ? data.directoryCounts : null;
  if (!rawDirectoryCounts || rawDirectoryCounts.length > normalizedDirectories.length) {
    throw new Error("Runnerから正しいディレクトリ別未読件数が返されませんでした");
  }
  const seenDirectories = new Set<string>();
  const directoryCounts: UnreadSessionCountSnapshot["directoryCounts"] = rawDirectoryCounts.map((itemRaw: unknown) => {
    const item = itemRaw && typeof itemRaw === "object" ? itemRaw as Record<string, unknown> : {};
    const directory = String(item.directory || "").trim();
    const count = Number(item.unreadCount);
    if (!directory || seenDirectories.has(directory) || !Number.isInteger(count) || count < 0) {
      throw new Error("Runnerから正しいディレクトリ別未読件数が返されませんでした");
    }
    seenDirectories.add(directory);
    return { directory, unreadCount: count };
  });
  if (directoryCounts.reduce((sum, item) => sum + item.unreadCount, 0) !== unreadCount) {
    throw new Error("Runnerの未読合計とディレクトリ別件数が一致しません");
  }
  return { unreadCount, directoryCounts };
}

export async function fetchSessionUnreadState({
  runnerUrl,
  runnerToken,
  sessionId,
  directory,
}: {
  runnerUrl: string;
  runnerToken: string;
  sessionId: string;
  directory: string;
}): Promise<{ found: boolean; unread: boolean }> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  if (!baseUrl || !token) throw new Error("Runner URL またはRunner Tokenが未設定です");
  const response = await fetch(`${baseUrl}/sessions/unread-state`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId, directory }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
  }
  return { found: data?.found === true, unread: data?.unread === true };
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
  const notificationsBySessionId = new Map<string, Notifications.Notification[]>();
  for (const notification of presented) {
    if (notification.request.content.categoryIdentifier !== TURN_COMPLETED_CATEGORY) continue;
    const metadata = normalizeNotificationMetadata(notification.request);
    if (!metadata.sessionId || metadata.directory !== directory) continue;
    const matches = notificationsBySessionId.get(metadata.sessionId) || [];
    matches.push(notification);
    notificationsBySessionId.set(metadata.sessionId, matches);
  }
  const failures: string[] = [];
  let dismissedCount = 0;
  await Promise.all([...notificationsBySessionId.entries()].map(async ([sessionId, notifications]) => {
    try {
      const state = await fetchSessionUnreadState({ runnerUrl, runnerToken, sessionId, directory });
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
    matchedCount: [...notificationsBySessionId.values()].reduce((sum, items) => sum + items.length, 0),
    dismissedCount,
    failureCount: failures.length,
  };
}

export async function syncUnreadBadgeCount(
  params: Parameters<typeof fetchUnreadSessionCounts>[0]
): Promise<UnreadSessionCountSnapshot | null> {
  const sequence = ++badgeSyncSequence;
  const snapshot = await fetchUnreadSessionCounts(params);
  let applied = false;
  const apply = badgeApplyQueue.then(async () => {
    if (sequence === badgeSyncSequence) {
      await Notifications.setBadgeCountAsync(snapshot.unreadCount);
      applied = true;
    }
  });
  badgeApplyQueue = apply.catch(() => {});
  await apply;
  return applied ? snapshot : null;
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
  const { sessionId, directory } = normalizeNotificationMetadata(notification.request);
  if (notification.request.content.categoryIdentifier !== TURN_COMPLETED_CATEGORY) return null;
  const badgeSync = syncUnreadBadgeCount({ runnerUrl, runnerToken, directories });
  const work: Promise<unknown>[] = [badgeSync];
  if (sessionId && directory) {
    work.push(fetchSessionUnreadState({
      runnerUrl,
      runnerToken,
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
