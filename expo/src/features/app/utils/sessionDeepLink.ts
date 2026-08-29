const MAX_DEEP_LINK_CHARS = 4096;
const MAX_CWD_CHARS = 2048;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type SessionDeepLinkTarget = {
  backendId: string;
  sessionId: string;
  messageId: string;
  cwd: string;
};

export type SessionDeepLinkJumpTarget = {
  requestId: number;
  sessionId: string;
  messageId: string;
};

export function parseSessionDeepLink(rawUrl: unknown): SessionDeepLinkTarget | null {
  const raw = String(rawUrl || "").trim();
  if (!raw || raw.length > MAX_DEEP_LINK_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "bitty:" || url.hostname !== "session") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const backendId = segments[0];
  const sessionId = segments[1];
  const messageId = String(url.searchParams.get("messageId") || "").trim();
  const cwd = String(url.searchParams.get("cwd") || "").trim();
  if (
    !backendId || backendId.length > 64 || !ID_PATTERN.test(backendId)
    || !sessionId || sessionId.length > 200 || !ID_PATTERN.test(sessionId)
    || !messageId || messageId.length > 300 || !ID_PATTERN.test(messageId)
    || !cwd.startsWith("/") || cwd.length > MAX_CWD_CHARS || cwd.includes("\0")
  ) return null;
  return { backendId, sessionId, messageId, cwd };
}
