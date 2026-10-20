import { act, renderHook } from "@testing-library/react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { useVoiceCalendar } from "./useVoiceCalendar";
import { parseCalendarToolCall, type createCalendarToolHandler } from "../../calendar/calendarToolHandler";

jest.mock("../../calendar/calendarToolHandler", () => ({
  parseCalendarToolCall: jest.fn(async (raw) => ({ appServerRequestId: raw.id, ...raw.params })),
}));

const handlers = new Map<string, (message: RunnerWsMessage) => void>();
const snapshotListeners = new Set<() => void>();
let connected = true;
const request = jest.fn(async () => ({ channel: "agent", op: "voice.calendar.respond.result" }));
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
const data = { ok: true as const, data: { events: [{ title: "配送予定" }] } };
const handle = jest.fn(async () => data);
const handler = { handle } as unknown as ReturnType<typeof createCalendarToolHandler>;
const calendar = (tool = "calendar_search_events"): RunnerWsMessage => ({
  channel: "agent", op: "voice.calendar.request", operationId: "voice-operation",
  payload: { requestId: "calendar-request", method: "item/tool/call", startedAtMs: Date.now(),
    params: { namespace: "calendar", tool, callId: "call", threadId: "native-thread", turnId: "native-turn",
      arguments: { start: "2026-10-20T00:00:00+09:00", end: "2026-10-21T00:00:00+09:00" } } },
});
beforeEach(() => {
  connected = true;
  handlers.clear();
  snapshotListeners.clear();
  jest.clearAllMocks();
  handle.mockImplementation(async () => data);
});

test("voice calendar uses the shared device handler once and returns the correlated result", async () => {
  const view = await renderHook(() => useVoiceCalendar(manager, handler));
  await act(async () => {
    handlers.get("voice.calendar.request")?.(calendar());
    handlers.get("voice.calendar.request")?.(calendar());
  });
  expect(handle).toHaveBeenCalledTimes(1);
  expect(handle).toHaveBeenCalledWith(expect.objectContaining({ threadId: "native-thread", turnId: "native-turn",
    tool: "calendar_search_events" }));
  expect(request).toHaveBeenCalledWith({ channel: "agent", op: "voice.calendar.respond", operationId: "voice-operation",
    payload: { requestId: "calendar-request", result: data } }, { timeoutMs: 30_000 });
  await view.unmount();
});

test.each(["calendar_create_event", "calendar_update_event", "calendar_delete_event", "unknown"])(
  "voice never executes %s", async (tool) => {
    const view = await renderHook(() => useVoiceCalendar(manager, handler));
    await act(async () => handlers.get("voice.calendar.request")?.(calendar(tool)));
    expect(handle).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ payload: { requestId: "calendar-request",
      result: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "invalid_arguments" }) }) } }),
    { timeoutMs: 30_000 });
    await view.unmount();
  });

test("expired, malformed, foreign namespace and failed reads do not reach calendar writes", async () => {
  const view = await renderHook(() => useVoiceCalendar(manager, handler));
  const expired = calendar();
  (expired.payload as { startedAtMs: number }).startedAtMs = Date.now() - 30_001;
  await act(async () => handlers.get("voice.calendar.request")?.(expired));
  expect(parseCalendarToolCall).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  const foreign = calendar();
  (foreign.payload as { params: { namespace: string } }).params.namespace = "other";
  await act(async () => handlers.get("voice.calendar.request")?.(foreign));
  expect(handle).not.toHaveBeenCalled();
  jest.mocked(parseCalendarToolCall).mockResolvedValueOnce(null);
  await act(async () => handlers.get("voice.calendar.request")?.(calendar()));
  expect(handle).not.toHaveBeenCalled();
  handle.mockRejectedValueOnce(new Error("device failure"));
  await act(async () => handlers.get("voice.calendar.request")?.(calendar()));
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { requestId: "calendar-request",
    result: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "calendar_api_failed" }) }) } }),
  { timeoutMs: 30_000 });
  await view.unmount();
});

test.each(["resolved", "disconnect", "unmount"])("%s suppresses late calendar results", async (end) => {
  let finish!: (value: typeof data) => void;
  handle.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = await renderHook(() => useVoiceCalendar(manager, handler));
  await act(async () => handlers.get("voice.calendar.request")?.(calendar()));
  expect(handle).toHaveBeenCalledTimes(1);
  await act(async () => {
    handlers.get("voice.calendar.resolved")?.({ channel: "agent", op: "voice.calendar.resolved",
      operationId: "unrelated", payload: { requestId: "calendar-request" } });
  });
  if (end === "resolved") await act(async () => handlers.get("voice.calendar.resolved")?.({
    channel: "agent", op: "voice.calendar.resolved", operationId: "voice-operation", payload: { requestId: "calendar-request" },
  }));
  if (end === "disconnect") await act(async () => { connected = false; snapshotListeners.forEach((listener) => listener()); });
  if (end === "unmount") await view.unmount();
  await act(async () => finish(data));
  expect(request).not.toHaveBeenCalled();
  if (end !== "unmount") await view.unmount();
});
