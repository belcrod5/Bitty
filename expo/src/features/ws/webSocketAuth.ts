export function createWebSocketWithOptionalAuth(url: string, token: string) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    return new WebSocket(url);
  }
  try {
    return new (WebSocket as any)(url, [], {
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
      },
    }) as WebSocket;
  } catch {
    try {
      return new (WebSocket as any)(url, undefined, {
        headers: {
          Authorization: `Bearer ${normalizedToken}`,
        },
      }) as WebSocket;
    } catch {
      return new WebSocket(url);
    }
  }
}
