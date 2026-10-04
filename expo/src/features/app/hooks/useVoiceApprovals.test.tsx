import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useVoiceApprovals } from "./useVoiceApprovals";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";

const mockHandlers = new Map<string, (message: { operationId?: string; payload?: Record<string, unknown> }) => void>();
const request = jest.fn(async ({ op }: { op: string }) => ({ op: `${op}.result` }));
const mockSubscribe = jest.fn(({ op }: { op: string }, listener: (message: { operationId?: string;
  payload?: Record<string, unknown> }) => void) => {
  mockHandlers.set(op, listener);
  return () => { mockHandlers.delete(op); };
});
const snapshotListeners = new Set<() => void>();
const mockManager = { request, subscribe: mockSubscribe,
  subscribeSnapshot: jest.fn((listener: () => void) => {
    snapshotListeners.add(listener);
    return () => { snapshotListeners.delete(listener); };
  }), getSnapshot: () => ({ connected: mockConnected }) };
const approvalManager = mockManager as unknown as RunnerWebSocketManager;
let mockConnected = true;

const approval = (requestId: string, operationId: string, orchestratorId: string) => ({
  channel: "agent", op: "voice.approval.request", operationId,
  payload: { requestId, orchestratorId, orchestratorName: orchestratorId === "main" ? "メイン" : "調査", method: "item/commandExecution/requestApproval",
    threadId: "thread", turnId: "turn", params: { command: "echo", args: ["hello"] } },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockHandlers.clear();
  snapshotListeners.clear();
  mockConnected = true;
});

test("pending approvals survive callback changes", async () => {
  let decide: ((value: "approve_once") => void) | undefined;
  const onRequest = jest.fn((_request: unknown) => new Promise<"approve_once">((resolve) => { decide = resolve; }));
  const onResolved = jest.fn();
  let callback = onRequest;
  const { rerender, unmount } = await renderHook(() => useVoiceApprovals(callback, onResolved, approvalManager));
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
  const { unmount } = await renderHook(() => useVoiceApprovals(onRequest, onResolved, approvalManager));
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
  const { unmount } = await renderHook(() => useVoiceApprovals(onRequest, onResolved, approvalManager));
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

test("disconnect clears pending approvals and reconnect accepts new requests", async () => {
  const onRequest = jest.fn((_request: unknown) => new Promise<"approve_once">(() => undefined));
  const onResolved = jest.fn();
  const { unmount } = await renderHook(() => useVoiceApprovals(onRequest, onResolved, approvalManager));
  await act(async () => { mockHandlers.get("voice.approval.request")?.(approval("before-disconnect", "operation-1", "main")); });
  expect(onRequest).toHaveBeenCalledTimes(1);

  await act(async () => {
    mockConnected = false;
    snapshotListeners.forEach((listener) => listener());
  });
  expect(onResolved).toHaveBeenCalledTimes(1);

  await act(async () => {
    mockConnected = true;
    snapshotListeners.forEach((listener) => listener());
    mockHandlers.get("voice.approval.request")?.(approval("after-reconnect", "operation-2", "main"));
  });
  expect(onRequest).toHaveBeenCalledTimes(2);
  await unmount();
  expect(onResolved).toHaveBeenCalledTimes(2);
});

test("native resolution dismisses only the matching approval and ignores a later UI decision", async () => {
  let decide: ((value: "approve_once") => void) | undefined;
  const onRequest = jest.fn((_request: unknown) => new Promise<"approve_once">((resolve) => { decide = resolve; }));
  const onResolved = jest.fn();
  const { unmount } = await renderHook(() => useVoiceApprovals(onRequest, onResolved, approvalManager));
  await act(async () => mockHandlers.get("voice.approval.request")?.(approval("child-approval", "operation-1", "main")));
  const resolved = { operationId: "operation-1", payload: { requestId: "child-approval" } };
  await act(async () => {
    mockHandlers.get("voice.approval.resolved")?.({ ...resolved, operationId: "other-operation" });
    mockHandlers.get("voice.approval.resolved")?.({ ...resolved, payload: { requestId: "other-request" } });
  });
  expect(onResolved).not.toHaveBeenCalled();
  await act(async () => {
    mockHandlers.get("voice.approval.resolved")?.(resolved);
    mockHandlers.get("voice.approval.resolved")?.(resolved);
    decide?.("approve_once");
  });
  expect(onResolved).toHaveBeenCalledTimes(1);
  expect(onResolved).toHaveBeenCalledWith(onRequest.mock.calls[0][0]);
  expect(request).not.toHaveBeenCalled();
  await unmount();
  expect(request).not.toHaveBeenCalled();
});
