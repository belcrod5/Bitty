import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { useCodexStatusRefreshEffects } from "./useCodexStatusRefreshEffects";

test("initial and short foreground resume refresh shared usage without a screen restriction", async () => {
  let onChange!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, callback) => {
    onChange = callback; return { remove };
  });
  const refresh = jest.fn();
  const { unmount } = await renderHook(() => useCodexStatusRefreshEffects({
    runnerUrl: "https://runner", runnerToken: "token", appStateRef: { current: "active" },
    codexCliStatusLastAttemptAtMsRef: { current: 0 }, codexCliStatusAutoRefreshMs: 600000,
    refreshCodexCliStatusForWidget: refresh, refreshCodexAuthProfiles: jest.fn(),
  }));
  expect(refresh).toHaveBeenCalledWith({ force: true, source: "initial" });
  await act(async () => { onChange("background"); onChange("active"); });
  expect(refresh).toHaveBeenLastCalledWith({ source: "resume" });
  await unmount();
  expect(remove).toHaveBeenCalled();
  jest.restoreAllMocks();
});
