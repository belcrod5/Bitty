const EMPTY_DISMISS_RESULT = {
  matchedCount: 0,
  dismissedCount: 0,
  failureCount: 0,
};

// macOS has no native notification delivery integration. HTTP unread state is
// synchronized by useSessionNotificationLifecycleController before reaching this boundary.
export async function setUnreadBadgeCount(_unreadCount: number): Promise<void> {}

export async function dismissReadSessionNotifications(_params: {
  backendId?: unknown;
  sessionId: unknown;
  directory: unknown;
}) {
  return EMPTY_DISMISS_RESULT;
}

export async function dismissReadDirectoryNotifications(_directory: unknown) {
  return EMPTY_DISMISS_RESULT;
}

export async function reconcileReadDirectoryNotifications(_params: {
  runnerUrl: string;
  runnerToken: string;
  directory: string;
}) {
  return EMPTY_DISMISS_RESULT;
}
