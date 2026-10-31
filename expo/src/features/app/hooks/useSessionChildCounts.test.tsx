import { act, renderHook, waitFor } from "@testing-library/react-native";
import { useSessionChildCounts } from "./useSessionChildCounts";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";

function source() {
  let snapshot = { connectionState: "ready", generation: 1, connectionId: "one", url: "ws://runner", supportedControlEvents: ["session_children_changed"] };
  const snapshots = new Set<() => void>();
  const handlers = new Set<{ filter: { op?: string }; handler: (message: RunnerWsMessage) => void }>();
  const fixture = {
    supported: true, fail: false, total: 2,
    pending: null as Promise<Record<string, unknown>> | null,
    request: jest.fn(async (message: RunnerWsMessage): Promise<RunnerWsMessage> => {
      if (message.op === "agent.hello") return { channel: "agent", op: "agent.ready", payload: {
        protocolVersion: 2, operations: fixture.supported ? ["sessions.children.count"] : [], sessionChildCounts: { maxParents: 512 }, backends: [],
      } };
      if (fixture.fail) throw new Error("offline");
      const payload = fixture.pending ? await fixture.pending : { counts: (message.payload as { parentSessionRefs: Array<{ backendId: string; nativeSessionId: string }> }).parentSessionRefs
        .map((sessionRef) => ({ sessionRef, totalCount: fixture.total, runningCount: sessionRef.backendId === "codex" ? 1 : 0 })) };
      return { channel: "agent", op: "sessions.children.count.result", payload };
    }),
    manager: null as unknown as RunnerWebSocketManager,
    emit(op: string, payload?: unknown) { for (const { filter, handler } of handlers) if (!filter.op || filter.op === op) handler({ channel: "control", op, payload }); },
    reconnect() { snapshot = { ...snapshot, generation: snapshot.generation + 1, connectionId: "reconnected" }; snapshots.forEach((listener) => listener()); },
  };
  fixture.manager = { request: fixture.request, getSnapshot: () => snapshot,
    subscribeSnapshot: (listener: () => void) => { snapshots.add(listener); return () => { snapshots.delete(listener); }; },
    subscribe: (filter: { op?: string }, handler: (message: RunnerWsMessage) => void) => {
      const item = { filter, handler }; handlers.add(item); return () => { handlers.delete(item); };
    },
  } as unknown as RunnerWebSocketManager;
  return fixture;
}

const parents = [{ backendId: "codex", nativeSessionId: "shared" }, { backendId: "claude", nativeSessionId: "shared" }];

test("35 board parents use one count RPC with qualified counts and never request child details", async () => {
  const fixture = source();
  const targets = Array.from({ length: 35 }, (_, i) => ({ backendId: i % 2 ? "claude" : "codex", nativeSessionId: `parent-${i}` }));
  const { result } = await renderHook(() => useSessionChildCounts(fixture.manager, "scope", targets));
  await waitFor(() => expect(result.current.counts.size).toBe(35));
  expect(fixture.request.mock.calls.map(([request]) => request.op)).toEqual(["agent.hello", "sessions.children.count"]);
  expect(result.current.counts.get(JSON.stringify(["codex", "parent-0"]))?.runningCount).toBe(1);
  expect(result.current.counts.get(JSON.stringify(["claude", "parent-1"]))?.runningCount).toBe(0);
});

test("child and activity notifications revalidate, reconnect revalidates once, and failures retain known counts", async () => {
  const fixture = source();
  const { result } = await renderHook(() => useSessionChildCounts(fixture.manager, "scope", parents));
  await waitFor(() => expect(result.current.counts.size).toBe(2));
  fixture.total = 3;
  await act(async () => { fixture.emit("session_children_changed", { parentSessionRef: parents[0] }); });
  expect(result.current.counts.get(JSON.stringify(["codex", "shared"]))?.totalCount).toBe(3);
  fixture.total = 4;
  await act(async () => { fixture.emit("sessions_active_changed"); });
  expect(result.current.counts.get(JSON.stringify(["claude", "shared"]))?.totalCount).toBe(4);
  fixture.fail = true;
  await act(async () => { fixture.reconnect(); });
  expect(result.current.counts.get(JSON.stringify(["claude", "shared"]))?.totalCount).toBe(4);
  expect(result.current.loading).toBe(false);
});

test("an old Runner leaves counts unknown without silently loading detail lists", async () => {
  const fixture = source(); fixture.supported = false;
  const { result } = await renderHook(() => useSessionChildCounts(fixture.manager, "scope", parents));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.counts.size).toBe(0);
  expect(fixture.request.mock.calls.map(([request]) => request.op)).toEqual(["agent.hello"]);
});

test("scope changes discard old in-flight counts and notifications coalesce behind one request", async () => {
  const fixture = source();
  let resolve!: (result: Record<string, unknown>) => void;
  fixture.pending = new Promise((next) => { resolve = next; });
  const { result, rerender } = await renderHook(({ scope }: { scope: string }) => useSessionChildCounts(fixture.manager, scope, parents), { initialProps: { scope: "old" } });
  await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2));
  await act(async () => { for (let i = 0; i < 10; i++) fixture.emit("sessions_active_changed"); });
  expect(fixture.request).toHaveBeenCalledTimes(2);
  fixture.pending = null; fixture.total = 8;
  await rerender({ scope: "new" });
  await waitFor(() => expect(result.current.counts.get(JSON.stringify(["codex", "shared"]))?.totalCount).toBe(8));
  await act(async () => { resolve({ counts: parents.map((sessionRef) => ({ sessionRef, totalCount: 99, runningCount: 1 })) }); });
  expect(result.current.counts.get(JSON.stringify(["codex", "shared"]))?.totalCount).toBe(8);
});

test("partial backend counts preserve the other backend's last known value", async () => {
  const fixture = source();
  const { result } = await renderHook(() => useSessionChildCounts(fixture.manager, "scope", parents));
  await waitFor(() => expect(result.current.counts.size).toBe(2));
  fixture.pending = Promise.resolve({ counts: [{ sessionRef: parents[0], totalCount: 5, runningCount: 1 }], errors: [{ backendId: "claude", message: "offline" }] });
  await act(async () => { fixture.emit("sessions_active_changed"); });
  expect(result.current.counts.get(JSON.stringify(["codex", "shared"]))?.totalCount).toBe(5);
  expect(result.current.counts.get(JSON.stringify(["claude", "shared"]))?.totalCount).toBe(2);
});

test("a burst during an active count request results in one trailing fresh request", async () => {
  const fixture = source();
  let resolve!: (result: Record<string, unknown>) => void;
  fixture.pending = new Promise((next) => { resolve = next; });
  const { result } = await renderHook(() => useSessionChildCounts(fixture.manager, "scope", parents));
  await waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(2));
  await act(async () => { for (let i = 0; i < 10; i++) fixture.emit("sessions_active_changed"); });
  fixture.pending = null; fixture.total = 7;
  await act(async () => { resolve({ counts: parents.map((sessionRef) => ({ sessionRef, totalCount: 2, runningCount: 0 })) }); });
  expect(fixture.request.mock.calls.map(([request]) => request.op)).toEqual(["agent.hello", "sessions.children.count", "agent.hello", "sessions.children.count"]);
  expect(result.current.counts.get(JSON.stringify(["codex", "shared"]))?.totalCount).toBe(7);
});
