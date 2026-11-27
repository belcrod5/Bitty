import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { useBrowserControl, type BrowserControlRequest } from "./useBrowserControl";
let mockUuidSequence = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++mockUuidSequence).padStart(12, "0")}` }));
const handlers = new Map<string, (message: RunnerWsMessage) => void>();
const listeners = new Set<() => void>();
const send = jest.fn();
const request = jest.fn(async (message) => ({ channel: "control", op: "browser.control.command.result", payload: { status: message.payload.action === "pause" ? "pending" : message.payload.action === "finish" ? "completed" : message.payload.action === "cancel" ? "cancelled" : "active" } }));
let connected = true, generation = 1;
const manager = { request, send, connect: jest.fn(async () => {}), getSnapshot: () => ({ connected, generation, connectionOptionsGeneration: 1 }),
  subscribe: ({ op }: { op: string }, handler: (message: RunnerWsMessage) => void) => { handlers.set(op, handler); return () => handlers.delete(op); },
  subscribeSnapshot: (handler: () => void) => { listeners.add(handler); return () => listeners.delete(handler); },
} as unknown as RunnerWebSocketManager;
const original = AppState.currentState;
const card = (id = "one", chat = "chat"): BrowserControlRequest => ({ requestId: id, origin: "https://example.com", label: "Control", createdAt: "2026-11-26T00:00:00Z", status: "pending", target: { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: chat }, cwd: "/repo" } });
const emit = (op: string, payload: unknown) => {
  if (["frame", "focus", "view_invalidated", "origin", "resolved"].includes(op) && payload && typeof payload === "object" && !("controlId" in payload)) {
    const controlId = request.mock.calls.filter(([message]) => message.payload.action === "start").at(-1)?.[0].payload.controlId;
    payload = { ...payload, controlId };
  }
  handlers.get(`browser.control.${op}`)?.({ channel: "control", op: `browser.control.${op}`, payload });
};
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
  expect(request).toHaveBeenLastCalledWith({ channel: "control", op: "browser.control.command", payload: { requestId: "one", controlId: expect.any(String), action: "input", frameId: 1, sequence: 1, input: { type: "text", text: "日本語 PRIVATE" } } }, { timeoutMs: 10_000 });
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

test("background/disconnect clear images, preserve cards and never forward text through ordinary chat", async () => {
  const spy = jest.spyOn(AppState, "addEventListener"); spy.mockClear();
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => { emit("request", card()); emit("request", card("two")); });
  const frames = jest.fn(); view.result.current.watch("one", frames); await act(async () => view.result.current.command("one", "start"));
  await act(async () => { AppState.currentState = "background"; spy.mock.calls[0][1]("background"); });
  expect(frames).toHaveBeenLastCalledWith(null); expect(view.result.current.requests.map((r) => r.status)).toEqual(["pending", "pending"]);
  expect(send.mock.calls.every(([m]) => ["browser.control.command", "browser.control.sync"].includes(m.op))).toBe(true);
  await view.unmount(); spy.mockRestore();
});

test("input failure pauses without replay and retains only fixed uncertainty metadata", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  const frames = jest.fn(); view.result.current.watch("one", frames); await act(async () => view.result.current.command("one", "start"));
  request.mockRejectedValueOnce(new Error("PRIVATE_RAW_ERROR")); await act(async () => view.result.current.input("one", { type: "text", text: "PRIVATE" }, 1));
  expect(send).toHaveBeenCalledWith({ channel: "control", op: "browser.control.command", payload: { requestId: "one", controlId: expect.any(String), action: "pause" } });
  expect(view.result.current.requests[0]).toMatchObject({ status: "pending", inputStatusUnknown: true });
  expect(frames).toHaveBeenLastCalledWith(null); expect(JSON.stringify(view.result.current.requests)).not.toContain("PRIVATE");
  await view.unmount();
});

test("stale text receives a fixed user notice while pointer drops stay silent and status stays active", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  view.result.current.watch("one", jest.fn()); await act(async () => view.result.current.command("one", "start"));
  request.mockResolvedValueOnce({ channel: "control", op: "browser.control.command.result", payload: { status: "active", inputStatus: "not_applied" } } as never);
  await act(async () => view.result.current.input("one", { type: "text", text: "PRIVATE_STALE" }, 1));
  expect(view.result.current.requests[0]).toMatchObject({ status: "active", inputNotApplied: true });
  expect(JSON.stringify(view.result.current.requests)).not.toContain("PRIVATE"); expect(send.mock.calls.filter(([message]) => message.op === "browser.control.command")).toHaveLength(0);
  await view.unmount();
});
test("an absent frame pauses safely while diagnostics contain only fixed phases and request ID", async () => {
  jest.useFakeTimers(); const diagnostic = jest.fn();
  const view = await renderHook(() => useBrowserControl(manager, diagnostic)); await act(async () => emit("request", card()));
  const frames = jest.fn(); view.result.current.watch("one", frames); await act(async () => view.result.current.command("one", "start"));
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(view.result.current.requests[0].status).toBe("pending"); expect(frames).toHaveBeenLastCalledWith(null);
  expect(send).toHaveBeenCalledWith({ channel: "control", op: "browser.control.command", payload: { requestId: "one", controlId: expect.any(String), action: "pause" } });
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

test("late pending metadata cannot replace a run opened after the sync snapshot", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  const frames = jest.fn(); view.result.current.watch("one", frames); await act(async () => view.result.current.command("one", "start"));
  await act(async () => { emit("sync.result", { requests: [card()] }); emit("request", card()); });
  expect(view.result.current.requests[0].status).toBe("active"); expect(frames).not.toHaveBeenCalled();
  await act(async () => emit("frame", { requestId: "one", frameId: 1, data: "PRIVATE_FRAME", width: 800, height: 600 }));
  expect(frames).toHaveBeenLastCalledWith({ frameId: 1, data: "PRIVATE_FRAME", width: 800, height: 600 }); await view.unmount();
});
test("recovering metadata from a half-open old socket never recovers its private run", async () => {
  const view = await renderHook(() => useBrowserControl(manager));
  await act(async () => emit("sync.result", { requests: [{ ...card(), status: "active" }] }));
  expect(view.result.current.requests[0].status).toBe("pending"); expect(request).not.toHaveBeenCalled();
  expect(JSON.stringify(view.result.current.requests)).not.toContain("controlId"); await view.unmount();
});
test("Open waits for connection without letting a reconnect snapshot close its viewer", async () => {
  connected = false; let ready: (() => void) | undefined;
  (manager.connect as jest.Mock).mockImplementationOnce(() => new Promise<void>((resolve) => { ready = resolve; }));
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  const frames = jest.fn(); view.result.current.watch("one", frames); let opening: Promise<void> | undefined;
  await act(async () => { opening = view.result.current.command("one", "start"); }); expect(view.result.current.requests[0].status).toBe("starting");
  await act(async () => { connected = true; generation++; listeners.forEach((listener) => listener()); emit("sync.result", { requests: [card()] }); ready?.(); await opening; });
  expect(view.result.current.requests[0].status).toBe("active"); expect(frames).not.toHaveBeenCalled(); await view.unmount();
});
test("network loss clears focus and queued input; explicit reopen ignores the old response and frame", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  const frames = jest.fn(), focus = jest.fn(); const stop = view.result.current.watch("one", frames, focus);
  await act(async () => view.result.current.command("one", "start"));
  const oldControlId = request.mock.calls.at(-1)?.[0].payload.controlId;
  let resolveInput: ((value: unknown) => void) | undefined;
  request.mockImplementationOnce(() => new Promise((resolve) => { resolveInput = resolve as (response: unknown) => void; }));
  let input: Promise<void> | undefined;
  await act(async () => { input = view.result.current.input("one", { type: "text", text: "already-sent" }, 1); view.result.current.input("one", { type: "text", text: "PRIVATE_UNSENT" }, 1); });
  await act(async () => { connected = false; listeners.forEach((listener) => listener()); });
  expect(frames).toHaveBeenLastCalledWith(null); expect(focus).toHaveBeenLastCalledWith(null);
  expect(view.result.current.requests[0]).toMatchObject({ status: "pending", inputStatusUnknown: true });
  await act(async () => { stop?.(); connected = true; generation++; listeners.forEach((listener) => listener()); emit("sync.result", { requests: [card()] }); });
  const newFrames = jest.fn(); view.result.current.watch("one", newFrames, jest.fn()); await act(async () => view.result.current.command("one", "start"));
  const newControlId = request.mock.calls.at(-1)?.[0].payload.controlId; expect(newControlId).not.toBe(oldControlId);
  await act(async () => { resolveInput?.({ payload: { status: "active" } }); await input;
    emit("frame", { requestId: "one", controlId: oldControlId, frameId: 1, data: "PRIVATE_OLD", width: 800, height: 600 });
    emit("resolved", { requestId: "one", controlId: oldControlId, status: "pending" }); });
  expect(newFrames).not.toHaveBeenCalled(); expect(view.result.current.requests[0].status).toBe("active");
  expect(JSON.stringify(request.mock.calls)).not.toContain("PRIVATE_UNSENT"); expect(JSON.stringify(view.result.current.requests)).not.toContain("PRIVATE"); await view.unmount();
});
test("focus metadata is bounded, private to the viewer, and invalidated with its frame", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  const focus = jest.fn(); view.result.current.watch("one", jest.fn(), focus); await act(async () => view.result.current.command("one", "start"));
  const meta = { editable: true, multiline: false, kind: "text", focusRevision: "focus-one" };
  await act(async () => emit("focus", { requestId: "one", ...meta, value: "PRIVATE_VALUE" })); expect(focus).toHaveBeenLastCalledWith(meta);
  expect(JSON.stringify(view.result.current.requests)).not.toContain("focus"); expect(JSON.stringify(focus.mock.calls)).not.toContain("PRIVATE_VALUE");
  const count = focus.mock.calls.length;
  await act(async () => { emit("focus", { requestId: "one", ...meta, focusRevision: "x".repeat(129) }); emit("focus", { requestId: "one", controlId: "old-control", ...meta }); });
  expect(focus).toHaveBeenCalledTimes(count); await act(async () => emit("view_invalidated", { requestId: "one" })); expect(focus).toHaveBeenLastCalledWith(null); await view.unmount();
});

test.each(["blur", "invalidate", "stop", "pause", "disconnect", "finish", "background"] as const)("browser typing is ephemeral and clears on %s", async (end) => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card()));
  const stop = view.result.current.watch("one", jest.fn(), jest.fn()); await act(async () => view.result.current.command("one", "start"));
  const meta = { requestId: "one", editable: true, multiline: false, kind: "text", focusRevision: "focus-one" };
  await act(async () => emit("focus", { ...meta, value: "PRIVATE_VALUE" }));
  expect(view.result.current.typingRequestId).toBe("one");
  expect(JSON.stringify(view.result.current.requests)).not.toMatch(/focus|PRIVATE/);
  await act(async () => {
    if (end === "blur") emit("focus", { ...meta, editable: false });
    if (end === "invalidate") emit("view_invalidated", { requestId: "one" });
    if (end === "stop") stop?.();
    if (end === "pause" || end === "finish") await view.result.current.command("one", end);
    if (end === "disconnect") { connected = false; listeners.forEach((listener) => listener()); }
    if (end === "background") { AppState.currentState = "background"; (AppState.addEventListener as jest.Mock).mock.calls.at(-1)[1]("background"); }
  });
  expect(view.result.current.typingRequestId).toBeNull();
  await view.unmount();
});

test("an unrelated viewer blur or pause cannot restore the currently typing chat's composer", async () => {
  const view = await renderHook(() => useBrowserControl(manager));
  await act(async () => { emit("request", card()); emit("request", card("two", "other")); });
  view.result.current.watch("one", jest.fn(), jest.fn()); view.result.current.watch("two", jest.fn(), jest.fn());
  await act(async () => view.result.current.command("one", "start"));
  const firstControl = request.mock.calls.at(-1)?.[0].payload.controlId;
  await act(async () => view.result.current.command("two", "start"));
  const secondControl = request.mock.calls.at(-1)?.[0].payload.controlId;
  const meta = { editable: true, multiline: false, kind: "text", focusRevision: "focus" };
  await act(async () => emit("focus", { ...meta, requestId: "two", controlId: secondControl }));
  await act(async () => { emit("focus", { ...meta, requestId: "one", controlId: firstControl, editable: false }); await view.result.current.command("one", "pause"); });
  expect(view.result.current.typingRequestId).toBe("two");
  await view.unmount();
});
test("completion waits for submitted input and its own response before ending ownership", async () => {
  const view = await renderHook(() => useBrowserControl(manager)); await act(async () => emit("request", card())); view.result.current.watch("one", jest.fn());
  await act(async () => view.result.current.command("one", "start"));
  let resolveInput: ((response: unknown) => void) | undefined, resolveFinish: ((response: unknown) => void) | undefined;
  request.mockImplementationOnce(() => new Promise((resolve) => { resolveInput = resolve as (response: unknown) => void; }));
  request.mockImplementationOnce(() => new Promise((resolve) => { resolveFinish = resolve as (response: unknown) => void; }));
  let finishing: Promise<void> | undefined;
  await act(async () => { view.result.current.input("one", { type: "key", key: "Enter" }, 1); finishing = view.result.current.command("one", "finish"); });
  expect(request.mock.calls.filter(([message]) => message.payload.action === "finish")).toHaveLength(0);
  await act(async () => { resolveInput?.({ payload: { status: "active" } }); });
  expect(request.mock.calls.filter(([message]) => message.payload.action === "finish")).toHaveLength(1); expect(view.result.current.requests[0].status).toBe("active");
  await act(async () => { resolveFinish?.({ payload: { status: "completed" } }); await finishing; });
  expect(view.result.current.requests[0].status).toBe("completed"); await view.unmount();
});


test("a duplicate start cannot cancel the first connection attempt", async () => {
  let connect: (() => void) | undefined;
  jest.spyOn(manager, "connect").mockImplementationOnce(async () => { await new Promise<void>((resolve) => { connect = resolve; }); });
  const view = await renderHook(() => useBrowserControl(manager));
  await act(async () => emit("request", card()));
  view.result.current.watch("one", jest.fn());
  let first: Promise<void> | undefined;
  await act(async () => { first = view.result.current.command("one", "start"); });
  expect(view.result.current.requests[0].status).toBe("starting");
  await act(async () => { await view.result.current.command("one", "start"); });
  await act(async () => { connect?.(); await first; });
  expect(request.mock.calls.filter(([message]) => message.payload.action === "start")).toHaveLength(1);
  expect(view.result.current.requests[0].status).toBe("active");
  await view.unmount();
});
