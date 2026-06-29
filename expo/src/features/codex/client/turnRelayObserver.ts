import {
  isApprovalAction,
} from "../approvalFlow";
import {
  createWebSocketWithOptionalAuth,
  extractAgentMessageText,
  normalizeAppServerApprovalRequest,
  normalizeCodexWsInputs,
  parseJsonRpcMessage,
  takeResolvedApprovalRequest,
  toCodexApprovalDecision,
  toErrorMessage,
} from "./helpers";
import {
  buildRunnerRelayResumeWsUrl,
  parseRunnerRelayControlMessage,
} from "./runnerRelayControl";
import { reserveRunnerWsReconnectDelay } from "./runnerWsReconnectGate";
import type {
  CodexAppServerRelayObserverOptions,
  CodexAppServerRelayObserverSession,
  JsonRpcId,
} from "./types";
import {
  encodeRunnerWsLlmRpc,
  encodeRunnerWsRelayResume,
  isRunnerWsUrl,
  normalizeRunnerWsIncomingCodexRpc,
  parseRunnerWsEnvelope,
} from "../../runnerWs/llmAdapter";
import type { RunnerWsMessage } from "../../runnerWs/types";

const RUNNER_RELAY_OBSERVER_PING_INTERVAL_MS = 5000;
const RUNNER_RELAY_OBSERVER_MAX_MISSED_PINGS = 2;

type RelayObserverReconnectTrigger =
  | "relay_observer_error"
  | "relay_observer_close"
  | "relay_observer_relay_closed"
  | "relay_observer_resume_send_error"
  | "relay_observer_runner_ws_error"
  | "relay_observer_stale";

function parseJsonRpcPayloadFromRunnerWsMessage(message: RunnerWsMessage): Record<string, unknown> | null {
  const payload = message.payload;
  if (typeof payload === "string") {
    return parseJsonRpcMessage(payload);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

function readRunnerRelayControlMessage(message: RunnerWsMessage) {
  if (message.channel !== "relay") return null;
  const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
    ? message.payload as Record<string, unknown>
    : {};
  const seq = Number(message.seq);
  const replayed = Number(payload.replayed);
  const latestSeq = Number(payload.latestSeq ?? message.seq);
  if (message.op === "seq") {
    return {
      type: "runner_relay_seq",
      seq: Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : undefined,
    };
  }
  if (message.op === "attached") {
    return {
      type: "runner_relay_attached",
      seq: Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : undefined,
      replayed: Number.isFinite(replayed) ? Math.max(0, Math.floor(replayed)) : undefined,
      latestSeq: Number.isFinite(latestSeq) ? Math.max(0, Math.floor(latestSeq)) : undefined,
    };
  }
  if (message.op === "resume_miss") {
    const reason = String(payload.reason || payload.message || "").trim();
    return {
      type: "runner_relay_resume_miss",
      seq: Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : undefined,
      reason: reason || undefined,
    };
  }
  if (message.op === "closed") {
    const reason = String(payload.reason || "").trim();
    return {
      type: "runner_relay_closed",
      reason: reason || undefined,
    };
  }
  return null;
}

export function startCodexAppServerTurnRelayObserver(
  options: CodexAppServerRelayObserverOptions
): CodexAppServerRelayObserverSession {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const useRunnerWsEnvelope = isRunnerWsUrl(wsUrl);
  const wsToken = normalized.wsToken;
  const threadId = String(options.threadId || "").trim();
  const resumeFromSeq = Number.isFinite(Number(options.resumeFromSeq))
    ? Math.max(0, Math.floor(Number(options.resumeFromSeq)))
    : 0;
  if (!wsUrl) throw new Error("Codex WebSocket URL is empty");
  if (!threadId) throw new Error("threadId is empty");
  if (typeof options.onApprovalRequest !== "function") {
    throw new Error("onApprovalRequest is required");
  }
  const onApprovalRequest = options.onApprovalRequest;

  let ws: WebSocket;
  let closeRequested = false;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempts = 0;
  let pingSeq = 0;
  let pendingPing: { requestId: string; sentAtMs: number } | null = null;
  let missedPingCount = 0;
  let lastRelaySeq = resumeFromSeq;
  let currentAgentMessageItemId = "";
  const agentMessageTextByItemId = new Map<string, string>();
  const pendingApprovalRequests = new Map<JsonRpcId, {
    active: boolean;
    request: import("../approvalFlow").ApprovalRequest;
  }>();
  let sendObserverJson: (payload: Record<string, unknown>) => void = (_payload) => {
    throw new Error("relay observer sender is not ready");
  };
  let finishClose = () => {
    if (closed) return;
    closed = true;
    pendingApprovalRequests.clear();
  };

  const extractAgentMessageItemId = (paramsRaw: unknown) => {
    const params = paramsRaw && typeof paramsRaw === "object" ? paramsRaw as any : {};
    return String(params?.item?.id || params?.itemId || "").trim();
  };

  const resolveAgentMessageItemId = (paramsRaw: unknown) => {
    const itemId = extractAgentMessageItemId(paramsRaw) || currentAgentMessageItemId || "__agent_message__";
    currentAgentMessageItemId = itemId;
    if (!agentMessageTextByItemId.has(itemId)) {
      agentMessageTextByItemId.set(itemId, "");
    }
    return itemId;
  };

  const emitLog = (entry: { stage: string; message?: string; readyState?: number }) => {
    if (!options.onLog) return;
    try {
      options.onLog(entry);
    } catch {}
  };

  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const clearHeartbeatTimer = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const handleJsonRpcMessage = (message: Record<string, unknown>, readyState: number) => {
    const method = String(message.method || "");
    if (!method) return;
    const rpcId = Number(message.id);
    options.onEvent?.(method, message.params);
    if (method === "serverRequest/resolved") {
      const resolvedApproval = takeResolvedApprovalRequest(
        pendingApprovalRequests,
        message.params
      );
      if (resolvedApproval) {
        options.onApprovalRequestResolved?.(resolvedApproval);
        if (closeRequested && pendingApprovalRequests.size === 0) {
          finishClose();
        }
      }
      return;
    }
    if (method.endsWith("/requestApproval") && Number.isInteger(rpcId)) {
      emitLog({
        stage: "relay_observer_approval_required",
        message: method,
        readyState,
      });
      const isKnownApprovalMethod = (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval"
      );
      if (!isKnownApprovalMethod) {
        try {
          sendObserverJson({
            id: rpcId,
            error: {
              code: -32601,
              message: `Unsupported approval method: ${method}`,
            },
          });
        } catch {}
        return;
      }
      const request = normalizeAppServerApprovalRequest(message.params ?? {}, {
        rpcId,
        method,
        threadId,
        turnId: "",
      });
      const guard = { active: true, request };
      pendingApprovalRequests.set(rpcId, guard);
      const processApprovalRequest = async () => {
        try {
          const decided = await onApprovalRequest(request);
          if (!isApprovalAction(decided)) {
            throw new Error(`Invalid approval action: ${String(decided)}`);
          }
          if (!guard.active || closed) return;
          sendObserverJson({
            id: rpcId,
            result: {
              decision: toCodexApprovalDecision(decided),
            },
          });
        } catch (error) {
          if (!guard.active || closed) return;
          emitLog({
            stage: "relay_observer_approval_handler_error",
            message: toErrorMessage(error),
            readyState,
          });
        } finally {
          pendingApprovalRequests.delete(rpcId);
          if (closeRequested && pendingApprovalRequests.size === 0) {
            finishClose();
          }
        }
      };
      void processApprovalRequest();
      return;
    }

    if (method === "item/started") {
      const itemType = String((message.params as any)?.item?.type || "");
      if (itemType === "agentMessage") {
        resolveAgentMessageItemId(message.params);
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = String((message.params as any)?.delta || "");
      if (!delta) return;
      const itemId = resolveAgentMessageItemId(message.params);
      const nextText = `${String(agentMessageTextByItemId.get(itemId) || "")}${delta}`;
      agentMessageTextByItemId.set(itemId, nextText);
      options.onDelta?.(delta, { ...(message.params as any), itemId });
      return;
    }
    if (method === "item/completed") {
      const itemType = String((message.params as any)?.item?.type || "");
      if (itemType !== "agentMessage") return;
      const text = extractAgentMessageText((message.params as any)?.item);
      if (!text) return;
      const itemId = resolveAgentMessageItemId(message.params);
      const observedAgentText = String(agentMessageTextByItemId.get(itemId) || "");
      const nextDelta = text.startsWith(observedAgentText)
        ? text.slice(observedAgentText.length)
        : text;
      agentMessageTextByItemId.set(itemId, text);
      if (nextDelta) {
        options.onDelta?.(nextDelta, { ...(message.params as any), itemId });
      }
      options.onAgentMessageCompleted?.(text, { ...(message.params as any), itemId });
      emitLog({
        stage: "relay_observer_agent_message_completed",
        message: `chars=${text.length}`,
        readyState,
      });
      return;
    }
    if (method === "turn/completed") {
      options.onTurnCompleted?.(message.params);
    }
  };

  const runnerWebSocketManager = options.runnerWebSocketManager;
  if (runnerWebSocketManager && useRunnerWsEnvelope) {
    const unsubscribers: Array<() => void> = [];
    let resumeSentGeneration = -1;

    const managerReadyState = () => runnerWebSocketManager.getSnapshot().readyState;

    finishClose = () => {
      if (closed) return;
      closed = true;
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch {}
      }
      for (const entry of pendingApprovalRequests.values()) {
        entry.active = false;
      }
      pendingApprovalRequests.clear();
    };

    const sendRelayResumeIfReady = (mode: "initial" | "resume") => {
      if (closeRequested || closed) return false;
      const snapshot = runnerWebSocketManager.getSnapshot();
      if (snapshot.connectionState !== "ready") {
        emitLog({
          stage: "relay_observer_resume_send_error",
          message: `manager_not_ready:${snapshot.connectionState}`,
          readyState: snapshot.readyState,
        });
        return false;
      }
      if (resumeSentGeneration === snapshot.generation) return true;
      try {
        emitLog({
          stage: mode === "initial" ? "relay_observer_open" : "relay_observer_reconnect_open",
          readyState: snapshot.readyState,
        });
        runnerWebSocketManager.send({
          channel: "relay",
          op: "resume",
          threadId,
          seq: lastRelaySeq,
        });
        resumeSentGeneration = snapshot.generation;
        return true;
      } catch (error) {
        emitLog({
          stage: "relay_observer_resume_send_error",
          message: toErrorMessage(error),
          readyState: snapshot.readyState,
        });
        return false;
      }
    };

    sendObserverJson = (payload: Record<string, unknown>) => {
      runnerWebSocketManager.send({
        channel: "llm",
        op: "rpc",
        threadId,
        payload,
      });
    };

    unsubscribers.push(runnerWebSocketManager.subscribe(
      { channel: "relay", threadId },
      (message) => {
        if (closeRequested || closed) return;
        if (typeof message.seq === "number") {
          lastRelaySeq = Math.max(lastRelaySeq, Math.max(0, Math.floor(message.seq)));
        }
        const control = readRunnerRelayControlMessage(message);
        if (!control) return;
        if (typeof control.seq === "number") {
          lastRelaySeq = Math.max(lastRelaySeq, control.seq);
        }
        if (typeof control.latestSeq === "number") {
          lastRelaySeq = Math.max(lastRelaySeq, control.latestSeq);
        }
        const readyState = managerReadyState();
        if (control.type === "runner_relay_attached") {
          emitLog({
            stage: "relay_observer_attached",
            message: `replayed=${control.replayed ?? 0} latestSeq=${control.latestSeq ?? lastRelaySeq}`,
            readyState,
          });
        } else if (control.type === "runner_relay_resume_miss") {
          emitLog({
            stage: "relay_observer_resume_miss",
            message: `threadId=${threadId} fromSeq=${lastRelaySeq}`,
            readyState,
          });
        } else if (control.type === "runner_relay_closed") {
          emitLog({
            stage: "relay_observer_relay_closed",
            message: control.reason || "relay_closed",
            readyState,
          });
        }
      }
    ));
    unsubscribers.push(runnerWebSocketManager.subscribe(
      { channel: "llm", op: "rpc", threadId },
      (message) => {
        if (closeRequested || closed) return;
        if (typeof message.seq === "number") {
          lastRelaySeq = Math.max(lastRelaySeq, Math.max(0, Math.floor(message.seq)));
        }
        const rpcMessage = parseJsonRpcPayloadFromRunnerWsMessage(message);
        if (!rpcMessage) {
          emitLog({
            stage: "relay_observer_runner_ws_error",
            message: "runner-ws llm:rpc payload is not a JSON-RPC object",
            readyState: managerReadyState(),
          });
          return;
        }
        handleJsonRpcMessage(rpcMessage, managerReadyState());
      }
    ));
    unsubscribers.push(runnerWebSocketManager.subscribe(
      { channel: "control", op: "error", threadId },
      (message) => {
        if (closeRequested || closed) return;
        const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
          ? message.payload as Record<string, unknown>
          : {};
        const code = String(payload.error || "runner_ws_error").trim();
        const detail = String(payload.message || payload.detail || "").trim();
        emitLog({
          stage: "relay_observer_runner_ws_error",
          message: detail ? `${code}: ${detail}` : code,
          readyState: managerReadyState(),
        });
      }
    ));
    unsubscribers.push(runnerWebSocketManager.subscribeSnapshot(() => {
      if (closeRequested || closed) return;
      const snapshot = runnerWebSocketManager.getSnapshot();
      if (snapshot.connectionState !== "ready") return;
      void sendRelayResumeIfReady(resumeSentGeneration < 0 ? "initial" : "resume");
    }));

    runnerWebSocketManager.connect()
      .then(() => {
        void sendRelayResumeIfReady(resumeSentGeneration < 0 ? "initial" : "resume");
      })
      .catch((error) => {
        emitLog({
          stage: "relay_observer_error",
          message: `manager_connect_failed:${toErrorMessage(error)}`,
          readyState: managerReadyState(),
        });
      });

    return {
      close: () => {
        if (closeRequested || closed) return;
        closeRequested = true;
        if (pendingApprovalRequests.size > 0) {
          emitLog({
            stage: "relay_observer_close_deferred",
            message: `pendingApprovals=${pendingApprovalRequests.size}`,
            readyState: managerReadyState(),
          });
          return;
        }
        finishClose();
      },
    };
  }

  const tryReconnectRelayObserver = (
    trigger: RelayObserverReconnectTrigger,
    detail: string,
    readyState: number
  ) => {
    if (closeRequested || closed) return false;
    if (reconnectTimer) {
      const confirmedDisconnect = (
        trigger === "relay_observer_error" ||
        trigger === "relay_observer_close" ||
        trigger === "relay_observer_resume_send_error" ||
        trigger === "relay_observer_runner_ws_error"
      );
      if (!confirmedDisconnect) {
        emitLog({
          stage: "relay_observer_reconnect_pending",
          message: `trigger=${trigger} threadId=${threadId} fromSeq=${lastRelaySeq} detail=${detail}`,
          readyState,
        });
        return true;
      }
      clearReconnectTimer();
      emitLog({
        stage: "relay_observer_reconnect_rescheduled",
        message: `trigger=${trigger} threadId=${threadId} fromSeq=${lastRelaySeq} detail=${detail}`,
        readyState,
      });
    }
    reconnectAttempts += 1;
    const attempt = reconnectAttempts;
    const nextResumeWsUrl = useRunnerWsEnvelope
      ? wsUrl
      : buildRunnerRelayResumeWsUrl(wsUrl, threadId, lastRelaySeq);
    const reconnectDelayMs = reserveRunnerWsReconnectDelay(nextResumeWsUrl, {
      minSpacingMs: Math.min(5000, 1000 * attempt),
      jitterMs: 500,
    });
    emitLog({
      stage: reconnectDelayMs > 0 ? "relay_observer_reconnect_scheduled" : "relay_observer_reconnect_start",
      message: `trigger=${trigger} attempt=${attempt} threadId=${threadId} fromSeq=${lastRelaySeq} delayMs=${reconnectDelayMs} detail=${detail}`,
      readyState,
    });

    const runReconnect = () => {
      reconnectTimer = null;
      if (closeRequested || closed) return;
      clearHeartbeatTimer();
      pendingPing = null;
      emitLog({
        stage: "relay_observer_reconnect_start",
        message: `trigger=${trigger} attempt=${attempt} threadId=${threadId} fromSeq=${lastRelaySeq} detail=${detail}`,
        readyState,
      });
      try {
        const previousSocket = ws;
        const nextSocket = createWebSocketWithOptionalAuth(nextResumeWsUrl, wsToken);
        ws = nextSocket;
        try {
          if (
            previousSocket !== nextSocket &&
            (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING)
          ) {
            previousSocket.close();
          }
        } catch {}
      } catch (error) {
        emitLog({
          stage: "relay_observer_reconnect_create_error",
          message: toErrorMessage(error),
          readyState,
        });
        if (!closeRequested && !closed) {
          void tryReconnectRelayObserver("relay_observer_close", "create_error", readyState);
        }
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

  const resumeWsUrl = useRunnerWsEnvelope
    ? wsUrl
    : buildRunnerRelayResumeWsUrl(wsUrl, threadId, resumeFromSeq);
  ws = createWebSocketWithOptionalAuth(resumeWsUrl, wsToken);

  finishClose = () => {
    if (closed) return;
    closed = true;
    clearReconnectTimer();
    clearHeartbeatTimer();
    pendingPing = null;
    for (const entry of pendingApprovalRequests.values()) {
      entry.active = false;
    }
    pendingApprovalRequests.clear();
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {}
  };

  sendObserverJson = (payload: Record<string, unknown>) => {
    ws.send(useRunnerWsEnvelope
      ? encodeRunnerWsLlmRpc(payload, threadId)
      : JSON.stringify(payload));
  };

  const sendHeartbeatPing = (socket: WebSocket) => {
    if (
      !useRunnerWsEnvelope ||
      closeRequested ||
      closed ||
      socket !== ws ||
      socket.readyState !== WebSocket.OPEN
    ) return;
    const now = Date.now();
    if (pendingPing) {
      missedPingCount += 1;
      emitLog({
        stage: "relay_observer_ping_missed",
        message: `requestId=${pendingPing.requestId} missed=${missedPingCount}`,
        readyState: socket.readyState,
      });
      if (missedPingCount >= RUNNER_RELAY_OBSERVER_MAX_MISSED_PINGS) {
        const detail = `missedPings=${missedPingCount} lastRequestId=${pendingPing.requestId}`;
        emitLog({
          stage: "relay_observer_stale",
          message: detail,
          readyState: socket.readyState,
        });
        void tryReconnectRelayObserver("relay_observer_stale", detail, socket.readyState);
        return;
      }
    }
    pingSeq += 1;
    const requestId = `relay-observer-ping-${now}-${pingSeq}`;
    pendingPing = { requestId, sentAtMs: now };
    try {
      socket.send(JSON.stringify({
        channel: "control",
        op: "ping",
        requestId,
      }));
    } catch (error) {
      const detail = toErrorMessage(error);
      emitLog({
        stage: "relay_observer_ping_send_error",
        message: detail,
        readyState: socket.readyState,
      });
      void tryReconnectRelayObserver("relay_observer_stale", detail, socket.readyState);
    }
  };

  const startHeartbeatTimer = (socket: WebSocket) => {
    clearHeartbeatTimer();
    pendingPing = null;
    missedPingCount = 0;
    if (!useRunnerWsEnvelope) return;
    sendHeartbeatPing(socket);
    heartbeatTimer = setInterval(() => sendHeartbeatPing(socket), RUNNER_RELAY_OBSERVER_PING_INTERVAL_MS);
  };

  const attachSocketHandlers = (socket: WebSocket, mode: "initial" | "resume") => {
    socket.onopen = () => {
      if (closeRequested || closed || socket !== ws) return;
      emitLog({
        stage: mode === "initial" ? "relay_observer_open" : "relay_observer_reconnect_open",
        readyState: socket.readyState,
      });
      if (useRunnerWsEnvelope) {
        try {
          socket.send(encodeRunnerWsRelayResume(threadId, lastRelaySeq));
        } catch (error) {
          const detail = toErrorMessage(error);
          emitLog({
            stage: "relay_observer_resume_send_error",
            message: detail,
            readyState: socket.readyState,
          });
          void tryReconnectRelayObserver("relay_observer_resume_send_error", detail, socket.readyState);
          return;
        }
      }
      startHeartbeatTimer(socket);
    };

    socket.onmessage = (event) => {
      if (closeRequested || closed || socket !== ws) return;
      const rawData = typeof event.data === "string" ? event.data : String(event.data || "");
      const envelope = useRunnerWsEnvelope ? parseRunnerWsEnvelope(rawData) : null;
      if (typeof envelope?.seq === "number") {
        lastRelaySeq = Math.max(lastRelaySeq, Math.max(0, Math.floor(envelope.seq)));
      }
      if (envelope?.channel === "llm" && envelope.op === "rpc") {
        reconnectAttempts = 0;
      }
      if (envelope?.channel === "control" && envelope.op === "pong") {
        const requestId = String(envelope.requestId || "");
        if (!pendingPing || requestId === pendingPing.requestId) {
          pendingPing = null;
          missedPingCount = 0;
        }
        return;
      }
      pendingPing = null;
      missedPingCount = 0;

      const control = parseRunnerRelayControlMessage(rawData);
      if (control) {
        if (typeof control.seq === "number") {
          lastRelaySeq = Math.max(lastRelaySeq, control.seq);
        }
        if (typeof control.latestSeq === "number") {
          lastRelaySeq = Math.max(lastRelaySeq, control.latestSeq);
        }
        if (control.type === "runner_relay_attached") {
          reconnectAttempts = 0;
          clearReconnectTimer();
          emitLog({
            stage: "relay_observer_attached",
            message: `replayed=${control.replayed ?? 0} latestSeq=${control.latestSeq ?? lastRelaySeq}`,
            readyState: socket.readyState,
          });
        } else if (control.type === "runner_relay_resume_miss") {
          emitLog({
            stage: "relay_observer_resume_miss",
            message: `threadId=${threadId} fromSeq=${lastRelaySeq}`,
            readyState: socket.readyState,
          });
        } else if (control.type === "runner_relay_closed") {
          const reason = control.reason || "relay_closed";
          emitLog({
            stage: "relay_observer_relay_closed",
            message: reason,
            readyState: socket.readyState,
          });
          void tryReconnectRelayObserver("relay_observer_relay_closed", reason, socket.readyState);
        }
        return;
      }

      const incoming = normalizeRunnerWsIncomingCodexRpc(rawData);
      if (incoming.type === "ignore") return;
      if (incoming.type === "error") {
        const detail = incoming.message;
        emitLog({
          stage: "relay_observer_runner_ws_error",
          message: detail,
          readyState: socket.readyState,
        });
        void tryReconnectRelayObserver("relay_observer_runner_ws_error", detail, socket.readyState);
        return;
      }

      const message = parseJsonRpcMessage(incoming.rawData);
      if (!message) return;
      handleJsonRpcMessage(message, socket.readyState);
    };

    socket.onerror = (event: any) => {
      if (closeRequested || closed || socket !== ws) return;
      const detail = String(event?.message || event?.type || "unknown");
      emitLog({
        stage: "relay_observer_error",
        message: detail,
        readyState: socket.readyState,
      });
      void tryReconnectRelayObserver("relay_observer_error", detail, socket.readyState);
    };

    socket.onclose = (event: any) => {
      if (closeRequested || closed || socket !== ws) return;
      clearHeartbeatTimer();
      pendingPing = null;
      const code = Number(event?.code);
      const reason = String(event?.reason || "").trim();
      const detail = `code=${Number.isFinite(code) ? code : "unknown"} reason=${reason || "-"} clean=${Boolean(event?.wasClean)}`;
      emitLog({
        stage: "relay_observer_close",
        message: detail,
        readyState: socket.readyState,
      });
      if (!tryReconnectRelayObserver("relay_observer_close", detail, socket.readyState)) {
        clearReconnectTimer();
      }
    };
  };

  attachSocketHandlers(ws, "initial");

  return {
    close: () => {
      if (closeRequested || closed) return;
      closeRequested = true;
      clearReconnectTimer();
      clearHeartbeatTimer();
      pendingPing = null;
      if (pendingApprovalRequests.size > 0) {
        emitLog({
          stage: "relay_observer_close_deferred",
          message: `pendingApprovals=${pendingApprovalRequests.size}`,
          readyState: ws.readyState,
        });
        return;
      }
      finishClose();
    },
  };
}
