import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import { usePendingPushSessionNavigationController } from "./usePendingPushSessionNavigationController";
import {
  clearPendingPushSessionTarget,
  getPendingPushSessionTarget,
  subscribePendingPushSessionTarget,
  type PendingPushSessionTarget,
} from "../utils/pushApprovalNotifications";

jest.mock("../utils/pushApprovalNotifications", () => ({
  clearPendingPushSessionTarget: jest.fn(),
  getPendingPushSessionTarget: jest.fn(),
  subscribePendingPushSessionTarget: jest.fn(),
}));

const mockClear = clearPendingPushSessionTarget as jest.Mock;
const mockGet = getPendingPushSessionTarget as jest.Mock;
const mockSubscribe = subscribePendingPushSessionTarget as jest.Mock;

function target(sessionId: string, directory: string, sequence: number): PendingPushSessionTarget {
  return { sessionId, directory, sequence };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe("usePendingPushSessionNavigationController", () => {
  let appStateListeners: Array<(state: "active" | "background" | "inactive") => void>;
  let storeListener: (() => void) | null;
  let currentTarget: PendingPushSessionTarget | null;
  const originalAppStateDescriptor = Object.getOwnPropertyDescriptor(AppState, "currentState");

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(AppState, "currentState", {
      configurable: true,
      writable: true,
      value: "active",
    });
    appStateListeners = [];
    storeListener = null;
    currentTarget = null;
    mockGet.mockImplementation(() => currentTarget);
    mockClear.mockImplementation((expected: PendingPushSessionTarget) => {
      if (currentTarget?.sequence !== expected.sequence) return false;
      currentTarget = null;
      return true;
    });
    mockSubscribe.mockImplementation((listener: () => void) => {
      storeListener = listener;
      return jest.fn();
    });
    jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
      appStateListeners.push(listener as (state: "active" | "background" | "inactive") => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
  });

  afterEach(() => {
    if (originalAppStateDescriptor) {
      Object.defineProperty(AppState, "currentState", originalAppStateDescriptor);
    }
    jest.restoreAllMocks();
  });

  async function renderController(overrides: { settingsLoaded?: boolean; open?: jest.Mock } = {}) {
    const closeDrawer = jest.fn();
    const open = overrides.open || jest.fn().mockResolvedValue(true);
    const rendered = await renderHook(() => usePendingPushSessionNavigationController({
      settingsLoaded: overrides.settingsLoaded ?? true,
      normalizedLlmDirectoryForRequest: () => "/fallback",
      closeDrawer,
      openSessionHistoryPopup: open,
    }));
    return { ...rendered, closeDrawer, open };
  }

  it("retains a cold-start intent until the current popup path opens successfully", async () => {
    currentTarget = target("session-abc", "/repo", 1);
    const pending = deferred<boolean>();
    const { open, closeDrawer } = await renderController({
      open: jest.fn(() => pending.promise),
    });
    expect(closeDrawer).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith({
      sessionId: "session-abc",
      source: "notification",
      directory: "/repo",
      origin: "drawer",
    });
    expect(mockClear).not.toHaveBeenCalled();

    await act(async () => pending.resolve(true));
    expect(mockClear).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }));
  });

  it("does not navigate while settings are loading or the app is backgrounded", async () => {
    currentTarget = target("session-abc", "/repo", 1);
    AppState.currentState = "background";
    const { open } = await renderController({ settingsLoaded: false });
    expect(open).not.toHaveBeenCalled();
  });

  it("reacts when a response arrives after AppState is already active", async () => {
    const { open } = await renderController();
    expect(open).not.toHaveBeenCalled();
    currentTarget = target("session-late", "/late", 2);
    await act(async () => storeListener?.());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-late",
      directory: "/late",
    }));
  });

  it("keeps a failed intent and opens a newer intent after an older navigation settles", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const open = jest.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    currentTarget = target("old", "/old", 1);
    await renderController({ open });
    currentTarget = target("new", "/new", 2);
    await act(async () => storeListener?.());
    expect(open).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve(true));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "new" }));
    await act(async () => second.resolve(false));
    expect(currentTarget?.sessionId).toBe("new");
  });

  it("retries a retained target when the app becomes active", async () => {
    AppState.currentState = "background";
    currentTarget = target("warm", "", 3);
    const { open } = await renderController();
    expect(open).not.toHaveBeenCalled();
    AppState.currentState = "active";
    await act(async () => appStateListeners.forEach((listener) => listener("active")));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "warm",
      directory: "/fallback",
    }));
  });

  it("retains a rejected intent without creating an unhandled navigation failure", async () => {
    currentTarget = target("rejected", "/repo", 4);
    const { open } = await renderController({
      open: jest.fn().mockRejectedValue(new Error("hydrate failed")),
    });
    await act(async () => {});
    expect(open).toHaveBeenCalledTimes(1);
    expect(mockClear).not.toHaveBeenCalled();
    expect(currentTarget?.sessionId).toBe("rejected");
  });
});
