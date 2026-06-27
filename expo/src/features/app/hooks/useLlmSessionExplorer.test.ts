import { buildLlmSessionHistoryEntry } from "./useLlmSessionExplorer";

describe("buildLlmSessionHistoryEntry", () => {
  it("uses the thread cwd instead of the parent discovery scope", () => {
    const entry = buildLlmSessionHistoryEntry({
      threadId: "session-1",
      cwd: "/workspace/bitty/subagent-worktree",
    } as never, ".", new Map());

    expect(entry.directory).toBe("/workspace/bitty/subagent-worktree");
    expect(entry.cwd).toBe("/workspace/bitty/subagent-worktree");
  });

  it("falls back to the discovery scope when cwd is unavailable", () => {
    const entry = buildLlmSessionHistoryEntry({
      threadId: "session-1",
      cwd: "",
    } as never, "/workspace/bitty", new Map());

    expect(entry.directory).toBe("/workspace/bitty");
  });
});
