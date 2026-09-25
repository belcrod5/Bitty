import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import type { RunnerWsMessage } from "../../runnerWs/types";
import type { VoiceContextStats } from "../types/appTypes";
import type { ApprovalAction, ApprovalRequest } from "../../codex/approvalFlow";
import { normalizeAppServerApprovalRequest, toCodexApprovalDecision } from "../../codex/client/helpers";

type TurnStatus = "idle" | "sending" | "accepted" | "running" | "completed" | "failed";
type PendingTurn = {
  id: string;
  text?: string;
  onAccepted?: () => void;
  resolve?: () => void;
  reject?: (error: Error) => void;
  readAloud: boolean;
  accepted: boolean;
};

function payloadOf(message: RunnerWsMessage): Record<string, unknown> {
  return message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
    ? message.payload as Record<string, unknown>
    : {};
}

function failureMessage(payload: Record<string, unknown>) {
  if (payload.status === "unknown") return "前の返答を確認できません。";
  return String(payload.message || payload.code || "音声会話に失敗しました。");
}

function contextStatsOf(payload: Record<string, unknown>): VoiceContextStats | null {
  const estimate = payload.estimatedContextUsagePercent;
  const unsummarized = payload.unsummarizedMessageCount;
  const characters = payload.memoryCharacterCount;
  if (estimate !== null && (typeof estimate !== "number" || !Number.isInteger(estimate)
    || estimate < 0 || estimate > 100)) return null;
  if (typeof unsummarized !== "number" || !Number.isSafeInteger(unsummarized) || unsummarized < 0
    || typeof characters !== "number" || !Number.isSafeInteger(characters) || characters < 0) return null;
  return {
    estimatedContextUsagePercent: estimate,
    unsummarizedMessageCount: unsummarized,
    memoryCharacterCount: characters,
  };
}

function sameContextStats(a: VoiceContextStats | null, b: VoiceContextStats | null) {
  return a === b || (!!a && !!b
    && a.estimatedContextUsagePercent === b.estimatedContextUsagePercent
    && a.unsummarizedMessageCount === b.unsummarizedMessageCount
    && a.memoryCharacterCount === b.memoryCharacterCount);
}

export function useVoiceConversation(
  onCompleted: (text: string, operationId: string) => void,
  onApprovalRequest?: (request: ApprovalRequest) => Promise<ApprovalAction>,
  onApprovalResolved?: (request: ApprovalRequest) => void,
) {
  const manager = useRunnerWebSocketManager();
  const { connected, generation } = useRunnerWebSocketSnapshot();
  const [logicalConversationId, setLogicalConversationId] = useState("");
  const [turnStatus, setTurnStatus] = useState<TurnStatus>("idle");
  const [reply, setReply] = useState<{ text: string; operationId: string } | null>(null);
  const [error, setError] = useState("");
  const [contextStats, setContextStats] = useState<VoiceContextStats | null>(null);
  const pendingRef = useRef<PendingTurn | null>(null);
  const turnRevisionRef = useRef(0);
  const conversationIdRef = useRef("");
  const onCompletedRef = useRef(onCompleted);
  const onApprovalRequestRef = useRef(onApprovalRequest);
  const onApprovalResolvedRef = useRef(onApprovalResolved);
  const approvalsRef = useRef(new Map<string, { request: ApprovalRequest; operationId: string }>());
  const aliveRef = useRef(true);
  const syncingRef = useRef(false);
  const validatedGenerationRef = useRef(0);
  onCompletedRef.current = onCompleted;
  onApprovalRequestRef.current = onApprovalRequest;
  onApprovalResolvedRef.current = onApprovalResolved;

  const applyStatus = useCallback((payload: Record<string, unknown>, acceptedPersisted = false) => {
    const id = String(payload.clientOperationId || "");
    const status = String(payload.status || "");
    const pending = pendingRef.current;
    if (!pending || pending.id !== id || !aliveRef.current) return;
    const stats = contextStatsOf(payload);
    if (stats) setContextStats((current) => sameContextStats(current, stats) ? current : stats);
    if (acceptedPersisted || status === "accepted" || status === "running" || status === "completed") {
      if (!pending.accepted) {
        pending.accepted = true;
        pending.onAccepted?.();
        pending.onAccepted = undefined;
      }
    }
    if (status === "accepted" || status === "running") {
      setTurnStatus(status);
      return;
    }
    pendingRef.current = null;
    if (status === "completed" && typeof payload.text === "string" && payload.text.trim()) {
      pending.resolve?.();
      setReply({ text: payload.text, operationId: id });
      setTurnStatus("completed");
      setError("");
      if (pending.readAloud) onCompletedRef.current(payload.text, id);
      return;
    }
    const message = failureMessage(payload);
    if (pending.accepted) pending.resolve?.();
    else pending.reject?.(new Error(message));
    setTurnStatus("failed");
    setError(message);
  }, []);

  const startTurn = useCallback(async (pending: PendingTurn) => {
    if (!pending.text || !conversationIdRef.current || !aliveRef.current) return;
    try {
      const response = await manager.request({
        channel: "agent",
        op: "turn.start",
        operationId: pending.id,
        payload: {
          backendId: "codex",
          logicalConversationId: conversationIdRef.current,
          clientOperationId: pending.id,
          input: { blocks: [{ type: "text", text: pending.text }] },
        },
      }, { timeoutMs: 30_000 });
      if (response.op === "turn.accepted") {
        const result = payloadOf(response);
        applyStatus({ ...result, clientOperationId: pending.id, status: result.status || "accepted" }, true);
      } else if (response.op === "error") {
        applyStatus({ clientOperationId: pending.id, status: "failed", ...payloadOf(response) });
      } else {
        throw new Error("音声会話の受付応答が不正です。");
      }
    } catch {
      // The request may have reached Runner. Resolve it by operation ID before resending.
      if (aliveRef.current && pendingRef.current === pending) setTurnStatus("sending");
    }
  }, [applyStatus, manager]);

  const sync = useCallback(async () => {
    if (syncingRef.current || !manager.getSnapshot().connected) return;
    syncingRef.current = true;
    const startedGeneration = manager.getSnapshot().generation;
    if (validatedGenerationRef.current !== startedGeneration) setLogicalConversationId("");
    const pendingAtStart = pendingRef.current;
    const turnRevisionAtStart = turnRevisionRef.current;
    try {
      const opened = await manager.request({ channel: "agent", op: "voice.open" });
      if (!aliveRef.current || manager.getSnapshot().generation !== startedGeneration
        || turnRevisionRef.current !== turnRevisionAtStart || pendingRef.current !== pendingAtStart) return;
      const openPayload = payloadOf(opened);
      if (opened.op !== "voice.open.result" || openPayload.contextMode !== "self_context_array"
        || typeof openPayload.logicalConversationId !== "string" || !openPayload.logicalConversationId) {
        throw new Error(opened.op === "error" ? failureMessage(openPayload) : "音声会話を開始できません。");
      }
      const conversationId = openPayload.logicalConversationId;
      if (conversationIdRef.current && conversationIdRef.current !== conversationId && pendingRef.current) {
        const message = "音声会話の接続先が変わりました。前の送信状態を確認できません。";
        pendingRef.current.reject?.(new Error(message));
        pendingRef.current = null;
        setTurnStatus("failed");
        setError(message);
        return;
      }
      conversationIdRef.current = conversationId;
      const stats = contextStatsOf(openPayload);
      setContextStats((current) => sameContextStats(current, stats) ? current : stats);
      setError("");
      let pending = pendingRef.current;
      if (!pending && typeof openPayload.clientOperationId === "string" && openPayload.clientOperationId
        && (openPayload.status === "accepted" || openPayload.status === "running")) {
        pending = { id: openPayload.clientOperationId, readAloud: false, accepted: true };
        pendingRef.current = pending;
        setTurnStatus("sending");
      }
      if (!pending) {
        validatedGenerationRef.current = startedGeneration;
        setLogicalConversationId(conversationId);
        if (openPayload.status === "completed" && typeof openPayload.text === "string"
          && typeof openPayload.clientOperationId === "string") {
          setReply({ text: openPayload.text, operationId: openPayload.clientOperationId });
          setTurnStatus("completed");
        } else if (openPayload.status === "unknown" || openPayload.status === "failed"
          || openPayload.status === "preflight_failed" || openPayload.status === "interrupted") {
          setTurnStatus("failed");
          setError(failureMessage(openPayload));
        }
        return;
      }
      let statusResponse: RunnerWsMessage;
      try {
        statusResponse = await manager.request({
          channel: "agent",
          op: "voice.status",
          payload: { logicalConversationId: conversationId, clientOperationId: pending.id },
        });
      } catch (cause) {
        if (aliveRef.current && manager.getSnapshot().generation === startedGeneration
          && turnRevisionRef.current === turnRevisionAtStart && pendingRef.current === null) {
          validatedGenerationRef.current = startedGeneration;
          setLogicalConversationId(conversationId);
          return;
        }
        throw cause;
      }
      if (!aliveRef.current || manager.getSnapshot().generation !== startedGeneration
        || turnRevisionRef.current !== turnRevisionAtStart) return;
      if (pendingRef.current !== pending) {
        // A turn event can settle the operation while the status request is in flight.
        if (pendingRef.current === null) {
          validatedGenerationRef.current = startedGeneration;
          setLogicalConversationId(conversationId);
        }
        return;
      }
      if (statusResponse.op === "voice.status.result") {
        applyStatus(payloadOf(statusResponse), true);
        validatedGenerationRef.current = startedGeneration;
        setLogicalConversationId(conversationId);
      } else if (statusResponse.op === "error" && payloadOf(statusResponse).code === "not_found" && pending.text) {
        // No saved operation: the first send did not reach Runner. Same ID and text are safe.
        await startTurn(pending);
      } else {
        throw new Error("音声会話の送信状態を確認できません。");
      }
    } catch (cause) {
      if (aliveRef.current && manager.getSnapshot().generation === startedGeneration
        && turnRevisionRef.current === turnRevisionAtStart) {
        setLogicalConversationId("");
        if (pendingRef.current) setTurnStatus("sending");
        setError(cause instanceof Error ? cause.message : "Private Runnerへ接続できません。");
      }
    } finally {
      syncingRef.current = false;
      if (aliveRef.current && manager.getSnapshot().connected
        && manager.getSnapshot().generation !== startedGeneration) void sync();
    }
  }, [applyStatus, manager, startTurn]);

  useEffect(() => {
    if (connected) void sync();
  }, [connected, generation, sync]);

  useEffect(() => {
    if (connected) return;
    setLogicalConversationId("");
    for (const { request } of approvalsRef.current.values()) onApprovalResolvedRef.current?.(request);
    approvalsRef.current.clear();
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    const pending = turnStatus === "sending" || turnStatus === "accepted" || turnStatus === "running";
    if (!pending && logicalConversationId && (contextStats?.unsummarizedMessageCount ?? 0) <= 20) return;
    const timer = setInterval(() => void sync(), pending ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [connected, contextStats?.unsummarizedMessageCount, logicalConversationId, sync, turnStatus]);

  useEffect(() => {
    aliveRef.current = true;
    const complete = manager.subscribe({ channel: "agent", op: "voice.turn.completed" }, (message) => {
      applyStatus({ ...payloadOf(message), status: "completed" }, true);
    });
    const failed = manager.subscribe({ channel: "agent", op: "voice.turn.failed" }, (message) => {
      applyStatus(payloadOf(message), true);
    });
    const approval = manager.subscribe({ channel: "agent", op: "voice.approval.request" }, (message) => {
      const pending = pendingRef.current;
      const payload = payloadOf(message);
      const requestId = String(payload.requestId || "");
      const method = String(payload.method || "");
      if (!pending || message.operationId !== pending.id || !requestId
        || (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval")
        || approvalsRef.current.has(requestId)) return;
      const request = {
        ...normalizeAppServerApprovalRequest(payload.params, {
          rpcId: 0, method, threadId: String(payload.threadId || ""), turnId: String(payload.turnId || ""),
        }),
        requestId,
        sessionInfo: { sessionId: String(payload.threadId || ""), sessionTitle: "音声会話" },
      };
      approvalsRef.current.set(requestId, { request, operationId: pending.id });
      const decision = onApprovalRequestRef.current?.(request) ?? Promise.resolve<ApprovalAction>("decline");
      void Promise.resolve(decision)
        .then((action) => {
          if (!aliveRef.current || approvalsRef.current.get(requestId)?.request !== request) return;
          return manager.request({
            channel: "agent", op: "voice.approval.decision", operationId: pending.id,
            payload: { requestId, decision: toCodexApprovalDecision(action) },
          }, { timeoutMs: 30_000 });
        })
        .catch(() => undefined)
        .finally(() => {
          if (approvalsRef.current.get(requestId)?.request !== request) return;
          approvalsRef.current.delete(requestId);
          onApprovalResolvedRef.current?.(request);
        });
    });
    void manager.connect().catch(() => undefined);
    return () => {
      aliveRef.current = false;
      pendingRef.current?.reject?.(new Error("音声画面を閉じました。"));
      for (const [requestId, { request, operationId }] of approvalsRef.current) {
        onApprovalResolvedRef.current?.(request);
        void manager.request({ channel: "agent", op: "voice.approval.decision",
          operationId, payload: { requestId, decision: "cancel" } }).catch(() => undefined);
      }
      approvalsRef.current.clear();
      complete();
      failed();
      approval();
    };
  }, [applyStatus, manager]);

  const sendTranscript = useCallback((text: string, onAccepted: () => void) => {
    const trimmed = text.trim();
    if (!trimmed || !conversationIdRef.current || pendingRef.current) {
      return Promise.reject(new Error("音声会話を送信できません。"));
    }
    setReply(null);
    setError("");
    setTurnStatus("sending");
    return new Promise<void>((resolve, reject) => {
      const pending: PendingTurn = {
        id: randomUUID(), text: trimmed, onAccepted, resolve, reject,
        readAloud: true, accepted: false,
      };
      turnRevisionRef.current += 1;
      pendingRef.current = pending;
      if (manager.getSnapshot().connected) void startTurn(pending);
    });
  }, [manager, startTurn]);

  return {
    ready: Boolean(logicalConversationId) && connected,
    turnStatus,
    reply,
    contextStats,
    error,
    setError,
    sendTranscript,
  };
}
