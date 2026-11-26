import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { useBrowserSecretInput, type BrowserSecretInputRequest } from "./useBrowserSecretInput";

const handlers = new Map<string, (message: RunnerWsMessage) => void>();
const listeners = new Set<() => void>();
const send = jest.fn();
const request = jest.fn(async () => ({ channel: "control", op: "browser.input.respond.result", payload: { status: "completed" } }));
let connected = true;
const manager = { request, send, getSnapshot: () => ({ connected }),
  subscribe: ({ op }: { op: string }, handler: (message: RunnerWsMessage) => void) => { handlers.set(op, handler); return () => { handlers.delete(op); }; },
  subscribeSnapshot: (handler: () => void) => { listeners.add(handler); return () => { listeners.delete(handler); }; },
} as unknown as RunnerWebSocketManager;
const originalState = AppState.currentState;
const form = (id = "request-1", chat = "chat"): BrowserSecretInputRequest => ({ requestId: id, destinationOrigin: "https://payments.example", topOrigin: "https://shop.example", label: "Card number", createdAt: "2026-11-26T00:00:00.000Z", status: "pending",
  target: { kind: "session", sessionRef: { backendId: "claude", nativeSessionId: chat }, cwd: "/repo" } });
const emit = (payload = form()) => handlers.get("browser.input.request")?.({ channel: "control", op: "browser.input.request", payload });
beforeEach(() => { AppState.currentState = "active"; connected = true; handlers.clear(); listeners.clear(); send.mockClear(); request.mockClear(); });
afterEach(() => { AppState.currentState = originalState; });

test("cards retain separate chat metadata and exact values use only the dedicated device channel", async () => {
  const view = await renderHook(() => useBrowserSecretInput(manager));
  await act(async () => { emit(); emit(form("second", "other-chat")); });
  view.result.current.drafts.set("request-1", "  private text  ");
  expect(view.result.current.requests).toHaveLength(2);
  expect(JSON.stringify(view.result.current.requests)).not.toContain("private text");
  await act(async () => view.result.current.submit("request-1", "  private text  "));
  expect(request).toHaveBeenCalledWith({ channel: "control", op: "browser.input.respond", payload: { requestId: "request-1", value: "  private text  " } }, { timeoutMs: 10_000 });
  expect(view.result.current.requests.map((r) => r.status)).toEqual(["completed", "pending"]);
  expect(view.result.current.drafts.has("request-1")).toBe(false);
  await act(async () => view.result.current.submit("request-1", "must not replay"));
  expect(request).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test("old creation timestamps do not expire cards and duplicate requests preserve memory drafts", async () => {
  const view = await renderHook(() => useBrowserSecretInput(manager));
  await act(async () => emit());
  view.result.current.drafts.set("request-1", "memory only");
  await act(async () => emit());
  expect(view.result.current.requests).toHaveLength(1);
  expect(view.result.current.drafts.get("request-1")).toBe("memory only");
  await act(async () => view.result.current.submit("request-1", "x".repeat(4097)));
  expect(request).not.toHaveBeenCalled();
  await act(async () => Promise.all([view.result.current.submit("request-1", "private"), view.result.current.submit("request-1", "private")]));
  expect(request).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test("disconnect retains terminal cards while clearing all draft values", async () => {
  const view = await renderHook(() => useBrowserSecretInput(manager));
  await act(async () => { emit(); emit(form("second")); });
  view.result.current.drafts.set("request-1", "discard private");
  await act(async () => view.result.current.submit("second", "completed private"));
  await act(async () => { connected = false; listeners.forEach((listener) => listener()); });
  expect(view.result.current.requests.map((r) => r.status)).toEqual(["expired", "completed"]);
  expect(view.result.current.drafts.size).toBe(0);
  expect(JSON.stringify(view.result.current.requests)).not.toContain("private");
  await view.unmount();
});

test("invalidation and cancellation affect only their card and never forward a draft", async () => {
  const view = await renderHook(() => useBrowserSecretInput(manager));
  await act(async () => { emit(); emit(form("second")); });
  view.result.current.drafts.set("request-1", "not sent");
  await act(async () => handlers.get("browser.input.resolved")?.({ channel: "control", op: "browser.input.resolved", payload: { requestId: "request-1", status: "invalidated" } }));
  await act(async () => view.result.current.cancel("second"));
  expect(view.result.current.requests.map((r) => r.status)).toEqual(["invalidated", "cancelled"]);
  expect(send).toHaveBeenCalledWith({ channel: "control", op: "browser.input.respond", payload: { requestId: "second", cancel: true } });
  expect(request).not.toHaveBeenCalled();
  expect(view.result.current.drafts.size).toBe(0);
  await view.unmount();
});

test("backgrounding clears drafts and keeps an expired card rather than deleting the timeline row", async () => {
  const spy = jest.spyOn(AppState, "addEventListener");
  spy.mockClear();
  const view = await renderHook(() => useBrowserSecretInput(manager));
  await act(async () => emit());
  view.result.current.drafts.set("request-1", "private draft");
  await act(async () => { AppState.currentState = "background"; spy.mock.calls[0][1]("background"); });
  expect(view.result.current.requests[0].status).toBe("expired");
  expect(view.result.current.drafts.size).toBe(0);
  expect(request).not.toHaveBeenCalled();
  await view.unmount(); spy.mockRestore();
});
