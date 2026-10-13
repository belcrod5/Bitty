import { NativeModules, Platform } from "react-native";
import { configureLocalRunnerTls, createLocalRunnerWebSocket, isLocalRunnerTlsReady } from "./localRunnerTls";
import { createWebSocketWithOptionalAuth } from "../../ws/webSocketAuth";

let mockListener: ((event: Record<string, unknown>) => void) | undefined;
const mockRemove = jest.fn();
jest.mock("react-native", () => {
  return {
    Platform: { OS: "ios" },
    NativeModules: { BittyRunnerTLS: { configure: jest.fn(), connect: jest.fn(), send: jest.fn(), close: jest.fn() } },
    NativeEventEmitter: jest.fn(() => ({ addListener: jest.fn((_name, listener) => {
      mockListener = listener;
      return { remove: mockRemove };
    }) })),
  };
});
const module = NativeModules.BittyRunnerTLS;
const origin = "https://test-mac.local:8789";

beforeEach(async () => {
  jest.replaceProperty(Platform, "OS", "ios");
  module.configure.mockResolvedValue(undefined);
  module.send.mockResolvedValue(undefined);
  await configureLocalRunnerTls("", "");
  jest.clearAllMocks();
});
afterEach(() => jest.restoreAllMocks());

test("paired trust becomes ready only after native configuration resolves and repeated install is avoided", async () => {
  let resolve!: () => void;
  module.configure.mockImplementation(() => new Promise<void>((finish) => { resolve = finish; }));
  const installing = configureLocalRunnerTls(origin, "test-ca");
  await Promise.resolve();
  expect(isLocalRunnerTlsReady(origin)).toBe(false);
  expect(createLocalRunnerWebSocket("wss://test-mac.local:8789/runner-ws", {})).toBeNull();
  resolve();
  await expect(installing).resolves.toBe(true);
  expect(isLocalRunnerTlsReady(origin, "test-ca")).toBe(true);
  expect(isLocalRunnerTlsReady(origin, "different-ca")).toBe(false);
  await configureLocalRunnerTls(origin, "test-ca");
  expect(module.configure).toHaveBeenCalledTimes(1);
});

test("unsupported platforms never enable custom local trust", async () => {
  jest.replaceProperty(Platform, "OS", "android");
  await expect(configureLocalRunnerTls(origin, "test-ca")).resolves.toBe(false);
  expect(isLocalRunnerTlsReady(origin)).toBe(false);
  expect(module.configure).not.toHaveBeenCalled();
});

test("configuration failure leaves local trust disabled and never forwards certificate contents in errors", async () => {
  module.configure.mockRejectedValue(new Error("invalid CA"));
  await expect(configureLocalRunnerTls(origin, "test-ca")).rejects.toThrow("invalid CA");
  expect(isLocalRunnerTlsReady(origin)).toBe(false);
});

test("production WebSocket auth uses paired native socket and dispatches text/binary/close events", async () => {
  await configureLocalRunnerTls(origin, "test-ca");
  const socket = createWebSocketWithOptionalAuth("wss://test-mac.local:8789/runner-ws", "runner-token");
  const [id, url, headers] = module.connect.mock.calls[0];
  expect(url).toBe("wss://test-mac.local:8789/runner-ws");
  expect(headers).toEqual({ Authorization: "Bearer runner-token" });
  expect(socket.readyState).toBe(0);
  const open = jest.fn();
  const message = jest.fn();
  const close = jest.fn();
  socket.onopen = open;
  socket.onmessage = message;
  socket.onclose = close;
  const listener = jest.fn();
  socket.addEventListener("message", listener);
  mockListener?.({ id: id + 1, type: "open" });
  expect(open).not.toHaveBeenCalled();
  mockListener?.({ id, type: "open" });
  expect(socket.readyState).toBe(1);
  expect(open).toHaveBeenCalledTimes(1);
  socket.send("text");
  socket.send(new Uint8Array([1, 2, 255]));
  expect(module.send).toHaveBeenCalledWith(id, "text", false);
  expect(module.send).toHaveBeenCalledWith(id, "AQL/", true);
  expect(socket.bufferedAmount).toBeGreaterThan(0);
  mockListener?.({ id, type: "message", data: "hello", binary: false });
  expect(message).toHaveBeenCalledWith(expect.objectContaining({ data: "hello" }));
  expect(listener).toHaveBeenCalledTimes(1);
  socket.removeEventListener("message", listener);
  mockListener?.({ id, type: "message", data: "AQL/", binary: true });
  expect(new Uint8Array(message.mock.calls[1][0].data)).toEqual(new Uint8Array([1, 2, 255]));
  expect(listener).toHaveBeenCalledTimes(1);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(socket.bufferedAmount).toBe(0);
  socket.close(1000, "done");
  expect(module.close).toHaveBeenCalledWith(id, 1000, "done");
  expect(socket.readyState).toBe(2);
  mockListener?.({ id, type: "close", code: 1000, reason: "done" });
  expect(socket.readyState).toBe(3);
  expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: 1000, reason: "done", wasClean: true }));
  expect(mockRemove).toHaveBeenCalledTimes(1);
});

test("plaintext LAN websocket is rejected before any native or global transport receives bearer", () => {
  expect(() => createWebSocketWithOptionalAuth("ws://192.168.1.5:8788/runner-ws", "runner-token"))
    .toThrow("runner_plaintext_connection_rejected");
  expect(module.connect).not.toHaveBeenCalled();
});
