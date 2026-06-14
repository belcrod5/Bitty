import {
  createWebSocketWithOptionalAuth,
  normalizeCodexWsInputs,
  parseJsonRpcMessage,
  toErrorMessage,
} from "./helpers";
import { NEAR_UNLIMITED_TIMEOUT_MS, type PendingRequest } from "./types";
import {
  encodeRunnerWsLlmRpc,
  isRunnerWsUrl,
  normalizeRunnerWsIncomingCodexRpc,
} from "../../runnerWs/llmAdapter";

export async function runCodexRpcSession<T>(options: {
  wsUrl: string;
  wsToken?: string;
  timeoutMs?: number;
  clientName: string;
  clientTitle: string;
  run: (rpc: <R>(method: string, params?: Record<string, unknown>) => Promise<R>) => Promise<T>;
}): Promise<T> {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const wsToken = normalized.wsToken;
  const useRunnerWsEnvelope = isRunnerWsUrl(wsUrl);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(5000, Math.floor(Number(options.timeoutMs)))
    : NEAR_UNLIMITED_TIMEOUT_MS;
  if (!wsUrl) throw new Error("Codex WebSocket URL is empty");

  const ws = createWebSocketWithOptionalAuth(wsUrl, wsToken);
  const wsLabel = wsToken ? `${wsUrl} (token)` : `${wsUrl} (no-token)`;
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let finalized = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  function cleanup() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    for (const entry of pending.values()) {
      entry.reject(new Error("Codex app-server request cancelled"));
    }
    pending.clear();
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {}
  }

  function sendJson(payload: Record<string, unknown>) {
    ws.send(useRunnerWsEnvelope ? encodeRunnerWsLlmRpc(payload, "") : JSON.stringify(payload));
  }

  function resolvePendingForId(idRaw: unknown, result: unknown) {
    const id = Number(idRaw);
    if (!Number.isInteger(id)) return;
    const pendingEntry = pending.get(id);
    if (!pendingEntry) return;
    pending.delete(id);
    pendingEntry.resolve(result);
  }

  function rejectPendingForId(idRaw: unknown, message: string) {
    const id = Number(idRaw);
    if (!Number.isInteger(id)) return;
    const pendingEntry = pending.get(id);
    if (!pendingEntry) return;
    pending.delete(id);
    pendingEntry.reject(new Error(message));
  }

  function sendRequest<R>(method: string, params: Record<string, unknown> = {}) {
    const id = nextId++;
    return new Promise<R>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sendJson({
        id,
        method,
        params,
      });
    });
  }

  return await new Promise<T>((resolve, reject) => {
    function fail(error: unknown) {
      if (finalized) return;
      finalized = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
    }

    function succeed(result: T) {
      if (finalized) return;
      finalized = true;
      cleanup();
      resolve(result);
    }

    timeoutHandle = setTimeout(() => {
      fail(new Error(`Codex app-server RPC timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    ws.onopen = () => {
      (async () => {
        await sendRequest("initialize", {
          clientInfo: {
            name: options.clientName,
            title: options.clientTitle,
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: [],
          },
        });
        sendJson({ method: "initialized", params: {} });
        const result = await options.run(sendRequest);
        succeed(result);
      })().catch((error) => {
        fail(error);
      });
    };

    ws.onmessage = (event) => {
      const rawData = typeof event.data === "string" ? event.data : String(event.data || "");
      const incoming = useRunnerWsEnvelope
        ? normalizeRunnerWsIncomingCodexRpc(rawData)
        : { type: "rpc" as const, rawData };
      if (incoming.type === "ignore") return;
      if (incoming.type === "error") {
        fail(new Error(incoming.message));
        return;
      }
      const message = parseJsonRpcMessage(incoming.rawData);
      if (!message) return;
      const id = message.id;
      const hasId = typeof id !== "undefined";
      const method = message.method;
      if (hasId && typeof method === "undefined") {
        const payloadError = message.error as { message?: string } | undefined;
        if (payloadError) {
          const msg = String(payloadError.message || "json-rpc request failed");
          rejectPendingForId(id, msg);
          return;
        }
        resolvePendingForId(id, message.result);
      }
    };

    ws.onerror = (event: any) => {
      const detail = String(event?.message || event?.type || "unknown");
      fail(new Error(`Codex app-server WebSocket error: ${detail} url=${wsLabel} readyState=${ws.readyState}`));
    };

    ws.onclose = (event: any) => {
      if (finalized) return;
      const code = Number(event?.code);
      const reason = String(event?.reason || "").trim();
      const wasClean = Boolean(event?.wasClean);
      const codeText = Number.isFinite(code) ? String(code) : "unknown";
      fail(
        new Error(
          `Codex app-server WebSocket closed: code=${codeText} reason=${reason || "-"} clean=${wasClean} url=${wsLabel} readyState=${ws.readyState}`
        )
      );
    };
  });
}
