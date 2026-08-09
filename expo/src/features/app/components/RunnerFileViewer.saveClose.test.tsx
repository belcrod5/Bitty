import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { RunnerFileViewer } from "./RunnerFileViewer";

const mockFetchRunnerTextFileContent = jest.fn();
const mockGestureHandlerRootView = jest.fn();

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-webview", () => ({ WebView: () => null }));
jest.mock("react-native-gesture-handler", () => {
  const actual = jest.requireActual("react-native-gesture-handler");
  const ReactModule = jest.requireActual("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    ...actual,
    GestureHandlerRootView: ({ children, ...props }: { children?: React.ReactNode }) => {
      mockGestureHandlerRootView(props);
      return ReactModule.createElement(View, props, children);
    },
  };
});
jest.mock("../utils/runnerFileContent", () => ({
  fetchRunnerTextFileContent: (...args: unknown[]) => mockFetchRunnerTextFileContent(...args),
}));

beforeEach(() => {
  mockFetchRunnerTextFileContent.mockReset();
  mockGestureHandlerRootView.mockClear();
});

test("blocks both close controls until an auto-save finishes", async () => {
  mockFetchRunnerTextFileContent.mockResolvedValue({
    path: "tasks/today.checklist",
    content: "- [ ] A\n",
    totalBytes: 8,
    version: "version-1",
  });
  let resolveSave: ((value: {
    ok: true;
    path: string;
    version: string;
  }) => void) | undefined;
  const onSave = jest.fn(() => new Promise<{
    ok: true;
    path: string;
    version: string;
  }>((resolve) => {
    resolveSave = resolve;
  }));
  const onRequestClose = jest.fn();
  const view = await render(
    <RunnerFileViewer
      target={{
        kind: "checklist",
        path: "today.checklist",
        name: "today.checklist",
        rootDirectory: "/work/other/tasks",
      }}
      runnerUrl="http://runner.test"
      runnerToken="token"
      onRequestClose={onRequestClose}
      onSave={onSave}
    />
  );

  const toggle = await view.findByTestId("checklist-toggle-0");
  expect(view.getByTestId("runner-file-viewer-gesture-root")).toBeTruthy();
  expect(mockGestureHandlerRootView).toHaveBeenCalled();
  expect(mockFetchRunnerTextFileContent).toHaveBeenCalledWith(expect.objectContaining({
    rootDir: "/work/other/tasks",
    path: "today.checklist",
  }));
  await fireEvent.press(toggle);
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ path: "today.checklist", rootDirectory: "/work/other/tasks" }),
    "- [x] A\n",
    "version-1",
  );

  const savingClose = view.getByTestId("runner-file-viewer-close");
  expect(savingClose.props.accessibilityState.disabled).toBe(true);
  expect(savingClose.props.accessibilityLabel).toContain("保存中");
  await fireEvent.press(savingClose);
  view.getByTestId("runner-file-viewer-modal").props.onRequestClose();
  expect(onRequestClose).not.toHaveBeenCalled();

  resolveSave?.({
    ok: true,
    path: "tasks/today.checklist",
    version: "version-2",
  });
  await waitFor(() => expect(
    view.getByTestId("runner-file-viewer-close").props.accessibilityState.disabled,
  ).toBe(false));

  await fireEvent.press(view.getByTestId("runner-file-viewer-close"));
  expect(onRequestClose).toHaveBeenCalledTimes(1);
});

test.each(["/", "D:/"])("uses the root-level location %s for both read and save", async (rootDirectory) => {
  mockFetchRunnerTextFileContent.mockResolvedValue({
    path: "root.checklist",
    content: "- [ ] A\n",
    totalBytes: 8,
    version: "version-1",
  });
  const onSave = jest.fn().mockResolvedValue({
    ok: true,
    path: "root.checklist",
    version: "version-2",
  });
  const targetPath = rootDirectory === "/" ? "/root.checklist" : `${rootDirectory}root.checklist`;
  const target = {
    kind: "checklist" as const,
    path: targetPath,
    name: "root.checklist",
    rootDirectory,
  };
  const view = await render(
    <RunnerFileViewer
      target={target}
      runnerUrl="http://runner.test"
      runnerToken="token"
      onRequestClose={jest.fn()}
      onSave={onSave}
    />
  );

  await fireEvent.press(await view.findByTestId("checklist-toggle-0"));
  expect(mockFetchRunnerTextFileContent).toHaveBeenCalledWith(expect.objectContaining({
    rootDir: rootDirectory,
    path: targetPath,
  }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(
    target,
    "- [x] A\n",
    "version-1",
  ));
});
