import { resolveSessionHistoryContext } from "./sessionHistoryContext";

describe("resolveSessionHistoryContext", () => {
  it("keeps a subagent cwd and derives its own display name", () => {
    const context = resolveSessionHistoryContext({
      sessionId: "subagent-1",
      registeredDirectories: [{
        id: "root",
        path: "/workspace/bitty",
        displayName: "Bitty",
      }],
      directorySessionsById: {
        root: {
          entries: [],
          childrenByParentId: {
            parent: {
              entries: [{
                sessionId: "subagent-1",
                directory: "/workspace/bitty/subagent-worktree",
                cwd: "/workspace/bitty/subagent-worktree",
                firstUserMessage: "Investigate",
              }],
            },
          },
        },
      },
      sessionTitleOverridesById: {},
    } as never);

    expect(context?.directory).toBe("/workspace/bitty/subagent-worktree");
    expect(context?.directoryDisplayName).toBe("subagent-worktree");
  });

  it("uses backend id to disambiguate identical native session ids", () => {
    const context = resolveSessionHistoryContext({
      backendId: "claude",
      sessionId: "shared",
      registeredDirectories: [{ id: "root", path: "/workspace", displayName: "Workspace" }],
      directorySessionsById: {
        root: {
          entries: [
            { backendId: "codex", sessionId: "shared", firstUserMessage: "Codex" },
            { backendId: "claude", sessionId: "shared", firstUserMessage: "Claude" },
          ],
        },
      },
      sessionTitleOverridesById: {},
    } as never);

    expect(context?.backendId).toBe("claude");
    expect(context?.sessionTitle).toBe("Claude");
  });
});
