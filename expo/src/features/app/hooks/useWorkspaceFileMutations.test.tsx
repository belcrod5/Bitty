import { act, renderHook } from "@testing-library/react-native";
import { useWorkspaceFileMutations } from "./useWorkspaceFileMutations";
import { mutateWorkspaceFile, writeWorkspaceTextFile } from "../utils/workspaceFiles";

jest.mock("../utils/workspaceFiles", () => ({
  createWorkspaceTextFile: jest.fn(),
  mutateWorkspaceFile: jest.fn(),
  writeWorkspaceTextFile: jest.fn(),
}));

const mockRenameBoardFile = jest.fn();
const mockMarkFileUnavailable = jest.fn();
jest.mock("../contexts/SkiaBoardContext", () => ({
  useSkiaBoard: () => ({
    renameFile: mockRenameBoardFile,
    markFileUnavailable: mockMarkFileUnavailable,
  }),
}));

const mockMutateWorkspaceFile = mutateWorkspaceFile as jest.MockedFunction<typeof mutateWorkspaceFile>;
const mockWriteWorkspaceTextFile = writeWorkspaceTextFile as jest.MockedFunction<
  typeof writeWorkspaceTextFile
>;

async function renderMutations(showInfoToast = jest.fn()) {
  return await renderHook(() => useWorkspaceFileMutations({
    runnerUrl: "http://localhost:8787",
    runnerToken: "token",
    rootDirectory: "/workspace",
    refreshChangedFiles: jest.fn(),
    showInfoToast,
  }));
}

beforeEach(() => {
  mockMutateWorkspaceFile.mockReset();
  mockWriteWorkspaceTextFile.mockReset();
  mockRenameBoardFile.mockReset();
  mockMarkFileUnavailable.mockReset();
});

test("updates the board reference after a successful rename", async () => {
  const hook = await renderMutations();
  const result = { ok: true, path: "docs/renamed.md", previousPath: "docs/guide.md" };
  mockMutateWorkspaceFile.mockResolvedValue(result);
  const target = { path: "docs/guide.md", name: "guide.md" };

  await act(async () => {
    await hook.result.current.renameFileTarget(target, "renamed.md");
  });

  expect(mockRenameBoardFile).toHaveBeenCalledWith(
    "/workspace",
    "docs/guide.md",
    "docs/renamed.md"
  );
});

test("marks the board reference unavailable after a successful delete", async () => {
  const hook = await renderMutations();
  mockMutateWorkspaceFile.mockResolvedValue({ ok: true, path: "docs/guide.md" });
  const target = { path: "docs/guide.md", name: "guide.md" };

  await act(async () => {
    await hook.result.current.deleteFile(target);
  });

  expect(mockMarkFileUnavailable).toHaveBeenCalledWith("/workspace", "docs/guide.md");
});

test("keeps the path available when rename succeeds without changing its normalized path", async () => {
  const hook = await renderMutations();
  mockMutateWorkspaceFile.mockResolvedValue({
    ok: true,
    path: " docs\\guide.md ",
    previousPath: "docs/guide.md",
  });

  await act(async () => {
    await hook.result.current.renameFileTarget(
      { path: "docs/guide.md", name: "guide.md" },
      "guide.md"
    );
  });

  expect(mockRenameBoardFile).not.toHaveBeenCalled();
});

test("does not mark a path unavailable when the mutation fails", async () => {
  const hook = await renderMutations();
  mockMutateWorkspaceFile.mockRejectedValue(new Error("failed"));

  await act(async () => {
    await expect(hook.result.current.renameFileTarget(
      { path: "docs/guide.md", name: "guide.md" },
      "renamed.md"
    )).rejects.toThrow("failed");
  });

  expect(mockRenameBoardFile).not.toHaveBeenCalled();
});

test.each(["/work/other/tasks", "/", "D:/"])(
  "writes viewer content with its location root %s instead of the current chat root",
  async (targetRootDirectory) => {
    const targetPath = targetRootDirectory === "/"
      ? "/today.checklist"
      : `${targetRootDirectory.replace(/\/$/u, "")}/today.checklist`;
    const hook = await renderMutations();
    mockWriteWorkspaceTextFile.mockResolvedValue({
      ok: true,
      path: targetPath,
      version: "version-2",
    });

    await act(async () => {
      await hook.result.current.writeFileContent(
        {
          path: targetPath,
          name: "today.checklist",
          rootDirectory: targetRootDirectory,
        },
        "- [x] A\n",
        "version-1",
      );
    });

    expect(mockWriteWorkspaceTextFile).toHaveBeenCalledWith(expect.objectContaining({
      rootDirectory: targetRootDirectory,
      path: targetPath,
    }));
  },
);

test("falls back to the current root when a save target has no location root", async () => {
  const showInfoToast = jest.fn();
  const hook = await renderMutations(showInfoToast);
  mockWriteWorkspaceTextFile.mockResolvedValue({
    ok: true,
    path: "docs/note.md",
    version: "version-2",
  });

  await act(async () => {
    await hook.result.current.writeFileContent(
      { path: "docs/note.md", name: "note.md" },
      "after",
      "version-1",
    );
  });

  expect(mockWriteWorkspaceTextFile).toHaveBeenCalledWith(expect.objectContaining({
    rootDirectory: "/workspace",
    path: "docs/note.md",
  }));
  expect(showInfoToast).toHaveBeenCalledWith("保存しました: docs/note.md");
});

test("auto-saves without showing the manual save success toast", async () => {
  const showInfoToast = jest.fn();
  const hook = await renderMutations(showInfoToast);
  mockWriteWorkspaceTextFile.mockResolvedValue({
    ok: true,
    path: "tasks/today.checklist",
    version: "version-2",
  });

  await act(async () => {
    await hook.result.current.autoSaveFileContent(
      { path: "tasks/today.checklist", name: "today.checklist" },
      "- [x] A\n",
      "version-1",
    );
  });

  expect(mockWriteWorkspaceTextFile).toHaveBeenCalledTimes(1);
  expect(showInfoToast).not.toHaveBeenCalled();
});
