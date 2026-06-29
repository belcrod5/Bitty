import {
  isApprovalAction,
} from "../approvalFlow";
import {
  createWebSocketWithOptionalAuth,
  extractAgentMessageText,
  extractContextUsageFromTurnCompletedParams,
  extractNotificationMessage,
  isNoRolloutForThreadError,
  isThreadNotLoadedError,
  deriveCodexSessionStateFromSnapshot,
  normalizeAppServerApprovalRequest,
  normalizeCodexWsInputs,
  parseCodexApprovalPolicy,
  parseJsonRpcMessage,
  takeResolvedApprovalRequest,
  toCodexApprovalDecision,
  toErrorMessage,
} from "./helpers";
import {
  NEAR_UNLIMITED_TIMEOUT_MS,
  type CodexAppServerTurnOptions,
  type CodexAppServerTurnResult,
  type CodexAppServerTurnSession,
  type CodexContextUsage,
  type CodexThreadResumeResponse,
  type CodexThreadStartResponse,
  type CodexTurnStartResponse,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcIncoming,
  type JsonRpcSuccess,
  type PendingRequest,
} from "./types";
import {
  encodeRunnerWsLlmRpc,
  encodeRunnerWsRelayResume,
  isRunnerWsUrl,
  parseRunnerWsLlmRpcAck,
  parseRunnerWsEnvelope,
  normalizeRunnerWsIncomingCodexRpc,
} from "../../runnerWs/llmAdapter";
import type {
  RunnerWsMessage,
} from "../../runnerWs/types";
import {
  buildRunnerRelayResumeWsUrl,
  parseRunnerRelayControlMessage,
} from "./runnerRelayControl";
import { reserveRunnerWsReconnectDelay } from "./runnerWsReconnectGate";
import {
  buildCodexRunnerWsRequestId,
  CodexRunnerWsJsonRpcIdMapper,
  createCodexRunnerWsLogicalId,
} from "./runnerWsJsonRpcIds";
export { startCodexAppServerTurnRelayObserver } from "./turnRelayObserver";

export const CODEX_APP_SERVER_TURN_INTERRUPTED_ERROR_CODE = "codex_app_server_turn_interrupted";
const PRE_TURN_RPC_TIMEOUT_MS = 15000;

type RunnerRelayReconnectTrigger =
  | "ws_close"
  | "ws_error"
  | "ws_resume_send_error"
  | "rx_runner_error"
  | "runner_relay_closed";

type InterruptedError = Error & {
  code?: string;
};

function createTurnInterruptedError(message = "Codex app-server turn interrupted"): InterruptedError {
  const error = new Error(message) as InterruptedError;
  error.name = "CodexAppServerTurnInterruptedError";
  error.code = CODEX_APP_SERVER_TURN_INTERRUPTED_ERROR_CODE;
  return error;
}

export function isCodexAppServerTurnInterruptedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const interruptedError = error as InterruptedError;
  return (
    interruptedError.code === CODEX_APP_SERVER_TURN_INTERRUPTED_ERROR_CODE ||
    interruptedError.name === "CodexAppServerTurnInterruptedError"
  );
}

function summarizeIncomingRpcFrame(
  rawData: string,
  pendingMethods: Map<JsonRpcId, string>
): string {
  const raw = String(rawData || "");
  const info: string[] = [`chars=${raw.length}`];
  const trimmed = raw.trim();
  if (!trimmed) {
    info.push("empty=1");
    return info.join(" ");
  }
  const pendingPreview = Array.from(pendingMethods.entries())
    .slice(0, 3)
    .map(([id, method]) => `${id}:${method}`)
    .join(",");
  info.push(`pendingCount=${pendingMethods.size}`);
  if (pendingPreview) {
    info.push(`pending=${pendingPreview}`);
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    info.push("json=0");
    return info.join(" ");
  }
  info.push("json=1");
  if (!parsed || typeof parsed !== "object") {
    info.push(`type=${typeof parsed}`);
    return info.join(" ");
  }
  const channel = String((parsed as any)?.channel || "").trim();
  const op = String((parsed as any)?.op || "").trim();
  if (channel) info.push(`ch=${channel}`);
  if (op) info.push(`op=${op}`);
  const requestId = String((parsed as any)?.requestId || "").trim();
  if (requestId) info.push(`req=${requestId}`);
  let rpcPayload: any = parsed;
  if (channel === "llm" && op === "rpc") {
    const payload = (parsed as any)?.payload;
    if (typeof payload === "string") {
      try {
        rpcPayload = JSON.parse(payload);
      } catch {
        info.push("payloadJson=0");
        return info.join(" ");
      }
      info.push("payloadJson=1");
    } else if (payload && typeof payload === "object") {
      rpcPayload = payload;
    } else {
      info.push("payload=none");
      return info.join(" ");
    }
  }
  if (!rpcPayload || typeof rpcPayload !== "object") {
    info.push("rpcObject=0");
    return info.join(" ");
  }
  const rpcIdRaw = (rpcPayload as any)?.id;
  const rpcMethod = String((rpcPayload as any)?.method || "").trim();
  if (typeof rpcIdRaw !== "undefined") {
    info.push(`rpcId=${String(rpcIdRaw)}`);
  }
  if (rpcMethod) {
    info.push(`rpcMethod=${rpcMethod}`);
  }
  if (Object.prototype.hasOwnProperty.call(rpcPayload, "result")) {
    info.push("hasResult=1");
  }
  if (Object.prototype.hasOwnProperty.call(rpcPayload, "error")) {
    info.push("hasError=1");
  }
  return info.join(" ");
}

function summarizeParsedJsonRpcShape(message: Record<string, unknown>): string {
  const keys = Object.keys(message || {}).slice(0, 8).join(",");
  const idValue = (message as any)?.id;
  const methodValue = (message as any)?.method;
  const hasResult = Object.prototype.hasOwnProperty.call(message || {}, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message || {}, "error");
  const methodType = typeof methodValue;
  const idType = typeof idValue;
  return [
    `keys=${keys || "-"}`,
    `idType=${idType}`,
    `methodType=${methodType}`,
    `hasResult=${hasResult ? 1 : 0}`,
    `hasError=${hasError ? 1 : 0}`,
    idType !== "undefined" ? `id=${String(idValue)}` : "",
    methodType === "string" ? `method=${String(methodValue)}` : "",
  ].filter(Boolean).join(" ");
}

function extractThreadReadPayload(result: unknown): unknown {
  const object = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return (object as any)?.thread ?? (object as any)?.data?.thread ?? (object as any)?.data ?? result;
}

export function startCodexAppServerTurn(
  options: CodexAppServerTurnOptions
): CodexAppServerTurnSession {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const useRunnerWsEnvelope = isRunnerWsUrl(wsUrl);
  const runnerWebSocketManager = options.runnerWebSocketManager;
  const useRunnerWsManager = Boolean(runnerWebSocketManager && useRunnerWsEnvelope);
  const inputText = String(options.inputText || "").trim();
  const wsToken = normalized.wsToken;
  const cwd = String(options.cwd || "").trim();
  const requestedThreadId = String(options.threadId || "").trim();
  const traceId = String(options.traceId || "").trim();
  const strictThreadResume = Boolean(options.strictThreadResume);
  const serviceName = String(options.serviceName || "").trim() || "expo-ios-client";
  const approvalPolicy = parseCodexApprovalPolicy(options.approvalPolicy);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(5000, Math.floor(Number(options.timeoutMs)))
    : NEAR_UNLIMITED_TIMEOUT_MS;
  if (!wsUrl) throw new Error("Codex WebSocket URL is empty");
  if (!inputText) throw new Error("inputText is empty");
  if (typeof options.onApprovalRequest !== "function") {
    throw new Error("onApprovalRequest is required");
  }
  const onApprovalRequest = options.onApprovalRequest;

  const pending = new Map<JsonRpcId, PendingRequest>();
  const pendingMethods = new Map<JsonRpcId, string>();
  const pendingApprovalRequests = new Map<JsonRpcId, {
    active: boolean;
    request: import("../approvalFlow").ApprovalRequest;
  }>();
  let nextId = 1;
  let activeThreadId = requestedThreadId;
  let activeTurnId = "";
  let currentAgentMessageItemId = "";
  const agentMessageOrder: string[] = [];
  const agentMessageBuffers = new Map<string, string>();
  let deltaBuffer = "";
  let completedAgentMessage = "";
  let latestContextUsage: CodexContextUsage | null = null;
  let lastErrorMessage = "";
  let finalized = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let interruptRequested = false;
  let interruptRpcSent = false;
  let failRef: ((error: unknown) => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let ws: WebSocket | null = useRunnerWsManager ? null : createWebSocketWithOptionalAuth(wsUrl, wsToken);
  const wsLabel = wsToken ? `${wsUrl} (token)` : `${wsUrl} (no-token)`;
  let lastRelaySeq = 0;
  let reconnectAttempts = 0;
  let turnStartIssued = false;
  let turnCompletedObserved = false;
  let runnerWsEnvelopeSeq = 0;
  const runnerWsOperationId = createCodexRunnerWsLogicalId("codex_turn_op", traceId);
  const runnerWsSessionId = createCodexRunnerWsLogicalId("codex_turn_session", traceId);
  const runnerWsRpcIds = new CodexRunnerWsJsonRpcIdMapper();
  const managerUnsubscribers: Array<() => void> = [];
  let reconnectRunnerRelay: ((trigger: RunnerRelayReconnectTrigger, detail: string) => boolean) | null = null;
  const notifyThreadIdResolved = (threadIdRaw: unknown) => {
    if (!options.onThreadIdResolved) return;
    const threadId = String(threadIdRaw || "").trim();
    if (!threadId) return;
    try {
      options.onThreadIdResolved(threadId);
    } catch {}
  };

  function emitLog(entry: {
    stage: string;
    method?: string;
    id?: number;
    readyState?: number;
    message?: string;
  }) {
    if (!options.onLog) return;
    try {
      options.onLog(entry);
    } catch {}
  }

  function emitEvent(method: string, params: unknown) {
    if (!options.onEvent) return;
    options.onEvent(method, params);
  }

  function extractAgentMessageItemId(paramsRaw: unknown) {
    const params = paramsRaw && typeof paramsRaw === "object" ? paramsRaw as any : {};
    return String(params?.item?.id || params?.itemId || "").trim();
  }

  function rememberAgentMessageItemId(itemIdRaw: string) {
    const itemId = String(itemIdRaw || "").trim();
    if (!itemId) return "";
    if (!agentMessageBuffers.has(itemId)) {
      agentMessageBuffers.set(itemId, "");
      agentMessageOrder.push(itemId);
    }
    currentAgentMessageItemId = itemId;
    return itemId;
  }

  function resolveAgentMessageItemId(paramsRaw: unknown) {
    const fromParams = extractAgentMessageItemId(paramsRaw);
    if (fromParams) return rememberAgentMessageItemId(fromParams);
    if (currentAgentMessageItemId) return rememberAgentMessageItemId(currentAgentMessageItemId);
    return rememberAgentMessageItemId("__agent_message__");
  }

  function buildCombinedAgentMessageReply() {
    return agentMessageOrder
      .map((itemId) => String(agentMessageBuffers.get(itemId) || "").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function getTransportReadyState() {
    if (useRunnerWsManager && runnerWebSocketManager) {
      return runnerWebSocketManager.getSnapshot().readyState;
    }
    return ws?.readyState ?? WebSocket.CLOSED;
  }

  function cleanup() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    for (const entry of pending.values()) {
      entry.reject(new Error("Codex app-server request cancelled"));
    }
    pending.clear();
    pendingMethods.clear();
    for (const entry of pendingApprovalRequests.values()) {
      entry.active = false;
    }
    pendingApprovalRequests.clear();
    runnerWsRpcIds.clear();
    while (managerUnsubscribers.length > 0) {
      const unsubscribe = managerUnsubscribers.pop();
      try {
        unsubscribe?.();
      } catch {}
    }
    if (useRunnerWsManager) return;
    try {
      if (getTransportReadyState() === WebSocket.OPEN || getTransportReadyState() === WebSocket.CONNECTING) {
        ws?.close();
      }
    } catch {}
  }

  function sendJson(payload: Record<string, unknown>) {
    const id = Number(payload.id);
    const method = String(payload.method || "");
    let runnerRequestId = "";
    if (useRunnerWsEnvelope) {
      runnerWsEnvelopeSeq += 1;
      runnerRequestId = buildCodexRunnerWsRequestId(
        traceId || runnerWsOperationId,
        runnerWsEnvelopeSeq,
        method,
        id
      );
    }
    emitLog({
      stage: "rpc_send",
      method: method || undefined,
      id: Number.isFinite(id) ? id : undefined,
      readyState: getTransportReadyState(),
      message: runnerRequestId ? `requestId=${runnerRequestId}` : undefined,
    });
    if (useRunnerWsManager && runnerWebSocketManager) {
      const outboundPayload = runnerWsRpcIds.rewriteOutbound(payload);
      const message: RunnerWsMessage = {
        channel: "llm",
        op: "rpc",
        requestId: runnerRequestId || undefined,
        operationId: runnerWsOperationId,
        sessionId: runnerWsSessionId,
        ...(activeThreadId ? { threadId: activeThreadId } : {}),
        payload: outboundPayload,
      };
      runnerWebSocketManager.send(message);
      return;
    }
    if (!ws) throw new Error("Codex app-server WebSocket is not initialized");
    ws.send(useRunnerWsEnvelope
      ? encodeRunnerWsLlmRpc(payload, activeThreadId, {
        requestId: runnerRequestId || undefined,
        sessionId: activeThreadId || undefined,
      })
      : JSON.stringify(payload));
  }

  function sendRequest<T>(method: string, params: Record<string, unknown>, rpcTimeoutMs?: number) {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMsRaw = Number(rpcTimeoutMs);
      const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
        ? Math.floor(timeoutMsRaw)
        : 0;
      let requestTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const clearRequestTimeout = () => {
        if (!requestTimeoutHandle) return;
        clearTimeout(requestTimeoutHandle);
        requestTimeoutHandle = null;
      };
      pending.set(id, {
        resolve: (value) => {
          clearRequestTimeout();
          pendingMethods.delete(id);
          resolve(value);
        },
        reject: (error) => {
          clearRequestTimeout();
          pendingMethods.delete(id);
          reject(error);
        },
      });
      pendingMethods.set(id, method);
      if (timeoutMs > 0) {
        requestTimeoutHandle = setTimeout(() => {
          const pendingEntry = pending.get(id);
          if (!pendingEntry) return;
          pending.delete(id);
          pendingMethods.delete(id);
          emitLog({
            stage: "rpc_timeout",
            method,
            id,
            readyState: getTransportReadyState(),
            message: `timeoutMs=${timeoutMs}`,
          });
          reject(new Error(`Codex app-server RPC timeout(${timeoutMs}ms): ${method} id=${id}`));
        }, timeoutMs);
      }
      try {
        sendJson({
          id,
          method,
          params,
        });
      } catch (error) {
        clearRequestTimeout();
        pending.delete(id);
        pendingMethods.delete(id);
        reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
      }
    });
  }

  function sendNotification(method: string, params: Record<string, unknown>) {
    sendJson({ method, params });
  }

  function rejectPendingForId(idRaw: unknown, message: string) {
    const id = Number(idRaw);
    if (!Number.isInteger(id)) return;
    const pendingEntry = pending.get(id);
    if (!pendingEntry) {
      emitLog({
        stage: "rpc_error_unmatched",
        id,
        message: `pending_missing msg=${message}`,
        readyState: getTransportReadyState(),
      });
      return;
    }
    pending.delete(id);
    const method = pendingMethods.get(id) || "";
    pendingMethods.delete(id);
    emitLog({
      stage: "rpc_error",
      method: method || undefined,
      id,
      message,
      readyState: getTransportReadyState(),
    });
    pendingEntry.reject(new Error(message));
  }

  function resolvePendingForId(idRaw: unknown, result: unknown) {
    const id = Number(idRaw);
    if (!Number.isInteger(id)) return;
    const pendingEntry = pending.get(id);
    if (!pendingEntry) {
      emitLog({
        stage: "rpc_result_unmatched",
        id,
        message: "pending_missing",
        readyState: getTransportReadyState(),
      });
      return;
    }
    pending.delete(id);
    const method = pendingMethods.get(id) || "";
    pendingMethods.delete(id);
    emitLog({
      stage: "rpc_result",
      method: method || undefined,
      id,
      readyState: getTransportReadyState(),
    });
    pendingEntry.resolve(result);
  }

  function sendTurnInterruptIfPossible() {
    if (!interruptRequested || interruptRpcSent) return false;
    if (!activeThreadId || !activeTurnId) return false;
    if (getTransportReadyState() !== WebSocket.OPEN) {
      emitLog({
        stage: "turn_interrupt_skipped",
        message: `ws_ready_state=${getTransportReadyState()}`,
        readyState: getTransportReadyState(),
      });
      return false;
    }
    interruptRpcSent = true;
    const id = nextId++;
    emitLog({
      stage: "turn_interrupt_send",
      method: "turn/interrupt",
      id,
      readyState: getTransportReadyState(),
      message: `threadId=${activeThreadId} turnId=${activeTurnId}`,
    });
    try {
      sendJson({
        id,
        method: "turn/interrupt",
        params: {
          threadId: activeThreadId,
          turnId: activeTurnId,
        },
      });
      emitLog({
        stage: "turn_interrupt_sent",
        method: "turn/interrupt",
        id,
        readyState: getTransportReadyState(),
      });
    } catch (error) {
      emitLog({
        stage: "turn_interrupt_error",
        method: "turn/interrupt",
        id,
        message: toErrorMessage(error),
        readyState: getTransportReadyState(),
      });
    }
    return true;
  }

  async function handleServerRequest(message: JsonRpcIncoming) {
    const id = Number(message.id);
    const method = String(message.method || "");
    const params = message.params ?? {};
    emitEvent(method, params);
    if (!Number.isInteger(id)) return;
    if (method.endsWith("/requestApproval")) {
      const isKnownApprovalMethod = (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval"
      );
      if (!isKnownApprovalMethod) {
        emitLog({
          stage: "approval_request_unknown",
          method,
          id,
          readyState: getTransportReadyState(),
        });
        sendJson({
          id,
          error: {
            code: -32601,
            message: `Unsupported approval method: ${method}`,
          },
        });
        return;
      }
      const request = normalizeAppServerApprovalRequest(params, {
        rpcId: id,
        method,
        threadId: activeThreadId,
        turnId: activeTurnId,
      });
      const guard = { active: true, request };
      pendingApprovalRequests.set(id, guard);
      try {
        const decided = await onApprovalRequest(request);
        if (!isApprovalAction(decided)) {
          throw new Error(`Invalid approval action: ${String(decided)}`);
        }
        if (!guard.active || finalized) return;
        sendJson({
          id,
          result: {
            decision: toCodexApprovalDecision(decided),
          },
        });
      } catch (error) {
        if (!guard.active || finalized) return;
        emitLog({
          stage: "approval_handler_error",
          method,
          id,
          message: toErrorMessage(error),
          readyState: getTransportReadyState(),
        });
      } finally {
        pendingApprovalRequests.delete(id);
      }
      return;
    }
    sendJson({
      id,
      error: {
        code: -32000,
        message: `${method || "unknown_method"} is not supported by this client`,
      },
    });
  }

  function handleNotification(methodRaw: unknown, paramsRaw: unknown) {
    const method = String(methodRaw || "");
    const params = paramsRaw || {};
    emitLog({
      stage: "notification",
      method: method || undefined,
      readyState: getTransportReadyState(),
    });
    emitEvent(method, params);
    if (method === "serverRequest/resolved") {
      const resolvedApproval = takeResolvedApprovalRequest(pendingApprovalRequests, params);
      if (resolvedApproval) {
        options.onApprovalRequestResolved?.(resolvedApproval);
      }
      return;
    }
    if (method === "error") {
      lastErrorMessage = extractNotificationMessage(params);
      if (lastErrorMessage) {
        emitLog({
          stage: "server_error",
          method,
          message: lastErrorMessage,
          readyState: getTransportReadyState(),
        });
      }
      return;
    }
    if (method === "item/started") {
      const itemType = String((params as any)?.item?.type || "");
      if (itemType === "agentMessage") {
        rememberAgentMessageItemId(extractAgentMessageItemId(params));
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (interruptRequested) return;
      const delta = String((params as any)?.delta || "");
      if (!delta) return;
      const itemId = resolveAgentMessageItemId(params);
      const itemBuffer = `${String(agentMessageBuffers.get(itemId) || "")}${delta}`;
      agentMessageBuffers.set(itemId, itemBuffer);
      deltaBuffer = buildCombinedAgentMessageReply();
      if (options.onDelta) {
        options.onDelta(delta, { ...(params as any), itemId });
      }
      return;
    }
    if (method === "item/completed") {
      if (interruptRequested) return;
      const itemType = String((params as any)?.item?.type || "");
      if (itemType !== "agentMessage") return;
      const text = extractAgentMessageText((params as any)?.item);
      if (text) {
        const itemId = resolveAgentMessageItemId(params);
        const previousItemBuffer = String(agentMessageBuffers.get(itemId) || "");
        const nextDelta = text.startsWith(previousItemBuffer)
          ? text.slice(previousItemBuffer.length)
          : text;
        agentMessageBuffers.set(itemId, text);
        completedAgentMessage = buildCombinedAgentMessageReply();
        deltaBuffer = completedAgentMessage;
        if (nextDelta && options.onDelta) {
          emitLog({
            stage: "agent_message_completed_delta",
            method,
            message: `chars=${nextDelta.length} total=${text.length}`,
            readyState: getTransportReadyState(),
          });
          options.onDelta(nextDelta, { ...(params as any), itemId });
        }
      }
      return;
    }
  }

  function maybeHandleRunnerRelayControl(rawData: string) {
    const control = parseRunnerRelayControlMessage(rawData);
    if (!control) return false;
    if (typeof control.seq === "number") {
      lastRelaySeq = Math.max(lastRelaySeq, control.seq);
    }
    if (typeof control.latestSeq === "number") {
      lastRelaySeq = Math.max(lastRelaySeq, control.latestSeq);
    }
    if (control.type === "runner_relay_attached") {
      emitLog({
        stage: "ws_relay_attached",
        message: `replayed=${control.replayed ?? 0} latestSeq=${control.latestSeq ?? lastRelaySeq}`,
        readyState: getTransportReadyState(),
      });
      reconnectAttempts = 0;
    } else if (control.type === "runner_relay_resume_miss") {
      const detail = control.reason || "resume_miss";
      failRef?.(new Error(`Codex app-server relay resume miss: ${detail}`));
    } else if (control.type === "runner_relay_closed") {
      const detail = control.reason || "relay_closed";
      if (!reconnectRunnerRelay?.("runner_relay_closed", detail)) {
        failRef?.(new Error(`Codex app-server relay closed: ${detail}`));
      }
    }
    return true;
  }

  function maybeHandleRunnerRpcAck(rawData: string) {
    const ack = parseRunnerWsLlmRpcAck(rawData);
    if (!ack) return false;
    emitLog({
      stage: "ws_server_ack",
      method: ack.method || undefined,
      id: Number.isInteger(ack.id) ? Number(ack.id) : undefined,
      readyState: getTransportReadyState(),
      message: `phase=${ack.phase} requestId=${ack.requestId}${ack.state ? ` state=${ack.state}` : ""}${ack.relayId ? ` relayId=${ack.relayId}` : ""}`,
    });
    return true;
  }

  const promise = new Promise<CodexAppServerTurnResult>((resolve, reject) => {
    function fail(error: unknown) {
      if (finalized) return;
      finalized = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
    }

    function succeed(result: CodexAppServerTurnResult) {
      if (finalized) return;
      finalized = true;
      cleanup();
      resolve(result);
    }

    failRef = fail;

    timeoutHandle = setTimeout(() => {
      fail(new Error(`Codex app-server turn timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    emitLog({
      stage: "ws_connect_start",
      readyState: getTransportReadyState(),
      message: wsLabel,
    });

    const tryReconnectViaRunnerRelay = (trigger: RunnerRelayReconnectTrigger, detail: string) => {
      const blockReconnect = (reason: string) => {
        emitLog({
          stage: "ws_reconnect_blocked",
          message: `reason=${reason} trigger=${trigger} threadId=${activeThreadId || "-"} turnStarted=${turnStartIssued ? 1 : 0} turnCompleted=${turnCompletedObserved ? 1 : 0} detail=${detail}`,
          readyState: getTransportReadyState(),
        });
        return false;
      };
      if (finalized) return blockReconnect("finalized");
      if (interruptRequested) return blockReconnect("interrupt_requested");
      if (turnCompletedObserved) return blockReconnect("turn_completed_observed");
      if (!turnStartIssued) return blockReconnect("turn_not_started");
      if (!activeThreadId) return blockReconnect("thread_not_resolved");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        emitLog({
          stage: "ws_reconnect_rescheduled",
          message: `trigger=${trigger} threadId=${activeThreadId} fromSeq=${lastRelaySeq} detail=${detail}`,
          readyState: getTransportReadyState(),
        });
      }
      reconnectAttempts += 1;
      const attempt = reconnectAttempts;
      const resumeWsUrl = useRunnerWsEnvelope
        ? wsUrl
        : buildRunnerRelayResumeWsUrl(wsUrl, activeThreadId, lastRelaySeq);
      const reconnectDelayMs = reserveRunnerWsReconnectDelay(resumeWsUrl, {
        minSpacingMs: Math.min(5000, 1000 * attempt),
        jitterMs: 500,
      });
      emitLog({
        stage: reconnectDelayMs > 0 ? "ws_reconnect_scheduled" : "ws_reconnect_start",
        message: `trigger=${trigger} attempt=${attempt} threadId=${activeThreadId} fromSeq=${lastRelaySeq} delayMs=${reconnectDelayMs} detail=${detail}`,
        readyState: getTransportReadyState(),
      });
      const runReconnect = () => {
        reconnectTimer = null;
        if (finalized || interruptRequested || turnCompletedObserved) return;
        if (!turnStartIssued || !activeThreadId) return;
        emitLog({
          stage: "ws_reconnect_start",
          message: `trigger=${trigger} attempt=${attempt} threadId=${activeThreadId} fromSeq=${lastRelaySeq} detail=${detail}`,
          readyState: getTransportReadyState(),
        });
        try {
          ws = createWebSocketWithOptionalAuth(resumeWsUrl, wsToken);
        } catch (error) {
          const createError = toErrorMessage(error);
          emitLog({
            stage: "ws_reconnect_create_error",
            message: createError,
            readyState: getTransportReadyState(),
          });
          void tryReconnectViaRunnerRelay("ws_close", `create_error ${createError}`);
          return;
        }
        attachSocketHandlers(ws, "resume");
      };
      if (reconnectDelayMs <= 0) {
        runReconnect();
        return true;
      }
      reconnectTimer = setTimeout(runReconnect, reconnectDelayMs);
      return true;
    };
    reconnectRunnerRelay = tryReconnectViaRunnerRelay;

    const runInitialTurnSetup = async (failIfActive: (error: Error) => void) => {
      await sendRequest("initialize", {
        clientInfo: {
          name: "expo-ios-client",
          title: "Expo iOS Client",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [],
        },
      }, PRE_TURN_RPC_TIMEOUT_MS);
      sendNotification("initialized", {});

      const readThreadSnapshot = async (threadId: string, reason: string) => {
        const readResult = await sendRequest<Record<string, unknown>>("thread/read", {
          threadId,
          includeTurns: true,
        }, PRE_TURN_RPC_TIMEOUT_MS);
        const thread = extractThreadReadPayload(readResult);
        const threadStatus = deriveCodexSessionStateFromSnapshot(thread);
        emitEvent("thread/status/changed", {
          threadId,
          status: (thread && typeof thread === "object" ? (thread as Record<string, unknown>).status : undefined),
          reason,
        });
        emitLog({
          stage: "thread_read_status",
          method: "thread/read",
          message: `reason=${reason} status=${threadStatus.threadStatusType}`,
          readyState: getTransportReadyState(),
        });
        return threadStatus;
      };

      if (activeThreadId) {
        try {
          let resumeReason = "";
          try {
            const snapshotStatus = await readThreadSnapshot(activeThreadId, "before_resume");
            resumeReason = snapshotStatus.threadStatusType;
          } catch (error) {
            if (!isThreadNotLoadedError(error)) {
              throw error;
            }
            resumeReason = "thread_read_not_loaded_error";
            emitLog({
              stage: "thread_read_before_resume_not_loaded",
              method: "thread/read",
              message: toErrorMessage(error),
              readyState: getTransportReadyState(),
            });
            emitEvent("thread/status/changed", {
              threadId: activeThreadId,
              status: "notLoaded",
              reason: "before_resume_read_error",
            });
          }
          const resumed = await sendRequest<CodexThreadResumeResponse>("thread/resume", {
            threadId: activeThreadId,
            cwd: cwd || undefined,
            persistExtendedHistory: false,
          }, PRE_TURN_RPC_TIMEOUT_MS);
          activeThreadId = String(resumed?.thread?.id || activeThreadId || "").trim();
          emitLog({
            stage: "thread_resume_before_turn",
            method: "thread/resume",
            message: `from_status=${resumeReason || "-"}`,
            readyState: getTransportReadyState(),
          });
          notifyThreadIdResolved(activeThreadId);
        } catch (error) {
          const noRollout = isNoRolloutForThreadError(error);
          if (strictThreadResume && !noRollout) {
            throw error;
          }
          if (!noRollout) throw error;
          emitLog({
            stage: "thread_resume_fallback",
            message: toErrorMessage(error),
            readyState: getTransportReadyState(),
          });
          activeThreadId = "";
        }
      }
      if (!activeThreadId) {
        const started = await sendRequest<CodexThreadStartResponse>("thread/start", {
          cwd: cwd || undefined,
          serviceName,
          approvalPolicy,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        }, PRE_TURN_RPC_TIMEOUT_MS);
        activeThreadId = String(started?.thread?.id || "").trim();
        notifyThreadIdResolved(activeThreadId);
        if (activeThreadId) {
          try {
            await readThreadSnapshot(activeThreadId, "after_start");
          } catch (error) {
            emitLog({
              stage: "thread_read_status_failed",
              method: "thread/read",
              message: toErrorMessage(error),
              readyState: getTransportReadyState(),
            });
          }
        }
      }
      if (!activeThreadId) {
        throw new Error("thread id was not returned from app-server");
      }

      const turnStartParams: Record<string, unknown> = {
        threadId: activeThreadId,
        input: [
          {
            type: "text",
            text: inputText,
          },
        ],
        cwd: cwd || undefined,
        approvalPolicy,
      };
      const model = String(options.model || "").trim();
      if (model) {
        turnStartParams.model = model;
      }
      const effort = String(options.effort || "").trim();
      if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") {
        turnStartParams.effort = effort;
      }
      turnStartIssued = true;
      const turnStarted = await sendRequest<CodexTurnStartResponse>(
        "turn/start",
        turnStartParams,
        PRE_TURN_RPC_TIMEOUT_MS
      );
      activeTurnId = String(turnStarted?.turn?.id || "").trim();

      if (interruptRequested) {
        sendTurnInterruptIfPossible();
        failIfActive(createTurnInterruptedError());
      }
    };

    const handleIncomingRawData = (
      rawData: string,
      failIfActive: (error: Error) => void
    ) => {
      const runnerWsEnvelope = useRunnerWsEnvelope ? parseRunnerWsEnvelope(rawData) : null;
      if (typeof runnerWsEnvelope?.seq === "number") {
        lastRelaySeq = Math.max(lastRelaySeq, Math.max(0, Math.floor(runnerWsEnvelope.seq)));
      }
      if (runnerWsEnvelope?.channel === "llm" && runnerWsEnvelope.op === "rpc") {
        reconnectAttempts = 0;
      }
      if (pendingMethods.size > 0) {
        emitLog({
          stage: "rx_raw",
          message: summarizeIncomingRpcFrame(rawData, pendingMethods),
          readyState: getTransportReadyState(),
        });
      }
      if (maybeHandleRunnerRpcAck(rawData)) return;
      if (maybeHandleRunnerRelayControl(rawData)) return;
      const incoming = normalizeRunnerWsIncomingCodexRpc(rawData);
      if (pendingMethods.size > 0 && incoming.type === "rpc") {
        emitLog({
          stage: "rx_normalized",
          message: `chars=${incoming.rawData.length}`,
          readyState: getTransportReadyState(),
        });
      }
      if (incoming.type === "ignore") {
        if (pendingMethods.size > 0) {
          emitLog({
            stage: "rx_ignored",
            message: summarizeIncomingRpcFrame(rawData, pendingMethods),
            readyState: getTransportReadyState(),
          });
        }
        return;
      }
      if (incoming.type === "error") {
        emitLog({
          stage: "rx_runner_error",
          message: incoming.message,
          readyState: getTransportReadyState(),
        });
        if (!useRunnerWsManager && tryReconnectViaRunnerRelay("rx_runner_error", incoming.message)) return;
        failIfActive(new Error(incoming.message));
        return;
      }
      const parsedMessage = parseJsonRpcMessage(incoming.rawData);
      if (!parsedMessage) {
        if (pendingMethods.size > 0) {
          emitLog({
            stage: "rx_parse_null",
            message: summarizeIncomingRpcFrame(rawData, pendingMethods),
            readyState: getTransportReadyState(),
          });
        }
        return;
      }
      const message = useRunnerWsManager
        ? runnerWsRpcIds.rewriteIncoming(parsedMessage)
        : parsedMessage;
      if (pendingMethods.size > 0) {
        emitLog({
          stage: "rx_jsonrpc_shape",
          message: summarizeParsedJsonRpcShape(message),
          readyState: getTransportReadyState(),
        });
      }
      const id = message.id;
      const hasId = typeof id !== "undefined";
      const method = message.method;

      if (hasId && typeof method === "string") {
        void handleServerRequest(message).catch((error) => {
          failIfActive(error instanceof Error ? error : new Error(toErrorMessage(error)));
        });
        return;
      }

      if (hasId && typeof method === "undefined") {
        const payloadError = message.error as JsonRpcFailure["error"] | undefined;
        const pendingMethod = Number.isInteger(Number(id))
          ? (pendingMethods.get(Number(id)) || "")
          : "";
        emitLog({
          stage: "rx_rpc_response",
          method: pendingMethod || undefined,
          id: Number.isInteger(Number(id)) ? Number(id) : undefined,
          readyState: getTransportReadyState(),
          message: payloadError
            ? `error=${String(payloadError.message || "json-rpc request failed")}`
            : "ok",
        });
        if (payloadError) {
          const msg = String(payloadError.message || "json-rpc request failed");
          rejectPendingForId(id, msg);
          return;
        }
        resolvePendingForId(id, (message as JsonRpcSuccess).result);
        return;
      }
      if (pendingMethods.size > 0 && hasId) {
        emitLog({
          stage: "rx_id_non_response",
          id: Number.isInteger(Number(id)) ? Number(id) : undefined,
          readyState: getTransportReadyState(),
          message: `methodType=${typeof method}`,
        });
      }

      handleNotification(method, message.params);
      if (String(method || "") !== "turn/completed") return;
      turnCompletedObserved = true;
      for (const entry of pendingApprovalRequests.values()) {
        entry.active = false;
      }
      pendingApprovalRequests.clear();
      latestContextUsage = extractContextUsageFromTurnCompletedParams(message.params, options.model);
      const threadId = String((message.params as any)?.threadId || activeThreadId || "").trim();
      const turnId = String((message.params as any)?.turn?.id || activeTurnId || "").trim();
      const turnStatus = String((message.params as any)?.turn?.status || "").trim().toLowerCase();
      if (!threadId) {
        failIfActive(new Error("turn completed without thread id"));
        return;
      }
      if (interruptRequested || turnStatus === "interrupted") {
        failIfActive(createTurnInterruptedError());
        return;
      }
      const reply = String(completedAgentMessage || deltaBuffer || "").trim();
      if (!reply && lastErrorMessage) {
        failIfActive(new Error(`Codex turn failed: ${lastErrorMessage}`));
        return;
      }
      succeed({
        threadId,
        turnId,
        reply,
        contextUsage: latestContextUsage,
      });
    };

    const attachSocketHandlers = (socket: WebSocket, mode: "initial" | "resume") => {
      let handledTerminal = false;
      const currentMode = mode;
      const failIfActive = (error: Error) => {
        if (handledTerminal) return;
        handledTerminal = true;
        if (socket !== ws) return;
        fail(error);
      };

      socket.onopen = () => {
        if (socket !== ws || finalized) return;
        emitLog({
          stage: currentMode === "initial" ? "ws_open" : "ws_reconnect_open",
          readyState: socket.readyState,
        });
        if (currentMode === "resume") {
          if (useRunnerWsEnvelope) {
            try {
              socket.send(encodeRunnerWsRelayResume(activeThreadId, lastRelaySeq));
            } catch (error) {
              const detail = toErrorMessage(error);
              emitLog({
                stage: "ws_resume_send_error",
                message: detail,
                readyState: socket.readyState,
              });
              if (tryReconnectViaRunnerRelay("ws_resume_send_error", detail)) return;
              failIfActive(error instanceof Error ? error : new Error(detail));
              return;
            }
          }
          if (interruptRequested) {
            sendTurnInterruptIfPossible();
            failIfActive(createTurnInterruptedError());
          }
          return;
        }
        (async () => {
          await runInitialTurnSetup(failIfActive);
        })().catch((error) => {
          failIfActive(error instanceof Error ? error : new Error(toErrorMessage(error)));
        });
      };

      socket.onmessage = (event) => {
        if (socket !== ws || finalized) return;
        const rawData = typeof event.data === "string" ? event.data : String(event.data || "");
        handleIncomingRawData(rawData, failIfActive);
      };

      socket.onerror = (event: any) => {
        if (socket !== ws || finalized) return;
        const detail = String(event?.message || event?.type || "unknown");
        emitLog({
          stage: "ws_error",
          message: detail,
          readyState: socket.readyState,
        });
        if (tryReconnectViaRunnerRelay("ws_error", detail)) return;
        failIfActive(
          new Error(`Codex app-server WebSocket error: ${detail} url=${wsLabel} readyState=${socket.readyState}`)
        );
      };

      socket.onclose = (event: any) => {
        if (socket !== ws || finalized) return;
        if (interruptRequested) {
          failIfActive(createTurnInterruptedError());
          return;
        }
        const code = Number(event?.code);
        const reason = String(event?.reason || "").trim();
        const wasClean = Boolean(event?.wasClean);
        const codeText = Number.isFinite(code) ? String(code) : "unknown";
        emitLog({
          stage: "ws_close",
          message: `code=${codeText} reason=${reason || "-"} clean=${wasClean}`,
          readyState: socket.readyState,
        });
        if (tryReconnectViaRunnerRelay("ws_close", `code=${codeText} reason=${reason || "-"}`)) return;
        failIfActive(
          new Error(
            `Codex app-server WebSocket closed: code=${codeText} reason=${reason || "-"} clean=${wasClean} url=${wsLabel} readyState=${socket.readyState}`
          )
        );
      };
    };

    if (useRunnerWsManager && runnerWebSocketManager) {
      let managerReadyObserved = runnerWebSocketManager.getSnapshot().connectionState === "ready";
      let handledTerminal = false;
      const failIfActive = (error: Error) => {
        if (handledTerminal) return;
        handledTerminal = true;
        fail(error);
      };
      managerUnsubscribers.push(runnerWebSocketManager.subscribe(
        {
          channel: "llm",
          op: "rpc",
          operationId: runnerWsOperationId,
          sessionId: runnerWsSessionId,
        },
        (message) => {
          if (finalized) return;
          handleIncomingRawData(JSON.stringify(message), failIfActive);
        }
      ));
      managerUnsubscribers.push(runnerWebSocketManager.subscribeSnapshot(() => {
        if (finalized || !managerReadyObserved) return;
        const snapshot = runnerWebSocketManager.getSnapshot();
        if (snapshot.connectionState === "ready") return;
        failIfActive(new Error(`Codex app-server runner-ws disconnected: state=${snapshot.connectionState}`));
      }));
      runnerWebSocketManager.connect()
        .then(() => {
          if (finalized) return;
          managerReadyObserved = true;
          emitLog({
            stage: "ws_open",
            readyState: getTransportReadyState(),
            message: "runner_ws_manager_ready",
          });
          return runInitialTurnSetup(failIfActive);
        })
        .catch((error) => {
          failIfActive(error instanceof Error ? error : new Error(toErrorMessage(error)));
        });
      return;
    }

    if (!ws) {
      fail(new Error("Codex app-server WebSocket is not initialized"));
      return;
    }
    attachSocketHandlers(ws, "initial");
  });

  const interrupt = async () => {
    if (finalized) return;
    if (!interruptRequested) {
      interruptRequested = true;
      emitLog({
        stage: "turn_interrupt_requested",
        message: `threadId=${activeThreadId || "-"} turnId=${activeTurnId || "-"}`,
        readyState: getTransportReadyState(),
      });
      for (const entry of pendingApprovalRequests.values()) {
        entry.active = false;
      }
      pendingApprovalRequests.clear();
    }
    if (activeThreadId && activeTurnId) {
      if (sendTurnInterruptIfPossible()) {
        failRef?.(createTurnInterruptedError());
        return;
      }
    }
    if (getTransportReadyState() === WebSocket.CLOSING || getTransportReadyState() === WebSocket.CLOSED) {
      failRef?.(createTurnInterruptedError());
    }
  };

  return {
    promise,
    interrupt,
  };
}

export async function runCodexAppServerTurn(
  options: CodexAppServerTurnOptions
): Promise<CodexAppServerTurnResult> {
  return await startCodexAppServerTurn(options).promise;
}
