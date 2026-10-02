import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { useVoiceUserInput } from "./useVoiceUserInput";

const handlers = new Map<string, (message: RunnerWsMessage) => void>();
const snapshotListeners = new Set<() => void>();
let connected = true;
const request = jest.fn(async () => ({ channel: "agent", op: "voice.userInput.respond.result" }));
const manager = {
  request,
  subscribe: ({ op }: { op: string }, listener: (message: RunnerWsMessage) => void) => {
    handlers.set(op, listener);
    return () => { handlers.delete(op); };
  },
  subscribeSnapshot: (listener: () => void) => {
    snapshotListeners.add(listener);
    return () => { snapshotListeners.delete(listener); };
  },
  getSnapshot: () => ({ connected }),
} as unknown as RunnerWebSocketManager;
const question = (requestId = "q1", orchestratorId = "main"): RunnerWsMessage => ({
  channel: "agent", op: "voice.userInput.request", operationId: "operation",
  payload: { requestId, orchestratorId, threadId: "ephemeral-native-thread", startedAtMs: Date.now() - 15_000,
    params: { questions: [{ id: "choice", question: "A or B?", options: [] }] } },
});
const originalState = AppState.currentState;
beforeEach(() => {
  connected = true;
  AppState.currentState = "active";
  handlers.clear();
  snapshotListeners.clear();
  request.mockClear();
});
afterEach(() => { AppState.currentState = originalState; });

test("shows only the visible orchestrator and sends answers using the original native thread and timestamp", async () => {
  const view = await renderHook(() => useVoiceUserInput(manager, "main"));
  await act(async () => handlers.get("voice.userInput.request")?.(question("other", "other")));
  expect(view.result.current.request).toBeNull();
  const message = question();
  await act(async () => {
    handlers.get("voice.userInput.request")?.(message);
    handlers.get("voice.userInput.request")?.(message);
  });
  expect(view.result.current.request?.threadId).toBe("ephemeral-native-thread");
  expect(view.result.current.request?.startedAtMs).toBe((message.payload as { startedAtMs: number }).startedAtMs);
  const answer = { answers: { choice: { answers: ["A"] } } };
  await act(async () => view.result.current.decide(answer));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith({ channel: "agent", op: "voice.userInput.respond",
    operationId: "operation", payload: { requestId: "q1", result: answer } }, { timeoutMs: 30_000 });
});

test("switching, backgrounding, disconnect and unmount drop the form without responding", async () => {
  const view = await renderHook<ReturnType<typeof useVoiceUserInput>, { selected: string }>(
    ({ selected }) => useVoiceUserInput(manager, selected), { initialProps: { selected: "main" } });
  await act(async () => handlers.get("voice.userInput.request")?.(question()));
  await view.rerender({ selected: "other" });
  expect(view.result.current.request).toBeNull();
  AppState.currentState = "background";
  await act(async () => handlers.get("voice.userInput.request")?.(question("background", "other")));
  expect(view.result.current.request).toBeNull();
  AppState.currentState = "active";
  await act(async () => handlers.get("voice.userInput.request")?.(question("disconnect", "other")));
  await act(async () => { connected = false; snapshotListeners.forEach((listener) => listener()); });
  expect(view.result.current.request).toBeNull();
  await act(async () => { connected = true; snapshotListeners.forEach((listener) => listener()); });
  await act(async () => handlers.get("voice.userInput.request")?.(question("unmount", "other")));
  await view.unmount();
  expect(request).not.toHaveBeenCalled();
});

test("skip returns empty answers and only a matching Runner resolution dismisses the question", async () => {
  const view = await renderHook(() => useVoiceUserInput(manager, "main"));
  await act(async () => handlers.get("voice.userInput.request")?.(question()));
  await act(async () => handlers.get("voice.userInput.resolved")?.({ channel: "agent", op: "voice.userInput.resolved",
    operationId: "wrong", payload: { requestId: "q1" } }));
  expect(view.result.current.request?.requestId).toBe("q1");
  await act(async () => handlers.get("voice.userInput.resolved")?.({ channel: "agent", op: "voice.userInput.resolved",
    operationId: "operation", payload: { requestId: "q1" } }));
  expect(view.result.current.request).toBeNull();
  expect(request).not.toHaveBeenCalled();
  await act(async () => handlers.get("voice.userInput.request")?.(question("skip")));
  await act(async () => view.result.current.decide({ answers: {} }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    payload: { requestId: "skip", result: { answers: {} } },
  }), { timeoutMs: 30_000 });
});

test("expired questions are ignored and late UI responses cannot survive native resolution", async () => {
  const view = await renderHook(() => useVoiceUserInput(manager, "main"));
  const expired = question();
  (expired.payload as { startedAtMs: number }).startedAtMs = Date.now() - 60_001;
  await act(async () => handlers.get("voice.userInput.request")?.(expired));
  expect(view.result.current.request).toBeNull();
  await act(async () => handlers.get("voice.userInput.request")?.(question("current")));
  await act(async () => {
    view.result.current.decide({ answers: {} });
    handlers.get("voice.userInput.resolved")?.({ channel: "agent", op: "voice.userInput.resolved",
      operationId: "operation", payload: { requestId: "current" } });
  });
  expect(request).not.toHaveBeenCalled();
});
