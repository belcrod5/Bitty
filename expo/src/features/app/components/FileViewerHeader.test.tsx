import { StrictMode } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { FileViewerHeader } from "./FileViewerHeader";
import type { RunnerFileContextMenuOptions, RunnerFileTarget } from "../utils/runnerFileContextMenu";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../keyboardController", () => ({
  KeyboardAvoidingView: require("react-native").KeyboardAvoidingView,
}));

function fileTarget(): RunnerFileTarget & { openContextMenu: jest.Mock } {
  return {
    path: "docs/note.md",
    name: "note.md",
    rootDirectory: "/external",
    openContextMenu: jest.fn(),
    renameFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(true),
  };
}

async function menuOptions(view: Awaited<ReturnType<typeof render>>, target: ReturnType<typeof fileTarget>) {
  await fireEvent.press(view.getByLabelText("ファイルの操作メニューを開く"));
  return target.openContextMenu.mock.calls[0][0] as RunnerFileContextMenuOptions;
}

test.each([true, false])("closes only after a successful delete (result: %s)", async (success) => {
  const target = fileTarget();
  (target.deleteFile as jest.Mock).mockResolvedValue(success);
  const onClose = jest.fn();
  const onBusyChange = jest.fn();
  const view = await render(
    <FileViewerHeader target={target} saving={false} onClose={onClose} onBusyChange={onBusyChange} />,
  );
  const options = await menuOptions(view, target);
  await act(async () => { await options.onRequestDelete?.(target); });
  expect(target.deleteFile).toHaveBeenCalledWith(target);
  expect(onClose).toHaveBeenCalledTimes(success ? 1 : 0);
  expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
});

test("disables close and menu until deletion completes", async () => {
  const target = fileTarget();
  let resolveDelete!: (result: boolean) => void;
  (target.deleteFile as jest.Mock).mockImplementation(() => new Promise<boolean>((resolve) => {
    resolveDelete = resolve;
  }));
  const onClose = jest.fn();
  const view = await render(
    <FileViewerHeader target={target} saving={false} onClose={onClose} onBusyChange={jest.fn()} />,
  );
  const options = await menuOptions(view, target);
  let deleting!: Promise<boolean | void> | void;
  await act(async () => { deleting = options.onRequestDelete?.(target); });
  expect(view.getByLabelText("ファイルの操作メニューを開く").props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText("ファイルビューアーを閉じる"));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { resolveDelete(true); await deleting; });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("keeps the nested rename dialog and viewer open after failure, then closes on successful retry", async () => {
  const target = fileTarget();
  (target.renameFile as jest.Mock).mockRejectedValueOnce(new Error("failed"))
    .mockResolvedValueOnce(undefined);
  const onClose = jest.fn();
  const onBusyChange = jest.fn();
  const view = await render(
    <FileViewerHeader target={target} saving={false} onClose={onClose} onBusyChange={onBusyChange} />,
  );
  const options = await menuOptions(view, target);
  await act(async () => { options.onRequestRename?.(target); });
  await fireEvent.changeText(view.getByDisplayValue("note.md"), "renamed.md");
  await fireEvent.press(view.getByText("変更"));
  await waitFor(() => expect(target.renameFile).toHaveBeenCalledTimes(1));
  expect(onClose).not.toHaveBeenCalled();
  expect(onBusyChange.mock.calls).toEqual([[true]]);
  expect(view.getByText("ファイル名を変更")).toBeTruthy();
  await waitFor(() => expect(view.getByDisplayValue("renamed.md").props.editable).toBe(true));
  await fireEvent.press(view.getByText("変更"));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(target.renameFile).toHaveBeenLastCalledWith(target, "renamed.md");
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
});

test("rejects delayed mutation actions after a target change or during saving", async () => {
  const target = fileTarget();
  const props = { onClose: jest.fn(), onBusyChange: jest.fn() };
  const view = await render(<FileViewerHeader {...props} target={target} saving={false} />);
  const options = await menuOptions(view, target);
  await view.rerender(<FileViewerHeader {...props} target={target} saving />);
  await act(async () => { options.onRequestRename?.(target); await options.onRequestDelete?.(target); });
  expect(target.renameFile).not.toHaveBeenCalled();
  expect(target.deleteFile).not.toHaveBeenCalled();
  await view.rerender(<FileViewerHeader {...props} target={fileTarget()} saving={false} />);
  await act(async () => { await options.onRequestDelete?.(target); });
  expect(target.deleteFile).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});


test("does not close or unlock a replacement viewer when a StrictMode mutation completes after unmount", async () => {
  const target = fileTarget();
  let resolveDelete!: (result: boolean) => void;
  (target.deleteFile as jest.Mock).mockImplementation(() => new Promise<boolean>((resolve) => {
    resolveDelete = resolve;
  }));
  const onClose = jest.fn();
  const onBusyChange = jest.fn();
  const view = await render(
    <StrictMode>
      <FileViewerHeader target={target} saving={false} onClose={onClose} onBusyChange={onBusyChange} />
    </StrictMode>,
  );
  const options = await menuOptions(view, target);
  let deleting!: Promise<boolean | void> | void;
  await act(async () => { deleting = options.onRequestDelete?.(target); });
  expect(target.deleteFile).toHaveBeenCalledTimes(1);
  await view.unmount();
  await act(async () => { resolveDelete(true); await deleting; });
  expect(onClose).not.toHaveBeenCalled();
  expect(onBusyChange.mock.calls).toEqual([[true]]);
});
