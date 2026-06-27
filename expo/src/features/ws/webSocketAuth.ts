import { getCloudflareAccessHeadersForUrl } from "../app/utils/cloudflareAccessFetch";

function buildWebSocketHeaders(url: string, token: string) {
  const normalizedToken = String(token || "").trim();
  const headers = {
    ...getCloudflareAccessHeadersForUrl(url),
  } as Record<string, string>;
  if (normalizedToken) {
    headers.Authorization = `Bearer ${normalizedToken}`;
  }
  return headers;
}

function isRunnerWebSocketUrl(url: string) {
  try {
    return ["/runner-ws", "/codex-ws", "/stream-tts"].includes(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function createWebSocketWithOptionalAuth(url: string, token: string) {
  if (isRunnerWebSocketUrl(url) && !String(token || "").trim()) {
    throw new Error("runner_token_required");
  }
  const headers = buildWebSocketHeaders(url, token);
  if (Object.keys(headers).length <= 0) {
    return new WebSocket(url);
  }
  let firstError: unknown = null;
  try {
    return new (WebSocket as any)(url, [], {
      headers,
    }) as WebSocket;
  } catch (error) {
    firstError = error;
    try {
      return new (WebSocket as any)(url, undefined, {
        headers,
      }) as WebSocket;
    } catch (secondError) {
      const message = secondError instanceof Error
        ? secondError.message
        : firstError instanceof Error
          ? firstError.message
          : "unknown_error";
      throw new Error(`authenticated_websocket_create_failed: ${message}`);
    }
  }
}
