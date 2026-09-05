import { fireEvent, render, waitFor } from "@testing-library/react-native";

import { WorkspaceTextFileEditor } from "./WorkspaceTextFileEditor";

const mockFetchRunnerTextFileContent = jest.fn();

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name) };
});

jest.mock("../utils/runnerFileContent", () => ({
  fetchRunnerTextFileContent: (...args: unknown[]) => mockFetchRunnerTextFileContent(...args),
}));

jest.mock("./MarkdownText", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    MarkdownText: ({ content }: { content: string }) => (
      React.createElement(Text, { testID: "markdown-preview" }, content)
    ),
  };
});

beforeEach(() => {
  mockFetchRunnerTextFileContent.mockReset();
});

test("saves with the version returned when the file was opened", async () => {
  mockFetchRunnerTextFileContent.mockResolvedValue({
    path: "project/note.md",
    content: "before",
    totalBytes: 6,
    version: "opened-version",
  });
  const onSave = jest.fn().mockResolvedValue({
    ok: true,
    path: "project/note.md",
    version: "saved-version",
  });
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

test("opens Markdown in edit mode and previews the current content", async () => {
  mockFetchRunnerTextFileContent.mockResolvedValue({
    path: "/external/note.md",
    content: "# Before",
    totalBytes: 8,
    version: "opened-version",
  });
  const view = await render(
    <WorkspaceTextFileEditor
      target={{
        path: "/external/note.md",
        name: "note.md",
        rootDirectory: "/external",
      }}
      runnerUrl="http://runner.test"
      runnerToken="token"
      rootDirectory="/workspace"
      onClose={jest.fn()}
      onSave={jest.fn()}
    />
  );

  const editor = view.getByTestId("workspace-text-file-editor-input");
  await waitFor(() => expect(editor.props.value).toBe("# Before"));
  expect(mockFetchRunnerTextFileContent).toHaveBeenCalledWith(expect.objectContaining({
    rootDir: "/external",
    path: "/external/note.md",
  }));

  await fireEvent.changeText(editor, "# After");
  await fireEvent.press(view.getByLabelText("プレビューを表示"));

  expect(view.getByTestId("markdown-preview").props.children).toBe("# After");
  expect(view.getByText("保存")).toBeTruthy();
  await fireEvent.press(view.getByLabelText("編集モードに戻る"));
  expect(view.getByTestId("workspace-text-file-editor-input").props.value).toBe("# After");
});

test("previews txt files as selectable plain text", async () => {
  mockFetchRunnerTextFileContent.mockResolvedValue({
    path: "notes.txt",
    content: "# Plain text",
    totalBytes: 12,
    version: "opened-version",
  });
  const view = await render(
    <WorkspaceTextFileEditor
      target={{ path: "notes.txt", name: "notes.txt" }}
      runnerUrl="http://runner.test"
      runnerToken="token"
      rootDirectory="/workspace"
      onClose={jest.fn()}
      onSave={jest.fn()}
    />
  );

  await waitFor(() => expect(
    view.getByTestId("workspace-text-file-editor-input").props.value
  ).toBe("# Plain text"));
  await fireEvent.press(view.getByLabelText("プレビューを表示"));

  expect(view.getByText("# Plain text").props.selectable).toBe(true);
  expect(view.queryByTestId("markdown-preview")).toBeNull();
});
