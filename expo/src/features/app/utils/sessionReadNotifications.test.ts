import * as Notifications from "expo-notifications";
import {
  dismissReadDirectoryNotifications,
  dismissReadSessionNotifications,
  reconcileReceivedSessionNotification,
  reconcileReadDirectoryNotifications,
  syncUnreadBadgeCount,
} from "./sessionReadNotifications";
import { fetchUnreadSessionCounts } from "./sessionUnreadState";

jest.mock("expo-notifications", () => ({
  dismissNotificationAsync: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(),
  setBadgeCountAsync: jest.fn(),
}));

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test("dismisses only delivered TURN_COMPLETED notifications for committed sessions", async () => {
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue([
    {
      request: {
        identifier: "matching",
        content: { categoryIdentifier: "TURN_COMPLETED", data: null },
        trigger: { type: "push", payload: { sessionId: "session-1", directory: "/repo" } },
      },
    },
    {
      request: {
        identifier: "wrong-category",
        content: { categoryIdentifier: "APPROVAL_REQUEST", data: { sessionId: "session-1" } },
      },
    },
    {
      request: {
        identifier: "same-session-wrong-directory",
        content: { categoryIdentifier: "TURN_COMPLETED", data: null },
        trigger: { type: "push", payload: { sessionId: "session-1", directory: "/other" } },
      },
    },
  ]);
  (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValue(new Error("isolated"));

  await expect(dismissReadSessionNotifications({
    sessionId: "session-1",
    directory: "/repo",
  })).resolves.toEqual({
    matchedCount: 1,
    dismissedCount: 0,
    failureCount: 1,
  });
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith("matching");
  expect(warning).toHaveBeenCalledWith(
    "[push] delivered notification dismissal failures",
    { operation: "session_read", failureCount: 1, reasons: ["error"] }
  );
  warning.mockRestore();
});

test("full directory cleanup dismisses only matching delivered completion notifications", async () => {
  (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue([
    {
      request: {
        identifier: "same-directory",
        content: { categoryIdentifier: "TURN_COMPLETED", data: {} },
        trigger: { type: "push", payload: { sessionId: "read", directory: "/repo" } },
      },
    },
    {
      request: {
        identifier: "other-directory",
        content: { categoryIdentifier: "TURN_COMPLETED", data: { directory: "/other" } },
        trigger: { type: "push", payload: { sessionId: "other" } },
      },
    },
  ]);
  (Notifications.dismissNotificationAsync as jest.Mock).mockResolvedValue(undefined);
  await expect(dismissReadDirectoryNotifications("/repo")).resolves.toMatchObject({
    matchedCount: 1,
    dismissedCount: 1,
  });
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith("same-directory");
});

test("partial directory cleanup reconciles authority and dismisses only read sessions", async () => {
  (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue([
    {
      request: {
        identifier: "read-notification",
        content: { categoryIdentifier: "TURN_COMPLETED", data: null },
        trigger: { type: "push", payload: { sessionId: "read", directory: "/repo" } },
      },
    },
    {
      request: {
        identifier: "unread-notification",
        content: { categoryIdentifier: "TURN_COMPLETED", data: {} },
        trigger: { type: "push", payload: { sessionId: "unread", directory: "/repo" } },
      },
    },
  ]);
  global.fetch = jest.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    return {
      ok: true,
      json: async () => ({ found: true, unread: body.sessionId === "unread" }),
    };
  }) as unknown as typeof fetch;
  (Notifications.dismissNotificationAsync as jest.Mock).mockResolvedValue(undefined);
  await reconcileReadDirectoryNotifications({
    runnerUrl: "https://runner.example.com",
    runnerToken: "token",
    directory: "/repo",
  });
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith("read-notification");
});

test("fetches the exact canonical unread count and applies it as an absolute badge", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      unreadCount: 4,
      directoryCounts: [
        { directory: "/canonical/one", unreadCount: 1 },
        { directory: "/canonical/two", unreadCount: 3 },
      ],
    }),
  }) as unknown as typeof fetch;

  await expect(syncUnreadBadgeCount({
    runnerUrl: "https://runner.example.com/",
    runnerToken: "token",
    directories: ["/one", "/one", "/two"],
  })).resolves.toEqual({
    unreadCount: 4,
    directoryCounts: [
      { directory: "/canonical/one", unreadCount: 1 },
      { directory: "/canonical/two", unreadCount: 3 },
    ],
  });
  expect(global.fetch).toHaveBeenCalledWith(
    "https://runner.example.com/sessions/unread-count",
    expect.objectContaining({
      body: JSON.stringify({ directories: ["/one", "/two"] }),
    })
  );
  expect(Notifications.setBadgeCountAsync).toHaveBeenCalledWith(4);
});

test("rejects malformed counts without changing the badge", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ unreadCount: -1 }),
  }) as unknown as typeof fetch;
  await expect(fetchUnreadSessionCounts({
    runnerUrl: "https://runner.example.com",
    runnerToken: "token",
    directories: [],
  })).rejects.toThrow("正しい未読件数");
  expect(Notifications.setBadgeCountAsync).not.toHaveBeenCalled();
});

test("rejects a badge total that differs from the same snapshot directory sum", async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      unreadCount: 66,
      directoryCounts: [
        { directory: "/one", unreadCount: 10 },
        { directory: "/two", unreadCount: 55 },
      ],
    }),
  }) as unknown as typeof fetch;

  await expect(syncUnreadBadgeCount({
    runnerUrl: "https://runner.example.com",
    runnerToken: "token",
    directories: ["/one", "/two"],
  })).rejects.toThrow("一致しません");
  expect(Notifications.setBadgeCountAsync).not.toHaveBeenCalled();
});

test("does not let an older unread-count response overwrite a newer absolute badge", async () => {
  let resolveFirst!: (value: unknown) => void;
  let resolveSecond!: (value: unknown) => void;
  global.fetch = jest.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; })) as unknown as typeof fetch;
  const params = {
    runnerUrl: "https://runner.example.com",
    runnerToken: "token",
    directories: ["/repo"],
  };
  const first = syncUnreadBadgeCount(params);
  const second = syncUnreadBadgeCount(params);
  resolveSecond({
    ok: true,
    json: async () => ({ unreadCount: 2, directoryCounts: [{ directory: "/repo", unreadCount: 2 }] }),
  });
  await expect(second).resolves.toEqual({
    unreadCount: 2,
    directoryCounts: [{ directory: "/repo", unreadCount: 2 }],
  });
  resolveFirst({
    ok: true,
    json: async () => ({ unreadCount: 5, directoryCounts: [{ directory: "/repo", unreadCount: 5 }] }),
  });
  await expect(first).resolves.toBeNull();
  expect(Notifications.setBadgeCountAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.setBadgeCountAsync).toHaveBeenCalledWith(2);
});

test("reconciles a stale foreground completion by setting the canonical badge and dismissing it", async () => {
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    const path = String(url);
    return {
      ok: true,
      json: async () => path.endsWith("/sessions/unread-count")
        ? { unreadCount: 1, directoryCounts: [{ directory: "/repo", unreadCount: 1 }] }
        : { found: true, unread: false },
    };
  }) as unknown as typeof fetch;
  await reconcileReceivedSessionNotification({
    notification: {
      request: {
        identifier: "stale-completion",
        content: {
          categoryIdentifier: "TURN_COMPLETED",
          data: null,
        },
        trigger: { type: "push", payload: { sessionId: "session-1", directory: "/repo" } },
      },
    } as unknown as Notifications.Notification,
    runnerUrl: "https://runner.example.com",
    runnerToken: "token",
    directories: ["/repo"],
  });
  expect(Notifications.setBadgeCountAsync).toHaveBeenCalledWith(1);
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith("stale-completion");
});
