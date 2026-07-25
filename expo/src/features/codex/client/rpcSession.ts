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
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../../runnerWs/types";
import {
  buildCodexRunnerWsRequestId,
  CodexRunnerWsJsonRpcIdMapper,
  createCodexRunnerWsLogicalId,
} from "./runnerWsJsonRpcIds";

export const MINIMUM_CODEX_APP_SERVER_VERSION = "0.145.0";

export function assertSupportedCodexAppServer(initialized: Record<string, unknown>) {
  const userAgent = String(initialized.userAgent || "").trim();
  const match = userAgent.match(/(\d+)\.(\d+)\.(\d+)/);
  const version = match ? match.slice(1, 4).map(Number) : [];
  const minimum = MINIMUM_CODEX_APP_SERVER_VERSION.split(".").map(Number);
  let comparison = 0;
  for (let index = 0; version.length === 3 && index < minimum.length; index += 1) {
    if (version[index] === minimum[index]) continue;
    comparison = version[index] > minimum[index] ? 1 : -1;
    break;
  }
  if (version.length === 3 && comparison >= 0) return;
  throw new Error(
    `Codex App Server ${match?.[0] || "unknown"} は未対応です。` +
    `${MINIMUM_CODEX_APP_SERVER_VERSION}以上へ更新してください: npm install -g @openai/codex@latest`
  );
}

export async function runCodexRpcSession<T>(options: {
  wsUrl: string;
  wsToken?: string;
  timeoutMs?: number;
  clientName: string;
  clientTitle: string;
  experimentalApi?: boolean;
  traceId?: string;
  threadId?: string;
  runnerWebSocketManager?: RunnerWebSocketManager;
  run: (
    rpc: <R>(method: string, params?: Record<string, unknown>) => Promise<R>,
    initialized?: Record<string, unknown>
  ) => Promise<T>;
}): Promise<T> {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const wsToken = normalized.wsToken;
  const runnerWebSocketManager = options.runnerWebSocketManager;
  const useRunnerWsManager = Boolean(runnerWebSocketManager);
  const useRunnerWsEnvelope = useRunnerWsManager || isRunnerWsUrl(wsUrl);
  const threadId = String(options.threadId || "").trim();
  const traceId = String(options.traceId || options.clientName || "").trim();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(5000, Math.floor(Number(options.timeoutMs)))
    : NEAR_UNLIMITED_TIMEOUT_MS;
  if (!wsUrl) throw new Error("Codex WebSocket URL is empty");

  const ws = useRunnerWsManager ? null : createWebSocketWithOptionalAuth(wsUrl, wsToken);
  const wsLabel = wsToken ? `${wsUrl} (token)` : `${wsUrl} (no-token)`;
  const pending = new Map<number, PendingRequest>();
  const runnerWsOperationId = createCodexRunnerWsLogicalId("codex_rpc_op", traceId);
  const runnerWsSessionId = threadId || createCodexRunnerWsLogicalId("codex_rpc_session", traceId);
  const runnerWsRpcIds = new CodexRunnerWsJsonRpcIdMapper();
  const managerUnsubscribers: Array<() => void> = [];
  let runnerWsEnvelopeSeq = 0;
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
    runnerWsRpcIds.clear();
    while (managerUnsubscribers.length > 0) {
      const unsubscribe = managerUnsubscribers.pop();
      try {
        unsubscribe?.();
      } catch {}
    }
    if (useRunnerWsManager) return;
    try {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    } catch {}
  }

  function getTransportReadyState() {
    if (useRunnerWsManager && runnerWebSocketManager) {
      return runnerWebSocketManager.getSnapshot().readyState;
    }
    return ws?.readyState ?? WebSocket.CLOSED;
  }

  function sendJson(payload: Record<string, unknown>) {
    if (useRunnerWsManager && runnerWebSocketManager) {
      const id = Number(payload.id);
      const method = String(payload.method || "");
      runnerWsEnvelopeSeq += 1;
      const outboundPayload = runnerWsRpcIds.rewriteOutbound(payload);
      runnerWebSocketManager.send({
        channel: "llm",
        op: "rpc",
        requestId: buildCodexRunnerWsRequestId(
          runnerWsOperationId,
          runnerWsEnvelopeSeq,
          method,
          id
        ),
        operationId: runnerWsOperationId,
        sessionId: runnerWsSessionId,
        ...(threadId ? { threadId } : {}),
        payload: outboundPayload,
      });
      return;
    }
    if (!ws) throw new Error("Codex app-server WebSocket is not initialized");
    ws.send(useRunnerWsEnvelope ? encodeRunnerWsLlmRpc(payload, threadId) : JSON.stringify(payload));
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
      try {
        sendJson({
          id,
          method,
          params,
        });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
      }
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

    function handleRpcMessage(message: Record<string, unknown>) {
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
    }

    function handleIncomingRawData(rawData: string) {
      const incoming = useRunnerWsEnvelope
        ? normalizeRunnerWsIncomingCodexRpc(rawData)
        : { type: "rpc" as const, rawData };
      if (incoming.type === "ignore") return;
      if (incoming.type === "error") {
        fail(new Error(incoming.message));
        return;
      }
      const parsed = parseJsonRpcMessage(incoming.rawData);
      if (!parsed) return;
      handleRpcMessage(useRunnerWsManager ? runnerWsRpcIds.rewriteIncoming(parsed) : parsed);
    }

    async function runSession() {
      const initialized = await sendRequest<Record<string, unknown>>("initialize", {
        clientInfo: {
          name: options.clientName,
          title: options.clientTitle,
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: options.experimentalApi ?? true,
          optOutNotificationMethods: [],
        },
      });
      assertSupportedCodexAppServer(initialized);
      sendJson({ method: "initialized", params: {} });
      const result = await options.run(sendRequest, initialized);
      succeed(result);
    }

    timeoutHandle = setTimeout(() => {
      fail(new Error(`Codex app-server RPC timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    if (useRunnerWsManager && runnerWebSocketManager) {
      let managerReadyObserved = runnerWebSocketManager.getSnapshot().connectionState === "ready";
      managerUnsubscribers.push(runnerWebSocketManager.subscribe(
        {
          channel: "llm",
          op: "rpc",
          operationId: runnerWsOperationId,
          sessionId: runnerWsSessionId,
          ...(threadId ? { threadId } : {}),
        },
        (message: RunnerWsMessage) => {
          if (finalized) return;
          handleIncomingRawData(JSON.stringify(message));
        }
      ));
      // The runner reports failures (invalid payload, identity rejection, ...) as
      // control/error envelopes addressed by operationId; without this the session
      // would sit silent until the RPC timeout.
      managerUnsubscribers.push(runnerWebSocketManager.subscribe(
        { channel: "control", op: "error", operationId: runnerWsOperationId },
        (message: RunnerWsMessage) => {
          if (finalized) return;
          const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
            ? message.payload as Record<string, unknown>
            : {};
          const detail = String(payload.message || payload.error || "runner_ws_error");
          fail(new Error(`Codex app-server runner-ws error: ${detail}`));
        }
      ));
      managerUnsubscribers.push(runnerWebSocketManager.subscribeSnapshot(() => {
        if (finalized || !managerReadyObserved) return;
        const snapshot = runnerWebSocketManager.getSnapshot();
        if (snapshot.connectionState === "ready") return;
        fail(new Error(`Codex app-server runner-ws disconnected: state=${snapshot.connectionState}`));
      }));
      runnerWebSocketManager.connect()
        .then(() => {
          if (finalized) return;
          managerReadyObserved = true;
          return runSession();
        })
        .catch((error) => {
          fail(error);
        });
      return;
    }

    if (!ws) {
      fail(new Error("Codex app-server WebSocket is not initialized"));
      return;
    }

    ws.onopen = () => {
      runSession().catch((error) => {
        fail(error);
      });
    };

    ws.onmessage = (event) => {
      const rawData = typeof event.data === "string" ? event.data : String(event.data || "");
      handleIncomingRawData(rawData);
    };

    ws.onerror = (event: any) => {
      const detail = String(event?.message || event?.type || "unknown");
      fail(new Error(`Codex app-server WebSocket error: ${detail} url=${wsLabel} readyState=${getTransportReadyState()}`));
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
