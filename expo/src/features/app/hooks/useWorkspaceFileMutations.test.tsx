import { act, renderHook } from "@testing-library/react-native";
import { useWorkspaceFileMutations } from "./useWorkspaceFileMutations";
import { mutateWorkspaceFile } from "../utils/workspaceFiles";

jest.mock("../utils/workspaceFiles", () => ({
  createWorkspaceTextFile: jest.fn(),
  mutateWorkspaceFile: jest.fn(),
  writeWorkspaceTextFile: jest.fn(),
}));

const mockMutateWorkspaceFile = mutateWorkspaceFile as jest.MockedFunction<typeof mutateWorkspaceFile>;

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
