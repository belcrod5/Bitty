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
    throw new Error("native error includes Bearer runner-token and access-secret");
  }) as unknown as typeof WebSocket;

  let thrown: unknown;
  try {
    createWebSocketWithOptionalAuth("ws://127.0.0.1:8788/runner-ws", "runner-token");
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toEqual(new Error("authenticated_websocket_create_failed"));
  expect(String(thrown)).not.toContain("runner-token");
  expect(String(thrown)).not.toContain("access-secret");

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

test("uses the explicit Access snapshot only for its matching runner origin", () => {
  const calls: unknown[][] = [];
  global.WebSocket = jest.fn((...args: unknown[]) => {
    calls.push(args);
    return {} as WebSocket;
  }) as unknown as typeof WebSocket;
  const access = {
    runnerUrl: "https://runner.example.com",
    clientId: "access-id",
    clientSecret: "access-secret",
  };

  createWebSocketWithOptionalAuth(
    "wss://runner.example.com/runner-ws",
    "runner-token",
    access
  );
  createWebSocketWithOptionalAuth(
    "ws://127.0.0.1:8788/runner-ws",
    "runner-token",
    access
  );
  createWebSocketWithOptionalAuth(
    "wss://unrelated.example.com/runner-ws",
    "runner-token",
    access
  );
  createWebSocketWithOptionalAuth(
    "ws://127.0.0.1:8788/runner-ws",
    "runner-token",
    {
      ...access,
      runnerUrl: "http://127.0.0.1:8788",
    }
  );

  expect(calls).toEqual([
    [
      "wss://runner.example.com/runner-ws",
      [],
      {
        headers: {
          "CF-Access-Client-Id": "access-id",
          "CF-Access-Client-Secret": "access-secret",
          Authorization: "Bearer runner-token",
        },
      },
    ],
    [
      "ws://127.0.0.1:8788/runner-ws",
      [],
      { headers: { Authorization: "Bearer runner-token" } },
    ],
    [
      "wss://unrelated.example.com/runner-ws",
      [],
      { headers: { Authorization: "Bearer runner-token" } },
    ],
    [
      "ws://127.0.0.1:8788/runner-ws",
      [],
      { headers: { Authorization: "Bearer runner-token" } },
    ],
  ]);
});
