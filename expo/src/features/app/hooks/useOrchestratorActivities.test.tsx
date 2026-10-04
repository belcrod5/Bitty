import { act, renderHook } from "@testing-library/react-native";
import { useOrchestratorActivities } from "./useOrchestratorActivities";

let mockConnection = { connected: true, generation: 1, appState: "active" };
const mockHandlers = new Map<string, (message: { payload: unknown }) => void>();
const mockPendingSnapshots: Array<(response: unknown) => void> = [];
const mockDefaultRequest = ({ op }: { op: string }) => op === "voice.orchestrators.list"
  ? Promise.resolve({ op: "voice.orchestrators.list.result", payload: { orchestrators: [
      { id: "parent", name: "親", icon: "", unreadCount: 2 },
    ] } })
  : new Promise((resolve) => mockPendingSnapshots.push(resolve));
const mockRequest = jest.fn(mockDefaultRequest);
const mockManager = {
  request: mockRequest,
  subscribe: ({ op }: { op: string }, handler: (message: { payload: unknown }) => void) => {
    mockHandlers.set(op, handler);
    return () => { if (mockHandlers.get(op) === handler) mockHandlers.delete(op); };
  },
};
jest.mock("../../runnerWs/RunnerWebSocketContext", () => ({
  useRunnerWebSocketManager: () => mockManager,
  useRunnerWebSocketSnapshot: () => mockConnection,
}));

const activity = { id: "a", orchestratorId: "parent", kind: "run", status: "running",
  label: "会話中…", startedAt: 1 };
const snapshot = (instanceId: string, revision: number, activities = [activity]) => ({
  instanceId, revision, activities,
});

beforeEach(() => {
  mockConnection = { connected: true, generation: 1, appState: "active" };
  mockHandlers.clear();
  mockPendingSnapshots.length = 0;
  mockRequest.mockReset();
  mockRequest.mockImplementation(mockDefaultRequest);
});

test("loads the current activity snapshot before any update notification", async () => {
  const hook = await renderHook(() => useOrchestratorActivities("url", "token", true));
  await act(async () => mockPendingSnapshots.shift()?.({ op: "orchestrator_activity_snapshot",
    payload: snapshot("server", 1) }));
  expect(hook.result.current.activities).toEqual([activity]);
  await hook.unmount();
});

test("newer activity notifications win over a delayed snapshot, including a server restart", async () => {
  const hook = await renderHook(() => useOrchestratorActivities("url", "token", true));
  await act(async () => undefined);
  expect(hook.result.current.orchestrators[0].unreadCount).toBe(2);
  await act(async () => mockHandlers.get("orchestrator_activity_updated")?.({ payload: snapshot("first", 2) }));
  expect(hook.result.current.activities).toEqual([activity]);
  await act(async () => mockPendingSnapshots.shift()?.({ op: "orchestrator_activity_snapshot",
    payload: snapshot("first", 1, []) }));
  expect(hook.result.current.activities).toEqual([activity]);
  await act(async () => mockHandlers.get("orchestrator_activity_updated")?.({ payload: snapshot("second", 1, []) }));
  await act(async () => mockHandlers.get("orchestrator_activity_updated")?.({ payload: snapshot("first", 3) }));
  expect(hook.result.current.activities).toEqual([]);
  await hook.unmount();
});

test("disconnect, connection generation, foreground, and credentials discard stale activities", async () => {
  let token = "one";
  const hook = await renderHook(() => useOrchestratorActivities("url", token, true));
  const oldNotification = mockHandlers.get("orchestrator_activity_updated")!;
  await act(async () => oldNotification({ payload: snapshot("first", 1) }));
  expect(hook.result.current.activities).toHaveLength(1);

  mockConnection = { ...mockConnection, connected: false };
  await hook.rerender(undefined);
  expect(hook.result.current.activities).toEqual([]);
  expect(hook.result.current.orchestrators[0].unreadCount).toBe(2);
  mockConnection = { ...mockConnection, connected: true, generation: 2 };
  await hook.rerender(undefined);
  await act(async () => oldNotification({ payload: snapshot("first", 4) }));
  expect(hook.result.current.activities).toEqual([]);

  await act(async () => mockHandlers.get("orchestrator_activity_updated")?.({ payload: snapshot("first", 2) }));
  mockConnection = { ...mockConnection, appState: "background" };
  await hook.rerender(undefined);
  expect(hook.result.current.activities).toEqual([]);
  const beforeForeground = mockRequest.mock.calls.filter(([value]) => value.op === "orchestrator_activity_snapshot").length;
  mockConnection = { ...mockConnection, appState: "active" };
  await hook.rerender(undefined);
  expect(mockRequest.mock.calls.filter(([value]) => value.op === "orchestrator_activity_snapshot")).toHaveLength(beforeForeground + 1);

  await act(async () => mockHandlers.get("orchestrator_activity_updated")?.({ payload: snapshot("first", 3) }));
  mockRequest.mockImplementation(({ op }: { op: string }) => op === "voice.orchestrators.list"
    ? Promise.resolve({ op: "voice.orchestrators.list.result", payload: { orchestrators: [] } })
    : new Promise((resolve) => mockPendingSnapshots.push(resolve)));
  token = "two";
  await hook.rerender(undefined);
  expect(hook.result.current.activities).toEqual([]);
  expect(hook.result.current.orchestrators).toEqual([]);
  await hook.unmount();
});
