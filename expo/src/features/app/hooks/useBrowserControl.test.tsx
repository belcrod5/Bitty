import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { useBrowserControl, type BrowserControlRequest } from "./useBrowserControl";
const handlers = new Map<string, (message: RunnerWsMessage) => void>();
const listeners = new Set<() => void>();
const send = jest.fn();
const request = jest.fn(async (message) => ({ channel: "control", op: "browser.control.command.result", payload: { status: message.payload.action === "pause" ? "pending" : message.payload.action === "finish" ? "completed" : message.payload.action === "cancel" ? "cancelled" : "active" } }));
let connected = true, generation = 1;
const manager = { request, send, getSnapshot: () => ({ connected, connectionOptionsGeneration: generation }),
  subscribe: ({ op }: { op: string }, handler: (message: RunnerWsMessage) => void) => { handlers.set(op, handler); return () => handlers.delete(op); },
  subscribeSnapshot: (handler: () => void) => { listeners.add(handler); return () => listeners.delete(handler); },
} as unknown as RunnerWebSocketManager;
const original = AppState.currentState;
const card = (id = "one", chat = "chat"): BrowserControlRequest => ({ requestId: id, origin: "https://example.com", label: "Control", createdAt: "2026-11-26T00:00:00Z", status: "pending", target: { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: chat }, cwd: "/repo" } });
const emit = (op: string, payload: unknown) => handlers.get(`browser.control.${op}`)?.({ channel: "control", op: `browser.control.${op}`, payload });
beforeEach(() => { AppState.currentState = "active"; connected = true; generation = 1; handlers.clear(); listeners.clear(); send.mockClear(); request.mockClear(); jest.spyOn(AppState, "addEventListener").mockImplementation(() => ({ remove: jest.fn() })); });
afterEach(() => { AppState.currentState = original; jest.restoreAllMocks(); });

test("cards are asynchronous; only the mounted viewer receives private frames and status remains metadata-only", async () => {
  const view = await renderHook(() => useBrowserControl(manager));
  await act(async () => { emit("request", card()); emit("request", card("two", "other-chat")); });
  expect(request).not.toHaveBeenCalled();
  const frames = jest.fn(); let stop: (() => void) | null = null;
  await act(async () => { stop = view.result.current.watch("one", frames); await view.result.current.command("one", "start"); });
  await act(async () => emit("frame", { requestId: "one", frameId: 1, data: "PRIVATE_IMAGE", width: 800, height: 600 }));
  expect(frames).toHaveBeenCalledWith({ frameId: 1, data: "PRIVATE_IMAGE", width: 800, height: 600 });
  expect(JSON.stringify(view.result.current.requests)).not.toContain("PRIVATE");
  await act(async () => view.result.current.input("one", { type: "text", text: "日本語 PRIVATE" }, 1));
  expect(request).toHaveBeenLastCalledWith({ channel: "control", op: "browser.control.command", payload: { requestId: "one", action: "input", frameId: 1, sequence: 1, input: { type: "text", text: "日本語 PRIVATE" } } }, { timeoutMs: 10_000 });
  await act(async () => { stop?.(); });
  expect(frames).toHaveBeenLastCalledWith(null); expect(view.result.current.requests.map((r) => r.status)).toEqual(["pending", "pending"]);
  await view.unmount();
});

test("high-rate gestures coalesce without losing down/up or typing order", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  view.result.current.watch("one", jest.fn()); await act(async () => view.result.current.command("one", "start"));
  let release: (() => void) | undefined;
  request.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { channel: "control", op: "browser.control.command.result", payload: { status: "active" } }; });
  let done: Promise<void> | undefined;
  await act(async () => {
    view.result.current.input("one", { type: "down", x: 0, y: 0 }, 1);
    for (let i = 1; i <= 120; i++) view.result.current.input("one", { type: "move", x: i / 120, y: 0.5 }, 1);
    view.result.current.input("one", { type: "up", x: 1, y: 0.5 }, 1);
    done = view.result.current.input("one", { type: "text", text: "after drag" }, 1);
  });
  await act(async () => { release?.(); await done; });
  const inputs = request.mock.calls.filter(([m]) => m.payload.action === "input").map(([m]) => m.payload.input);
  expect(inputs).toEqual([{ type: "down", x: 0, y: 0 }, { type: "move", x: 1, y: 0.5 }, { type: "up", x: 1, y: 0.5 }, { type: "text", text: "after drag" }]);
  await view.unmount();
});

test("only one view owns a card; navigation clears its image and departure drops unsent input", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  const frames = jest.fn(); const stop = view.result.current.watch("one", frames); expect(view.result.current.watch("one", jest.fn())).toBeNull();
  await act(async () => view.result.current.command("one", "start"));
  await act(async () => emit("view_invalidated", { requestId: "one" })); expect(frames).toHaveBeenLastCalledWith(null);
  let release: (() => void) | undefined;
  request.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { channel: "control", op: "browser.control.command.result", payload: { status: "active" } }; });
  await act(async () => { view.result.current.input("one", { type: "text", text: "already sent" }, 1); view.result.current.input("one", { type: "text", text: "must discard" }, 1); stop?.(); });
  await act(async () => { release?.(); });
  expect(JSON.stringify(request.mock.calls)).not.toContain("must discard");
  expect(view.result.current.requests[0].status).toBe("pending"); await view.unmount();
});

test("background/disconnect clear images, terminate cards and never forward text through ordinary chat", async () => {
  const spy = jest.spyOn(AppState, "addEventListener"); spy.mockClear();
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => { emit("request", card()); emit("request", card("two")); });
  const frames = jest.fn(); view.result.current.watch("one", frames); await act(async () => view.result.current.command("one", "start"));
  await act(async () => { AppState.currentState = "background"; spy.mock.calls[0][1]("background"); });
  expect(frames).toHaveBeenLastCalledWith(null); expect(view.result.current.requests.map((r) => r.status)).toEqual(["control_status_unknown", "expired"]);
  expect(send.mock.calls.every(([m]) => m.op === "browser.control.command")).toBe(true);
  await view.unmount(); spy.mockRestore();
});

test("input failure sends cancel immediately and retains only fixed status", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  const frames = jest.fn(); view.result.current.watch("one", frames); await act(async () => view.result.current.command("one", "start"));
  request.mockRejectedValueOnce(new Error("PRIVATE_RAW_ERROR")); await act(async () => view.result.current.input("one", { type: "text", text: "PRIVATE" }, 1));
  expect(send).toHaveBeenCalledWith({ channel: "control", op: "browser.control.command", payload: { requestId: "one", action: "cancel" } });
  expect(frames).toHaveBeenLastCalledWith(null); expect(JSON.stringify(view.result.current.requests)).not.toContain("PRIVATE");
  await view.unmount();
});

test("stale text receives a fixed user notice while pointer drops stay silent and status stays active", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  view.result.current.watch("one", jest.fn()); await act(async () => view.result.current.command("one", "start"));
  request.mockResolvedValueOnce({ channel: "control", op: "browser.control.command.result", payload: { status: "active", inputStatus: "not_applied" } } as never);
  await act(async () => view.result.current.input("one", { type: "text", text: "PRIVATE_STALE" }, 1));
  expect(view.result.current.requests[0]).toMatchObject({ status: "active", inputNotApplied: true });
  expect(JSON.stringify(view.result.current.requests)).not.toContain("PRIVATE"); expect(send).not.toHaveBeenCalled();
  await view.unmount();
});
test("an absent frame times out safely while diagnostics contain only fixed phases and request ID", async () => {
  jest.useFakeTimers(); const diagnostic = jest.fn();
  const view = await renderHook(() => useBrowserControl(manager, diagnostic)); await act(async () => emit("request", card()));
  const frames = jest.fn(); view.result.current.watch("one", frames); await act(async () => view.result.current.command("one", "start"));
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(view.result.current.requests[0].status).toBe("failed"); expect(frames).toHaveBeenLastCalledWith(null);
  expect(send).toHaveBeenCalledWith({ channel: "control", op: "browser.control.command", payload: { requestId: "one", action: "cancel" } });
  expect(diagnostic.mock.calls).toEqual([["browser_control", { requestId: "one", phase: "start" }], ["browser_control", { requestId: "one", phase: "frame_timeout" }]]);
  await view.unmount(); jest.useRealTimers();
});
test("first receipt and rendering are logged once without private content, and stop the missing-frame timer", async () => {
  jest.useFakeTimers(); const diagnostic = jest.fn();
  const view = await renderHook(() => useBrowserControl(manager, diagnostic)); await act(async () => emit("request", card()));
  view.result.current.watch("one", jest.fn()); await act(async () => view.result.current.command("one", "start"));
  await act(async () => {
    emit("frame", { requestId: "one", frameId: 1, data: "PRIVATE_FRAME", width: 800, height: 600 });
    view.result.current.ack("one", 1);
    emit("frame", { requestId: "one", frameId: 2, data: "PRIVATE_FRAME_2", width: 800, height: 600 });
    view.result.current.ack("one", 2); jest.advanceTimersByTime(20_000);
  });
  expect(view.result.current.requests[0].status).toBe("active"); expect(diagnostic.mock.calls.map(([, payload]) => payload.phase)).toEqual(["start", "frame_received", "frame_rendered"]);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("PRIVATE");
  await act(async () => view.result.current.failDisplay("one", "render_failed"));
  expect(view.result.current.requests[0].status).toBe("failed"); expect(diagnostic).toHaveBeenLastCalledWith("browser_control", { requestId: "one", phase: "render_failed" });
  await view.unmount(); jest.useRealTimers();
});
test("close/reopen and late start responses cannot revive the previous viewer", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  const stop = view.result.current.watch("one", jest.fn()); let resolveStart: ((response: unknown) => void) | undefined; let starting: Promise<void> | undefined;
  request.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve as (response: unknown) => void; }));
  await act(async () => { starting = view.result.current.command("one", "start"); });
  await act(async () => stop?.());
  expect(view.result.current.requests[0].status).toBe("pending");
  await act(async () => { resolveStart?.({ payload: { status: "active" } }); await starting; });
  expect(view.result.current.requests[0].status).toBe("pending");
  view.result.current.watch("one", jest.fn()); await act(async () => view.result.current.command("one", "start"));
  expect(view.result.current.requests[0].status).toBe("active"); await view.unmount();
});
test("effect setup/cleanup/setup discards an unstarted viewer without sending its delayed start", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  await act(async () => {
    const stop = view.result.current.watch("one", jest.fn()); const first = view.result.current.command("one", "start");
    stop?.(); view.result.current.watch("one", jest.fn()); await view.result.current.command("one", "start"); await first;
  });
  expect(request.mock.calls.filter(([message]) => message.payload.action === "start")).toHaveLength(1);
  expect(view.result.current.requests[0].status).toBe("active"); await view.unmount();
});
test("a display failure after an action preserves uncertainty and sends cancellation once", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  view.result.current.watch("one", jest.fn()); await act(async () => view.result.current.command("one", "start"));
  await act(async () => view.result.current.input("one", { type: "key", key: "Enter" }, 1));
  await act(async () => view.result.current.failDisplay("one", "render_failed"));
  expect(view.result.current.requests[0].status).toBe("control_status_unknown");
  expect(send.mock.calls.filter(([message]) => message.payload.action === "cancel")).toHaveLength(1); await view.unmount();
});
