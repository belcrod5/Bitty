export function toCodexHttpEndpoint(wsUrlRaw: unknown, endpoint: "readyz" | "healthz"): string {
  const wsUrl = String(wsUrlRaw || "").trim();
  if (!wsUrl) return "";
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return "";
    const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${parsed.host}/${endpoint}`;
  } catch {
    return "";
  }
}

export function deriveRunnerBaseUrlFromCodexWsUrl(wsUrlRaw: unknown): string {
  const wsUrl = String(wsUrlRaw || "").trim();
  if (!wsUrl) return "";
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return "";
    const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${parsed.hostname}:8788`;
  } catch {
    return "";
  }
}

export function diagErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "unknown_error");
}

export async function fetchHttpWithTimeout(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => {
    try {
      controller?.abort();
    } catch {}
  }, Math.max(1000, timeoutMs));
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      ...(headers ? { headers } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const body = await response.text().catch(() => "");
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: String(body || "").slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function postJsonWithTimeout(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number
) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => {
    try {
      controller?.abort();
    } catch {}
  }, Math.max(1000, timeoutMs));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}
