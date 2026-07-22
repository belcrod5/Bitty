import { fireEvent, render, waitFor } from "@testing-library/react-native";

import { WorkspaceTextFileEditor } from "./WorkspaceTextFileEditor";

const mockFetchRunnerTextFileContent = jest.fn();

jest.mock("../utils/runnerFileContent", () => ({
  fetchRunnerTextFileContent: (...args: unknown[]) => mockFetchRunnerTextFileContent(...args),
}));

test("saves with the version returned when the file was opened", async () => {
  mockFetchRunnerTextFileContent.mockResolvedValue({
    path: "project/note.md",
    content: "before",
    totalBytes: 6,
    version: "opened-version",
  });
  const onSave = jest.fn().mockResolvedValue(undefined);
  const onClose = jest.fn();
  const view = await render(
    <WorkspaceTextFileEditor
      target={{ path: "project/note.md", name: "note.md" }}
      runnerUrl="http://runner.test"
      runnerToken="token"
      rootDirectory="project"
      onClose={onClose}
      onSave={onSave}
    />
  );

  const editor = view.getByTestId("workspace-text-file-editor-input");
  await waitFor(() => expect(editor.props.value).toBe("before"));
  await fireEvent.changeText(editor, "after");
  await fireEvent.press(view.getByText("保存"));

  await waitFor(() => expect(onSave).toHaveBeenCalledWith(
    { path: "project/note.md", name: "note.md" },
    "after",
    "opened-version"
  ));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});
