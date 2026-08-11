import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import {
  dismissReadDirectoryNotifications,
  dismissReadSessionNotifications,
  reconcileReadDirectoryNotifications,
  syncUnreadBadgeCount,
} from "../utils/sessionReadNotifications";
import { useSessionNotificationLifecycleController } from "./useSessionNotificationLifecycleController";

jest.mock("../utils/sessionReadNotifications", () => ({
  dismissReadDirectoryNotifications: jest.fn(async () => {}),
  dismissReadSessionNotifications: jest.fn(async () => {}),
  notificationFailureReason: jest.fn(() => "error"),
  reconcileReadDirectoryNotifications: jest.fn(async () => {}),
  syncUnreadBadgeCount: jest.fn(async () => ({
    unreadCount: 0,
    directoryCounts: [{ directory: "/repo", unreadCount: 0 }],
  })),
}));

const mockDismissDirectory = dismissReadDirectoryNotifications as jest.Mock;
const mockDismiss = dismissReadSessionNotifications as jest.Mock;
const mockReconcileDirectory = reconcileReadDirectoryNotifications as jest.Mock;
const mockSyncBadge = syncUnreadBadgeCount as jest.Mock;

function renderController({
  popup = "",
  popupDirectory = "/repo",
  popupIsHydrating = false,
} = {}) {
  return renderHook(() => useSessionNotificationLifecycleController({
    getPopupSessionTarget: () => ({
      sessionId: popup,
      directory: popupDirectory,
      isHydrating: popupIsHydrating,
    }),
    getRunnerHttpAuth: async () => ({ baseUrl: "https://runner", token: "token" }),
    normalizedLlmDirectoryForRequest: () => "/fallback",
    registeredDirectoryPaths: ["/repo"],
  }));
}

describe("useSessionNotificationLifecycleController", () => {
  const originalAppStateDescriptor = Object.getOwnPropertyDescriptor(AppState, "currentState");

  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncBadge.mockResolvedValue({
      unreadCount: 0,
      directoryCounts: [{ directory: "/repo", unreadCount: 0 }],
    });
    Object.defineProperty(AppState, "currentState", {
      configurable: true,
      writable: true,
      value: "active",
    });
  });

  afterAll(() => {
    if (originalAppStateDescriptor) {
      Object.defineProperty(AppState, "currentState", originalAppStateDescriptor);
    }
  });

  it("does not treat a selected Skia board card as a visible chat", async () => {
    const { result } = await renderController();
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;
    let handled = false;
    await act(async () => {
      handled = result.current.handleForegroundSessionCompletion({
        sessionId: "selected-session",
        directory: "/repo",
      });
    });
    expect(handled).toBe(false);
    expect(markRead).not.toHaveBeenCalled();
    expect(mockSyncBadge).toHaveBeenCalled();
  });

  it("marks a visible popup completion read even when another session is selected", async () => {
    const { result } = await renderController({ popup: "popup-session" });
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;
    let handled = false;
    await act(async () => {
      handled = result.current.handleForegroundSessionCompletion({ sessionId: "popup-session" });
    });
    expect(handled).toBe(true);
    expect(markRead).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "popup-session",
      directory: "/repo",
      readTrigger: "visible_completion",
    }));
  });

  it("does not auto-read a popup session id reused in another directory", async () => {
    const { result } = await renderController({
      popup: "shared-session",
      popupDirectory: "/visible",
    });
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;

    let handled = true;
    await act(async () => {
      handled = result.current.handleForegroundSessionCompletion({
        sessionId: "shared-session",
        directory: "/other",
      });
    });
    expect(handled).toBe(false);
    expect(markRead).not.toHaveBeenCalled();
    expect(mockSyncBadge).toHaveBeenCalled();
  });

  it("does not auto-read a popup until its history hydration has applied", async () => {
    const { result } = await renderController({
      popup: "popup-session",
      popupDirectory: "/repo",
      popupIsHydrating: true,
    });
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;

    let handled = true;
    await act(async () => {
      handled = result.current.handleForegroundSessionCompletion({
        sessionId: "popup-session",
        directory: "/repo",
      });
    });
    expect(handled).toBe(false);
    expect(markRead).not.toHaveBeenCalled();
    expect(mockSyncBadge).toHaveBeenCalled();
  });

  it("auto-reads a popup completion when canonical directory and session id both match", async () => {
    const { result } = await renderController({
      popup: "shared-session",
      popupDirectory: "/visible",
    });
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;

    expect(result.current.handleForegroundSessionCompletion({
      sessionId: "shared-session",
      directory: "/visible",
    })).toBe(true);
    expect(markRead).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "shared-session",
      directory: "/visible",
      readTrigger: "visible_completion",
    }));
  });

  it("syncs the canonical badge for an active non-visible completion", async () => {
    const { result } = await renderController();
    let handled = true;
    await act(async () => {
      handled = result.current.handleForegroundSessionCompletion({ sessionId: "other-session" });
    });
    expect(handled).toBe(false);
    expect(mockSyncBadge).toHaveBeenCalledWith({
      runnerUrl: "https://runner",
      runnerToken: "token",
      directories: ["/repo"],
    });
  });

  it("dismisses delivered completion notifications only after a read commit", async () => {
    const { result } = await renderController();
    await act(async () => {
      result.current.handleSessionReadStateCommitted({
        sessionId: "session-1",
        directory: "/canonical",
        isRead: true,
      });
    });
    expect(mockDismiss).toHaveBeenCalledWith({
      sessionId: "session-1",
      directory: "/canonical",
      isRead: true,
    });
    expect(mockSyncBadge).toHaveBeenCalled();
  });

  it("dismisses a canonical directory only on full success and syncs badge once", async () => {
    mockSyncBadge.mockResolvedValue({
      unreadCount: 0,
      directoryCounts: [{ directory: "/canonical", unreadCount: 0 }],
    });
    const { result } = await renderController();
    await act(async () => {
      await result.current.handleDirectoryReadStateCommitted({
        status: "full",
        directory: "/canonical",
      } as never);
    });
    expect(mockDismissDirectory).toHaveBeenCalledWith("/canonical");
    expect(mockReconcileDirectory).not.toHaveBeenCalled();
    expect(mockSyncBadge).toHaveBeenCalledTimes(1);
    expect(result.current.directoryUnreadCountByPath).toEqual({ "/canonical": 0 });
  });

  it("keeps partial directory reads authoritative instead of optimistically clearing the count", async () => {
    mockSyncBadge.mockResolvedValue({
      unreadCount: 3,
      directoryCounts: [{ directory: "/canonical", unreadCount: 3 }],
    });
    const { result } = await renderController();
    await act(async () => {
      result.current.applyUnreadCountSnapshot({
        unreadCount: 7,
        directoryCounts: [{ directory: "/canonical", unreadCount: 7 }],
      });
    });
    await act(async () => {
      await result.current.handleDirectoryReadStateCommitted({
        status: "partial",
        directory: "/canonical",
      } as never);
    });
    expect(mockDismissDirectory).not.toHaveBeenCalled();
    expect(mockReconcileDirectory).toHaveBeenCalledWith({
      runnerUrl: "https://runner",
      runnerToken: "token",
      directory: "/canonical",
    });
    expect(mockSyncBadge).toHaveBeenCalledTimes(1);
    expect(result.current.directoryUnreadCountByPath).toEqual({ "/canonical": 3 });
  });
});
