import { getVoiceControl, type AppControlOrigin } from "../../appControl/voiceControl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveTtsAudioQuality, type TtsAudioQuality } from "../utils/ttsAudioQuality";
import { randomUUID } from "expo-crypto";
import { AppState } from "react-native";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import type { RunnerWsMessage } from "../../runnerWs/types";
import { playVoiceSound } from "../voiceSounds";
import type { VoiceContextStats } from "../types/appTypes";

type TurnStatus = "idle" | "sending" | "accepted" | "running" | "completed" | "failed";
export type VoiceHistoryMessage = { role: "user" | "assistant"; text: string; clientOperationId: string; at?: string; outputTokens?: number; completedOrdinal?: number; sessionSwitched?: boolean };
export type VoiceTaskChecklist = { status: "present"; markdown: string } | { status: "missing" } | { status: "unavailable" };
export type VoiceTaskChecklistOverview = { status: "present"; markdown: string }
  | { status: "pending" } | { status: "unavailable" };
export type VoiceTaskChecklistCompletion = { sourceHash: string; version: string };
type PendingTurn = {
  id: string;
  text?: string;
  onAccepted?: () => void;
  resolve?: () => void;
  reject?: (error: Error) => void;
  readAloud: boolean;
  accepted: boolean;
  appControlOrigin?: AppControlOrigin;
  jobId?: string;
  resetDecision?: { parentGeneration: unknown; turnSeq: unknown; required: boolean; decision: "reset" | "continue" };
  tts?: { speedScale: number; lightweightTtsOnCellular?: boolean };
  audioQuality?: TtsAudioQuality;
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
  const percent = payload.contextUsagePercent ?? null;
  const unsummarized = payload.unsummarizedMessageCount;
  const characters = payload.memoryCharacterCount;
  const running = payload.subagentRunningCount;
  const total = payload.subagentTotalCount;
  if (percent !== null && (typeof percent !== "number" || !Number.isInteger(percent)
    || percent < 0 || percent > 100)) return null;
  if (typeof unsummarized !== "number" || !Number.isSafeInteger(unsummarized) || unsummarized < 0
    || typeof characters !== "number" || !Number.isSafeInteger(characters) || characters < 0) return null;
  if ((running !== undefined || total !== undefined)
    && (typeof running !== "number" || !Number.isSafeInteger(running) || running < 0
      || typeof total !== "number" || !Number.isSafeInteger(total) || total < running)) return null;
  return {
    contextUsagePercent: percent,
    unsummarizedMessageCount: unsummarized,
    memoryCharacterCount: characters,
    ...(typeof running === "number" ? { subagentRunningCount: running, subagentTotalCount: total as number } : {}),
  };
}

function sameContextStats(a: VoiceContextStats | null, b: VoiceContextStats | null) {
  return a === b || (!!a && !!b
    && a.contextUsagePercent === b.contextUsagePercent
    && a.unsummarizedMessageCount === b.unsummarizedMessageCount
    && a.memoryCharacterCount === b.memoryCharacterCount
    && a.subagentRunningCount === b.subagentRunningCount
    && a.subagentTotalCount === b.subagentTotalCount);
}

export type VoiceResetConfirmation = {
  required: boolean;
  deadlineMs: number | null;
  decide: (decision: "reset" | "continue") => void;
};

export function useVoiceConversation(
  onCompleted: (text: string, operationId: string) => void,
  onJob?: (jobId: string, operationId: string) => void,
  tts?: { speedScale: number; lightweightTtsOnCellular?: boolean },
  orchestratorId = "main",
) {
  const manager = useRunnerWebSocketManager();
  const { connected, generation } = useRunnerWebSocketSnapshot();
  const [resetConfirmation, setResetConfirmation] = useState<VoiceResetConfirmation | null>(null);
  const cancelResetRef = useRef<(() => void) | null>(null);
  const [logicalConversationId, setLogicalConversationId] = useState("");
  const [turnStatus, setTurnStatus] = useState<TurnStatus>("idle");
  const [settledOperationId, setSettledOperationId] = useState("");
  const [reply, setReply] = useState<{ text: string; operationId: string; outputTokens?: number;
    completedOrdinal?: number } | null>(null);
  const [error, setError] = useState("");
  const [contextStats, setContextStats] = useState<VoiceContextStats | null>(null);
  const [history, setHistory] = useState<VoiceHistoryMessage[]>([]);
  const [localHistory, setLocalHistory] = useState<VoiceHistoryMessage[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [taskChecklist, setTaskChecklist] = useState<VoiceTaskChecklist | null>(null);
  const [taskChecklistOverview, setTaskChecklistOverview] = useState<VoiceTaskChecklistOverview | null>(null);
  const [taskChecklistCompletion, setTaskChecklistCompletion] = useState<VoiceTaskChecklistCompletion | null>(null);
  const historyRequestRef = useRef(0);
  const pendingRef = useRef<PendingTurn | null>(null);
  const startTurnTasksRef = useRef(new Map<string, Promise<void>>());
  const turnRevisionRef = useRef(0);
  const settledOperationRef = useRef("");
  const conversationIdRef = useRef("");
  const onCompletedRef = useRef(onCompleted);
  const onJobRef = useRef(onJob);
  const ttsRef = useRef(tts);
  const aliveRef = useRef(true);
  const syncingRef = useRef(false);
  const syncErrorRef = useRef("");
  const validatedGenerationRef = useRef(0);
  onCompletedRef.current = onCompleted;
  onJobRef.current = onJob;
  ttsRef.current = tts;

  const requestResetDecision = useCallback((pending: PendingTurn, required: boolean) => {
    cancelResetRef.current?.();
    return new Promise<"reset" | "continue" | null>((resolve) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (decision: "reset" | "continue" | null) => {
        if (settled || decision === "continue" && required) return;
        settled = true;
        clearTimeout(timer);
        controller.abort();
        cancelResetRef.current = null;
        setResetConfirmation(null);
        resolve(decision);
      };
      cancelResetRef.current = () => finish(null);
      void playVoiceSound("resetConfirmation", controller.signal).catch(() => undefined).then(() => {
        if (settled) return;
        if (!aliveRef.current || pendingRef.current !== pending) { finish(null); return; }
        setResetConfirmation({ required, deadlineMs: required ? null : Date.now() + 10_000, decide: finish });
        if (!required) timer = setTimeout(() => finish("continue"), 10_000);
      });
    });
  }, []);

  const applyStatus = useCallback((payload: Record<string, unknown>, acceptedPersisted = false) => {
    if (payload.orchestratorId && payload.orchestratorId !== orchestratorId) return;
    const id = String(payload.clientOperationId || "");
    const status = String(payload.status || "");
    const pending = pendingRef.current;
    if (!aliveRef.current) return;
    if (payload.sessionSwitched === true && payload.logicalConversationId === conversationIdRef.current) {
      const markSwitch = (messages: VoiceHistoryMessage[]) => messages.map((message) =>
        message.role === "user" && message.clientOperationId === id ? { ...message, sessionSwitched: true } : message);
      setHistory(markSwitch);
      setLocalHistory(markSwitch);
    }
    if (!pending || pending.id !== id) return;
    const jobId = String(payload.jobId || "");
    if (pending.readAloud && jobId && !pending.jobId) {
      pending.jobId = jobId;
      onJobRef.current?.(jobId, id);
    }
    const stats = contextStatsOf(payload);
    if (stats) setContextStats((current) => sameContextStats(current, stats) ? current : stats);
    if (acceptedPersisted || status === "accepted" || status === "running" || status === "completed") {
      if (!pending.accepted) {
        pending.accepted = true;
        pending.onAccepted?.();
        pending.onAccepted = undefined;
      }
    }
    if (status === "unknown") {
      pending.resolve?.();
      setTurnStatus("running");
      setError(failureMessage(payload));
      return;
    }
    if (status === "accepted" || status === "running") {
      cancelResetRef.current?.();
      const partialText = typeof payload.partialText === "string" ? payload.partialText : "";
      if (partialText) setReply((current) => {
        if (current?.operationId !== id) return { text: partialText, operationId: id };
        if (current.text.startsWith(partialText)) return current;
        return { text: partialText, operationId: id };
      });
      setTurnStatus(status);
      return;
    }
    pendingRef.current = null;
    cancelResetRef.current?.();
    settledOperationRef.current = id;
    setSettledOperationId(id);
    if (!pending.accepted) {
      setLocalHistory((current) => current.filter((message) => message.clientOperationId !== id));
    }
    if (status !== "completed") {
      setContextStats((current) => current ? { ...current, contextUsagePercent: null } : null);
    }
    if (status === "interrupted" && payload.code === "voice_cancelled"
      || status === "preflight_failed" && payload.code === "voice_cancelled") {
      pending.resolve?.();
      setTurnStatus("idle");
      setError("");
      return;
    }
    if (status === "completed" && typeof payload.text === "string" && payload.text.trim()) {
      pending.resolve?.();
      const text = payload.text;
      setLocalHistory((current) => [...current, { role: "assistant", text,
        clientOperationId: id,
        outputTokens: typeof payload.outputTokens === "number" ? payload.outputTokens : undefined,
        completedOrdinal: typeof payload.completedOrdinal === "number" ? payload.completedOrdinal : undefined }]);
      setReply({ text: payload.text, operationId: id,
        outputTokens: typeof payload.outputTokens === "number" ? payload.outputTokens : undefined,
        completedOrdinal: typeof payload.completedOrdinal === "number" ? payload.completedOrdinal : undefined });
      setTurnStatus("completed");
      setError("");
      if (pending.readAloud && !pending.jobId) onCompletedRef.current(payload.text, id);
      return;
    }
    const message = failureMessage(payload);
    if (pending.accepted) pending.resolve?.();
    else pending.reject?.(new Error(message));
    setTurnStatus("failed");
    setError(message);
  }, [orchestratorId]);

  const startTurn = useCallback((pending: PendingTurn) => {
    const existing = startTurnTasksRef.current.get(pending.id);
    if (existing) return existing;
    const task = (async () => {
      if (!pending.text || !conversationIdRef.current || !aliveRef.current) return;
      try {
        if (pending.tts && pending.audioQuality === undefined) {
          pending.audioQuality = pending.tts.lightweightTtsOnCellular
            ? await resolveTtsAudioQuality(true) : "standard";
        }
        const tts = pending.tts ? { speedScale: pending.tts.speedScale, audioQuality: pending.audioQuality } : undefined;
        while (aliveRef.current && pendingRef.current === pending) {
          const response = await manager.request({
            channel: "agent",
            op: "turn.start",
            operationId: pending.id,
            payload: {
              backendId: "codex",
              ...(pending.appControlOrigin ? { appControlOrigin: pending.appControlOrigin } : {}),
              orchestratorId,
              logicalConversationId: conversationIdRef.current,
              clientOperationId: pending.id,
              input: { blocks: [{ type: "text", text: pending.text }] },
              ...(tts ? { tts } : {}),
            },
          }, { timeoutMs: 30_000 });
          if (!aliveRef.current || pendingRef.current !== pending) return;
          if (response.op === "turn.accepted") {
            const result = payloadOf(response);
            if (result.status === "confirmation_required") {
              const confirmation = result.resetConfirmation;
              if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)) {
                throw new Error("セッション確認を開始できません。");
              }
              const value = confirmation as Record<string, unknown>;
              const required = value.required === true;
              const previous = pending.resetDecision;
              const decision = previous && previous.parentGeneration === value.parentGeneration && previous.turnSeq === value.turnSeq
                && previous.required === required ? previous.decision : await requestResetDecision(pending, required);
              if (!decision || !aliveRef.current || pendingRef.current !== pending) return;
              pending.resetDecision = { parentGeneration: value.parentGeneration, turnSeq: value.turnSeq, required, decision };
              const confirmed = await manager.request({ channel: "agent", op: "voice.session-reset.respond",
                operationId: pending.id, payload: {
                  orchestratorId, logicalConversationId: conversationIdRef.current,
                  clientOperationId: pending.id, parentGeneration: value.parentGeneration,
                  turnSeq: value.turnSeq, decision,
                } }, { timeoutMs: 30_000 });
              if (confirmed.op !== "voice.session-reset.respond.result") {
                throw new Error("セッション確認を保存できません。");
              }
              continue;
            }
            applyStatus({ ...result, clientOperationId: pending.id, status: result.status || "accepted" }, true);
            break;
          }
          if (response.op === "error") {
            applyStatus({ clientOperationId: pending.id, status: "failed", ...payloadOf(response) });
            break;
          }
          throw new Error("音声会話の受付応答が不正です。");
        }
      } catch {
        // The request may have reached Runner. Resolve it by operation ID before resending.
        if (aliveRef.current && pendingRef.current === pending) setTurnStatus("sending");
      }
    })();
    startTurnTasksRef.current.set(pending.id, task);
    void task.finally(() => {
      if (startTurnTasksRef.current.get(pending.id) === task) startTurnTasksRef.current.delete(pending.id);
    });
    return task;
  }, [applyStatus, manager, orchestratorId, requestResetDecision]);

  const sync = useCallback(async () => {
    if (syncingRef.current || !manager.getSnapshot().connected) return;
    syncingRef.current = true;
    const startedGeneration = manager.getSnapshot().generation;
    if (validatedGenerationRef.current !== startedGeneration) setLogicalConversationId("");
    const pendingAtStart = pendingRef.current;
    const turnRevisionAtStart = turnRevisionRef.current;
    try {
      const opened = await manager.request({ channel: "agent", op: "voice.open",
        payload: { orchestratorId } });
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
        cancelResetRef.current?.();
        setTurnStatus("failed");
        setError(message);
        return;
      }
      if (conversationIdRef.current && conversationIdRef.current !== conversationId) {
        historyRequestRef.current += 1;
        settledOperationRef.current = "";
        setSettledOperationId("");
        syncErrorRef.current = "";
        setError("");
        setReply(null);
        setHistory([]);
        setLocalHistory([]);
        setHistoryError("");
        setTaskChecklist(null);
        setTaskChecklistCompletion(null);
        setTaskChecklistOverview(null);
        setTurnStatus("idle");
      }
      conversationIdRef.current = conversationId;
      const stats = contextStatsOf(openPayload);
      setContextStats((current) => sameContextStats(current, stats) ? current : stats);
      const previousSyncError = syncErrorRef.current;
      if (previousSyncError) {
        syncErrorRef.current = "";
        setError((current) => current === previousSyncError ? "" : current);
      }
      let pending = pendingRef.current;
      if (!pending && typeof openPayload.clientOperationId === "string" && openPayload.clientOperationId
        && (openPayload.status === "accepted" || openPayload.status === "running"
          || openPayload.status === "confirmation_required" || openPayload.status === "unknown")) {
        pending = { id: openPayload.clientOperationId,
          ...(typeof openPayload.inputText === "string" ? { text: openPayload.inputText } : {}),
          readAloud: false, accepted: openPayload.status !== "confirmation_required" };
        pendingRef.current = pending;
        const { id, text } = pending;
        if (text) setLocalHistory((current) => [...current, { role: "user", text, clientOperationId: id }]);
        setTurnStatus("sending");
      }
      if (!pending) {
        validatedGenerationRef.current = startedGeneration;
        setLogicalConversationId(conversationId);
        const operationId = String(openPayload.clientOperationId || "");
        const alreadySettled = operationId && settledOperationRef.current === operationId;
        // Completed snapshots may add metadata without replaying the turn outcome.
        if (alreadySettled && openPayload.status !== "completed") return;
        if (["completed", "failed", "preflight_failed", "interrupted"].includes(String(openPayload.status))) {
          settledOperationRef.current = operationId;
          setSettledOperationId(operationId);
        }
        if (openPayload.status === "completed" && typeof openPayload.text === "string"
          && typeof openPayload.clientOperationId === "string") {
          setReply({ text: openPayload.text, operationId: openPayload.clientOperationId,
            outputTokens: typeof openPayload.outputTokens === "number" ? openPayload.outputTokens : undefined,
            completedOrdinal: typeof openPayload.completedOrdinal === "number" ? openPayload.completedOrdinal : undefined });
          if (!alreadySettled) {
            setTurnStatus("completed");
            setError("");
          }
        } else if ((openPayload.status === "interrupted" || openPayload.status === "preflight_failed")
          && openPayload.code === "voice_cancelled") {
          setTurnStatus("idle");
          setError("");
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
          payload: { orchestratorId, logicalConversationId: conversationId, clientOperationId: pending.id },
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
        const message = cause instanceof Error ? cause.message : "Private Runnerへ接続できません。";
        syncErrorRef.current = message;
        setError(message);
      }
    } finally {
      syncingRef.current = false;
      if (aliveRef.current && manager.getSnapshot().connected
        && manager.getSnapshot().generation !== startedGeneration) void sync();
    }
  }, [applyStatus, manager, orchestratorId, startTurn]);

  useEffect(() => {
    if (connected) void sync();
  }, [connected, generation, sync]);

  useEffect(() => {
    if (connected) return;
    setLogicalConversationId("");
    setContextStats((current) => current ? { ...current, contextUsagePercent: null } : null);
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    const pending = turnStatus === "sending" || turnStatus === "accepted" || turnStatus === "running";
    const timer = setInterval(() => void sync(), pending ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [connected, sync, turnStatus]);

  useEffect(() => {
    aliveRef.current = true;
    const delta = manager.subscribe({ channel: "agent", op: "voice.turn.delta" }, (message) => {
      const pending = pendingRef.current;
      const payload = payloadOf(message);
      const operationId = String(payload.clientOperationId || message.operationId || "");
      const conversationId = String(payload.logicalConversationId || "");
      const text = typeof payload.delta === "string" ? payload.delta : "";
      if (!pending || pending.id !== operationId || conversationId !== conversationIdRef.current
        || (payload.orchestratorId && payload.orchestratorId !== orchestratorId) || !text) return;
      setReply((current) => ({
        operationId,
        text: current?.operationId === operationId ? current.text + text : text,
      }));
    });
    const started = manager.subscribe({ channel: "agent", op: "voice.turn.started" }, (message) => {
      applyStatus(payloadOf(message), true);
    });
    const complete = manager.subscribe({ channel: "agent", op: "voice.turn.completed" }, (message) => {
      applyStatus({ ...payloadOf(message), status: "completed" }, true);
    });
    const failed = manager.subscribe({ channel: "agent", op: "voice.turn.failed" }, (message) => {
      applyStatus(payloadOf(message), true);
    });
    void manager.connect().catch(() => undefined);
    return () => {
      aliveRef.current = false;
      pendingRef.current?.reject?.(new Error("音声画面を閉じました。"));
      pendingRef.current = null;
      cancelResetRef.current?.();
      delta();
      started();
      complete();
      failed();
    };
  }, [applyStatus, manager, orchestratorId]);

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
        appControlOrigin: getVoiceControl(manager).origin(undefined, { kind: "orchestrator", orchestratorId }),
        tts: ttsRef.current,
      };
      turnRevisionRef.current += 1;
      pendingRef.current = pending;
      setLocalHistory((current) => [...current, { role: "user", text: trimmed, clientOperationId: pending.id,
        at: new Date().toISOString() }]);
      if (manager.getSnapshot().connected) void startTurn(pending);
    });
  }, [manager, startTurn, orchestratorId]);

  const interrupt = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending || !conversationIdRef.current) return;
    pendingRef.current = null;
    cancelResetRef.current?.();
    settledOperationRef.current = pending.id;
    setSettledOperationId(pending.id);
    turnRevisionRef.current += 1;
    pending.resolve?.();
    setTurnStatus("idle");
    setError("");
    setContextStats((current) => current ? { ...current, contextUsagePercent: null } : null);
    const request = {
      channel: "agent", op: "voice.turn.interrupt", operationId: pending.id,
      payload: { orchestratorId, logicalConversationId: conversationIdRef.current, clientOperationId: pending.id },
    } as const;
    void manager.request(request, { timeoutMs: 30_000 }).catch(async () => {
      await manager.connect();
      await manager.request(request, { timeoutMs: 30_000 });
    }).catch(() => undefined);
  }, [manager, orchestratorId]);

  const refreshHistory = useCallback(async () => {
    const conversationId = conversationIdRef.current;
    const startedGeneration = manager.getSnapshot().generation;
    if (!conversationId || !manager.getSnapshot().connected) return;
    const requestNumber = ++historyRequestRef.current;
    try {
      const response = await manager.request({ channel: "agent", op: "voice.history",
        payload: { orchestratorId } });
      const payload = payloadOf(response);
      if (response.op !== "voice.history.result" || payload.logicalConversationId !== conversationId
        || (payload.orchestratorId && payload.orchestratorId !== orchestratorId)
        || !Array.isArray(payload.messages) || !payload.messages.every((message) =>
          message && typeof message === "object" && (message.role === "user" || message.role === "assistant")
          && typeof message.text === "string" && typeof message.clientOperationId === "string")) {
        throw new Error("音声会話の履歴を読み込めません。");
      }
      if (!aliveRef.current || historyRequestRef.current !== requestNumber || conversationIdRef.current !== conversationId
        || manager.getSnapshot().generation !== startedGeneration) return;
      const messages = payload.messages as VoiceHistoryMessage[];
      setHistory((current) => messages.map((message) => message.role === "user" && current.some((old) =>
        old.clientOperationId === message.clientOperationId && old.sessionSwitched === true)
        ? { ...message, sessionSwitched: true } : message));
      const raw = payload.taskChecklist;
      const value = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown> : null;
      setTaskChecklist(value
        && (value.status === "missing" || value.status === "unavailable"
          || value.status === "present" && typeof value.markdown === "string")
        ? value as VoiceTaskChecklist : { status: "unavailable" });
      const overview = payload.taskChecklistOverview;
      const display = overview && typeof overview === "object" && !Array.isArray(overview)
        ? overview as Record<string, unknown> : null;
      setTaskChecklistOverview(overview === undefined ? null : value?.status === "present" && display
        && (display.status === "pending" || display.status === "unavailable"
          || display.status === "present" && typeof display.markdown === "string")
        ? display as VoiceTaskChecklistOverview : { status: "unavailable" });
      const completion = payload.taskChecklistCompletion;
      const offer = completion && typeof completion === "object" && !Array.isArray(completion)
        ? completion as Record<string, unknown> : null;
      setTaskChecklistCompletion(offer && typeof offer.sourceHash === "string"
        && typeof offer.version === "string" && /^[0-9a-f]{64}$/.test(offer.sourceHash)
        && /^[0-9a-f]{64}$/.test(offer.version)
        ? { sourceHash: offer.sourceHash, version: offer.version } : null);
      setLocalHistory((current) => current.filter((local) => !messages.some((message) =>
        message.role === local.role && message.clientOperationId === local.clientOperationId
        && (local.sessionSwitched !== true || message.sessionSwitched === true))));
      setHistoryError("");
    } catch (cause) {
      if (aliveRef.current && historyRequestRef.current === requestNumber && conversationIdRef.current === conversationId
        && manager.getSnapshot().generation === startedGeneration) {
        setHistoryError(cause instanceof Error ? cause.message : "音声会話の履歴を読み込めません。");
        setTaskChecklist({ status: "unavailable" });
        setTaskChecklistOverview(null);
        setTaskChecklistCompletion(null);
      }
    }
  }, [manager, orchestratorId]);

  const respondToChecklistCompletion = useCallback(async (sourceHash: string, version: string,
    decision: "clear" | "keep") => {
    const response = await manager.request({ channel: "agent", op: "voice.task-checklist.complete.respond",
      payload: { orchestratorId, sourceHash, version, decision } });
    if (response.op !== "voice.task-checklist.complete.respond.result") {
      throw new Error("To Do の完了確認を保存できませんでした。");
    }
    await refreshHistory();
  }, [manager, orchestratorId, refreshHistory]);

  useEffect(() => {
    return manager.subscribe({ channel: "agent", op: "voice.task-checklist.changed" }, (message) => {
      const payload = payloadOf(message);
      if (payload.orchestratorId === orchestratorId) {
        void refreshHistory();
      }
    });
  }, [manager, orchestratorId, refreshHistory]);

  useEffect(() => {
    if (!logicalConversationId || !connected) return;
    const refresh = () => { void refreshHistory(); };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [connected, logicalConversationId, refreshHistory, settledOperationId]);

  const visibleHistory = useMemo(() => [...history.map((message) => message.role === "user" && localHistory.some((local) =>
    local.clientOperationId === message.clientOperationId && local.sessionSwitched === true)
    ? { ...message, sessionSwitched: true } : message), ...localHistory.filter((local) => !history.some((message) =>
    message.role === local.role && message.clientOperationId === local.clientOperationId))], [history, localHistory]);

  return {
    resetConfirmation,
    ready: Boolean(logicalConversationId) && connected,
    logicalConversationId,
    turnStatus,
    reply,
    contextStats,
    history: visibleHistory,
    historyError,
    taskChecklist,
    taskChecklistOverview,
    taskChecklistCompletion,
    respondToChecklistCompletion,
    refreshHistory,
    error,
    setError,
    sendTranscript,
    interrupt,
  };
}
