import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import {
  dismissReadDirectoryNotifications,
  dismissReadSessionNotifications,
  reconcileReadDirectoryNotifications,
  setUnreadBadgeCount,
} from "../utils/sessionReadNotifications";
import { syncUnreadSessionCounts } from "../utils/sessionUnreadState";
import { useSessionNotificationLifecycleController } from "./useSessionNotificationLifecycleController";

jest.mock("../utils/sessionReadNotifications", () => ({
  dismissReadDirectoryNotifications: jest.fn(async () => {}),
  dismissReadSessionNotifications: jest.fn(async () => {}),
  reconcileReadDirectoryNotifications: jest.fn(async () => {}),
  setUnreadBadgeCount: jest.fn(async () => {}),
}));

jest.mock("../utils/sessionUnreadState", () => ({
  notificationFailureReason: jest.fn(() => "error"),
  syncUnreadSessionCounts: jest.fn(async () => ({
    unreadCount: 0,
    directoryCounts: [{ directory: "/repo", unreadCount: 0 }],
  })),
}));

const mockDismissDirectory = dismissReadDirectoryNotifications as jest.Mock;
const mockDismiss = dismissReadSessionNotifications as jest.Mock;
const mockReconcileDirectory = reconcileReadDirectoryNotifications as jest.Mock;
const mockSetBadge = setUnreadBadgeCount as jest.Mock;
const mockSyncUnread = syncUnreadSessionCounts as jest.Mock;
let runnerConnectionState = "ready";
let runnerSnapshotListener: (() => void) | null = null;
const runnerWebSocketManager = {
  getSnapshot: () => ({ connectionState: runnerConnectionState }),
  subscribeSnapshot: (listener: () => void) => {
    runnerSnapshotListener = listener;
    return () => {
      if (runnerSnapshotListener === listener) runnerSnapshotListener = null;
    };
  },
};

function renderController({
  popup = "",
  popupDirectory = "/repo",
  popupIsHydrating = false,
} = {}) {
  const getPopupSessionTarget = () => ({
    sessionId: popup,
    directory: popupDirectory,
    isHydrating: popupIsHydrating,
  });
  const getRunnerHttpAuth = async () => ({ baseUrl: "https://runner", token: "token" });
  const normalizedLlmDirectoryForRequest = () => "/fallback";
  const registeredDirectoryPaths = ["/repo"];
  return renderHook(() => useSessionNotificationLifecycleController({
    getPopupSessionTarget,
    getRunnerHttpAuth,
    normalizedLlmDirectoryForRequest,
    registeredDirectoryPaths,
    runnerWebSocketManager,
  }));
}

describe("useSessionNotificationLifecycleController", () => {
  const originalAppStateDescriptor = Object.getOwnPropertyDescriptor(AppState, "currentState");
  let appStateListener: ((state: string) => void) | null = null;
  let removeAppStateListener: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    appStateListener = null;
    runnerConnectionState = "ready";
    runnerSnapshotListener = null;
    removeAppStateListener = jest.fn();
    jest.spyOn(AppState, "addEventListener").mockImplementation((_, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove: removeAppStateListener };
    });
    mockSyncUnread.mockResolvedValue({
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

  it("owns initial and active-resume unread synchronization", async () => {
    const { rerender } = await renderController();
    await waitFor(() => expect(mockSyncUnread).toHaveBeenCalledTimes(1));
    expect(mockSetBadge).toHaveBeenLastCalledWith(0);

    await rerender(undefined);
    expect(mockSyncUnread).toHaveBeenCalledTimes(1);

    await act(async () => {
      appStateListener?.("background");
    });
    expect(mockSyncUnread).toHaveBeenCalledTimes(1);

    await act(async () => {
      appStateListener?.("active");
    });
    await waitFor(() => expect(mockSyncUnread).toHaveBeenCalledTimes(2));
  });

  it("waits for a connection and synchronizes again after reconnect", async () => {
    runnerConnectionState = "reconnecting";
    await renderController();
    expect(mockSyncUnread).not.toHaveBeenCalled();

    await act(async () => {
      appStateListener?.("active");
    });
    expect(mockSyncUnread).not.toHaveBeenCalled();

    await act(async () => {
      runnerConnectionState = "ready";
      runnerSnapshotListener?.();
    });
    await waitFor(() => expect(mockSyncUnread).toHaveBeenCalledTimes(1));

    await act(async () => {
      runnerConnectionState = "reconnecting";
      runnerSnapshotListener?.();
      runnerConnectionState = "ready";
      runnerSnapshotListener?.();
    });
    await waitFor(() => expect(mockSyncUnread).toHaveBeenCalledTimes(2));
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
    expect(mockSyncUnread).toHaveBeenCalled();
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
    expect(mockSyncUnread).toHaveBeenCalled();
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
    expect(mockSyncUnread).toHaveBeenCalled();
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
    expect(mockSyncUnread).toHaveBeenCalledWith({
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
    expect(mockSyncUnread).toHaveBeenCalled();
  });

  it("dismisses a canonical directory only on full success and syncs badge once", async () => {
    mockSyncUnread.mockResolvedValue({
      unreadCount: 0,
      directoryCounts: [{ directory: "/canonical", unreadCount: 0 }],
    });
    const { result } = await renderController();
    await waitFor(() => expect(mockSyncUnread).toHaveBeenCalledTimes(1));
    mockSyncUnread.mockClear();
    await act(async () => {
      await result.current.handleDirectoryReadStateCommitted({
        status: "full",
        directory: "/canonical",
      } as never);
    });
    expect(mockDismissDirectory).toHaveBeenCalledWith("/canonical");
    expect(mockReconcileDirectory).not.toHaveBeenCalled();
    expect(mockSyncUnread).toHaveBeenCalledTimes(1);
    expect(mockSetBadge).toHaveBeenCalledWith(0);
    expect(result.current.directoryUnreadCountByPath).toEqual({ "/canonical": 0 });
  });

  it("keeps partial directory reads authoritative instead of optimistically clearing the count", async () => {
    mockSyncUnread.mockResolvedValue({
      unreadCount: 3,
      directoryCounts: [{ directory: "/canonical", unreadCount: 3 }],
    });
    const { result } = await renderController();
    await waitFor(() => expect(mockSyncUnread).toHaveBeenCalledTimes(1));
    mockSyncUnread.mockClear();
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
    expect(mockSyncUnread).toHaveBeenCalledTimes(1);
    expect(result.current.directoryUnreadCountByPath).toEqual({ "/canonical": 3 });
  });
});
