import { act, renderHook, waitFor } from "@testing-library/react-native";
import { applyConsultationProgressDelta, useConsultationRooms, type ConsultationRoom, type ConsultationProgress } from "./useConsultationRooms";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";

const room = (id = "a", revision = 1): ConsultationRoom => ({ id, revision, generation: 1, question: `Question ${id}`, participants: ["one", "two"],
  profiles: { one: { orchestratorId: "one", name: "One" }, two: { orchestratorId: "two", name: "Two" } }, template: "Synthetic", turns: 0, maxTurns: 9,
  state: "running", reason: "", messages: [{ id: "user", seq: 1, speakerId: "user", source: "user", text: "Synthetic question" }], run: { id: `run-${id}`, orchestratorId: "one" } });
const summary = (value: ConsultationRoom) => ({ id: value.id, revision: value.revision, generation: value.generation, question: value.question,
  participants: value.participants, profiles: value.profiles, turns: value.turns, maxTurns: value.maxTurns, state: value.state, reason: value.reason, lastMessage: value.messages.at(-1) });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
function fixture({ legacy = false } = {}) {
  const handlers = new Map<string, (message: any) => void>();
  let current = room();
  let lease = "";
  const send = jest.fn(async (op: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
    if (op === "list") { lease = String(payload.subscriptionId); return { rooms: [legacy ? current : summary(current)], defaultTemplate: "Synthetic",
      ...(legacy ? {} : { updates: "delta", subscriptionId: lease }) }; }
    if (op === "get") return payload.roomId ? { ...current, id: String(payload.roomId), run: { id: `run-${payload.roomId}`, orchestratorId: "one" } } : { room: null };
    return { removed: true };
  });
  const manager = { connect: async () => {}, subscribe: (filter: { op: string }, handler: (message: any) => void) => {
    handlers.set(filter.op, handler); return () => { handlers.delete(filter.op); };
  } } as unknown as RunnerWebSocketManager;
  const onError = jest.fn();
  return { send, manager, onError, setRoom: (value: ConsultationRoom) => { current = value; },
    receive: (op: string, payload: unknown) => handlers.get(`voice.consultations.${op}`)?.({ operationId: legacy ? undefined : lease, payload }) };
}

test("list summaries and detail revisions remain separate", async () => {
  const f = fixture();
  const { result, rerender } = await renderHook(({ selected }: { selected: string }) => useConsultationRooms({ ...f, connected: true, generation: 1, selectedRoom: selected }), { initialProps: { selected: "" } });
  await waitFor(() => expect(result.current.rooms.length).toBe(1));
  expect(f.send.mock.calls.filter(([op, payload]) => op === "get" && payload?.roomId)).toHaveLength(0);
  await act(async () => { f.receive("summary", summary(room("a", 20))); });
  await rerender({ selected: "a" });
  await waitFor(() => expect(result.current.room?.revision).toBe(1));
  expect(result.current.rooms[0].revision).toBe(20);
  await act(async () => { f.receive("changed", { ...room("a", 2), question: "Authoritative detail" }); });
  expect(result.current.room.question).toBe("Authoritative detail");
  expect(result.current.rooms[0].revision).toBe(20);
});

test("suffix deltas ignore duplicates, and gaps recover with one in-flight GET", async () => {
  const f = fixture();
  const { result } = await renderHook(() => useConsultationRooms({ ...f, connected: true, generation: 1, selectedRoom: "a" }));
  await waitFor(() => expect(result.current.room?.id).toBe("a"));
  const first = { roomId: "a", runId: "run-a", generation: 1, baseSeq: 0, seq: 1, message: { id: "answer", phase: "final_answer", offset: 0, append: "A" } };
  await act(async () => { f.receive("progress.delta", first); f.receive("progress.delta", first); });
  expect(result.current.room.run?.progress?.messages[0].text).toBe("A");
  const pending = deferred<ConsultationRoom>();
  const before = f.send.mock.calls.filter(([op, payload]) => op === "get" && payload?.roomId).length;
  f.send.mockImplementationOnce(async () => pending.promise);
  await act(async () => {
    f.receive("progress.delta", { ...first, baseSeq: 2, seq: 3 });
    f.receive("progress.delta", { ...first, baseSeq: 3, seq: 4 });
  });
  expect(f.send.mock.calls.filter(([op, payload]) => op === "get" && payload?.roomId).length).toBe(before + 1);
  await act(async () => { pending.resolve({ ...room(), run: { id: "run-a", orchestratorId: "one", progress: {
    roomId: "a", runId: "run-a", generation: 1, seq: 4, messages: [{ id: "answer", phase: "final_answer", text: "ABCD" }], tools: [],
  } } }); });
  await act(async () => { f.receive("progress.delta", { ...first, baseSeq: 4, seq: 5, message: { ...first.message, offset: 4, append: "E" } }); });
  expect(result.current.room.run?.progress?.messages[0].text).toBe("ABCDE");
  expect(f.onError).not.toHaveBeenCalled();
});

test("A to B to A selection sends a new scope GET and rejects the first A response", async () => {
  const f = fixture(), firstA = deferred<ConsultationRoom>(), secondA = deferred<ConsultationRoom>();
  const original = f.send.getMockImplementation()!;
  let aCalls = 0;
  f.send.mockImplementation((op, payload = {}) => op === "get" && payload.roomId === "a"
    ? (++aCalls === 1 ? firstA.promise : secondA.promise) : original(op, payload));
  const { result, rerender } = await renderHook(({ selected }: { selected: string }) => useConsultationRooms({ ...f, connected: true, generation: 1, selectedRoom: selected }), { initialProps: { selected: "a" } });
  await waitFor(() => expect(aCalls).toBe(1));
  await rerender({ selected: "b" });
  await waitFor(() => expect(result.current.room?.id).toBe("b"));
  await rerender({ selected: "a" });
  await waitFor(() => expect(aCalls).toBe(2));
  await act(async () => { firstA.resolve(room("a", 99)); secondA.resolve(room("a", 2)); });
  expect(result.current.room.revision).toBe(2);
});

test("a reconnect accepts a restored lower revision and changes the subscription lease", async () => {
  const f = fixture(); f.setRoom(room("a", 10));
  const { result, rerender } = await renderHook(({ generation }: { generation: number }) => useConsultationRooms({ ...f, connected: true, generation, selectedRoom: "a" }), { initialProps: { generation: 1 } });
  await waitFor(() => expect(result.current.room?.revision).toBe(10));
  const firstLease = f.send.mock.calls.find(([op]) => op === "list")![1]!.subscriptionId;
  f.setRoom(room("a", 1));
  await rerender({ generation: 2 });
  await waitFor(() => expect(result.current.room?.revision).toBe(1));
  const lists = f.send.mock.calls.filter(([op]) => op === "list");
  expect(lists[1][1]!.subscriptionId).not.toBe(firstLease);
  expect(f.send).toHaveBeenCalledWith("unsubscribe", { subscriptionId: firstLease });
});

test("immediate reconnect negotiation always scopes its GET to the new lease", async () => {
  const f = fixture();
  const original = f.send.getMockImplementation()!;
  const unscoped = deferred<ConsultationRoom>();
  f.send.mockImplementation((op, payload = {}) => op === "get" && payload.roomId && !payload.subscriptionId ? unscoped.promise : original(op, payload));
  const { result, rerender } = await renderHook(({ generation }: { generation: number }) => useConsultationRooms({ ...f, connected: true, generation, selectedRoom: "a" }), { initialProps: { generation: 1 } });
  await waitFor(() => expect(result.current.room?.id).toBe("a"));
  f.send.mockClear();
  await rerender({ generation: 2 });
  await waitFor(() => expect(result.current.room?.id).toBe("a"));
  const nextLease = f.send.mock.calls.find(([op]) => op === "list")![1]!.subscriptionId;
  const gets = f.send.mock.calls.filter(([op, payload]) => op === "get" && payload?.roomId);
  expect(gets).toHaveLength(1);
  expect(gets[0][1]!.subscriptionId).toBe(nextLease);
});

test("an older Runner retains full snapshots and progress without a delta marker", async () => {
  const f = fixture({ legacy: true });
  const { result } = await renderHook(() => useConsultationRooms({ ...f, connected: true, generation: 1, selectedRoom: "a" }));
  await waitFor(() => expect(result.current.room?.id).toBe("a"));
  await act(async () => f.receive("progress", { roomId: "a", runId: "run-a", generation: 1, seq: 1, messages: [{ id: "x", phase: "final_answer", text: "Legacy text" }], tools: [] }));
  expect(result.current.room.run?.progress?.messages[0].text).toBe("Legacy text");
});

test("tool suffixes validate offsets without mutating the prior trace", () => {
  const initial: ConsultationProgress = { roomId: "a", runId: "run-a", generation: 1, seq: 0, messages: [], tools: [] };
  const one = applyConsultationProgressDelta(initial, { roomId: "a", runId: "run-a", generation: 1, baseSeq: 0, seq: 1,
    tool: { id: "tool", type: "commandExecution", name: "commandExecution", status: "running" } })!;
  const two = applyConsultationProgressDelta(one, { roomId: "a", runId: "run-a", generation: 1, baseSeq: 1, seq: 2,
    toolOutput: { id: "tool", offset: 0, append: "output" } })!;
  expect(two.tools[0].output).toBe("output");
  expect(one.tools[0].output).toBeUndefined();
  expect(applyConsultationProgressDelta(two, { roomId: "a", runId: "run-a", generation: 1, baseSeq: 2, seq: 3,
    toolOutput: { id: "tool", offset: 1, append: "wrong" } })).toBeNull();
});

test("a previous selection's rejected GET cannot replace the current room's error", async () => {
  const f = fixture();
  let rejectA!: (cause: Error) => void;
  const pendingA = new Promise<unknown>((_resolve, reject) => { rejectA = reject; });
  const original = f.send.getMockImplementation()!;
  f.send.mockImplementation((op, payload = {}) => op === "get" && payload.roomId === "a" ? pendingA : original(op, payload));
  const { result, rerender } = await renderHook(({ selected }: { selected: string }) => useConsultationRooms({ ...f, connected: true, generation: 1, selectedRoom: selected }), { initialProps: { selected: "a" } });
  await waitFor(() => expect(f.send.mock.calls.some(([op, payload]) => op === "get" && payload?.roomId === "a")).toBe(true));
  await rerender({ selected: "b" });
  await waitFor(() => expect(result.current.room?.id).toBe("b"));
  await act(async () => { rejectA(new Error("stale A error")); });
  expect(f.onError).not.toHaveBeenCalled();
});
