import { isApprovalAction, type ApprovalRequest } from "../codex/approvalFlow";
import type {
  CodexAppServerTurnOptions,
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

const PROTOCOL_VERSION = 1;
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

    let runId = "";
    let threadId = requestedSessionId;
    let turnId = "";
    let reply = "";
    let usage: CodexContextUsage | null = null;
    let lastSequence = 0;
    const eventsBeforeAcceptance: AgentEvent[] = [];
    const handledActions = new Set<string>();
    const approvalActions = new Map<string, { request: ApprovalRequest; resolvedByServer: boolean }>();
    let eventQueue = Promise.resolve();
    let settled = false;
    let resolveTurn!: (result: CodexAppServerTurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completion = new Promise<CodexAppServerTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const finish = (error?: Error, finishOptions?: { interruptRun?: boolean }) => {
      if (settled) return;
      settled = true;
      for (const state of approvalActions.values()) {
        if (!state.resolvedByServer) {
          state.resolvedByServer = true;
          try {
            options.onApprovalRequestResolved?.(state.request);
          } catch {}
        }
      }
      approvalActions.clear();
      unsubscribe();
      unsubscribeSnapshot();
      clearTimeout(timeout);
      // クライアント都合の打ち切り(action処理失敗・イベント処理失敗・タイムアウト)では
      // サーバー側runを孤児にせずbest-effortでinterruptする。サーバー起点の終了
      // (turn.completed/interrupted/failed)ではrunは既に終わっているため送らない。
      if (error && finishOptions?.interruptRun && runId) {
        void manager.request({ channel: "agent", op: "turn.interrupt", streamId: runId, payload: { runId } })
          .catch(() => {});
      }
      if (error) rejectTurn(error);
      else resolveTurn({ threadId, turnId, reply, contextUsage: usage });
    };
    const handleAction = async (payload: Record<string, unknown>) => {
      const requestId = String(payload.requestId || "");
      if (!requestId || handledActions.has(requestId)) return;
      handledActions.add(requestId);
      if (String(payload.kind || "") === "dynamic_tool") {
        try {
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
          const response = await manager.request({
            channel: "agent", op: "action.respond", streamId: runId,
            payload: {
              runId, requestId, decision: "result",
              result: calendarToolResponse(requestId, result).result,
            },
          });
          if (response.op === "error") throw new Error(String(object(response.payload).message || "Tool response failed"));
        } catch (error) {
          handledActions.delete(requestId);
          throw error;
        }
        return;
      }
      const state = {
        request: approvalRequest({ payload }, threadId, turnId),
        resolvedByServer: false,
      };
      approvalActions.set(requestId, state);
      void (async () => {
        try {
          const action = await options.onApprovalRequest(state.request);
          if (state.resolvedByServer) return;
          if (!isApprovalAction(action)) throw new Error("Invalid approval action");
          const response = await manager.request({
            channel: "agent", op: "action.respond", streamId: runId,
            payload: {
              runId, requestId,
              decision: action === "approve_once" || action === "approve_for_session" ? "allow" : "deny",
            },
          });
          if (response.op === "error") {
            const responsePayload = object(response.payload);
            if (responsePayload.code === "action_expired") {
              if (!state.resolvedByServer) {
                state.resolvedByServer = true;
                options.onApprovalRequestResolved?.(state.request);
              }
              return;
            }
            throw new Error(String(responsePayload.message || "Approval response failed"));
          }
          if (!state.resolvedByServer) options.onApprovalRequestResolved?.(state.request);
        } catch (error) {
          if (!state.resolvedByServer) {
            handledActions.delete(requestId);
            finish(error instanceof Error ? error : new Error("Approval handling failed"), { interruptRun: true });
          }
        } finally {
          if (approvalActions.get(requestId) === state) approvalActions.delete(requestId);
        }
      })();
    };
    const applyEvent = async (event: AgentEvent) => {
      if (!runId || event.runId !== runId || settled) return;
      if (event.protocolVersion !== PROTOCOL_VERSION || !EVENT_TYPES.has(String(event.type || ""))) {
        throw new Error("Agent protocol version or event type is unsupported");
      }
      const sequence = Number(event.sequence || 0);
      if (!Number.isInteger(sequence) || sequence <= 0) throw new Error("Agent event sequence is invalid");
      if (sequence <= lastSequence) return;
      if (lastSequence > 0 && sequence !== lastSequence + 1) throw new Error("Agent event replay gap");
      lastSequence = sequence;
      const payload = object(event.payload);
      options.onEvent?.(String(event.type || ""), payload);
      if (event.type === "session.resolved") {
        threadId = String(event.sessionRef?.nativeSessionId || object(payload.sessionRef).nativeSessionId || "");
        if (threadId) options.onThreadIdResolved?.(threadId);
        return;
      }
      if (event.type === "turn.started") {
        turnId = String(payload.nativeTurnId || runId);
        return;
      }
      if (event.type === "content.delta") {
        const delta = String(payload.delta || "");
        if (delta) {
          reply += delta;
          options.onDelta?.(delta, payload);
        }
        return;
      }
      if (event.type === "item.completed") {
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
        return;
      }
      if (event.type === "usage.updated") {
        usage = contextUsage(payload) || usage;
        return;
      }
      if (event.type === "action.requested") {
        await handleAction(payload);
        return;
      }
      if (event.type === "action.resolved") {
        const requestId = String(payload.requestId || "");
        const state = approvalActions.get(requestId);
        if (state && !state.resolvedByServer) {
          state.resolvedByServer = true;
          options.onApprovalRequestResolved?.(state.request);
        }
        return;
      }
      if (event.type === "turn.completed") finish();
      else if (event.type === "turn.interrupted") finish(interruptedError());
      else if (event.type === "turn.failed") {
        finish(new Error(String(object(payload.error).message || "Agent turn failed")));
      }
    };
    const unsubscribe = manager.subscribe({ channel: "agent", op: "event" }, (message) => {
      const event = object(message.payload) as AgentEvent;
      if (!runId) {
        eventsBeforeAcceptance.push(event);
        return;
      }
      eventQueue = eventQueue.then(() => applyEvent(event)).catch((error) => {
        finish(error instanceof Error ? error : new Error("Agent event handling failed"), { interruptRun: true });
      });
    });
    let generation = manager.getSnapshot().generation;
    const unsubscribeSnapshot = manager.subscribeSnapshot(() => {
      const snapshot = manager.getSnapshot();
      if (!runId || settled || snapshot.connectionState !== "ready" || snapshot.generation === generation) return;
      generation = snapshot.generation;
      void manager.request({
        channel: "agent",
        op: "events.resume",
        streamId: runId,
        seq: lastSequence,
        payload: { runId, afterSequence: lastSequence },
      }).then(async (response) => {
        const payload = object(response.payload);
        if (response.op === "error") throw new Error(String(payload.message || "Agent event resume failed"));
        if (payload.resumeMiss === true) throw new Error("Agent event replay is no longer available");
        for (const action of Array.isArray(payload.activeActions) ? payload.activeActions : []) {
          await handleAction(object(action));
        }
      }).catch((error) => finish(error instanceof Error ? error : new Error("Agent event resume failed"), { interruptRun: true }));
    });
    const timeout = setTimeout(() => finish(new Error("Agent turn timed out"), { interruptRun: true }), options.timeoutMs || 24 * 60 * 60 * 1000);
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
    runId = String(accepted.streamId || object(accepted.payload).runId || "");
    if (!runId) {
      finish(new Error("Agent turn did not return runId"));
      return await completion;
    }
    options.onTurnAccepted?.({
      runId,
      queued: object(accepted.payload).queued === true,
    });
    if (accepted.op === "turn.result") {
      const result = object(accepted.payload);
      const resultSession = object(result.sessionRef);
      threadId = String(resultSession.nativeSessionId || threadId);
      if (threadId) options.onThreadIdResolved?.(threadId);
      if (result.outcome === "completed") {
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
        finish();
      }
      else if (result.outcome === "interrupted") finish(interruptedError());
      else finish(new Error(String(object(result.error).message || "Agent turn failed")));
      return await completion;
    }
    for (const event of eventsBeforeAcceptance.splice(0)) {
      eventQueue = eventQueue.then(() => applyEvent(event)).catch((error) => {
        finish(error instanceof Error ? error : new Error("Agent event handling failed"), { interruptRun: true });
      });
    }
    activeInterrupt = async () => {
      interrupted = true;
      const response = await manager.request({ channel: "agent", op: "turn.interrupt", streamId: runId, payload: { runId } });
      if (response.op === "error") throw new Error(String(object(response.payload).message || "Agent interrupt failed"));
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
