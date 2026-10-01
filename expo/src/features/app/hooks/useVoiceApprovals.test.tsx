import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useVoiceApprovals } from "./useVoiceApprovals";

const mockHandlers = new Map<string, (message: { operationId?: string; payload?: Record<string, unknown> }) => void>();
const request = jest.fn(async ({ op }: { op: string }) => ({ op: `${op}.result` }));
const mockSubscribe = jest.fn(({ op }: { op: string }, listener: (message: { operationId?: string;
  payload?: Record<string, unknown> }) => void) => {
  mockHandlers.set(op, listener);
  return () => { mockHandlers.delete(op); };
});
const mockManager = { request, subscribe: mockSubscribe };
let mockConnected = true;

jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => mockManager,
  useRunnerWebSocketSnapshot: () => ({ connected: mockConnected }),
}));

const approval = (requestId: string, operationId: string, orchestratorId: string) => ({
  channel: "agent", op: "voice.approval.request", operationId,
  payload: { requestId, orchestratorId, orchestratorName: orchestratorId === "main" ? "メイン" : "調査", method: "item/commandExecution/requestApproval",
    threadId: "thread", turnId: "turn", params: { command: "echo", args: ["hello"] } },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockHandlers.clear();
  mockConnected = true;
});

test("pending approvals survive callback changes", async () => {
  let decide: ((value: "approve_once") => void) | undefined;
  const onRequest = jest.fn((_request: unknown) => new Promise<"approve_once">((resolve) => { decide = resolve; }));
  const onResolved = jest.fn();
  let callback = onRequest;
  const { rerender, unmount } = await renderHook(() => useVoiceApprovals(callback, onResolved));
  await act(async () => { mockHandlers.get("voice.approval.request")?.(approval("approval-1", "operation-1", "main")); });
  await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1));
  expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
    sessionInfo: expect.objectContaining({ sessionTitle: "メイン" }),
  }));
  callback = jest.fn(onRequest);
  await rerender(undefined);
  await act(async () => { decide?.("approve_once"); });
  await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.approval.decision", operationId: "operation-1",
    payload: { requestId: "approval-1", decision: "accept" },
  }), { timeoutMs: 30_000 });
  await unmount();
});

test("unmounting the app approval listener cancels only unresolved approvals", async () => {
  const onRequest = jest.fn((_request: unknown) => new Promise<"approve_once">(() => undefined));
  const onResolved = jest.fn();
  const { unmount } = await renderHook(() => useVoiceApprovals(onRequest, onResolved));
  await act(async () => { mockHandlers.get("voice.approval.request")?.(approval("approval-close", "operation-2", "other")); });
  await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1));
  expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
    sessionInfo: expect.objectContaining({ sessionTitle: "調査" }),
  }));
  await unmount();
  expect(onResolved).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    op: "voice.approval.decision", operationId: "operation-2",
    payload: { requestId: "approval-close", decision: "cancel" },
  }));
});


test("background approvals use the Runner orchestrator name without a mounted voice screen", async () => {
  const onRequest = jest.fn(async () => "approve_once" as const);
  const onResolved = jest.fn();
  const { unmount } = await renderHook(() => useVoiceApprovals(onRequest, onResolved));
  const message = approval("scheduled-approval", "scheduled-operation", "main");
  await act(async () => mockHandlers.get("voice.approval.request")?.({ ...message,
    payload: { ...message.payload, orchestratorName: "定期調査" } }));
  await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
    sessionInfo: expect.objectContaining({ sessionTitle: "定期調査" }),
  }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    operationId: "scheduled-operation", payload: { requestId: "scheduled-approval", decision: "accept" },
  }), { timeoutMs: 30_000 });
  await unmount();
});
