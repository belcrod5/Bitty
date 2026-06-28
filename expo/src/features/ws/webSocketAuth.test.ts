import { createWebSocketWithOptionalAuth } from "./webSocketAuth";

const originalWebSocket = global.WebSocket;

afterEach(() => {
  global.WebSocket = originalWebSocket;
  jest.restoreAllMocks();
});

test("does not create a runner websocket without a runner token", () => {
  const calls: unknown[][] = [];
  global.WebSocket = jest.fn((...args: unknown[]) => {
    calls.push(args);
    return {} as WebSocket;
  }) as unknown as typeof WebSocket;

  expect(() => {
    createWebSocketWithOptionalAuth("ws://127.0.0.1:8788/runner-ws", "");
  }).toThrow("runner_token_required");

  expect(calls).toEqual([]);
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

test("does not open a Cloudflare Access websocket without a runner token", () => {
  global.WebSocket = jest.fn() as unknown as typeof WebSocket;

  jest.spyOn(require("../app/utils/cloudflareAccessFetch"), "getCloudflareAccessHeadersForUrl")
    .mockReturnValue({
      "CF-Access-Client-Id": "access-id",
      "CF-Access-Client-Secret": "access-secret",
    });

  expect(() => {
    createWebSocketWithOptionalAuth("wss://runner.example.com/runner-ws", "");
  }).toThrow("runner_token_required");
  expect(global.WebSocket).not.toHaveBeenCalled();
});
