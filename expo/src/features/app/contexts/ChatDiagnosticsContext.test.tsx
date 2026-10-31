import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { ChatDiagnosticsProvider, useDirectoryGitChangedFiles, type ChatDiagnosticsContextValue } from "./ChatDiagnosticsContext";

test("Git revalidates only displayed directories on resume and releases the listener on close", async () => {
  const previousState = AppState.currentState;
  AppState.currentState = "active";
  const listeners = new Set<(state: AppStateStatus) => void>();
  const spy = jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    listeners.add(listener);
    return { remove: () => { listeners.delete(listener); } };
  });
  const refreshGitChangedFiles = jest.fn(async () => {});
  const value = { gitChangedFilesByDirectory: {}, refreshGitChangedFiles } as unknown as ChatDiagnosticsContextValue;
  const wrapper = ({ children }: { children: React.ReactNode }) => <ChatDiagnosticsProvider value={value}>{children}</ChatDiagnosticsProvider>;
  const { rerender, unmount } = await renderHook(({ directory }: { directory: string }) => useDirectoryGitChangedFiles(directory), {
    wrapper, initialProps: { directory: "/visible" },
  });
  refreshGitChangedFiles.mockClear();
  await act(async () => { listeners.forEach((listener) => listener("active")); });
  expect(refreshGitChangedFiles).toHaveBeenCalledTimes(1);
  expect(refreshGitChangedFiles).toHaveBeenLastCalledWith("/visible", { force: true });
  await rerender({ directory: "/other" });
  expect(refreshGitChangedFiles).toHaveBeenLastCalledWith("/other", { force: true });
  await unmount();
  refreshGitChangedFiles.mockClear();
  await act(async () => { listeners.forEach((listener) => listener("active")); });
  expect(refreshGitChangedFiles).not.toHaveBeenCalled();
  spy.mockRestore();
  AppState.currentState = previousState;
});
