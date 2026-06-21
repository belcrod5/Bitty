import { normalizeThreadListEntry, takeResolvedApprovalRequest } from "./helpers";
import type { ApprovalRequest } from "../approvalFlow";

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

describe("takeResolvedApprovalRequest", () => {
  it("removes the matching request and disables its delayed response", () => {
    const request = {
      requestId: "item/commandExecution/requestApproval:20",
      source: "codex-app-server",
      command: "git status",
      args: [],
      reason: "",
      approvalKey: "",
      message: "",
      threadId: "thread-1",
      turnId: "turn-1",
    } satisfies ApprovalRequest;
    const guard = { active: true, request };
    const pending = new Map([[20, guard]]);

    expect(takeResolvedApprovalRequest(pending, { requestId: 20 })).toBe(request);
    expect(guard.active).toBe(false);
    expect(pending.size).toBe(0);
  });
});
