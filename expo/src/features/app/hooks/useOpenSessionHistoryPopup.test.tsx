import { act, renderHook } from "@testing-library/react-native";

import { useOpenSessionHistoryPopup } from "./useOpenSessionHistoryPopup";

function options(hydrate: jest.Mock) {
  return {
    panelId: "drawer-popup",
    resolveContext: () => ({
      backendId: "codex",
      sessionId: "session-1",
      directory: "/workspace",
      directoryDisplayName: "workspace",
      sessionTitle: "Session",
      updatedAt: "",
      modelRef: "",
      reasoningEffort: "",
      contextUsedPct: null,
    }),
    hydrate,
    markRead: jest.fn(),
    presentPanel: jest.fn(),
    requestClose: jest.fn(),
    setCycleId: jest.fn(),
    setSourceRect: jest.fn(),
    setOrigin: jest.fn(),
    setHighlight: jest.fn(),
    showToast: jest.fn(),
    log: jest.fn(),
  };
}

test("requests the displayed popup to close when hydration fails", async () => {
  const currentOptions = options(jest.fn(async () => "failed" as const));
  const { result } = await renderHook(() => useOpenSessionHistoryPopup(currentOptions));

  await act(async () => {
    await result.current({ sessionId: "session-1", source: "all" });
  });

  expect(currentOptions.presentPanel).toHaveBeenCalledWith("drawer-popup");
  expect(currentOptions.requestClose).toHaveBeenCalledWith({ clearHighlight: true });
});

test("does not request a close when validation fails before presentation", async () => {
  const currentOptions = options(jest.fn());
  const { result } = await renderHook(() => useOpenSessionHistoryPopup(currentOptions));

  await act(async () => {
    await result.current({ sessionId: "", source: "all" });
  });

  expect(currentOptions.presentPanel).not.toHaveBeenCalled();
  expect(currentOptions.requestClose).not.toHaveBeenCalled();
});
