import { createApprovalQueueController, type ApprovalRequest } from "./approvalFlow";

function approvalRequest(): ApprovalRequest {
  return {
    requestId: "item/commandExecution/requestApproval:8",
    source: "codex-app-server",
    command: "git commit",
    args: [],
    reason: "",
    approvalKey: "",
    message: "",
    threadId: "session-1",
    turnId: "",
    sessionInfo: {
      sessionId: "session-1",
    },
  };
}

test("discard forgets a shifted approval so it can be enqueued again", () => {
  const controller = createApprovalQueueController();
  const approval = approvalRequest();

  controller.enqueue(approval, () => {});
  expect(controller.shift()).not.toBeNull();
  controller.discard((pending) => pending.requestId === approval.requestId);
  controller.enqueue(approval, () => {});

  expect(controller.size()).toBe(1);
});
