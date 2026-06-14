import {
  checkReadyzHttp,
  createWebSocketWithOptionalAuth,
  deriveReadyzUrlFromWsUrl,
  normalizeCodexWsInputs,
  parseJsonRpcMessage,
  toErrorMessage,
} from "./helpers";
import {
  NEAR_UNLIMITED_TIMEOUT_MS,
  type CodexAppServerProbeResult,
  type CodexWebSocketHandshakeProbeResult,
  type PendingRequest,
} from "./types";
import {
  encodeRunnerWsLlmRpc,
  isRunnerWsUrl,
  normalizeRunnerWsIncomingCodexRpc,
} from "../../runnerWs/llmAdapter";

function shouldRunReadyzPreflight(wsUrl: string): boolean {
  try {
    const parsed = new URL(wsUrl);
    const pathname = String(parsed.pathname || "").trim();
    return !pathname || pathname === "/";
  } catch {
    return false;
  }
}

export async function probeCodexAppServerConnection(options: {
  wsUrl: string;
  wsToken?: string;
  timeoutMs?: number;
}): Promise<CodexAppServerProbeResult> {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const wsToken = normalized.wsToken;
  const useRunnerWsEnvelope = isRunnerWsUrl(wsUrl);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(3000, Math.floor(Number(options.timeoutMs)))
    : NEAR_UNLIMITED_TIMEOUT_MS;
  if (!wsUrl) throw new Error("Codex WebSocket URL is empty");
  const readyzUrl = deriveReadyzUrlFromWsUrl(wsUrl);
  if (readyzUrl && shouldRunReadyzPreflight(wsUrl)) {
    await checkReadyzHttp(readyzUrl, timeoutMs);
  }

  const ws = createWebSocketWithOptionalAuth(wsUrl, wsToken);
  const wsLabel = wsToken ? `${wsUrl} (token)` : `${wsUrl} (no-token)`;
  let finalized = false;
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  function cleanup() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    for (const entry of pending.values()) {
      entry.reject(new Error("Codex app-server probe cancelled"));
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

  function sendRequest<T>(method: string, params: Record<string, unknown>) {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sendJson({
        id,
        method,
        params,
      });
    });
  }

  function rejectPendingForId(idRaw: unknown, message: string) {
    const id = Number(idRaw);
    if (!Number.isInteger(id)) return;
    const pendingEntry = pending.get(id);
    if (!pendingEntry) return;
    pending.delete(id);
    pendingEntry.reject(new Error(message));
  }

  function resolvePendingForId(idRaw: unknown, result: unknown) {
    const id = Number(idRaw);
    if (!Number.isInteger(id)) return;
    const pendingEntry = pending.get(id);
    if (!pendingEntry) return;
    pending.delete(id);
    pendingEntry.resolve(result);
  }

  return await new Promise<CodexAppServerProbeResult>((resolve, reject) => {
    function fail(error: unknown) {
      if (finalized) return;
      finalized = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
    }

    function succeed(result: CodexAppServerProbeResult) {
      if (finalized) return;
      finalized = true;
      cleanup();
      resolve(result);
    }

    timeoutHandle = setTimeout(() => {
      fail(new Error(`Codex app-server probe timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    ws.onopen = () => {
      (async () => {
        const initialized = await sendRequest<Record<string, unknown>>("initialize", {
          clientInfo: {
            name: "expo-ios-client-probe",
            title: "Expo iOS Client Probe",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: false,
            optOutNotificationMethods: [],
          },
        });
        sendJson({ method: "initialized", params: {} });
        succeed({
          userAgent: String(initialized?.userAgent || ""),
          codexHome: String(initialized?.codexHome || ""),
          platformOs: String(initialized?.platformOs || ""),
        });
      })().catch((error) => {
        fail(error);
      });
    };

    ws.onmessage = (event) => {
      const rawData = typeof event.data === "string" ? event.data : String(event.data || "");
      const normalizedIncoming = useRunnerWsEnvelope
        ? normalizeRunnerWsIncomingCodexRpc(rawData)
        : { type: "rpc" as const, rawData };
      if (normalizedIncoming.type === "ignore") return;
      if (normalizedIncoming.type === "error") {
        fail(new Error(normalizedIncoming.message));
        return;
      }
      const message = parseJsonRpcMessage(normalizedIncoming.rawData);
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

export async function probeCodexWebSocketHandshakeOnly(options: {
  wsUrl: string;
  wsToken?: string;
  timeoutMs?: number;
}): Promise<CodexWebSocketHandshakeProbeResult> {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const wsToken = normalized.wsToken;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(3000, Math.floor(Number(options.timeoutMs)))
    : NEAR_UNLIMITED_TIMEOUT_MS;
  if (!wsUrl) throw new Error("Codex WebSocket URL is empty");

  const ws = createWebSocketWithOptionalAuth(wsUrl, wsToken);
  const wsLabel = wsToken ? `${wsUrl} (token)` : `${wsUrl} (no-token)`;

  return await new Promise<CodexWebSocketHandshakeProbeResult>((resolve, reject) => {
    let opened = false;
    let finalized = false;
    const timeoutHandle = setTimeout(() => {
      if (finalized) return;
      finalized = true;
      try {
        ws.close();
      } catch {}
      reject(new Error(`Codex WS handshake timeout (${timeoutMs}ms) url=${wsLabel} readyState=${ws.readyState}`));
    }, timeoutMs);

    function finishWithError(message: string) {
      if (finalized) return;
      finalized = true;
      clearTimeout(timeoutHandle);
      reject(new Error(message));
    }

    ws.onopen = () => {
      if (finalized) return;
      opened = true;
      finalized = true;
      clearTimeout(timeoutHandle);
      const readyStateAtOpen = ws.readyState;
      try {
        ws.close();
      } catch {}
      resolve({
        opened: true,
        readyStateAtOpen,
      });
    };

    ws.onerror = (event: any) => {
      const detail = String(event?.message || event?.type || "unknown");
      finishWithError(`Codex WS handshake error: ${detail} url=${wsLabel} readyState=${ws.readyState}`);
    };

    ws.onclose = (event: any) => {
      if (finalized) return;
      const code = Number(event?.code);
      const reason = String(event?.reason || "").trim();
      const wasClean = Boolean(event?.wasClean);
      const codeText = Number.isFinite(code) ? String(code) : "unknown";
      const phase = opened ? "after-open" : "before-open";
      finishWithError(
        `Codex WS handshake closed(${phase}): code=${codeText} reason=${reason || "-"} clean=${wasClean} url=${wsLabel} readyState=${ws.readyState}`
      );
    };
  });
}
