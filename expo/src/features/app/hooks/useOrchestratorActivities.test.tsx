import { act, renderHook } from "@testing-library/react-native";
import { useOrchestratorActivities } from "./useOrchestratorActivities";

const mockMutatePersistedSettings = jest.fn(async (mutate: (settings: Record<string, unknown>) => Record<string, unknown>) =>
  mutate({}));
jest.mock("../utils/persistedSettingsFile", () => ({
  SIRI_VOICE_ORCHESTRATORS_FIELD: "siriVoiceOrchestrators",
  mutatePersistedSettings: (mutate: (settings: Record<string, unknown>) => Record<string, unknown>) =>
    mockMutatePersistedSettings(mutate),
}));

let mockConfigurationGeneration = 0;
let mockConnection = { connected: true, generation: 1, appState: "active" };
const mockHandlers = new Map<string, (message: { payload: unknown }) => void>();
const mockPendingSnapshots: Array<(response: unknown) => void> = [];
const mockDefaultRequest = ({ op }: { op: string }) => op === "voice.orchestrators.list"
  ? Promise.resolve({ op: "voice.orchestrators.list.result", payload: { orchestrators: [
      { id: "parent", name: "親", icon: "", unreadCount: 2 },
    ], selectedId: "parent" } })
  : new Promise((resolve) => mockPendingSnapshots.push(resolve));
const mockRequest = jest.fn(mockDefaultRequest);
let mockManager = {
  getSnapshot: () => ({ ...mockConnection, url: "url", connectionOptionsGeneration: mockConfigurationGeneration }),
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
  mockConfigurationGeneration = 0;
  mockManager = { ...mockManager };
  mockConnection = { connected: true, generation: 1, appState: "active" };
  mockHandlers.clear();
  mockPendingSnapshots.length = 0;
  mockRequest.mockReset();
  mockRequest.mockImplementation(mockDefaultRequest);
  mockMutatePersistedSettings.mockClear();
});

test("keeps Siri's local name list current without rewriting it for unread counts", async () => {
  const hook = await renderHook(() => useOrchestratorActivities("url", "token", true));
  await act(async () => undefined);
  expect(mockMutatePersistedSettings).toHaveBeenCalledTimes(1);
  await expect(mockMutatePersistedSettings.mock.results[0].value).resolves.toEqual({
    siriVoiceOrchestrators: { runnerUrl: "url", orchestrators: [{ id: "parent", name: "親" }] },
  });
  await act(async () => mockHandlers.get("voice.unread.changed")?.({ payload: {
    orchestrators: [{ id: "parent", name: "親", unreadCount: 3 }], selectedId: "parent",
  } }));
  expect(mockMutatePersistedSettings).toHaveBeenCalledTimes(1);
  await act(async () => mockHandlers.get("voice.unread.changed")?.({ payload: {
    orchestrators: [{ id: "parent", name: "メイン", unreadCount: 3 },
      { id: "other", name: "調査", unreadCount: 0 }], selectedId: "parent",
  } }));
  expect(mockMutatePersistedSettings).toHaveBeenCalledTimes(2);
  await expect(mockMutatePersistedSettings.mock.results[1].value).resolves.toEqual({
    siriVoiceOrchestrators: { runnerUrl: "url", orchestrators: [
      { id: "parent", name: "メイン" }, { id: "other", name: "調査" },
    ] },
  });
  await hook.unmount();
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

test("selected orchestrator metadata arrives with unread counts and wins over an older list", async () => {
  let resolveList!: (value: unknown) => void;
  mockRequest.mockImplementation(({ op }: { op: string }) => op === "voice.orchestrators.list"
    ? new Promise((resolve) => { resolveList = resolve; })
    : new Promise((resolve) => mockPendingSnapshots.push(resolve)));
  const hook = await renderHook(() => useOrchestratorActivities("url", "token", true));
  await act(async () => mockHandlers.get("voice.unread.changed")?.({ payload: {
    orchestrators: [{ id: "parent", name: "親", unreadCount: 3 }, { id: "other", name: "調査", unreadCount: 1 }],
    selectedId: "other",
  } }));
  await act(async () => resolveList({ op: "voice.orchestrators.list.result", payload: {
    orchestrators: [{ id: "parent", name: "親", unreadCount: 2 }], selectedId: "parent",
  } }));
  expect(hook.result.current.selectedId).toBe("other");
  expect(hook.result.current.orchestrators.map((item) => item.unreadCount)).toEqual([3, 1]);
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
    ? Promise.resolve({ op: "voice.orchestrators.list.result", payload: { orchestrators: [], selectedId: "" } })
    : new Promise((resolve) => mockPendingSnapshots.push(resolve)));
  mockConfigurationGeneration += 1;
  token = "two";
  await hook.rerender(undefined);
  expect(hook.result.current.activities).toEqual([]);
  expect(hook.result.current.orchestrators).toEqual([]);
  await hook.unmount();
});

test("learning metadata follows pushes, excludes invalid counts, and clears on credential changes", async () => {
  let token = "one";
  const hook = await renderHook(() => useOrchestratorActivities("url", token, true));
  await act(async () => mockHandlers.get("voice.unread.changed")?.({ payload: {
    orchestrators: [{ id: "main", name: "メイン", learningUnreadCount: 4 },
      { id: "other", name: "調査", learningUnreadCount: -2 }], selectedId: "other",
  } }));
  expect(hook.result.current.orchestrators.map((item) => item.learningUnreadCount)).toEqual([4, 0]);
  const stale = mockHandlers.get("voice.unread.changed")!;
  mockConfigurationGeneration += 1;
  token = "two";
  await hook.rerender(undefined);
  await act(async () => stale({ payload: {
    orchestrators: [{ id: "main", name: "古い", learningUnreadCount: 9 }], selectedId: "main",
  } }));
  expect(hook.result.current.orchestrators.some((item) => item.learningUnreadCount === 9)).toBe(false);
  await hook.unmount();
});


test("inactive does not start synchronization; returning active revalidates once", async () => {
  const hook = await renderHook(() => useOrchestratorActivities("url", "token", true));
  await act(async () => undefined);
  const before = mockRequest.mock.calls.length;
  mockConnection = { ...mockConnection, appState: "inactive" };
  await hook.rerender(undefined);
  expect(mockRequest).toHaveBeenCalledTimes(before);
  mockConnection = { ...mockConnection, appState: "active" };
  await hook.rerender(undefined);
  expect(mockRequest).toHaveBeenCalledTimes(before + 2); // one activity snapshot and one metadata validation
  await hook.unmount();
});


test("a queued notification after domain apply cannot be overwritten by the request continuation", async () => {
  let resolveList!: (value: unknown) => void;
  mockRequest.mockImplementation(({ op }: { op: string }) => op === "voice.orchestrators.list"
    ? new Promise((resolve) => { resolveList = resolve; })
    : new Promise((resolve) => mockPendingSnapshots.push(resolve)));
  const hook = await renderHook(() => useOrchestratorActivities("url", "token", true));
  await act(async () => {
    resolveList({ op: "voice.orchestrators.list.result", payload: { etag: "A", selectedId: "parent",
      orchestrators: [{ id: "parent", name: "Old", unreadCount: 1 }] } });
    queueMicrotask(() => mockHandlers.get("voice.unread.changed")?.({ payload: { etag: "B", selectedId: "other",
      orchestrators: [{ id: "other", name: "New", icon: "new", unreadCount: 9 }] } }));
  });
  expect(hook.result.current.selectedId).toBe("other");
  expect(hook.result.current.orchestrators[0]).toMatchObject({ name: "New", icon: "new", unreadCount: 9 });
  await hook.unmount();
});
