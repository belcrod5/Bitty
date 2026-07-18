import { act, renderHook } from "@testing-library/react-native";
import { useRunnerHttpAuthBootstrap } from "./useRunnerHttpAuthBootstrap";

type HookProps = {
  settingsLoaded: boolean;
  baseUrl: string;
  token: string;
  onSettingsLoadedOnceRef: { current: () => void };
};

function renderBootstrapHook(initialProps: HookProps) {
  return renderHook(
    (props: HookProps) => useRunnerHttpAuthBootstrap(props),
    { initialProps }
  );
}

describe("useRunnerHttpAuthBootstrap", () => {
  it("holds early callers until settings load, then returns the live credentials", async () => {
    const onSettingsLoadedOnceRef = { current: jest.fn() };
    const { result, rerender } = await renderBootstrapHook({
      settingsLoaded: false,
      baseUrl: "",
      token: "",
      onSettingsLoadedOnceRef,
    });

    // Fired before settings load (like MiniBoard effects): must not resolve
    // with the empty startup token.
    const earlyCall = result.current();
    const settled = jest.fn();
    void earlyCall.then(settled);
    await act(async () => {});
    expect(settled).not.toHaveBeenCalled();

    // Settings commit real credentials, then settingsLoaded flips.
    await act(async () => {
      rerender({
        settingsLoaded: false,
        baseUrl: "http://runner.test",
        token: " runner-token ",
        onSettingsLoadedOnceRef,
      });
    });
    expect(settled).not.toHaveBeenCalled();
    await act(async () => {
      rerender({
        settingsLoaded: true,
        baseUrl: "http://runner.test",
        token: " runner-token ",
        onSettingsLoadedOnceRef,
      });
    });

    await expect(earlyCall).resolves.toEqual({
      baseUrl: "http://runner.test",
      token: "runner-token",
    });
    // Later callers resolve immediately with the current credentials.
    await expect(result.current()).resolves.toEqual({
      baseUrl: "http://runner.test",
      token: "runner-token",
    });
  });

  it("fires the one-shot recovery exactly once on the settingsLoaded transition", async () => {
    const onSettingsLoadedOnceRef = { current: jest.fn() };
    const { rerender } = await renderBootstrapHook({
      settingsLoaded: false,
      baseUrl: "http://runner.test",
      token: "runner-token",
      onSettingsLoadedOnceRef,
    });
    expect(onSettingsLoadedOnceRef.current).not.toHaveBeenCalled();

    await act(async () => {
      rerender({
        settingsLoaded: true,
        baseUrl: "http://runner.test",
        token: "runner-token",
        onSettingsLoadedOnceRef,
      });
    });
    expect(onSettingsLoadedOnceRef.current).toHaveBeenCalledTimes(1);

    // Re-renders with settingsLoaded still true must not re-fire it.
    await act(async () => {
      rerender({
        settingsLoaded: true,
        baseUrl: "http://runner.test",
        token: "next-token",
        onSettingsLoadedOnceRef,
      });
    });
    expect(onSettingsLoadedOnceRef.current).toHaveBeenCalledTimes(1);
  });
});
