import { normalizeCodexWsInputs } from "./helpers";

export type CodexQueuedTurnSnapshot = {
  queuedTurnId: string;
  threadId: string;
  status: string;
  inputPreview: string;
  cwd?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: string;
  sourcePanelId?: string;
  clientRequestId?: string;
  errorMessage?: string;
  turnId?: string;
  createdAtMs?: number;
  startedAtMs?: number | null;
  completedAtMs?: number | null;
  cancelledAtMs?: number | null;
  updatedAtMs?: number;
};

export type CodexCompactSnapshot = {
  compactId: string;
  threadId: string;
  status: string;
  method?: string;
  errorMessage?: string;
  createdAtMs?: number;
  startedAtMs?: number;
  completedAtMs?: number | null;
  updatedAtMs?: number;
};

export type CodexQueueSnapshot = {
  compact?: CodexCompactSnapshot | null;
  queuedTurns: CodexQueuedTurnSnapshot[];
};

function deriveRunnerHttpBaseUrl(wsUrlRaw: string) {
  const wsUrl = String(wsUrlRaw || "").trim();
  if (!wsUrl) return "";
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return "";
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

async function fetchRunnerJson(
  wsUrl: string,
  wsToken: string,
  path: string,
  options: { method?: "GET" | "POST"; body?: Record<string, unknown>; timeoutMs?: number } = {}
) {
  const normalized = normalizeCodexWsInputs(wsUrl, wsToken);
  const baseUrl = deriveRunnerHttpBaseUrl(normalized.wsUrl);
  if (!baseUrl) throw new Error("Runner HTTP URL could not be derived from Codex WS URL");
  const token = normalized.wsToken;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs || 30000)));
  const timer = setTimeout(() => {
    try {
      controller?.abort();
    } catch {}
  }, timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = String((data as any)?.message || (data as any)?.error || response.statusText || "request failed");
      throw new Error(message);
    }
    return data as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export async function enqueueRunnerCodexTurn(options: {
  wsUrl: string;
  wsToken?: string;
  threadId: string;
  inputText: string;
  cwd?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: string;
  sourcePanelId?: string;
  clientRequestId?: string;
  onlyIfCompacting?: boolean;
  waitForCompactMs?: number;
  timeoutMs?: number;
}) {
  return await fetchRunnerJson(options.wsUrl, options.wsToken || "", "/codex/queued-turns", {
    method: "POST",
    timeoutMs: options.timeoutMs || 10000,
    body: {
      threadId: options.threadId,
      inputText: options.inputText,
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      approvalPolicy: options.approvalPolicy,
      sourcePanelId: options.sourcePanelId,
      clientRequestId: options.clientRequestId,
      onlyIfCompacting: Boolean(options.onlyIfCompacting),
      waitForCompactMs: options.waitForCompactMs,
    },
  }) as {
    ok: boolean;
    queued: boolean;
    reason: string;
    queuedTurn: CodexQueuedTurnSnapshot | null;
    queue: CodexQueueSnapshot;
  };
}

export async function cancelRunnerCodexQueuedTurn(options: {
  wsUrl: string;
  wsToken?: string;
  queuedTurnId: string;
  timeoutMs?: number;
}) {
  const queuedTurnId = String(options.queuedTurnId || "").trim();
  if (!queuedTurnId) throw new Error("queuedTurnId is empty");
  return await fetchRunnerJson(
    options.wsUrl,
    options.wsToken || "",
    `/codex/queued-turns/${encodeURIComponent(queuedTurnId)}/cancel`,
    {
      method: "POST",
      timeoutMs: options.timeoutMs || 10000,
    }
  ) as {
    ok: boolean;
    queuedTurn: CodexQueuedTurnSnapshot;
    queue: CodexQueueSnapshot;
  };
}
