import { renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import { usePendingPushSessionNavigationController } from "./usePendingPushSessionNavigationController";
import { consumePendingPushSessionId } from "../utils/pushApprovalNotifications";

jest.mock("../utils/pushApprovalNotifications", () => ({
  consumePendingPushSessionId: jest.fn(),
  setPendingPushSessionId: jest.fn(),
}));

const mockConsumePendingPushSessionId = consumePendingPushSessionId as jest.Mock;

describe("usePendingPushSessionNavigationController", () => {
  let appStateListeners: Array<(state: "active" | "background" | "inactive") => void>;

  beforeEach(() => {
    jest.clearAllMocks();
    appStateListeners = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
      appStateListeners.push(listener as (state: "active" | "background" | "inactive") => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does nothing while settings have not finished loading", async () => {
    mockConsumePendingPushSessionId.mockReturnValue("session-abc");
    const selectSpecificLlmSession = jest.fn();

    await renderHook(() =>
      usePendingPushSessionNavigationController({
        settingsLoaded: false,
        normalizedLlmDirectoryForRequest: () => "/workspace",
        selectSpecificLlmSession,
      })
    );

    expect(selectSpecificLlmSession).not.toHaveBeenCalled();
  });

  it("navigates to the pending session once settings are loaded (cold start via notification tap)", async () => {
    mockConsumePendingPushSessionId.mockReturnValue("session-abc");
    const selectSpecificLlmSession = jest.fn().mockResolvedValue(true);

    await renderHook(() =>
      usePendingPushSessionNavigationController({
        settingsLoaded: true,
        normalizedLlmDirectoryForRequest: () => "/workspace",
        selectSpecificLlmSession,
      })
    );

    expect(selectSpecificLlmSession).toHaveBeenCalledWith("session-abc", {
      source: "notification",
      directory: "/workspace",
    });
  });

  it("does not navigate when there is no pending session id", async () => {
    mockConsumePendingPushSessionId.mockReturnValue("");
    const selectSpecificLlmSession = jest.fn();

    await renderHook(() =>
      usePendingPushSessionNavigationController({
        settingsLoaded: true,
        normalizedLlmDirectoryForRequest: () => "/workspace",
        selectSpecificLlmSession,
      })
    );

    expect(selectSpecificLlmSession).not.toHaveBeenCalled();
  });

  it("re-checks for a pending session id when the app returns to foreground (warm start)", async () => {
    mockConsumePendingPushSessionId.mockReturnValue("");
    const selectSpecificLlmSession = jest.fn();

    await renderHook(() =>
      usePendingPushSessionNavigationController({
        settingsLoaded: true,
        normalizedLlmDirectoryForRequest: () => "/workspace",
        selectSpecificLlmSession,
      })
    );
    expect(selectSpecificLlmSession).not.toHaveBeenCalled();

    mockConsumePendingPushSessionId.mockReturnValue("session-xyz");
    appStateListeners.forEach((listener) => listener("active"));

    expect(selectSpecificLlmSession).toHaveBeenCalledWith("session-xyz", {
      source: "notification",
      directory: "/workspace",
    });
  });
});
