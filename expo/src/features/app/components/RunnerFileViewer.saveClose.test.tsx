import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { RunnerFileViewer } from "./RunnerFileViewer";

const mockFetchRunnerTextFileContent = jest.fn();

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-webview", () => ({ WebView: () => null }));
jest.mock("../utils/runnerFileContent", () => ({
  fetchRunnerTextFileContent: (...args: unknown[]) => mockFetchRunnerTextFileContent(...args),
}));

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
        path: "tasks/today.checklist",
        name: "today.checklist",
      }}
      runnerUrl="http://runner.test"
      runnerToken="token"
      rootDirectory="project"
      onRequestClose={onRequestClose}
      onSave={onSave}
    />
  );

  const toggle = await view.findByTestId("checklist-toggle-0");
  await fireEvent.press(toggle);
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

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
