import { act, renderHook } from "@testing-library/react-native";
import { useWorkspaceFileMutations } from "./useWorkspaceFileMutations";
import { mutateWorkspaceFile, writeWorkspaceTextFile } from "../utils/workspaceFiles";

jest.mock("../utils/workspaceFiles", () => ({
  createWorkspaceTextFile: jest.fn(),
  mutateWorkspaceFile: jest.fn(),
  writeWorkspaceTextFile: jest.fn(),
}));

const mockMutateWorkspaceFile = mutateWorkspaceFile as jest.MockedFunction<typeof mutateWorkspaceFile>;
const mockWriteWorkspaceTextFile = writeWorkspaceTextFile as jest.MockedFunction<
  typeof writeWorkspaceTextFile
>;

async function renderMutations(onPathRemoved: jest.Mock) {
  return await renderHook(() => useWorkspaceFileMutations({
    runnerUrl: "http://localhost:8787",
    runnerToken: "token",
    rootDirectory: "/workspace",
    refreshChangedFiles: jest.fn(),
    showInfoToast: jest.fn(),
    onPathRemoved,
  }));
}

beforeEach(() => {
  mockMutateWorkspaceFile.mockReset();
  mockWriteWorkspaceTextFile.mockReset();
});

test.each([
  ["rename" as const, { path: "docs/renamed.md", previousPath: "docs/guide.md" }],
  ["delete" as const, { path: "docs/guide.md" }],
])("reports the old path after a successful %s", async (operation, result) => {
  const onPathRemoved = jest.fn();
  const hook = await renderMutations(onPathRemoved);
  mockMutateWorkspaceFile.mockResolvedValue({ ok: true, ...result });
  const target = { path: "docs/guide.md", name: "guide.md" };

  await act(async () => {
    if (operation === "rename") {
      await hook.result.current.renameFileTarget(target, "renamed.md");
    } else {
      await hook.result.current.deleteFile(target);
    }
  });

  expect(onPathRemoved).toHaveBeenCalledWith(target);
});

test("keeps the path available when rename succeeds without changing its normalized path", async () => {
  const onPathRemoved = jest.fn();
  const hook = await renderMutations(onPathRemoved);
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

  expect(onPathRemoved).not.toHaveBeenCalled();
});

test("does not mark a path unavailable when the mutation fails", async () => {
  const onPathRemoved = jest.fn();
  const hook = await renderMutations(onPathRemoved);
  mockMutateWorkspaceFile.mockRejectedValue(new Error("failed"));

  await act(async () => {
    await expect(hook.result.current.renameFileTarget(
      { path: "docs/guide.md", name: "guide.md" },
      "renamed.md"
    )).rejects.toThrow("failed");
  });

  expect(onPathRemoved).not.toHaveBeenCalled();
});

test.each(["/work/other/tasks", "/", "D:/"])(
  "writes viewer content with its location root %s instead of the current chat root",
  async (targetRootDirectory) => {
    const hook = await renderMutations(jest.fn());
    mockWriteWorkspaceTextFile.mockResolvedValue({
      ok: true,
      path: "today.checklist",
      version: "version-2",
    });

    await act(async () => {
      await hook.result.current.writeFileContent(
        {
          path: "today.checklist",
          name: "today.checklist",
          rootDirectory: targetRootDirectory,
        },
        "- [x] A\n",
        "version-1",
      );
    });

    expect(mockWriteWorkspaceTextFile).toHaveBeenCalledWith(expect.objectContaining({
      rootDirectory: targetRootDirectory,
      path: "today.checklist",
    }));
  },
);

test("falls back to the current root when a save target has no location root", async () => {
  const hook = await renderMutations(jest.fn());
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
});
