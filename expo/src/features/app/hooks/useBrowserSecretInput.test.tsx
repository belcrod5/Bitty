import { act, renderHook } from "@testing-library/react-native";
import { AppState } from "react-native";
import { getVoiceControl } from "../../appControl/voiceControl";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { useBrowserSecretInput, type BrowserSecretInputRequest } from "./useBrowserSecretInput";

jest.mock("../../appControl/voiceControl", () => ({ getVoiceControl: jest.fn() }));
const handlers = new Map<string, (message: RunnerWsMessage) => void>();
const listeners = new Set<() => void>();
const send = jest.fn();
const request = jest.fn(async () => ({ channel: "control", op: "browser.input.respond.result", payload: { status: "completed" } }));
let connected = true; let owns = true;
const manager = {
  request, send,
  getSnapshot: () => ({ connected }),
  subscribe: ({ op }: { op: string }, handler: (message: RunnerWsMessage) => void) => { handlers.set(op, handler); return () => { handlers.delete(op); }; },
  subscribeSnapshot: (handler: () => void) => { listeners.add(handler); return () => { listeners.delete(handler); }; },
} as unknown as RunnerWebSocketManager;
const originalState = AppState.currentState;
const form = (id = "request-1"): BrowserSecretInputRequest => ({ requestId: id, destinationOrigin: "https://payments.example", topOrigin: "https://shop.example", label: "Card number", expiresAt: new Date(Date.now() + 120_000).toISOString(),
  origin: { clientInstanceId: "phone", connectionGeneration: "connection", surfaceId: "panel", ownerGeneration: 4, target: { kind: "session", sessionRef: { backendId: "claude", nativeSessionId: "chat" }, cwd: "/repo" } } });
const emit = (payload = form()) => handlers.get("browser.input.request")?.({ channel: "control", op: "browser.input.request", payload });
beforeEach(() => {
  AppState.currentState = "active"; connected = true; owns = true;
  handlers.clear(); listeners.clear(); send.mockClear(); request.mockClear();
  (getVoiceControl as jest.Mock).mockReturnValue({ matchesOrigin: () => owns });
});
afterEach(() => { AppState.currentState = originalState; jest.useRealTimers(); });

test("dedicated device channel submits exact whitespace without chat/model action messages", async () => {
  const view = await renderHook(() => useBrowserSecretInput(manager));
  await act(async () => emit());
  expect(view.result.current.request?.destinationOrigin).toBe("https://payments.example");
  await act(async () => view.result.current.submit("  private text  "));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith({ channel: "control", op: "browser.input.respond", payload: { requestId: "request-1", value: "  private text  " } }, { timeoutMs: 10_000 });
  expect(view.result.current.request).toBeNull();
  await view.unmount();
});

test("wrong origin, expired request and background never expose a form", async () => {
  const view = await renderHook(() => useBrowserSecretInput(manager));
  owns = false; await act(async () => emit());
  expect(view.result.current.request).toBeNull();
  owns = true;
  const expired = { ...form(), expiresAt: new Date(Date.now() - 1).toISOString() };
  await act(async () => emit(expired));
  AppState.currentState = "background"; await act(async () => emit());
  expect(view.result.current.request).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(3);
  await view.unmount();
});

test("owner change, disconnection, expiry and unmount discard pending input", async () => {
  jest.useFakeTimers();
  const view = await renderHook(() => useBrowserSecretInput(manager));
  await act(async () => emit());
  owns = false;
  await act(async () => { jest.advanceTimersByTime(250); });
  expect(view.result.current.request).toBeNull();
  owns = true; await act(async () => emit(form("disconnect")));
  await act(async () => { connected = false; listeners.forEach((listener) => listener()); });
  expect(view.result.current.request).toBeNull();
  connected = true; await act(async () => emit(form("expire")));
  await act(async () => { jest.advanceTimersByTime(120_000); });
  expect(view.result.current.request).toBeNull();
  await act(async () => emit(form("unmount")));
  await view.unmount();
  expect(request).not.toHaveBeenCalled();
  expect(send.mock.calls.every(([message]) => message.payload.cancel === true && message.payload.value === undefined)).toBe(true);
});

test("only matching resolution clears form; stale submit cannot carry a value", async () => {
  const view = await renderHook(() => useBrowserSecretInput(manager));
  await act(async () => emit());
  await act(async () => handlers.get("browser.input.resolved")?.({ channel: "control", op: "browser.input.resolved", payload: { requestId: "other" } }));
  expect(view.result.current.request).not.toBeNull();
  owns = false;
  await act(async () => view.result.current.submit("must never leave app"));
  expect(request).not.toHaveBeenCalled();
  expect(view.result.current.request).toBeNull();
  owns = true; await act(async () => emit());
  await act(async () => handlers.get("browser.input.resolved")?.({ channel: "control", op: "browser.input.resolved", payload: { requestId: "request-1" } }));
  expect(view.result.current.request).toBeNull();
  await view.unmount();
});

test("oversized values stay local and synchronous duplicate submits cannot send twice", async () => {
  const view = await renderHook(() => useBrowserSecretInput(manager));
  await act(async () => emit());
  await act(async () => view.result.current.submit("x".repeat(4097)));
  expect(request).not.toHaveBeenCalled();
  expect(view.result.current.request).not.toBeNull();
  await act(async () => { await Promise.all([view.result.current.submit("private"), view.result.current.submit("private")]); });
  expect(request).toHaveBeenCalledTimes(1);
  await view.unmount();
});
