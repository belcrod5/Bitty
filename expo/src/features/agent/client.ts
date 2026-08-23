import { isApprovalAction, type ApprovalRequest } from "../codex/approvalFlow";
import type {
  CodexAppServerTurnOptions,
  CodexAppServerRelayObserverOptions,
  CodexAppServerRelayObserverSession,
  CodexAppServerTurnResult,
  CodexAppServerTurnSession,
  CodexContextUsage,
} from "../codex/client/types";
import { normalizeContextUsageSnapshot } from "../codex/client/helpers";
import type { RunnerWebSocketManager } from "../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../runnerWs/types";
import {
  calendarDynamicToolsIncompatible,
  calendarToolResponse,
} from "../calendar/calendarToolHandler";

const PROTOCOL_VERSION = 2;
// sessions.listのprovider-neutralスコープ。session.list対応の全Backendを集約する。
export const ALL_BACKENDS_SCOPE = "all";
const EVENT_TYPES = new Set([
  "turn.accepted", "session.resolved", "turn.started", "item.started", "content.delta", "item.completed",
  "tool.started", "tool.completed", "action.requested", "action.resolved", "usage.updated",
  "turn.completed", "turn.interrupted", "turn.failed", "provider.event",
]);

export type BackendStatus = {
  backendId?: string;
  readiness?: { ready?: boolean; reason?: string };
  capabilities?: {
    action?: { policyProfiles?: Array<{ id?: string; interactive?: boolean }> };
    model?: {
      select?: boolean;
      effort?: boolean;
      effortOptions?: string[];
      catalog?: Array<{ modelId?: string; label?: string }>;
    };
    workspace?: { admission?: boolean };
    operations?: { compact?: boolean; schedule?: boolean };
  };
};

type AgentEvent = {
  protocolVersion?: number;
  type?: string;
  runId?: string;
  sessionRef?: { backendId?: string; nativeSessionId?: string };
  sequence?: number;
  payload?: Record<string, unknown>;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function operationId(traceId: string) {
  const normalized = String(traceId || "").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160);
  return `agent_turn_${normalized || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function interruptedError() {
  const error = new Error("Agent turn interrupted") as Error & { code?: string };
  error.name = "CodexAppServerTurnInterruptedError";
  error.code = "codex_app_server_turn_interrupted";
  return error;
}

export async function getAgentBackendStatuses(manager: RunnerWebSocketManager) {
  const response = await manager.request({ channel: "agent", op: "agent.hello" }, { timeoutMs: 10_000 });
  if (response.channel !== "agent" || response.op !== "agent.ready") return [];
  const payload = object(response.payload);
  if (Number(payload.protocolVersion) !== PROTOCOL_VERSION) return [];
  return Array.isArray(payload.backends) ? payload.backends as BackendStatus[] : [];
}

export async function getAgentBackendStatus(manager: RunnerWebSocketManager, backendId: string) {
  const backends = await getAgentBackendStatuses(manager);
  return backends.find((entry) => String(entry.backendId || "") === backendId) || null;
}

function approvalRequest(event: AgentEvent, threadId: string, turnId: string): ApprovalRequest {
  const payload = object(event.payload);
  const requestId = String(payload.requestId || "");
  return {
    requestId,
    source: "agent-backend",
    command: String(payload.title || payload.kind || "Approval required"),
    args: [],
    reason: String(payload.title || ""),
    approvalKey: requestId,
    message: String(payload.title || ""),
    threadId,
    turnId,
  };
}

function contextUsage(payload: Record<string, unknown>): CodexContextUsage | null {
  // raw経路と同じ正規化を通してusedPctまで計算する(自前実装で0固定にすると
  // 右上のcontext length表示が一切更新されない)。
  return normalizeContextUsageSnapshot(object(payload.usage || payload));
}

function agentItemAsCodexItem(payload: Record<string, unknown>) {
  const itemType = String(payload.itemType || "item");
  return {
    id: String(payload.itemId || ""),
    type: itemType === "assistant" ? "agentMessage" : itemType,
    ...(Array.isArray(payload.content) ? { content: payload.content } : {}),
  };
}

function agentEventAsCodexEvent(event: AgentEvent, payload: Record<string, unknown>) {
  if (event.type === "item.started" || event.type === "item.completed") {
    return {
      method: event.type.replace(".", "/"),
      params: { item: agentItemAsCodexItem(payload) },
    };
  }
  if (event.type === "tool.started") {
    return {
      method: "item/started",
      params: {
        item: {
          id: String(payload.toolCallId || ""),
          type: "commandExecution",
          command: String(payload.inputSummary || payload.name || "tool"),
          status: "inProgress",
        },
      },
    };
  }
  if (event.type === "tool.completed") {
    const exitCode = payload.exitCode === null || payload.exitCode === undefined
      ? null
      : Number(payload.exitCode);
    return {
      method: "item/completed",
      params: {
        item: {
          id: String(payload.toolCallId || ""),
          type: "commandExecution",
          command: String(payload.inputSummary || ""),
          status: String(payload.status || "completed"),
          exitCode: Number.isFinite(exitCode) ? exitCode : null,
        },
      },
    };
  }
  return {
    method: String(event.type || "").replace(".", "/"),
    params: payload,
  };
}

type AgentRunEventPumpOptions = {
  manager: RunnerWebSocketManager;
  threadId: string;
  actionConsumer: "all" | "approval";
  onApprovalRequest: CodexAppServerTurnOptions["onApprovalRequest"];
  onApprovalRequestResolved?: CodexAppServerTurnOptions["onApprovalRequestResolved"];
  onCalendarToolCall?: CodexAppServerTurnOptions["onCalendarToolCall"];
  onThreadIdResolved?: (threadId: string) => void;
  onEvent?: (event: AgentEvent, payload: Record<string, unknown>) => void;
  onDelta?: (delta: string, payload: Record<string, unknown>) => void;
  onAgentMessageCompleted?: (text: string, payload: Record<string, unknown>) => void;
  onSequence?: (runId: string, sequence: number) => void;
  onReplayTruncated?: (runId: string, replayFromSequence: number) => void;
  onTerminal: (type: string, payload: Record<string, unknown>) => void;
  onError: (error: Error) => void;
};

function createAgentRunEventPump(options: AgentRunEventPumpOptions) {
  const subscriptionId = `agent_subscription_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let runId = "";
  let threadId = options.threadId;
  let turnId = "";
  let reply = "";
  let usage: CodexContextUsage | null = null;
  let lastSequence = 0;
  let closed = false;
  let resuming = false;
  let generation = options.manager.getSnapshot().generation;
  let eventQueue = Promise.resolve();
  const bufferedEvents: AgentEvent[] = [];
  const handledActions = new Set<string>();
  const ignoredActionRequests = new Set<string>();
  const approvalActions = new Map<string, { request: ApprovalRequest; resolvedByServer: boolean }>();

  const fail = (error: unknown) => {
    if (closed) return;
    options.onError(error instanceof Error ? error : new Error("Agent event handling failed"));
  };
  const resolveApproval = (requestId: string) => {
    const state = approvalActions.get(requestId);
    if (!state || state.resolvedByServer) return;
    state.resolvedByServer = true;
    options.onApprovalRequestResolved?.(state.request);
  };
  const handleAction = async (payload: Record<string, unknown>) => {
    const requestId = String(payload.requestId || "").trim();
    if (!requestId || handledActions.has(requestId) || !runId || closed) return;
    handledActions.add(requestId);
    try {
      if (String(payload.kind || "") === "dynamic_tool") {
        if (options.actionConsumer !== "all") return;
        const claim = await options.manager.request({
          channel: "agent", op: "action.claim", operationId: subscriptionId, streamId: runId,
          payload: { runId, subscriptionId, requestId },
        });
        if (claim.op === "error") throw new Error(String(object(claim.payload).message || "Tool execution claim failed"));
        const input = object(payload.input);
        const rawRequest = { id: requestId, method: String(input.method || ""), params: object(input.params) };
        let result;
        try {
          result = options.onCalendarToolCall
            ? await options.onCalendarToolCall(rawRequest)
            : calendarDynamicToolsIncompatible("tool_response");
        } catch {
          result = calendarDynamicToolsIncompatible("tool_response");
        }
        const response = await options.manager.request({
          channel: "agent", op: "action.respond", operationId: subscriptionId, streamId: runId,
          payload: { runId, subscriptionId, requestId, decision: "result", result: calendarToolResponse(requestId, result).result },
        });
        if (response.op === "error") throw new Error(String(object(response.payload).message || "Tool response failed"));
        return;
      }
      const state = {
        request: approvalRequest({ payload }, threadId, turnId || runId),
        resolvedByServer: false,
      };
      approvalActions.set(requestId, state);
      void (async () => {
        try {
          const action = await options.onApprovalRequest(state.request);
          if (state.resolvedByServer || closed) return;
          if (!isApprovalAction(action)) throw new Error("Invalid approval action");
          const advertisedDecisions = Array.isArray(payload.decisions) ? payload.decisions : [];
          let decision = "deny";
          if (action === "approve_once" || action === "approve_for_session") {
            decision = action === "approve_for_session" && advertisedDecisions.includes("allow_for_session")
              ? "allow_for_session"
              : "allow";
          }
          const response = await options.manager.request({
            channel: "agent", op: "action.respond", operationId: subscriptionId, streamId: runId,
            payload: { runId, subscriptionId, requestId, decision },
          });
          if (response.op === "error") {
            const responsePayload = object(response.payload);
            if (responsePayload.code === "action_expired") {
              resolveApproval(requestId);
              return;
            }
            throw new Error(String(responsePayload.message || "Approval response failed"));
          }
          resolveApproval(requestId);
        } catch (error) {
          if (!state.resolvedByServer && !closed) {
            handledActions.delete(requestId);
            fail(error);
          }
        } finally {
          if (approvalActions.get(requestId) === state) approvalActions.delete(requestId);
        }
      })();
    } catch (error) {
      handledActions.delete(requestId);
      throw error;
    }
  };
  const applyEvent = async (event: AgentEvent) => {
    if (closed || !runId || event.runId !== runId) return;
    if (event.protocolVersion !== PROTOCOL_VERSION || !EVENT_TYPES.has(String(event.type || ""))) {
      throw new Error("Agent protocol version or event type is unsupported");
    }
    const sequence = Number(event.sequence || 0);
    if (!Number.isInteger(sequence) || sequence <= 0) throw new Error("Agent event sequence is invalid");
    if (sequence <= lastSequence) throw new Error("Agent event sequence is not increasing");
    lastSequence = sequence;
    options.onSequence?.(runId, sequence);
    const payload = object(event.payload);
    if (event.type === "action.requested" && ignoredActionRequests.delete(String(payload.requestId || ""))) return;
    options.onEvent?.(event, payload);
    if (event.type === "session.resolved") {
      threadId = String(event.sessionRef?.nativeSessionId || object(payload.sessionRef).nativeSessionId || threadId);
      if (threadId) options.onThreadIdResolved?.(threadId);
    } else if (event.type === "turn.started") {
      turnId = String(payload.nativeTurnId || runId);
    } else if (event.type === "content.delta") {
      const delta = String(payload.delta || "");
      if (delta) {
        reply += delta;
        options.onDelta?.(delta, payload);
      }
    } else if (event.type === "item.completed") {
      const content = Array.isArray(payload.content) ? payload.content : [];
      const finalText = content
        .filter((block) => object(block).type === "text")
        .map((block) => String(object(block).text || ""))
        .join("");
      if (finalText) {
        if (!reply) options.onDelta?.(finalText, payload);
        reply = finalText;
        options.onAgentMessageCompleted?.(finalText, payload);
      }
    } else if (event.type === "usage.updated") {
      usage = contextUsage(payload) || usage;
    } else if (event.type === "action.requested") {
      await handleAction(payload);
    } else if (event.type === "action.resolved") {
      resolveApproval(String(payload.requestId || ""));
    } else if (event.type === "turn.completed" || event.type === "turn.interrupted" || event.type === "turn.failed") {
      options.onTerminal(event.type, payload);
    }
  };
  const enqueue = (event: AgentEvent) => {
    eventQueue = eventQueue.then(() => applyEvent(event)).catch(fail);
  };
  const unsubscribe = options.manager.subscribe({ channel: "agent", op: "event", operationId: subscriptionId }, (message) => {
    if (message.operationId && message.operationId !== subscriptionId) return;
    const event = object(message.payload) as AgentEvent;
    if (!runId || resuming) {
      bufferedEvents.push(event);
      return;
    }
    if (event.runId === runId) enqueue(event);
  });

  async function applyResumeResponse(response: RunnerWsMessage) {
    const payload = object(response.payload);
    if (response.op === "error") throw new Error(String(payload.message || "Agent event resume failed"));
    const resumedRunId = String(response.streamId || payload.runId || runId).trim();
    const replayTruncated = payload.replayTruncated === true;
    if (replayTruncated && !options.onReplayTruncated) {
      if (resumedRunId) runId = resumedRunId;
      throw new Error("Agent event replay is no longer available");
    }
    const activeActions = Array.isArray(payload.activeActions) ? payload.activeActions : [];
    const activeActionIds = new Set(activeActions.map((action) => String(object(action).requestId || "")));
    if (resumedRunId) attach(resumedRunId, payload.runChanged === true || replayTruncated, activeActionIds);
    if (replayTruncated) {
      options.onReplayTruncated?.(runId, Math.max(1, Math.floor(Number(payload.replayFromSequence) || 1)));
    }
    for (const action of activeActions) {
      await handleAction(object(action));
    }
    return payload;
  }

  const unsubscribeSnapshot = options.manager.subscribeSnapshot(() => {
    const snapshot = options.manager.getSnapshot();
    if (closed || !runId || snapshot.connectionState !== "ready" || snapshot.generation === generation) return;
    generation = snapshot.generation;
    resuming = true;
    void options.manager.request({
      channel: "agent", op: "events.resume", operationId: subscriptionId, streamId: runId, seq: lastSequence,
      payload: { runId, subscriptionId, actionConsumer: options.actionConsumer, afterSequence: lastSequence },
    }).then(applyResumeResponse).catch(fail);
  });

  function attach(nextRunId: string, resetSequence = false, activeActionIds?: Set<string>) {
    const normalized = String(nextRunId || "").trim();
    if (!normalized) throw new Error("Agent event resume did not return runId");
    if (resetSequence || (runId && runId !== normalized)) lastSequence = 0;
    runId = normalized;
    for (const event of bufferedEvents.splice(0)) {
      if (event.runId !== runId) continue;
      if (
        activeActionIds && event.type === "action.requested" &&
        !activeActionIds.has(String(object(event.payload).requestId || ""))
      ) ignoredActionRequests.add(String(object(event.payload).requestId || ""));
      enqueue(event);
    }
    resuming = false;
  }

  async function detach(targetRunId = runId) {
    await options.manager.request({
      channel: "agent",
      op: "events.detach",
      operationId: subscriptionId,
      ...(targetRunId ? { streamId: targetRunId } : {}),
      payload: { ...(targetRunId ? { runId: targetRunId } : {}), subscriptionId },
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const [requestId, state] of approvalActions) {
      if (state.resolvedByServer) continue;
      try {
        resolveApproval(requestId);
      } catch {}
    }
    approvalActions.clear();
    unsubscribe();
    unsubscribeSnapshot();
    void detach().catch(() => {});
    handledActions.clear();
    ignoredActionRequests.clear();
  }

  return {
    attach,
    applyResumeResponse,
    close,
    interrupt: async () => {
      if (!runId) return;
      const response = await options.manager.request({ channel: "agent", op: "turn.interrupt", streamId: runId, payload: { runId } });
      if (response.op === "error") throw new Error(String(object(response.payload).message || "Agent interrupt failed"));
    },
    snapshot: () => ({ subscriptionId, runId, threadId, turnId, reply, usage, lastSequence, closed }),
  };
}

export function startAgentTurnWithRawFallback(
  options: CodexAppServerTurnOptions,
  startRaw: () => CodexAppServerTurnSession,
): CodexAppServerTurnSession {
  const manager = options.runnerWebSocketManager;
  const backendId = String(options.backendId || "codex").trim() || "codex";
  let activeInterrupt: (() => Promise<void>) | null = null;
  let interrupted = false;

  const promise = (async (): Promise<CodexAppServerTurnResult> => {
    if (!manager || (!options.preferNeutralAgent && !options.backendId)) {
      const raw = startRaw();
      activeInterrupt = raw.interrupt;
      if (interrupted) await raw.interrupt();
      return await raw.promise;
    }
    let status: BackendStatus | null = null;
    try {
      status = await getAgentBackendStatus(manager, backendId);
    } catch {
      status = null;
    }
    if (!status?.readiness?.ready) {
      if (!options.rawFallbackBackendId || backendId !== options.rawFallbackBackendId) {
        throw new Error(status?.readiness?.reason || "Selected Agent Backend is unavailable");
      }
      const raw = startRaw();
      activeInterrupt = raw.interrupt;
      if (interrupted) await raw.interrupt();
      return await raw.promise;
    }

    if (status.capabilities?.workspace?.admission === true) {
      const cwd = String(options.cwd || "").trim();
      const listed = await manager.request({ channel: "agent", op: "workspaces.list" }, { timeoutMs: 10_000 });
      if (listed.op === "error") throw new Error(String(object(listed.payload).message || "Workspace list failed"));
      const roots = Array.isArray(object(listed.payload).workspaces)
        ? object(listed.payload).workspaces as Array<Record<string, unknown>>
        : [];
      const allowed = roots.some((entry) => {
        const root = String(entry.canonicalRoot || "");
        return root && (cwd === root || cwd.startsWith(`${root}/`));
      });
      if (!allowed) {
        const prepared = await manager.request({
          channel: "agent",
          op: "workspace.prepare",
          payload: { path: cwd },
        }, { timeoutMs: 10_000 });
        if (prepared.op === "error") throw new Error(String(object(prepared.payload).message || "Workspace preparation failed"));
        const request = object(prepared.payload);
        const approved = await options.confirmWorkspaceAdmission?.({
          canonicalRoot: String(request.canonicalRoot || cwd),
          warning: String(request.warning || "This Agent Backend can access this workspace."),
        });
        if (!approved) throw new Error("Workspace access was not approved");
        const confirmed = await manager.request({
          channel: "agent",
          op: "workspace.confirm",
          payload: { requestId: String(request.requestId || "") },
        }, { timeoutMs: 10_000 });
        if (confirmed.op === "error") throw new Error(String(object(confirmed.payload).message || "Workspace confirmation failed"));
      }
    }

    const clientOperationId = operationId(String(options.traceId || ""));
    const requestedSessionId = String(options.threadId || "").trim();
    if (requestedSessionId) {
      const handoff = await manager.request({
        channel: "agent",
        op: "session.handoff",
        payload: {
          sessionRef: { backendId, nativeSessionId: requestedSessionId },
          targetMode: "neutral",
          ...(options.cwd ? { cwd: options.cwd } : {}),
        },
      }, { timeoutMs: 30_000 });
      if (handoff.op === "error") throw new Error(String(object(handoff.payload).message || "Session handoff failed"));
    }

    let settled = false;
    let pump: ReturnType<typeof createAgentRunEventPump> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let resolveTurn!: (result: CodexAppServerTurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completion = new Promise<CodexAppServerTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const finish = (
      error?: Error,
      finishOptions?: { interruptRun?: boolean },
      resultOverride?: CodexAppServerTurnResult,
    ) => {
      if (settled) return;
      settled = true;
      const snapshot = pump?.snapshot();
      pump?.close();
      if (timeout) clearTimeout(timeout);
      // クライアント都合の打ち切り(action処理失敗・イベント処理失敗・タイムアウト)では
      // サーバー側runを孤児にせずbest-effortでinterruptする。サーバー起点の終了
      // (turn.completed/interrupted/failed)ではrunは既に終わっているため送らない。
      if (error && finishOptions?.interruptRun) void pump?.interrupt().catch(() => {});
      if (error) rejectTurn(error);
      else resolveTurn(resultOverride || {
        threadId: snapshot?.threadId || requestedSessionId,
        turnId: snapshot?.turnId || "",
        reply: snapshot?.reply || "",
        contextUsage: snapshot?.usage || null,
      });
    };
    pump = createAgentRunEventPump({
      manager,
      threadId: requestedSessionId,
      actionConsumer: "all",
      onApprovalRequest: options.onApprovalRequest,
      onApprovalRequestResolved: options.onApprovalRequestResolved,
      onCalendarToolCall: options.onCalendarToolCall,
      onThreadIdResolved: options.onThreadIdResolved,
      onEvent: (event, payload) => {
        const compatible = agentEventAsCodexEvent(event, payload);
        options.onEvent?.(compatible.method, compatible.params);
      },
      onDelta: options.onDelta,
      onAgentMessageCompleted: options.onAgentMessageCompleted,
      onTerminal: (type, payload) => {
        if (type === "turn.completed") finish();
        else if (type === "turn.interrupted") finish(interruptedError());
        else finish(new Error(String(object(payload.error).message || "Agent turn failed")));
      },
      onError: (error) => finish(error, { interruptRun: true }),
    });
    timeout = setTimeout(() => finish(new Error("Agent turn timed out"), { interruptRun: true }), options.timeoutMs || 24 * 60 * 60 * 1000);
    const policyProfiles = status.capabilities?.action?.policyProfiles || [];
    const wantsInteractive = options.approvalPolicy !== "never";
    const policyProfileId = policyProfiles.find((profile) => profile.interactive === wantsInteractive)?.id
      || policyProfiles[0]?.id;
    const capabilities = status.capabilities || {};
    let accepted: RunnerWsMessage;
    try {
      accepted = await manager.request({
        channel: "agent",
        op: "turn.start",
        operationId: clientOperationId,
        payload: {
          backendId,
          ...(requestedSessionId ? { sessionRef: { backendId, nativeSessionId: requestedSessionId } } : { cwd: options.cwd }),
          input: { blocks: [{ type: "text", text: options.inputText }] },
          ...(capabilities.model?.select && options.model ? { model: options.model } : {}),
          ...(capabilities.model?.effort && options.effort ? { effort: options.effort } : {}),
          ...(policyProfileId ? { policyProfileId } : {}),
          clientOperationId,
          subscriptionId: pump.snapshot().subscriptionId,
          actionConsumer: "all",
        },
      }, { timeoutMs: 30_000 });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Agent turn start failed"));
      return await completion;
    }
    if (accepted.op === "error") {
      finish(new Error(String(object(accepted.payload).message || "Agent turn was rejected")));
      return await completion;
    }
    const acceptedRunId = String(accepted.streamId || object(accepted.payload).runId || "");
    if (!acceptedRunId) {
      finish(new Error("Agent turn did not return runId"));
      return await completion;
    }
    options.onTurnAccepted?.({
      runId: acceptedRunId,
      queued: object(accepted.payload).queued === true,
    });
    if (accepted.op === "turn.result") {
      const result = object(accepted.payload);
      const resultSession = object(result.sessionRef);
      const threadId = String(resultSession.nativeSessionId || requestedSessionId);
      if (threadId) options.onThreadIdResolved?.(threadId);
      if (result.outcome === "completed") {
        let reply = "";
        try {
          const history = await readAgentHistory(manager, { backendId, nativeSessionId: threadId, limit: 20 });
          const items = Array.isArray(history?.items) ? history.items : [];
          const latest = [...items].reverse().find((item) => object(item).role === "assistant");
          const content = Array.isArray(object(latest).content) ? object(latest).content as unknown[] : [];
          reply = content.filter((block) => object(block).type === "text").map((block) => String(object(block).text || "")).join("");
          if (reply) {
            options.onDelta?.(reply, { recoveredFromHistory: true });
            options.onAgentMessageCompleted?.(reply, { recoveredFromHistory: true });
          }
        } catch {}
        finish(undefined, undefined, { threadId, turnId: "", reply, contextUsage: null });
      }
      else if (result.outcome === "interrupted") finish(interruptedError());
      else finish(new Error(String(object(result.error).message || "Agent turn failed")));
      return await completion;
    }
    try {
      await pump.applyResumeResponse(accepted);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Agent event attach failed"), { interruptRun: true });
      return await completion;
    }
    activeInterrupt = async () => {
      interrupted = true;
      await pump?.interrupt();
    };
    if (interrupted) await activeInterrupt();
    return await completion;
  })();

  return {
    promise,
    interrupt: async () => {
      interrupted = true;
      await activeInterrupt?.();
    },
  };
}

export function startAgentSessionObserverWithRawFallback(
  options: CodexAppServerRelayObserverOptions,
  startRaw: () => CodexAppServerRelayObserverSession,
): CodexAppServerRelayObserverSession {
  const manager = options.runnerWebSocketManager;
  const backendId = String(options.backendId || "codex").trim() || "codex";
  const threadId = String(options.threadId || "").trim();
  if (!threadId) throw new Error("threadId is empty");
  if (typeof options.onApprovalRequest !== "function") throw new Error("onApprovalRequest is required");

  let closed = false;
  let interruptRequested = false;
  let raw: CodexAppServerRelayObserverSession | null = null;
  let pump: ReturnType<typeof createAgentRunEventPump> | null = null;

  const emitLog = (stage: string, message?: string) => {
    try { options.onLog?.({ stage, ...(message ? { message } : {}) }); } catch {}
  };
  function close() {
    if (closed) return;
    closed = true;
    pump?.close();
    raw?.close();
  }

  const failObserver = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    emitLog("relay_observer_resume_miss", normalized.message);
    close();
  };

  void (async () => {
    if (!manager || options.preferNeutralAgent !== true) {
      raw = startRaw();
      if (closed) raw.close();
      else if (interruptRequested) await raw.interrupt?.();
      return;
    }
    let status: BackendStatus | null = null;
    try { status = await getAgentBackendStatus(manager, backendId); } catch {}
    if (!status?.readiness?.ready) {
      if (options.rawFallbackBackendId === backendId) {
        raw = startRaw();
        if (closed) raw.close();
        else if (interruptRequested) await raw.interrupt?.();
      } else {
        emitLog("relay_observer_resume_miss", status?.readiness?.reason || "Selected Agent Backend is unavailable");
        close();
      }
      return;
    }
    if (closed) return;
    emitLog("relay_observer_open");
    pump = createAgentRunEventPump({
      manager,
      threadId,
      actionConsumer: "approval",
      onApprovalRequest: options.onApprovalRequest,
      onApprovalRequestResolved: options.onApprovalRequestResolved,
      onEvent: (event, payload) => {
        const compatible = agentEventAsCodexEvent(event, payload);
        options.onEvent?.(compatible.method, compatible.params);
        if (event.type === "action.requested") emitLog("relay_observer_approval_required");
      },
      onDelta: (delta, payload) => options.onDelta?.(delta, { itemId: String(payload.itemId || "") }),
      onAgentMessageCompleted: (text, payload) => options.onAgentMessageCompleted?.(text, { item: agentItemAsCodexItem(payload) }),
      onSequence: (activeRunId, sequence) => options.onRelaySeqAdvance?.({ threadId, relayId: activeRunId, seq: sequence }),
      onReplayTruncated: (activeRunId, replayFromSequence) => {
        emitLog("relay_observer_replay_truncated", "Agent event replay starts after the retained history boundary");
        options.onRelayReset?.({ threadId, relayId: activeRunId, seq: replayFromSequence - 1 });
      },
      onTerminal: (type, payload) => {
        options.onTurnCompleted?.({ ...payload, outcome: type.slice("turn.".length) });
        close();
      },
      onError: failObserver,
    });
    const expectedRunId = String(options.resumeFromRelayId || "").trim();
    const afterSequence = expectedRunId
      ? Math.max(0, Math.floor(Number(options.resumeFromSeq) || 0))
      : 0;
    const response = await manager.request({
      channel: "agent",
      op: "events.resume",
      operationId: pump.snapshot().subscriptionId,
      seq: afterSequence,
      payload: {
        sessionRef: { backendId, nativeSessionId: threadId },
        subscriptionId: pump.snapshot().subscriptionId,
        actionConsumer: "approval",
        expectedRunId,
        afterSequence,
      },
    }, { timeoutMs: 30_000 });
    if (closed) return;
    const payload = object(response.payload);
    if (payload.active === false) {
      emitLog("relay_observer_attached");
      options.onTurnCompleted?.({ noActiveRun: true });
      close();
      return;
    }
    if (payload.runChanged === true) {
      options.onRelayReset?.({
        threadId,
        relayId: String(response.streamId || payload.runId || ""),
        seq: 0,
      });
    }
    await pump.applyResumeResponse(response);
    if (interruptRequested) await pump.interrupt();
    emitLog("relay_observer_attached");
  })().catch(failObserver);

  return {
    close,
    interrupt: async () => {
      interruptRequested = true;
      if (raw?.interrupt) return await raw.interrupt();
      await pump?.interrupt();
    },
  };
}

export async function listAgentSessions(manager: RunnerWebSocketManager, options: {
  backendId: string;
  cwd: string;
  cursor?: string;
  limit?: number;
  includeSubagents?: boolean;
}) {
  const backendId = String(options.backendId || "").trim();
  if (backendId && backendId !== ALL_BACKENDS_SCOPE) {
    const status = await getAgentBackendStatus(manager, backendId);
    if (!status?.readiness?.ready) return null;
  } else {
    // all-backendsスコープはBackendごとのreadinessをserviceが個別に扱う。
    // agent channel自体が使えない場合のみnull(raw fallback)へ落とす。
    const statuses = await getAgentBackendStatuses(manager);
    if (statuses.length === 0) return null;
  }
  const response = await manager.request({
    channel: "agent",
    op: "sessions.list",
    payload: { ...options, backendId },
  }, { timeoutMs: 30_000 });
  if (response.op === "error") throw new Error(String(object(response.payload).message || "Session list failed"));
  return object(response.payload);
}

export async function readAgentHistory(manager: RunnerWebSocketManager, options: {
  backendId: string;
  nativeSessionId: string;
  cursor?: string;
  sinceCursor?: string;
  limit?: number;
}) {
  const status = await getAgentBackendStatus(manager, options.backendId);
  if (!status?.readiness?.ready) return null;
  const response = await manager.request({
    channel: "agent",
    op: "history.read",
    payload: {
      sessionRef: { backendId: options.backendId, nativeSessionId: options.nativeSessionId },
      cursor: options.cursor,
      sinceCursor: options.sinceCursor,
      limit: options.limit,
    },
  }, { timeoutMs: 30_000 });
  if (response.op === "error") throw new Error(String(object(response.payload).message || "Session history failed"));
  return object(response.payload);
}
