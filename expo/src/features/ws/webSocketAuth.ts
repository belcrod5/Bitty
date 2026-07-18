import { getCloudflareAccessHeadersForUrl } from "../app/utils/cloudflareAccessFetch";

export type WebSocketCloudflareAccess = {
  runnerUrl: string;
  clientId: string;
  clientSecret: string;
};

function normalizeOrigin(rawUrl: string) {
  try {
    const url = new URL(String(rawUrl || "").trim());
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol === "ws:") url.protocol = "http:";
    return url.origin.toLowerCase();
  } catch {
    return "";
  }
}

export function isWebSocketForCloudflareRunner(url: string, runnerUrl: string) {
  try {
    const webSocketUrl = new URL(String(url || "").trim());
    const configuredRunnerUrl = new URL(String(runnerUrl || "").trim());
    if (webSocketUrl.protocol !== "wss:") return false;
    if (configuredRunnerUrl.protocol !== "https:" && configuredRunnerUrl.protocol !== "wss:") {
      return false;
    }
    return normalizeOrigin(webSocketUrl.toString()) === normalizeOrigin(configuredRunnerUrl.toString());
  } catch {
    return false;
  }
}

function buildWebSocketHeaders(
  url: string,
  token: string,
  cloudflareAccess?: WebSocketCloudflareAccess
) {
  const normalizedToken = String(token || "").trim();
  const headers: Record<string, string> = cloudflareAccess
    ? {}
    : getCloudflareAccessHeadersForUrl(url);
  const accessClientId = String(cloudflareAccess?.clientId || "").trim();
  const accessClientSecret = String(cloudflareAccess?.clientSecret || "").trim();
  if (
    cloudflareAccess &&
    accessClientId &&
    accessClientSecret &&
    isWebSocketForCloudflareRunner(url, cloudflareAccess.runnerUrl)
  ) {
    headers["CF-Access-Client-Id"] = accessClientId;
    headers["CF-Access-Client-Secret"] = accessClientSecret;
  }
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

export function createWebSocketWithOptionalAuth(
  url: string,
  token: string,
  cloudflareAccess?: WebSocketCloudflareAccess
) {
  if (isRunnerWebSocketUrl(url) && !String(token || "").trim()) {
    throw new Error("runner_token_required");
  }
  const headers = buildWebSocketHeaders(url, token, cloudflareAccess);
  if (Object.keys(headers).length <= 0) {
    return new WebSocket(url);
  }
  try {
    return new (WebSocket as any)(url, [], {
      headers,
    }) as WebSocket;
  } catch {
    try {
      return new (WebSocket as any)(url, undefined, {
        headers,
      }) as WebSocket;
    } catch {
      throw new Error("authenticated_websocket_create_failed");
    }
  }
}
