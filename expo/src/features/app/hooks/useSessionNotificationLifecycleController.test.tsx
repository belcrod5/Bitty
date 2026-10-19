import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import type { RunnerWsMessage, RunnerWsMessageFilter } from "../../runnerWs/types";
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
const playUiSfx = jest.fn();
const messageHandlers = new Map<string, (message: RunnerWsMessage) => void>();
let runnerConnectionState = "ready";
let runnerSnapshotListener: (() => void) | null = null;
const runnerWebSocketManager = {
  subscribe: (filter: RunnerWsMessageFilter, handler: (message: RunnerWsMessage) => void) => {
    messageHandlers.set(String(filter.op), handler);
    return () => { if (messageHandlers.get(String(filter.op)) === handler) messageHandlers.delete(String(filter.op)); };
  },
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
  popupBackendId = "codex",
  popupDirectory = "/repo",
  popupIsHydrating = false,
} = {}) {
  const getPopupSessionTarget = () => ({
    backendId: popupBackendId,
    sessionId: popup,
    directory: popupDirectory,
    isHydrating: popupIsHydrating,
  });
  const getRunnerHttpAuth = async () => ({ baseUrl: "https://runner", token: "token" });
  const normalizedLlmDirectoryForRequest = () => "/fallback";
  const registeredDirectoryPaths = ["/repo"];
  return renderHook(() => useSessionNotificationLifecycleController({
    playUiSfx,
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
    messageHandlers.clear();
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

  it("sounds once from a live completion even when a local callback also reconciles it", async () => {
    const { result } = await renderController({ popup: "popup-session", popupBackendId: "claude" });
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;
    await act(async () => {
      messageHandlers.get("turn_completed_notification")?.({
        channel: "llm", op: "turn_completed_notification", sessionId: "popup-session",
        payload: { backendId: "claude", directory: "/repo", previewText: "" },
      });
      result.current.handleForegroundSessionCompletion({ backendId: "claude", sessionId: "popup-session", directory: "/repo" });
    });
    expect(playUiSfx).toHaveBeenCalledTimes(1);
    expect(playUiSfx).toHaveBeenCalledWith("reply");
    expect(markRead).toHaveBeenCalledWith(expect.objectContaining({ backendId: "claude", sessionId: "popup-session" }));
  });

  it("plays live completion sound before deferred HTTP unread reconciliation without optimistic counts", async () => {
    const { result } = await renderController();
    await waitFor(() => expect(mockSyncUnread).toHaveBeenCalledTimes(1));
    let resolveSnapshot!: (value: { unreadCount: number; directoryCounts: Array<{ directory: string; unreadCount: number }> }) => void;
    mockSyncUnread.mockImplementationOnce(() => new Promise((resolve) => { resolveSnapshot = resolve; }));
    await act(async () => {
      messageHandlers.get("turn_completed_notification")?.({
        channel: "llm", op: "turn_completed_notification", sessionId: "completed-session",
        payload: { backendId: "codex", directory: "/repo" },
      });
    });
    expect(playUiSfx).toHaveBeenCalledTimes(1);
    expect(result.current.unreadCount).toBe(0);
    await act(async () => { resolveSnapshot({ unreadCount: 3, directoryCounts: [{ directory: "/repo", unreadCount: 3 }] }); });
    expect(result.current.unreadCount).toBe(3);
    expect(playUiSfx).toHaveBeenCalledTimes(1);
  });

  it("refreshes unread counts for text-free completions outside the visible chat", async () => {
    const { result } = await renderController();
    await waitFor(() => expect(mockSyncUnread).toHaveBeenCalledTimes(1));
    mockSyncUnread.mockResolvedValue({ unreadCount: 4, directoryCounts: [{ directory: "/repo", unreadCount: 4 }] });
    await act(async () => {
      messageHandlers.get("turn_completed_notification")?.({
        channel: "llm", op: "turn_completed_notification", threadId: "scheduled-session",
        payload: { backendId: "codex", directory: "/repo", previewText: "" },
      });
    });
    expect(playUiSfx).toHaveBeenCalledTimes(1);
    expect(result.current.unreadCount).toBe(4);
    expect(result.current.directoryUnreadCountByPath).toEqual({ "/repo": 4 });
  });

  it.each(["background", "inactive"])("keeps %s completions silent and does not replay them on resume", async (state) => {
    const { result } = await renderController({ popup: "popup-session" });
    await waitFor(() => expect(mockSyncUnread).toHaveBeenCalledTimes(1));
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;
    Object.defineProperty(AppState, "currentState", { configurable: true, writable: true, value: state });
    await act(async () => {
      messageHandlers.get("turn_completed_notification")?.({
        channel: "llm", op: "turn_completed_notification", sessionId: "popup-session",
        payload: { backendId: "codex", directory: "/repo" },
      });
      result.current.handleForegroundSessionCompletion({ backendId: "codex", sessionId: "popup-session", directory: "/repo" });
    });
    expect(mockSyncUnread).toHaveBeenCalledTimes(1);
    expect(markRead).not.toHaveBeenCalled();
    Object.defineProperty(AppState, "currentState", { configurable: true, writable: true, value: "active" });
    await act(async () => { appStateListener?.("active"); });
    expect(mockSyncUnread).toHaveBeenCalledTimes(2);
    expect(playUiSfx).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("keeps voice unread in the native badge and counts only directory sessions in the menu", async () => {
    mockSyncUnread.mockResolvedValue({ unreadCount: 7, voiceUnreadCount: 5, directoryCounts: [{ directory: "/repo", unreadCount: 2 }] });
    const { result } = await renderController();
    await waitFor(() => expect(mockSetBadge).toHaveBeenCalledWith(7));
    expect(result.current.unreadCount).toBe(2);
    await act(async () => {
      result.current.applyUnreadCountSnapshot({ unreadCount: 5, voiceUnreadCount: 5, directoryCounts: [{ directory: "/repo", unreadCount: 0 }] });
    });
    expect(result.current.unreadCount).toBe(0);
    expect(playUiSfx).not.toHaveBeenCalled();
  });

  it("does not treat a selected Skia board card as a visible chat", async () => {
    const { result } = await renderController();
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;
    let handled = false;
    await act(async () => {
      handled = result.current.handleForegroundSessionCompletion({
        backendId: "codex",
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
      handled = result.current.handleForegroundSessionCompletion({ backendId: "codex", sessionId: "popup-session" });
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
        backendId: "codex",
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
        backendId: "codex",
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
      backendId: "codex",
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
      handled = result.current.handleForegroundSessionCompletion({ backendId: "codex", sessionId: "other-session" });
    });
    expect(handled).toBe(false);
    expect(mockSyncUnread).toHaveBeenCalledWith({
      runnerUrl: "https://runner",
      runnerToken: "token",
      directories: ["/repo"],
    });
  });

  it("does not auto-read a visible Codex session when Claude reuses its native id", async () => {
    const { result } = await renderController({ popup: "shared-session", popupBackendId: "codex" });
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;

    expect(result.current.handleForegroundSessionCompletion({
      backendId: "claude",
      sessionId: "shared-session",
      directory: "/repo",
    })).toBe(false);
    expect(markRead).not.toHaveBeenCalled();
  });

  it("auto-reads a visible Claude completion with its full identity", async () => {
    const { result } = await renderController({ popup: "shared-session", popupBackendId: "claude" });
    const markRead = jest.fn();
    result.current.markSessionReadAsyncRef.current = markRead;

    expect(result.current.handleForegroundSessionCompletion({
      backendId: "claude",
      sessionId: "shared-session",
      directory: "/repo",
    })).toBe(true);
    expect(markRead).toHaveBeenCalledWith(expect.objectContaining({
      backendId: "claude",
      sessionId: "shared-session",
    }));
  });

  it("dismisses delivered completion notifications only after a read commit", async () => {
    const { result } = await renderController();
    await act(async () => {
      result.current.handleSessionReadStateCommitted({
        backendId: "codex",
        sessionId: "session-1",
        directory: "/canonical",
        isRead: true,
      });
    });
    expect(mockDismiss).toHaveBeenCalledWith({
      backendId: "codex",
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
