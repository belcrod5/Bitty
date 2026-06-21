import { normalizeThreadListEntry } from "./helpers";

describe("normalizeThreadListEntry", () => {
  it("reads subagent relationship metadata from the thread source", () => {
    const entry = normalizeThreadListEntry({
      id: "child-thread",
      parentThreadId: null,
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: "parent-thread",
            agent_nickname: "Carson",
            agent_role: "explorer",
          },
        },
      },
    });

    expect(entry).toMatchObject({
      threadId: "child-thread",
      parentThreadId: "parent-thread",
      agentDisplayName: "Carson",
      agentRole: "explorer",
      sourceKind: "subAgentThreadSpawn",
    });
  });
});
