import { buildSessionScopedApprovalKey } from "./useApprovalRequestController";
import type { ApprovalRequest } from "../../codex/approvalFlow";

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: "item/commandExecution/requestApproval:1",
    source: "codex-app-server",
    command: "toolrun",
    args: ["youtube_search"],
    reason: "",
    approvalKey: "toolrun:youtube_search",
    message: "",
    threadId: "",
    turnId: "",
    sessionInfo: { sessionId: "session-a" },
    ...overrides,
  };
}

describe("buildSessionScopedApprovalKey", () => {
  test("same sessionId + same approvalKey produce the same composite key", () => {
    const first = approvalRequest();
    const second = approvalRequest();

    const keyA = buildSessionScopedApprovalKey(first);
    const keyB = buildSessionScopedApprovalKey(second);

    expect(keyA).not.toBe("");
    expect(keyA).toBe(keyB);
  });

  test("different sessionId with the same approvalKey produce different composite keys", () => {
    const sessionA = approvalRequest({ sessionInfo: { sessionId: "session-a" } });
    const sessionB = approvalRequest({ sessionInfo: { sessionId: "session-b" } });

    const keyA = buildSessionScopedApprovalKey(sessionA);
    const keyB = buildSessionScopedApprovalKey(sessionB);

    expect(keyA).not.toBe(keyB);
  });

  test("falls back to threadId when sessionInfo.sessionId is absent", () => {
    const withThreadId = approvalRequest({ sessionInfo: undefined, threadId: "thread-1" });

    expect(buildSessionScopedApprovalKey(withThreadId)).toBe("thread-1:toolrun:youtube_search");
  });

  test("empty sessionId (no sessionInfo, empty threadId) yields an empty key, disabling auto-approval", () => {
    const request = approvalRequest({ sessionInfo: undefined, threadId: "" });

    expect(buildSessionScopedApprovalKey(request)).toBe("");
  });

  test("empty approvalKey yields an empty key, disabling auto-approval", () => {
    const request = approvalRequest({ approvalKey: "" });

    expect(buildSessionScopedApprovalKey(request)).toBe("");
  });
});
