import { createWebSocketWithOptionalAuth } from "./webSocketAuth";

const originalWebSocket = global.WebSocket;

afterEach(() => {
  global.WebSocket = originalWebSocket;
  jest.restoreAllMocks();
});

test("creates an unauthenticated websocket only when no auth headers are needed", () => {
  const calls: unknown[][] = [];
  global.WebSocket = jest.fn((...args: unknown[]) => {
    calls.push(args);
    return {} as WebSocket;
  }) as unknown as typeof WebSocket;

  createWebSocketWithOptionalAuth("ws://127.0.0.1:8788/runner-ws", "");

  expect(calls).toEqual([["ws://127.0.0.1:8788/runner-ws"]]);
});

test("does not fall back to an unauthenticated websocket when auth headers are needed", () => {
  const calls: unknown[][] = [];
  global.WebSocket = jest.fn((...args: unknown[]) => {
    calls.push(args);
    throw new Error("headers unsupported");
  }) as unknown as typeof WebSocket;

  expect(() => {
    createWebSocketWithOptionalAuth("ws://127.0.0.1:8788/runner-ws", "runner-token");
  }).toThrow("authenticated_websocket_create_failed");

  expect(calls).toEqual([
    [
      "ws://127.0.0.1:8788/runner-ws",
      [],
      { headers: { Authorization: "Bearer runner-token" } },
    ],
    [
      "ws://127.0.0.1:8788/runner-ws",
      undefined,
      { headers: { Authorization: "Bearer runner-token" } },
    ],
  ]);
});
