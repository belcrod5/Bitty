import {
  normalizeCodexWsInputs,
  normalizeThreadListEntry,
  normalizeThreadReadEntry,
  takeResolvedApprovalRequest,
} from "./helpers";
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

describe("normalizeThreadReadEntry", () => {
  it("includes commandExecution items alongside user/agent messages in turn order", () => {
    const result = normalizeThreadReadEntry({
      id: "thread-1",
      status: "idle",
      turns: [
        {
          status: "completed",
          items: [
            { type: "userMessage", text: "run tests" },
            { type: "commandExecution", id: "call_1", command: "npm test", status: "completed", exitCode: 0 },
            { type: "agentMessage", text: "done" },
          ],
        },
      ],
    });

    expect(result.messages).toEqual([
      expect.objectContaining({ role: "user", content: "run tests" }),
      expect.objectContaining({
        role: "assistant",
        content: "",
        commandExecution: { command: "npm test", status: "completed", exitCode: 0 },
      }),
      expect.objectContaining({ role: "assistant", content: "done" }),
    ]);
  });

  it("maps failed and declined statuses to failed", () => {
    const failed = normalizeThreadReadEntry({
      id: "thread-1",
      status: "idle",
      turns: [{
        status: "completed",
        items: [{ type: "commandExecution", id: "call_1", command: "false", status: "failed", exitCode: 1 }],
      }],
    });
    expect(failed.messages[0]?.commandExecution).toEqual({ command: "false", status: "failed", exitCode: 1 });

    const declined = normalizeThreadReadEntry({
      id: "thread-1",
      status: "idle",
      turns: [{
        status: "completed",
        items: [{ type: "commandExecution", id: "call_2", command: "rm -rf /", status: "declined" }],
      }],
    });
    expect(declined.messages[0]?.commandExecution).toEqual({ command: "rm -rf /", status: "failed", exitCode: null });
  });

  it("joins array-form commands with spaces", () => {
    const result = normalizeThreadReadEntry({
      id: "thread-1",
      status: "idle",
      turns: [{
        status: "completed",
        items: [{ type: "commandExecution", id: "call_1", command: ["ls", "-la"], status: "completed" }],
      }],
    });
    expect(result.messages[0]?.commandExecution?.command).toBe("ls -la");
  });

  it("skips commandExecution items without a command (fail-safe)", () => {
    const result = normalizeThreadReadEntry({
      id: "thread-1",
      status: "idle",
      turns: [{
        status: "completed",
        items: [{ type: "commandExecution", id: "call_1", status: "completed" }],
      }],
    });
    expect(result.messages).toEqual([]);
  });
});

describe("normalizeCodexWsInputs", () => {
  it("migrates a legacy query token out of the URL", () => {
    expect(normalizeCodexWsInputs(
      "wss://runner.example.com/codex-ws?token=legacy-secret&resume=1",
      ""
    )).toEqual({
      wsUrl: "wss://runner.example.com/codex-ws?resume=1",
      wsToken: "legacy-secret",
    });
  });

  it("removes query tokens without replacing an explicit token", () => {
    expect(normalizeCodexWsInputs(
      "wss://runner.example.com/codex-ws?Token=old-secret",
      "secure-store-secret"
    )).toEqual({
      wsUrl: "wss://runner.example.com/codex-ws",
      wsToken: "secure-store-secret",
    });
  });
});
