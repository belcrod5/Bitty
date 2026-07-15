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
const MANAGER_RECONNECT_WAIT_TIMEOUT_MS = 120_000;

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

function extractThreadReadPayload(result: unknown): unknown {
  const object = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return (object as any)?.thread ?? (object as any)?.data?.thread ?? (object as any)?.data ?? result;
}

export function startCodexAppServerTurn(
  options: CodexAppServerTurnOptions
): CodexAppServerTurnSession {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const runnerWebSocketManager = options.runnerWebSocketManager;
  const useRunnerWsManager = Boolean(runnerWebSocketManager);
  const useRunnerWsEnvelope = useRunnerWsManager || isRunnerWsUrl(wsUrl);
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
  let hasReceivedRelaySeq = false;
  let reconnectAttempts = 0;
  let turnStartIssued = false;
  let turnCompletedObserved = false;
  let runnerWsEnvelopeSeq = 0;
  const runnerWsOperationId = createCodexRunnerWsLogicalId("codex_turn_op", traceId);
  const runnerWsSessionId = createCodexRunnerWsLogicalId("codex_turn_session", traceId);
  const runnerWsRpcIds = new CodexRunnerWsJsonRpcIdMapper();
  const managerUnsubscribers: Array<() => void> = [];
  let reconnectRunnerRelay: ((trigger: RunnerRelayReconnectTrigger, detail: string) => boolean) | null = null;
  let awaitingReconnect = false;
  let reconnectWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeSentGeneration = -1;
  let settleAdmission: ((error?: Error) => void) | null = null;
  let operationEpoch = 0;
  let admissionConnectRequested = false;
  const sentPendingRpcIds = new Set<JsonRpcId>();
  const unsentRunnerRpcErrors = new WeakSet<Error>();
  const pendingRpcTimeouts = new Map<JsonRpcId, {
    remainingMs: number;
    startedAtMs: number;
    timer: ReturnType<typeof setTimeout> | null;
    expire: () => void;
  }>();
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
    settleAdmission?.(createTurnInterruptedError());
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (reconnectWaitTimer) {
      clearTimeout(reconnectWaitTimer);
      reconnectWaitTimer = null;
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
    sentPendingRpcIds.clear();
    for (const timeout of pendingRpcTimeouts.values()) {
      if (timeout.timer) clearTimeout(timeout.timer);
    }
    pendingRpcTimeouts.clear();
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
    if (finalized || (interruptRequested && payload.method !== "turn/interrupt")) {
      throw createTurnInterruptedError();
    }
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
    } else {
      if (!ws) throw new Error("Codex app-server WebSocket is not initialized");
      ws.send(useRunnerWsEnvelope
        ? encodeRunnerWsLlmRpc(payload, activeThreadId, {
          requestId: runnerRequestId || undefined,
          operationId: runnerWsOperationId,
          sessionId: runnerWsSessionId,
        })
        : JSON.stringify(payload));
    }
    if (Number.isInteger(id)) sentPendingRpcIds.add(id);
    if (method === "turn/start") turnStartIssued = true;
  }

  function sendRequest<T>(method: string, params: Record<string, unknown>, rpcTimeoutMs?: number) {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMsRaw = Number(rpcTimeoutMs);
      const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
        ? Math.floor(timeoutMsRaw)
        : 0;
      const clearRequestTimeout = () => {
        const timeout = pendingRpcTimeouts.get(id);
        if (timeout?.timer) clearTimeout(timeout.timer);
        pendingRpcTimeouts.delete(id);
      };
      pending.set(id, {
        resolve: (value) => {
          clearRequestTimeout();
          pendingMethods.delete(id);
          sentPendingRpcIds.delete(id);
          resolve(value);
        },
        reject: (error) => {
          clearRequestTimeout();
          pendingMethods.delete(id);
          sentPendingRpcIds.delete(id);
          reject(error);
        },
      });
      pendingMethods.set(id, method);
      if (timeoutMs > 0) {
        const expire = () => {
          const pendingEntry = pending.get(id);
          if (!pendingEntry) return;
          pending.delete(id);
          pendingMethods.delete(id);
          sentPendingRpcIds.delete(id);
          pendingRpcTimeouts.delete(id);
          reject(new Error(`Codex app-server RPC timeout(${timeoutMs}ms): ${method} id=${id}`));
        };
        const timeout = {
          remainingMs: timeoutMs, startedAtMs: Date.now(),
          timer: null as ReturnType<typeof setTimeout> | null, expire,
        };
        timeout.timer = setTimeout(expire, timeoutMs);
        pendingRpcTimeouts.set(id, timeout);
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
        sentPendingRpcIds.delete(id);
        const sendError = error instanceof Error ? error : new Error(toErrorMessage(error));
        unsentRunnerRpcErrors.add(sendError);
        reject(sendError);
      }
    });
  }

  function pausePendingRpcTimeouts() {
    const now = Date.now();
    for (const timeout of pendingRpcTimeouts.values()) {
      if (!timeout.timer) continue;
      clearTimeout(timeout.timer);
      timeout.timer = null;
      timeout.remainingMs = Math.max(1, timeout.remainingMs - (now - timeout.startedAtMs));
    }
  }

  function resumePendingRpcTimeouts() {
    for (const timeout of pendingRpcTimeouts.values()) {
      if (timeout.timer) continue;
      timeout.startedAtMs = Date.now();
      timeout.timer = setTimeout(timeout.expire, timeout.remainingMs);
    }
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
    sentPendingRpcIds.delete(id);
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
    sentPendingRpcIds.delete(id);
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
        options.onAgentMessageCompleted?.(text, { ...(params as any), itemId });
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
      if (awaitingReconnect) {
        awaitingReconnect = false;
        if (reconnectWaitTimer) {
          clearTimeout(reconnectWaitTimer);
          reconnectWaitTimer = null;
        }
      }
      if (interruptRequested && activeThreadId && activeTurnId && sendTurnInterruptIfPossible()) {
        failRef?.(createTurnInterruptedError());
      }
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
      operationEpoch += 1;
      cleanup();
      reject(error instanceof Error ? error : new Error(toErrorMessage(error)));
    }

    function succeed(result: CodexAppServerTurnResult) {
      if (finalized) return;
      finalized = true;
      operationEpoch += 1;
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
    if (!useRunnerWsManager) {
      reconnectRunnerRelay = tryReconnectViaRunnerRelay;
    }

    const requestManagerConnection = () => {
      if (!runnerWebSocketManager || admissionConnectRequested) return;
      const snapshot = runnerWebSocketManager.getSnapshot();
      if (snapshot.appState !== "active" || snapshot.connectionState !== "idle") return;
      admissionConnectRequested = true;
      runnerWebSocketManager.connect().catch(() => undefined);
    };
    const waitForManagerAdmission = (requireSnapshotSignal = false): Promise<number> => {
      if (!runnerWebSocketManager) return Promise.resolve(operationEpoch);
      if (finalized || interruptRequested) return Promise.reject(createTurnInterruptedError());
      const snapshot = runnerWebSocketManager.getSnapshot();
      if (!requireSnapshotSignal && snapshot.appState === "active" && snapshot.connectionState === "ready") {
        return Promise.resolve(operationEpoch);
      }
      if (snapshot.appState === "active" && snapshot.connectionState === "stopped") {
        return Promise.reject(new Error("Codex app-server runner-ws stopped"));
      }
      return new Promise<number>((resolve, reject) => {
        const epoch = operationEpoch;
        settleAdmission = (error) => {
          settleAdmission = null;
          error ? reject(error) : resolve(epoch);
        };
        requestManagerConnection();
      });
    };
    const sendRequestWhenAdmitted = async <T,>(
      method: string,
      params: Record<string, unknown>,
      rpcTimeoutMs?: number
    ): Promise<T> => {
      if (!runnerWebSocketManager) return sendRequest<T>(method, params, rpcTimeoutMs);
      let requireSnapshotSignal = false;
      while (true) {
        const epoch = await waitForManagerAdmission(requireSnapshotSignal);
        requireSnapshotSignal = false;
        const snapshot = runnerWebSocketManager.getSnapshot();
        if (epoch !== operationEpoch || finalized || interruptRequested) throw createTurnInterruptedError();
        if (snapshot.appState !== "active" || snapshot.connectionState !== "ready") continue;
        try {
          return await sendRequest<T>(method, params, rpcTimeoutMs);
        } catch (error) {
          if (
            error instanceof Error &&
            unsentRunnerRpcErrors.has(error) &&
            (error.message.includes("runner_ws_inactive_start_blocked") ||
              error.message.includes("runner_ws_not_ready"))
          ) {
            requireSnapshotSignal = true;
            continue;
          }
          throw error;
        }
      }
    };
    const sendNotificationWhenAdmitted = (method: string, params: Record<string, unknown>) => {
      let requireSnapshotSignal = false;
      const initialSnapshot = runnerWebSocketManager?.getSnapshot();
      if (!initialSnapshot || (
        initialSnapshot.appState === "active" && initialSnapshot.connectionState === "ready"
      )) {
        try {
          sendNotification(method, params);
          return;
        } catch (error) {
          if (!(error instanceof Error) || !(
            error.message.includes("runner_ws_inactive_start_blocked") ||
            error.message.includes("runner_ws_not_ready")
          )) throw error;
          requireSnapshotSignal = true;
        }
      }
      return (async () => { while (true) {
        const epoch = await waitForManagerAdmission(requireSnapshotSignal);
        requireSnapshotSignal = false;
        const snapshot = runnerWebSocketManager?.getSnapshot();
        if (epoch !== operationEpoch || finalized || interruptRequested) throw createTurnInterruptedError();
        if (snapshot && (snapshot.appState !== "active" || snapshot.connectionState !== "ready")) continue;
        try {
          sendNotification(method, params);
          return;
        } catch (error) {
          if (error instanceof Error && (
            error.message.includes("runner_ws_inactive_start_blocked") ||
            error.message.includes("runner_ws_not_ready")
          )) {
            requireSnapshotSignal = true;
            continue;
          }
          throw error;
        }
      } })();
    };

    const runInitialTurnSetup = async (failIfActive: (error: Error) => void) => {
      await waitForManagerAdmission();
      await sendRequestWhenAdmitted("initialize", {
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
      const initializedAdmission = sendNotificationWhenAdmitted("initialized", {});
      if (initializedAdmission) await initializedAdmission;

      const readThreadSnapshot = async (threadId: string, reason: string) => {
        const readResult = await sendRequestWhenAdmitted<Record<string, unknown>>("thread/read", {
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
          const resumed = await sendRequestWhenAdmitted<CodexThreadResumeResponse>("thread/resume", {
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
        const started = await sendRequestWhenAdmitted<CodexThreadStartResponse>("thread/start", {
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
      const turnStarted = await sendRequestWhenAdmitted<CodexTurnStartResponse>(
        "turn/start", turnStartParams, PRE_TURN_RPC_TIMEOUT_MS
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
      const isRelayedLlmRpc = runnerWsEnvelope?.channel === "llm" && runnerWsEnvelope.op === "rpc";
      if (typeof runnerWsEnvelope?.seq === "number") {
        const seq = Math.max(0, Math.floor(runnerWsEnvelope.seq));
        // On the singleton WS, another subscriber (e.g. the relay observer) can
        // trigger its own relay:resume for the same thread, replaying events we
        // already applied. Only llm:rpc envelopes carry actual delta/notification
        // content, so only those are safe (and necessary) to de-dupe by seq;
        // relay-channel control envelopes (attached/resume_miss/closed) reuse the
        // same watermark and must always reach maybeHandleRunnerRelayControl.
        if (isRelayedLlmRpc && hasReceivedRelaySeq && seq <= lastRelaySeq) {
          return;
        }
        if (isRelayedLlmRpc) {
          hasReceivedRelaySeq = true;
        }
        lastRelaySeq = Math.max(lastRelaySeq, seq);
      }
      if (isRelayedLlmRpc) {
        reconnectAttempts = 0;
      }
      if (maybeHandleRunnerRpcAck(rawData)) return;
      if (maybeHandleRunnerRelayControl(rawData)) return;
      const incoming = normalizeRunnerWsIncomingCodexRpc(rawData);
      if (incoming.type === "ignore") return;
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
      if (!parsedMessage) return;
      const message = useRunnerWsManager
        ? runnerWsRpcIds.rewriteIncoming(parsedMessage)
        : parsedMessage;
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
      managerUnsubscribers.push(runnerWebSocketManager.subscribe(
        {
          channel: "llm",
          op: "rpc",
          operationId: runnerWsOperationId,
          sessionId: runnerWsSessionId,
        },
        (message) => {
          if (finalized) return;
          handleIncomingRawData(JSON.stringify(message), fail);
        }
      ));
      managerUnsubscribers.push(runnerWebSocketManager.subscribe(
        { channel: "relay" },
        (message) => {
          if (finalized) return;
          const matchesIdentity = (
            message.operationId === runnerWsOperationId && message.sessionId === runnerWsSessionId
          );
          const matchesThread = Boolean(activeThreadId && message.threadId === activeThreadId);
          if (!matchesIdentity && !matchesThread) return;
          maybeHandleRunnerRelayControl(JSON.stringify(message));
        }
      ));
      managerUnsubscribers.push(runnerWebSocketManager.subscribeSnapshot(() => {
        if (finalized) return;
        const snapshot = runnerWebSocketManager.getSnapshot();
        if (snapshot.connectionState !== "idle") admissionConnectRequested = false;
        if (settleAdmission) {
          if (snapshot.appState === "active" && snapshot.connectionState === "ready") {
            settleAdmission();
          } else if (snapshot.appState === "active" && snapshot.connectionState === "stopped") {
            settleAdmission(new Error("Codex app-server runner-ws stopped"));
          } else {
            requestManagerConnection();
          }
          return;
        }
        if (snapshot.connectionState === "ready") {
          resumePendingRpcTimeouts();
          if (awaitingReconnect && snapshot.generation !== resumeSentGeneration) {
            try {
              const resumeByThread = Boolean(turnStartIssued && activeThreadId);
              runnerWebSocketManager.send({
                channel: "relay",
                op: "resume",
                requestId: `${runnerWsOperationId}:resume:${snapshot.generation}`,
                ...(resumeByThread
                  ? { threadId: activeThreadId }
                  : { operationId: runnerWsOperationId, sessionId: runnerWsSessionId }),
                seq: lastRelaySeq,
              });
              resumeSentGeneration = snapshot.generation;
              emitLog({
                stage: "ws_reconnect_resume_sent",
                message: `${resumeByThread ? `threadId=${activeThreadId}` : "match=identity"} fromSeq=${lastRelaySeq}`,
                readyState: getTransportReadyState(),
              });
            } catch {
              // Retried on the next ready snapshot; the generation guard above
              // prevents sending relay:resume twice for the same reconnect.
            }
          }
          return;
        }
        pausePendingRpcTimeouts();
        if (sentPendingRpcIds.size === 0 && !turnStartIssued) return;
        if (turnCompletedObserved || (interruptRequested && !turnStartIssued)) return;
        if (!awaitingReconnect) {
          awaitingReconnect = true;
          emitLog({
            stage: "ws_reconnect_wait",
            message: `state=${snapshot.connectionState} threadId=${activeThreadId || "-"} fromSeq=${lastRelaySeq}`,
            readyState: getTransportReadyState(),
          });
          reconnectWaitTimer = setTimeout(() => {
            reconnectWaitTimer = null;
            fail(new Error("Codex app-server runner-ws reconnect timeout"));
          }, MANAGER_RECONNECT_WAIT_TIMEOUT_MS);
        }
      }));
      runInitialTurnSetup(fail).catch(fail);
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
      operationEpoch += 1;
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
    if (activeThreadId && activeTurnId && sendTurnInterruptIfPossible()) {
      failRef?.(createTurnInterruptedError());
      return;
    }
    if (turnStartIssued) {
      if (useRunnerWsManager && runnerWebSocketManager) {
        const snapshot = runnerWebSocketManager.getSnapshot();
        if (snapshot.connectionState !== "ready" && !awaitingReconnect) {
          awaitingReconnect = true;
          reconnectWaitTimer = setTimeout(() => {
            reconnectWaitTimer = null;
            failRef?.(new Error("Codex app-server runner-ws reconnect timeout"));
          }, MANAGER_RECONNECT_WAIT_TIMEOUT_MS);
        }
      }
      return;
    }
    failRef?.(createTurnInterruptedError());
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
