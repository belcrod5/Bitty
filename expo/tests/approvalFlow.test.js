const assert = require("node:assert/strict");
const test = require("node:test");
const { createApprovalQueueController } = require("../src/features/codex/approvalFlow");

function request(overrides = {}) {
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
    ...overrides,
  };
}

test("coalesces a replayed pending approval and responds to every observer", async () => {
  const controller = createApprovalQueueController();
  const responses = [];
  const approval = request();

  controller.enqueue(approval, (action) => {
    responses.push(`first:${action}`);
    controller.enqueue(approval, (lateAction) => responses.push(`late:${lateAction}`));
  });
  const item = controller.shift();
  controller.enqueue(approval, (action) => responses.push(`replay:${action}`));

  assert.ok(item);
  assert.equal(controller.size(), 0);
  await item.respond("approve_once");
  assert.deepEqual(responses, [
    "first:approve_once",
    "replay:approve_once",
    "late:approve_once",
  ]);
});

test("does not merge matching request ids from different sessions", () => {
  const controller = createApprovalQueueController();

  controller.enqueue(request(), () => {});
  controller.enqueue(request({
    threadId: "session-2",
    sessionInfo: { sessionId: "session-2" },
  }), () => {});

  assert.equal(controller.size(), 2);
});
