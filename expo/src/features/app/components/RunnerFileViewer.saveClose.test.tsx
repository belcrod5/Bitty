import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import type { RunnerFileContextMenuOptions } from "../utils/runnerFileContextMenu";
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
      onAutoSave={onSave}
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
      onAutoSave={onSave}
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


jest.mock("../keyboardController", () => ({
  KeyboardAvoidingView: require("react-native").KeyboardAvoidingView,
}));


test("blocks checklist writes and native close during file deletion, preserving the viewer on failure", async () => {
  mockFetchRunnerTextFileContent.mockResolvedValue({ content: "- [ ] A\n", version: "v1" });
  let resolveDelete!: (result: boolean) => void;
  const target = {
    kind: "checklist" as const, path: "today.checklist", name: "today.checklist", rootDirectory: "/external",
    openContextMenu: jest.fn(),
    deleteFile: jest.fn(() => new Promise<boolean>((resolve) => { resolveDelete = resolve; })),
  };
  const onAutoSave = jest.fn();
  const onRequestClose = jest.fn();
  const view = await render(
    <RunnerFileViewer target={target} runnerUrl="http://runner.test" runnerToken="token"
      onRequestClose={onRequestClose} onAutoSave={onAutoSave} />,
  );
  await view.findByTestId("checklist-toggle-0");
  await fireEvent.press(view.getByLabelText("ファイルの操作メニューを開く"));
  const options = target.openContextMenu.mock.calls[0][0] as RunnerFileContextMenuOptions;
  let deleting!: Promise<boolean | void> | void;
  await act(async () => { deleting = options.onRequestDelete?.(target); });
  await fireEvent.press(view.getByTestId("checklist-toggle-0"));
  expect(view.getByTestId("checklist-new-item-input").props.editable).toBe(false);
  expect(view.getByTestId("checklist-drag-0").props.accessibilityState.disabled).toBe(true);
  view.getByTestId("runner-file-viewer-modal").props.onRequestClose();
  expect(onAutoSave).not.toHaveBeenCalled();
  expect(onRequestClose).not.toHaveBeenCalled();
  await act(async () => { resolveDelete(false); await deleting; });
  expect(view.getByTestId("checklist-new-item-input").props.editable).toBe(true);
  expect(onRequestClose).not.toHaveBeenCalled();
});

test.each(["row", "composer"])("preserves a pending checklist %s draft before rename/delete", async (draftKind) => {
  mockFetchRunnerTextFileContent.mockResolvedValue({ content: "- [ ] A\n", version: "v1" });
  const target = {
    kind: "checklist" as const, path: "today.checklist", name: "today.checklist", rootDirectory: "/external",
    openContextMenu: jest.fn(), renameFile: jest.fn(), deleteFile: jest.fn(),
  };
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const view = await render(
    <RunnerFileViewer target={target} runnerUrl="http://runner.test" runnerToken="token"
      onRequestClose={jest.fn()} onAutoSave={jest.fn()} />,
  );
  await view.findByTestId("checklist-toggle-0");
  const inputID = draftKind === "row" ? "checklist-edit-input-0" : "checklist-new-item-input";
  if (draftKind === "row") await fireEvent.press(view.getByTestId("checklist-text-0"));
  await fireEvent.changeText(view.getByTestId(inputID), "draft");
  await fireEvent.press(view.getByLabelText("ファイルの操作メニューを開く"));
  const options = target.openContextMenu.mock.calls[0][0] as RunnerFileContextMenuOptions;
  await act(async () => { options.onRequestRename?.(target); await options.onRequestDelete?.(target); });
  expect(alert).toHaveBeenCalledWith("項目の編集を完了してください", expect.any(String));
  expect(target.renameFile).not.toHaveBeenCalled();
  expect(target.deleteFile).not.toHaveBeenCalled();
  expect(view.getByTestId(inputID).props.value).toBe("draft");
  alert.mockRestore();
});
