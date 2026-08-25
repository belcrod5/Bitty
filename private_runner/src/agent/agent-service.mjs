import { randomUUID } from "node:crypto";

import {
  AGENT_PROTOCOL_VERSION,
  AGENT_TERMINAL_EVENT_TYPES,
  ALL_BACKENDS_SCOPE,
  agentError,
  createAgentEvent,
  hashAgentOperationRequest,
  normalizeAgentStartRequest,
  normalizeAgentSessionRef,
  serializeAgentError,
} from "./agent-protocol.mjs";

const DEFAULT_REPLAY_LIMIT = 512;
const COMPOSITE_SESSION_LIST_CURSOR_VERSION = 1;

// all-backendsスコープの複合cursor。Backend固有cursorを共通層で解釈せず、
// backendIdごとのopaque cursorをまとめて往復させる。
function encodeCompositeSessionListCursor(cursorsByBackendId) {
  return Buffer.from(JSON.stringify({
    v: COMPOSITE_SESSION_LIST_CURSOR_VERSION,
    backends: cursorsByBackendId,
  })).toString("base64url");
}

function decodeCompositeSessionListCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    if (parsed?.v !== COMPOSITE_SESSION_LIST_CURSOR_VERSION) return null;
    const backends = parsed.backends;
    if (!backends || typeof backends !== "object" || Array.isArray(backends)) return null;
    const cursors = {};
    for (const [backendId, cursor] of Object.entries(backends)) {
      if (typeof cursor !== "string") return null;
      cursors[backendId] = cursor;
    }
    return cursors;
  } catch {
    return null;
  }
}

function sessionKey(sessionRef) {
  return `${sessionRef.backendId}\u0000${sessionRef.nativeSessionId}`;
}

function newerTimestamp(first, second) {
  const firstMs = Date.parse(String(first || ""));
  const secondMs = Date.parse(String(second || ""));
  if (!Number.isFinite(firstMs)) return Number.isFinite(secondMs) ? second : "";
  if (!Number.isFinite(secondMs)) return first;
  return secondMs > firstMs ? second : first;
}

function createEventStream(service, runId, subjectId, actionConsumerId) {
  return {
    [Symbol.asyncIterator]() {
      const buffered = [];
      let wake = null;
      let done = false;
      const subscription = service.subscribe(runId, {
        afterSequence: 0,
        actionConsumerId,
        actionScope: "all",
        onEvent(event) {
          buffered.push(event);
          if (AGENT_TERMINAL_EVENT_TYPES.has(event.type)) done = true;
          wake?.();
          wake = null;
        },
      }, { subjectId });
      for (const action of subscription.activeActions) {
        buffered.push({ type: "action.requested", runId, payload: action });
      }
      return {
        async next() {
          while (buffered.length === 0 && !done) {
            await new Promise((resolve) => { wake = resolve; });
          }
          if (buffered.length > 0) return { value: buffered.shift(), done: false };
          subscription.unsubscribe();
          return { value: undefined, done: true };
        },
        async return() {
          done = true;
          subscription.unsubscribe();
          wake?.();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

export function createAgentService({
  backends,
  operationStore,
  sessionStore,
  workspaceAdmission,
  resolveCanonicalCwd,
  replayLimit = DEFAULT_REPLAY_LIMIT,
  runRetentionMs = 24 * 60 * 60 * 1000,
  // Backend側のcompactタイムアウト(既定10分)より長くし、compactが時間切れ間際
  // まで走っても待機turnが先にtimeoutしないマージンを持たせる
  compactWaitTimeoutMs = 11 * 60 * 1000,
  compactLeasePollMs = 500,
  now = () => new Date().toISOString(),
  generateRunId = () => `agent_run_${randomUUID()}`,
  onRunEvent,
} = {}) {
  const registry = new Map();
  for (const backend of backends || []) {
    const backendId = String(backend?.backendId || "").trim();
    if (!backendId || registry.has(backendId)) throw new TypeError("Agent Backend IDs must be unique and non-empty");
    registry.set(backendId, backend);
  }
  if (registry.size === 0) throw new TypeError("At least one Agent Backend is required");
  if (typeof operationStore?.claim !== "function" || typeof operationStore?.complete !== "function") {
    throw new TypeError("A durable operationStore is required");
  }
  if (
    typeof sessionStore?.bind !== "function" ||
    typeof sessionStore?.getBinding !== "function" ||
    typeof sessionStore?.getMode !== "function" ||
    typeof sessionStore?.acquire !== "function" ||
    typeof sessionStore?.settle !== "function" ||
    typeof sessionStore?.updateIdentity !== "function" ||
    typeof sessionStore?.handoff !== "function" ||
    typeof sessionStore?.setSettings !== "function" ||
    typeof sessionStore?.recordActivity !== "function" ||
    typeof sessionStore?.getReadState !== "function"
  ) throw new TypeError("A durable sessionStore is required");
  if (typeof resolveCanonicalCwd !== "function") throw new TypeError("resolveCanonicalCwd is required");

  const runs = new Map();
  const activeRunBySession = new Map();
  const compactQueueBySession = new Map();
  const recoveryBySession = new Map();
  let admissionQueue = Promise.resolve();

  async function admitStart(run) {
    const previous = admissionQueue;
    let release;
    admissionQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  function getRun(runIdRaw) {
    const runId = String(runIdRaw || "").trim();
    const run = runs.get(runId);
    if (!run) throw agentError("turn_rejected", "run was not found");
    return run;
  }

  function getOwnedRun(runIdRaw, context = {}) {
    const run = getRun(runIdRaw);
    const subjectId = String(context.subjectId || "").trim();
    if (!subjectId || run.subjectId !== subjectId) {
      throw agentError("turn_rejected", "run was not found");
    }
    return run;
  }

  function acceptsAction(subscriber, action) {
    return Boolean(
      subscriber.actionConsumerId &&
      (subscriber.actionScope === "all" || (
        subscriber.actionScope === "approval" && String(action.payload.kind || "") !== "dynamic_tool"
      ))
    );
  }

  function claimPendingActions(run, notify = true) {
    for (const action of run.activeActions.values()) {
      if (action.consumerId) continue;
      const subscriber = Array.from(run.subscribers).find((candidate) => acceptsAction(candidate, action));
      if (!subscriber) continue;
      action.consumerId = subscriber.actionConsumerId;
      if (notify && action.event) publish(run, "action.requested", action.payload);
    }
  }

  function removeFromCompactQueue(run) {
    if (!run.sessionKey || !run.queuedForCompact) return;
    const queue = compactQueueBySession.get(run.sessionKey);
    if (!queue) return;
    const index = queue.indexOf(run.runId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) compactQueueBySession.delete(run.sessionKey);
  }

  function getActiveRun(sessionRefRaw, context = {}) {
    const sessionRef = normalizeAgentSessionRef(sessionRefRaw);
    const key = sessionKey(sessionRef);
    const runId = activeRunBySession.get(key) || compactQueueBySession.get(key)?.[0];
    const run = runs.get(runId);
    const subjectId = String(context.subjectId || "").trim();
    if (!subjectId || !run || run.terminal || run.subjectId !== subjectId) return null;
    return {
      runId: run.runId,
      sessionRef,
      state: run.state,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      waitingForAction: run.activeActions.size > 0,
    };
  }

  async function resolveNativeSessionCwd(sessionRef, backend, { reconcileIdle = false } = {}) {
    const nativeCanonicalCwd = await resolveCanonicalCwd(await backend.resolveSessionCwd(sessionRef));
    const binding = await sessionStore.getBinding(sessionRef);
    if (!binding?.canonicalCwd) return nativeCanonicalCwd;
    if (binding.canonicalCwd === nativeCanonicalCwd) return binding.canonicalCwd;
    // native cwdはBackendが持つ真実。idle(lease無し)のbindingが食い違う場合は
    // mode据え置きでnativeへ収束させる。requested cwdとの照合はfail-closedのまま。
    if (reconcileIdle) {
      const mode = await sessionStore.getMode(sessionRef);
      if (mode?.mode && !mode.lease) {
        const reconciled = await sessionStore.bind(
          sessionRef,
          nativeCanonicalCwd,
          mode.mode,
          { reconcileCwd: true },
        );
        if (reconciled?.status === "bound") return nativeCanonicalCwd;
      }
    }
    throw agentError("session_cwd_mismatch", "session cwd does not match", { backendId: sessionRef.backendId });
  }

  function publish(run, type, payload = {}) {
    if (run.terminal) return null;
    const event = createAgentEvent({
      type,
      runId: run.runId,
      sessionRef: run.sessionRef,
      sequence: ++run.sequence,
      at: now(),
      payload,
    });
    run.events.push(event);
    if (!run.startedAt) run.startedAt = event.at;
    run.updatedAt = event.at;
    if (run.events.length > replayLimit) run.events.shift();
    if (typeof onRunEvent === "function") {
      try {
        Promise.resolve(onRunEvent(event)).catch(() => {});
      } catch {}
    }
    const requestedAction = type === "action.requested"
      ? run.activeActions.get(String(payload?.requestId || ""))
      : null;
    if (requestedAction) {
      requestedAction.event = event;
      if (!requestedAction.consumerId) {
        const subscriber = Array.from(run.subscribers).find((candidate) => acceptsAction(candidate, requestedAction));
        if (subscriber) requestedAction.consumerId = subscriber.actionConsumerId;
      }
    }
    for (const subscriber of run.subscribers) {
      if (!requestedAction || (
        requestedAction.consumerId && requestedAction.consumerId === subscriber.actionConsumerId
      )) {
        subscriber.onEvent(event);
      }
    }
    return event;
  }

  async function persistRunSettings(run, sessionRef) {
    try {
      const settings = await sessionStore.setSettings(sessionRef, {
        modelId: run.model,
        reasoningEffort: run.effort,
      });
      if (settings?.status === "missing") {
        throw agentError("session_busy", "session settings could not be stored", { backendId: run.backendId });
      }
      run.settingsPersisted = true;
    } catch (error) {
      if (error && typeof error === "object" && !error.nativeActivity) error.nativeActivity = "not_started";
      throw error;
    }
  }

  async function bindResolvedSession(run, sessionRefRaw) {
    const resolved = normalizeAgentSessionRef(sessionRefRaw);
    if (!resolved || resolved.backendId !== run.backendId) {
      throw agentError("protocol_error", "Backend resolved an invalid session", { backendId: run.backendId });
    }
    if (run.sessionRef && sessionKey(run.sessionRef) !== sessionKey(resolved)) {
      throw agentError("protocol_error", "Backend changed the requested session", { backendId: run.backendId });
    }
    const key = sessionKey(resolved);
    const activeRunId = activeRunBySession.get(key);
    if (activeRunId && activeRunId !== run.runId) {
      throw agentError("session_busy", "session already has an active turn", { backendId: run.backendId });
    }
    if (run.sessionResolved) throw agentError("protocol_error", "Backend resolved the session more than once", { backendId: run.backendId });
    const binding = await sessionStore.bind(resolved, run.cwd, "neutral", {
      settings: { modelId: run.model, reasoningEffort: run.effort },
    });
    if (binding?.status === "cwd_conflict") {
      throw agentError("session_cwd_mismatch", "session cwd does not match", { backendId: run.backendId });
    }
    if (binding?.status === "mode_conflict") {
      throw agentError("session_busy", "session is owned by the compatibility transport", { backendId: run.backendId });
    }
    run.settingsPersisted = true;
    if (!run.lease) {
      const acquired = await sessionStore.acquire({
        sessionRef: resolved,
        mode: "neutral",
        owner: "agent-service",
        runId: run.runId,
      });
      if (acquired?.status !== "acquired" && acquired?.status !== "existing") {
        throw agentError("session_busy", "session already has an active or recovering turn", { backendId: run.backendId });
      }
      run.lease = acquired.lease;
    }
    run.sessionRef = resolved;
    run.sessionKey = key;
    run.sessionResolved = true;
    activeRunBySession.set(key, run.runId);
    publish(run, "session.resolved", { sessionRef: resolved });
  }

  async function recoverSessionLease(sessionRef, backend) {
    const key = sessionKey(sessionRef);
    const existingRecovery = recoveryBySession.get(key);
    if (existingRecovery) return await existingRecovery;
    const recovery = recoverSessionLeaseOnce(sessionRef, backend);
    recoveryBySession.set(key, recovery);
    try {
      return await recovery;
    } finally {
      if (recoveryBySession.get(key) === recovery) recoveryBySession.delete(key);
    }
  }

  async function recoverSessionLeaseOnce(sessionRef, backend) {
    const mode = await sessionStore.getMode(sessionRef);
    if (mode?.lease?.state !== "recovering") return mode;
    if (typeof backend.recoverSession !== "function") {
      throw agentError("session_busy", "session recovery is not supported", { backendId: sessionRef.backendId });
    }
    const recovered = await backend.recoverSession({
      sessionRef,
      lease: mode.lease,
      binding: await sessionStore.getBinding(sessionRef),
    });
    if (recovered?.nativeActivity !== "stopped") {
      throw agentError("session_busy", "native session activity could not be stopped safely", { backendId: sessionRef.backendId });
    }
    const settled = await sessionStore.settle(sessionRef, mode.lease.generation, "released");
    if (settled?.status !== "released") {
      throw agentError("session_busy", "session recovery changed concurrently", { backendId: sessionRef.backendId });
    }
    return await sessionStore.getMode(sessionRef);
  }

  async function withStoredSessionState(session, cwd) {
    const [binding, readState] = await Promise.all([
      sessionStore.getBinding(session?.sessionRef),
      sessionStore.getReadState(session?.sessionRef, cwd),
    ]);
    const lastReadAt = String(readState?.lastReadAt || "").trim()
      || newerTimestamp(binding?.lastReadAt, session?.lastReadAt);
    return {
      ...session,
      // Neutral selection is authoritative until an explicit raw handoff clears it.
      // Native metadata remains the legacy/raw fallback when no stored selection exists.
      modelId: String(binding?.modelId || session?.modelId || "").trim(),
      reasoningEffort: String(binding?.reasoningEffort || session?.reasoningEffort || "").trim(),
      ...(lastReadAt ? { lastReadAt } : {}),
    };
  }

  async function finish(run, outcome, error = null) {
    if (run.terminal) return run.result;
    run.state = "finalizing";
    for (const request of run.activeActions.values()) {
      publish(run, "action.resolved", {
        requestId: request.payload.requestId,
        outcome: outcome === "completed" ? "expired" : "cancelled",
      });
    }
    run.activeActions.clear();
    const nativeActivity = String(error?.nativeActivity || "");
    const nativeKnownStopped = outcome === "completed" || outcome === "interrupted" || nativeActivity === "stopped" || nativeActivity === "not_started";
    const finalOutcome = run.cancelRequested && nativeKnownStopped ? "interrupted" : outcome;
    const result = {
      runId: run.runId,
      ...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
      outcome: finalOutcome,
      ...(error && finalOutcome === "failed" ? { error: serializeAgentError(error, run.backendId) } : {}),
    };
    const terminalType = finalOutcome === "completed"
      ? "turn.completed"
      : finalOutcome === "interrupted" ? "turn.interrupted" : "turn.failed";
    if (run.lease && run.sessionRef) {
      await sessionStore.settle(run.sessionRef, run.lease.generation, nativeKnownStopped ? "released" : "recovering").catch(() => {});
    }
    if (finalOutcome === "completed" && run.sessionRef) {
      await sessionStore.recordActivity(run.sessionRef, run.cwd, now()).catch(() => {});
    }
    publish(run, terminalType, result);
    run.terminal = true;
    run.state = finalOutcome;
    run.result = result;
    if (run.sessionKey && activeRunBySession.get(run.sessionKey) === run.runId) {
      activeRunBySession.delete(run.sessionKey);
    }
    removeFromCompactQueue(run);
    run.resolveCompletion(result);
    await operationStore.complete(run.subjectId, run.clientOperationId, result).catch(() => {});
    const retentionTimer = setTimeout(() => {
      if (runs.get(run.runId) === run && run.terminal) runs.delete(run.runId);
    }, Math.max(60_000, Number(runRetentionMs) || 24 * 60 * 60 * 1000));
    retentionTimer.unref?.();
    return result;
  }

  function emitFromBackend(run, type, payload = {}) {
    if (AGENT_TERMINAL_EVENT_TYPES.has(type) || type === "turn.accepted") {
      throw agentError("protocol_error", `Backend cannot emit ${type}`, { backendId: run.backendId });
    }
    if (type === "session.resolved") throw agentError("protocol_error", "Backend must resolve sessions through resolveSession", { backendId: run.backendId });
    if (type === "provider.event") {
      const keys = Object.keys(payload || {});
      let serialized = "";
      try { serialized = JSON.stringify(payload); } catch {}
      if (
        payload?.backendId !== run.backendId || typeof payload?.nativeType !== "string" ||
        keys.some((key) => !["backendId", "nativeType", "data"].includes(key)) ||
        !serialized || serialized.length > 16 * 1024
      ) throw agentError("protocol_error", "Backend emitted an invalid provider diagnostic", { backendId: run.backendId });
    }
    if (type === "turn.started") {
      if (!run.sessionResolved || run.nativeStarted) {
        throw agentError("protocol_error", "Backend emitted turn.started out of order", { backendId: run.backendId });
      }
      run.nativeStarted = true;
    } else if (!run.nativeStarted && type !== "provider.event") {
      throw agentError("protocol_error", `Backend emitted ${type} before turn.started`, { backendId: run.backendId });
    }
    if (type === "item.started") {
      const itemId = String(payload?.itemId || "").trim();
      if (!itemId || run.startedItems.has(itemId)) throw agentError("protocol_error", "Backend started an invalid item", { backendId: run.backendId });
      run.startedItems.add(itemId);
    } else if (type === "content.delta") {
      const itemId = String(payload?.itemId || "").trim();
      if (!run.startedItems.has(itemId) || run.completedItems.has(itemId)) throw agentError("protocol_error", "Backend emitted a delta outside an active item", { backendId: run.backendId });
    } else if (type === "item.completed") {
      const itemId = String(payload?.itemId || "").trim();
      if (!run.startedItems.has(itemId) || run.completedItems.has(itemId)) throw agentError("protocol_error", "Backend completed an invalid item", { backendId: run.backendId });
      run.completedItems.add(itemId);
    } else if (type === "tool.started") {
      const toolCallId = String(payload?.toolCallId || "").trim();
      if (!toolCallId || run.startedTools.has(toolCallId)) throw agentError("protocol_error", "Backend started an invalid tool", { backendId: run.backendId });
      run.startedTools.add(toolCallId);
    } else if (type === "tool.completed") {
      const toolCallId = String(payload?.toolCallId || "").trim();
      if (!run.startedTools.has(toolCallId) || run.completedTools.has(toolCallId)) throw agentError("protocol_error", "Backend completed an invalid tool", { backendId: run.backendId });
      run.completedTools.add(toolCallId);
    }
    if (type === "action.requested") {
      const requestId = String(payload?.requestId || "").trim();
      if (!requestId || run.activeActions.has(requestId)) {
        throw agentError("protocol_error", "Backend emitted an invalid action request", { backendId: run.backendId });
      }
      run.activeActions.set(requestId, {
        payload: { ...payload, requestId },
        consumerId: null,
        claimState: null,
        event: null,
      });
    }
    if (type === "action.resolved") {
      const requestId = String(payload?.requestId || "").trim();
      if (!run.activeActions.delete(requestId)) {
        throw agentError("protocol_error", "Backend resolved an inactive action", { backendId: run.backendId });
      }
    }
    publish(run, type, payload);
  }

  // compact操作のleaseはrunId接頭辞で識別する(compactSessionのrunId生成と共有)
  const COMPACT_RUN_PREFIX = "agent_compact_";

  function compactLeaseHolder(lease) {
    return String(lease?.owner || "") === "agent-service"
      && String(lease?.runId || "").startsWith(COMPACT_RUN_PREFIX);
  }

  // compact実行中に受理したrunのlease取得待ち。圧縮完了(lease解放)後に自分の
  // leaseを取って返す。中断は"interrupted"、compact以外の保持者やタイムアウトはthrow。
  // 保持者判定はacquireがbusy/recovering結果に同梱するleaseで行う。解放直後に
  // storeを再読すると保持者不在を「compact以外」と誤判定してsession_busyになるため。
  async function waitForCompactLeaseRelease(run, backend) {
    let deadlineMs = 0;
    while (true) {
      if (run.cancelRequested) return "interrupted";
      if (compactQueueBySession.get(run.sessionKey)?.[0] !== run.runId) {
        await new Promise((resolve) => setTimeout(resolve, compactLeasePollMs));
        continue;
      }
      if (!deadlineMs) deadlineMs = Date.now() + compactWaitTimeoutMs;
      const acquired = await sessionStore.acquire({
        sessionRef: run.sessionRef,
        mode: "neutral",
        owner: "agent-service",
        runId: run.runId,
      });
      if (acquired?.status === "acquired" || acquired?.status === "existing") {
        activeRunBySession.set(run.sessionKey, run.runId);
        run.state = "running";
        return acquired.lease;
      }
      if (!compactLeaseHolder(acquired?.lease)) {
        const error = agentError("session_busy", "session already has an active or recovering turn", { backendId: run.backendId });
        error.nativeActivity = "not_started";
        throw error;
      }
      if (Date.now() >= deadlineMs) {
        const error = agentError("timeout", "session compaction did not finish before the queued turn", { backendId: run.backendId });
        error.nativeActivity = "not_started";
        throw error;
      }
      if (String(acquired.lease?.state || "") === "recovering") {
        // compactが異常終了しrecoveringへ落ちた場合は回収してから再取得する
        await recoverSessionLease(run.sessionRef, backend);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, compactLeasePollMs));
    }
  }

  async function execute(run, backend, request) {
    try {
      if (run.sessionRef && !run.settingsPersisted) {
        await persistRunSettings(run, run.sessionRef);
      }
      if (run.sessionRef && !run.lease) {
        const awaited = await waitForCompactLeaseRelease(run, backend);
        if (awaited === "interrupted") {
          await finish(run, "interrupted");
          return;
        }
        run.lease = awaited;
        // Several turns may queue behind one compact. Re-assert the head turn's
        // selection immediately before native start so a later queued turn does not win early.
        await persistRunSettings(run, run.sessionRef);
      }
      const backendResult = await backend.startTurn({
        ...request,
        runId: run.runId,
        signal: run.abortController.signal,
        resolveSession: (sessionRef) => bindResolvedSession(run, sessionRef),
        setNativeProcessIdentity: async (identity) => {
          if (!run.sessionRef || !run.lease) {
            throw agentError("protocol_error", "Backend reported process identity before session resolution", { backendId: run.backendId });
          }
          const updated = await sessionStore.updateIdentity(run.sessionRef, run.lease.generation, identity);
          if (updated?.status !== "updated") {
            throw agentError("session_busy", "session lease changed while starting native process", { backendId: run.backendId });
          }
        },
        emit: (type, payload) => emitFromBackend(run, type, payload),
      });
      if (!run.sessionResolved && backendResult?.sessionRef) await bindResolvedSession(run, backendResult.sessionRef);
      if (!run.nativeStarted) throw agentError("protocol_error", "Backend completed before turn.started", { backendId: run.backendId });
      await finish(run, backendResult?.outcome === "interrupted" ? "interrupted" : "completed");
    } catch (error) {
      await finish(run, "failed", error);
    }
  }

  async function startTurn(rawRequest, context = {}) {
    const subjectId = String(context.subjectId || "").trim();
    if (!subjectId) throw agentError("turn_rejected", "authenticated subject is required");
    const request = normalizeAgentStartRequest(rawRequest);
    const backend = registry.get(request.backendId);
    if (!backend) throw agentError("backend_unavailable", "Agent Backend is unavailable", { backendId: request.backendId });
    const status = await backend.getStatus();
    if (!status?.available || !status?.readiness?.ready) {
      throw agentError("backend_unavailable", status?.readiness?.reason || "Agent Backend is not ready", {
        backendId: request.backendId,
      });
    }
    if (request.policyProfileId) {
      const profiles = status?.capabilities?.action?.policyProfiles || [];
      if (!profiles.some((profile) => profile?.id === request.policyProfileId)) {
        throw agentError("capability_unsupported", "policy profile is not supported", { backendId: request.backendId });
      }
    }
    if (request.model && status?.capabilities?.model?.select !== true) {
      throw agentError("capability_unsupported", "model selection is not supported", { backendId: request.backendId });
    }
    if (request.effort && status?.capabilities?.model?.effort !== true) {
      throw agentError("capability_unsupported", "effort selection is not supported", { backendId: request.backendId });
    }
    const effortOptions = status?.capabilities?.model?.effortOptions;
    if (request.effort && Array.isArray(effortOptions) && effortOptions.length > 0 && !effortOptions.includes(request.effort)) {
      throw agentError("capability_unsupported", "effort value is not supported", { backendId: request.backendId });
    }
    const canonicalCwd = request.sessionRef
      ? await resolveNativeSessionCwd(request.sessionRef, backend)
      : await resolveCanonicalCwd(request.cwd);
    if (request.sessionRef && request.cwd) {
      const requestedCwd = await resolveCanonicalCwd(request.cwd);
      if (requestedCwd !== canonicalCwd) {
        throw agentError("session_cwd_mismatch", "session cwd does not match", { backendId: request.backendId });
      }
    }
    if (status?.capabilities?.workspace?.admission === true) {
      if (typeof workspaceAdmission?.assertAllowed !== "function") {
        throw agentError("backend_unavailable", "workspace admission is unavailable", { backendId: request.backendId });
      }
      await workspaceAdmission.assertAllowed(subjectId, canonicalCwd);
    }
    if (request.sessionRef) await recoverSessionLease(request.sessionRef, backend);
    return await admitStart(async () => {
      const acceptedRequest = { ...request, cwd: canonicalCwd };
      const requestHash = hashAgentOperationRequest(acceptedRequest);
      const replayOperation = (operation) => {
        const existing = runs.get(String(operation.runId || ""));
        if (!existing && operation.result) {
          return {
            runId: String(operation.runId || operation.result.runId || ""),
            result: operation.result,
            events: { async *[Symbol.asyncIterator]() {} },
            completion: Promise.resolve(operation.result),
          };
        }
        if (!existing) throw agentError("operation_status_unknown", "previous operation is no longer replayable");
        const actionConsumerId = {};
        return {
          runId: existing.runId,
          queued: existing.queuedForCompact === true,
          events: createEventStream(service, existing.runId, subjectId, actionConsumerId),
          actionConsumerId,
          completion: existing.completion,
        };
      };
      const inspected = await operationStore.inspect(subjectId, request.clientOperationId, requestHash);
      if (inspected?.status === "conflict") throw agentError("operation_conflict", "clientOperationId has different input");
      if (inspected?.status === "unknown") throw agentError("operation_status_unknown", "previous operation status is unknown");
      if (inspected?.status === "existing") return replayOperation(inspected);
      if (request.sessionRef && activeRunBySession.has(sessionKey(request.sessionRef))) {
        throw agentError("session_busy", "session already has an active turn", { backendId: request.backendId });
      }

      const proposedRunId = generateRunId();
      let preAcquiredLease = null;
      let queuedForCompact = false;
      if (request.sessionRef) {
        const mode = await sessionStore.getMode(request.sessionRef);
        const binding = await sessionStore.getBinding(request.sessionRef);
        if (!mode || !binding) {
          const bound = await sessionStore.bind(
            request.sessionRef,
            canonicalCwd,
            backend.defaultDiscoveredSessionMode === "raw" ? "raw" : "neutral",
          );
          if (bound?.status !== "bound") {
            throw agentError("session_busy", "session mode could not be established", { backendId: request.backendId });
          }
        }
        const resolvedMode = await sessionStore.getMode(request.sessionRef);
        if (resolvedMode?.mode !== "neutral") {
          throw agentError("session_busy", "session requires an explicit neutral handoff", { backendId: request.backendId });
        }
        if ((compactQueueBySession.get(sessionKey(request.sessionRef))?.length || 0) > 0) {
          queuedForCompact = true;
        } else {
          const acquired = await sessionStore.acquire({
            sessionRef: request.sessionRef,
            mode: "neutral",
            owner: "agent-service",
            runId: proposedRunId,
          });
          if (acquired?.status === "acquired" || acquired?.status === "existing") {
            preAcquiredLease = acquired.lease;
          } else if (compactLeaseHolder(acquired?.lease)) {
            queuedForCompact = true;
          } else {
            throw agentError("session_busy", "session already has an active or recovering turn", { backendId: request.backendId });
          }
        }
      }
      let claim;
      try {
        claim = await operationStore.claim(subjectId, request.clientOperationId, requestHash, proposedRunId);
      } catch (error) {
        if (preAcquiredLease && request.sessionRef) {
          await sessionStore.settle(request.sessionRef, preAcquiredLease.generation, "released").catch(() => {});
        }
        throw error;
      }
      if (claim?.status !== "claimed" && preAcquiredLease && request.sessionRef) {
        await sessionStore.settle(request.sessionRef, preAcquiredLease.generation, "released").catch(() => {});
        preAcquiredLease = null;
      }
      if (claim?.status === "conflict") throw agentError("operation_conflict", "clientOperationId has different input");
      if (claim?.status === "unknown") throw agentError("operation_status_unknown", "previous operation status is unknown");
      if (claim?.status === "existing") return replayOperation(claim);

      let resolveCompletion;
      const completion = new Promise((resolve) => { resolveCompletion = resolve; });
      const run = {
        runId: proposedRunId,
        backendId: request.backendId,
        subjectId,
        clientOperationId: request.clientOperationId,
        requestHash,
        sessionRef: request.sessionRef,
        sessionResolved: Boolean(request.sessionRef),
        sessionKey: request.sessionRef ? sessionKey(request.sessionRef) : "",
        cwd: canonicalCwd,
        model: request.model,
        effort: request.effort,
        settingsPersisted: false,
        lease: preAcquiredLease,
        queuedForCompact,
        sequence: 0,
        startedAt: "",
        updatedAt: "",
        events: [],
        subscribers: new Set(),
        activeActions: new Map(),
        startedItems: new Set(),
        completedItems: new Set(),
        startedTools: new Set(),
        completedTools: new Set(),
        abortController: new AbortController(),
        state: queuedForCompact ? "queued" : "running",
        nativeStarted: false,
        cancelRequested: false,
        terminal: false,
        result: null,
        completion,
        resolveCompletion,
      };
      runs.set(run.runId, run);
      if (run.sessionKey) {
        if (queuedForCompact) {
          const queue = compactQueueBySession.get(run.sessionKey) || [];
          queue.push(run.runId);
          compactQueueBySession.set(run.sessionKey, queue);
        } else {
          activeRunBySession.set(run.sessionKey, run.runId);
        }
      }
      publish(run, "turn.accepted", { backendId: run.backendId, queued: queuedForCompact });
      if (run.sessionResolved) publish(run, "session.resolved", { sessionRef: run.sessionRef });
      queueMicrotask(() => void execute(run, backend, acceptedRequest));
      const actionConsumerId = {};
      return {
        runId: run.runId,
        queued: queuedForCompact,
        events: createEventStream(service, run.runId, subjectId, actionConsumerId),
        actionConsumerId,
        completion,
      };
    });
  }

  async function interrupt(runId, context = {}) {
    const run = getOwnedRun(runId, context);
    if (run.terminal) return { status: "already_terminal", result: run.result };
    if (!run.cancelRequested) {
      run.cancelRequested = true;
      run.state = "cancelling";
      run.abortController.abort();
      await registry.get(run.backendId).interrupt?.({ runId: run.runId });
    }
    return { status: "cancelling", runId: run.runId };
  }

  async function claimAction({ runId, requestId }, context = {}) {
    const run = getOwnedRun(runId, context);
    const normalizedRequestId = String(requestId || "").trim();
    const action = run.activeActions.get(normalizedRequestId);
    if (
      run.terminal ||
      String(action?.payload?.kind || "") !== "dynamic_tool" ||
      !context.actionConsumerId ||
      action.consumerId !== context.actionConsumerId ||
      action.claimState
    ) {
      throw agentError("action_expired", "action request cannot be claimed", { backendId: run.backendId });
    }
    action.claimState = "executing";
    return { status: "claimed", runId: run.runId, requestId: normalizedRequestId };
  }

  async function respondToAction({ runId, requestId, decision, result }, context = {}) {
    const run = getOwnedRun(runId, context);
    const normalizedRequestId = String(requestId || "").trim();
    if (run.terminal || !run.activeActions.has(normalizedRequestId)) {
      throw agentError("action_expired", "action request is no longer active", { backendId: run.backendId });
    }
    const action = run.activeActions.get(normalizedRequestId);
    const ownsAction = Boolean(context.actionConsumerId)
      && action.consumerId === context.actionConsumerId;
    const approvalResponder = context.approvalResponder === true
      && String(action.payload.kind || "") !== "dynamic_tool";
    if ((!ownsAction && !approvalResponder) || action.claimState === "responding") {
      throw agentError("action_expired", "action request is owned by another consumer", { backendId: run.backendId });
    }
    const normalizedDecision = String(decision || "").trim();
    if (String(action.payload.kind || "") === "dynamic_tool" && action.claimState !== "executing") {
      throw agentError("action_expired", "dynamic action was not claimed before execution", { backendId: run.backendId });
    }
    if (!Array.isArray(action.payload.decisions) || !action.payload.decisions.includes(normalizedDecision)) {
      throw agentError("turn_rejected", "action decision is not supported", { backendId: run.backendId });
    }
    if (normalizedDecision === "result") {
      let serialized;
      try {
        serialized = JSON.stringify(result);
      } catch {
        throw agentError("turn_rejected", "action result must be JSON serializable", { backendId: run.backendId });
      }
      if (!serialized || serialized.length > 1024 * 1024) {
        throw agentError("turn_rejected", "action result is invalid or too large", { backendId: run.backendId });
      }
    }
    const priorClaimState = action.claimState;
    action.claimState = "responding";
    try {
      await registry.get(run.backendId).respondToAction({
        runId: run.runId,
        requestId: normalizedRequestId,
        decision: normalizedDecision,
        ...(normalizedDecision === "result" ? { result } : {}),
      });
    } catch (error) {
      if (run.activeActions.get(normalizedRequestId) === action) {
        action.claimState = priorClaimState;
        if (
          !action.claimState &&
          !Array.from(run.subscribers).some((subscriber) => subscriber.actionConsumerId === action.consumerId)
        ) {
          action.consumerId = null;
          claimPendingActions(run);
        }
      }
      throw error;
    }
  }

  function subscribe(runId, {
    afterSequence = 0,
    onEvent,
    actionConsumerId = null,
    actionScope = null,
  } = {}, context = {}) {
    const run = getOwnedRun(runId, context);
    if (typeof onEvent !== "function") throw new TypeError("onEvent is required");
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw agentError("turn_rejected", "afterSequence must be a non-negative integer");
    }
    const oldestSequence = run.events[0]?.sequence || 0;
    const replayTruncated = oldestSequence > afterSequence + 1;
    const subscriber = { onEvent, actionConsumerId, actionScope };
    if (!run.terminal) run.subscribers.add(subscriber);
    claimPendingActions(run, false);
    for (const event of run.events) {
      if (event.sequence > afterSequence && event.type !== "action.requested") onEvent(event);
    }
    return {
      replayTruncated,
      replayFromSequence: oldestSequence,
      activeActions: Array.from(run.activeActions.values())
        .filter((action) => action.consumerId === actionConsumerId)
        .map((action) => action.payload),
      unsubscribe: () => {
        if (!run.subscribers.delete(subscriber) || !actionConsumerId) return;
        if (Array.from(run.subscribers).some((candidate) => candidate.actionConsumerId === actionConsumerId)) return;
        for (const action of run.activeActions.values()) {
          if (action.consumerId === actionConsumerId && !action.claimState) {
            action.consumerId = null;
          }
        }
        claimPendingActions(run);
      },
    };
  }

  async function getStatuses() {
    return await Promise.all(Array.from(registry.values(), (backend) => backend.getStatus()));
  }

  async function handoffSession({ sessionRef: rawSessionRef, targetMode = "neutral", cwd = "" }) {
    const sessionRef = normalizeAgentSessionRef(rawSessionRef);
    const backend = registry.get(sessionRef.backendId);
    if (!backend) throw agentError("backend_unavailable", "Agent Backend is unavailable");
    if (targetMode !== "neutral" && targetMode !== "raw") throw agentError("turn_rejected", "targetMode is invalid");
    if (targetMode === "raw" && backend.defaultDiscoveredSessionMode !== "raw") {
      throw agentError("capability_unsupported", "raw compatibility mode is not supported", { backendId: sessionRef.backendId });
    }
    if (targetMode === "neutral") {
      const status = await backend.getStatus();
      if (!status?.readiness?.ready) {
        throw agentError("backend_unavailable", status?.readiness?.reason || "Agent Backend is not ready", {
          backendId: sessionRef.backendId,
        });
      }
    }
    await recoverSessionLease(sessionRef, backend);
    const canonicalCwd = await resolveNativeSessionCwd(sessionRef, backend, { reconcileIdle: true });
    const existingBinding = await sessionStore.getBinding(sessionRef);
    if (cwd) {
      const requested = await resolveCanonicalCwd(cwd);
      if (requested !== canonicalCwd) throw agentError("session_cwd_mismatch", "session cwd does not match");
    }
    if (!existingBinding) {
      const bound = await sessionStore.bind(
        sessionRef,
        canonicalCwd,
        backend.defaultDiscoveredSessionMode === "raw" ? "raw" : "neutral",
      );
      if (bound?.status !== "bound") throw agentError("session_busy", "session could not be bound");
    }
    const handedOff = await sessionStore.handoff(sessionRef, targetMode, {
      clearSettings: targetMode === "raw",
    });
    if (handedOff?.status === "busy") throw agentError("session_busy", "session has an active or recovering turn");
    return { sessionRef, canonicalCwd, mode: handedOff.mode };
  }

  async function cancelRunsInWorkspace({ subjectId, canonicalRoot }) {
    const root = String(canonicalRoot || "");
    const candidates = Array.from(runs.values()).filter((run) => (
      !run.terminal && run.subjectId === subjectId &&
      (run.cwd === root || run.cwd.startsWith(`${root}/`))
    ));
    await Promise.all(candidates.map((run) => interrupt(run.runId, { subjectId }).catch(() => {})));
  }

  async function compactSession({ sessionRef: rawSessionRef }) {
    const sessionRef = normalizeAgentSessionRef(rawSessionRef);
    const backend = registry.get(sessionRef.backendId);
    if (!backend) throw agentError("backend_unavailable", "Agent Backend is unavailable");
    const status = await backend.getStatus();
    if (status?.capabilities?.operations?.compact !== true || typeof backend.compactSession !== "function") {
      throw agentError("capability_unsupported", "session compaction is not supported", { backendId: sessionRef.backendId });
    }
    await recoverSessionLease(sessionRef, backend);
    // admitStart(排他)は受理判定+lease取得だけに使う。圧縮本体まで排他内で
    // 実行すると、圧縮中は全セッションのturn受理までブロックされてしまう。
    const admitted = await admitStart(async () => {
      if ((await sessionStore.getMode(sessionRef))?.mode !== "neutral") {
        throw agentError("session_busy", "session requires an explicit neutral handoff", { backendId: sessionRef.backendId });
      }
      const runId = `${COMPACT_RUN_PREFIX}${randomUUID()}`;
      const acquired = await sessionStore.acquire({ sessionRef, mode: "neutral", owner: "agent-service", runId });
      if (acquired?.status !== "acquired") {
        throw agentError("session_busy", "session already has an active or recovering operation", { backendId: sessionRef.backendId });
      }
      return { runId, lease: acquired.lease };
    });
    try {
      const result = await backend.compactSession({ sessionRef, runId: admitted.runId });
      await sessionStore.settle(sessionRef, admitted.lease.generation, "released");
      return result;
    } catch (error) {
      const stopped = error?.nativeActivity === "stopped" || error?.nativeActivity === "not_started";
      await sessionStore.settle(sessionRef, admitted.lease.generation, stopped ? "released" : "recovering").catch(() => {});
      throw error;
    }
  }

  const service = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    startTurn,
    interrupt,
    claimAction,
    respondToAction,
    subscribe,
    getActiveRun,
    getStatuses,
    handoffSession,
    compactSession,
    cancelRunsInWorkspace,
    async listSessions(options) {
      const requestedCwd = String(options?.cwd || "").trim();
      if (!requestedCwd) throw agentError("turn_rejected", "cwd is required");
      const cwd = await resolveCanonicalCwd(requestedCwd);
      const requestedBackendId = String(options?.backendId || "").trim();
      if (requestedBackendId && requestedBackendId !== ALL_BACKENDS_SCOPE) {
        const backend = registry.get(requestedBackendId);
        if (!backend) throw agentError("backend_unavailable", "Agent Backend is unavailable");
        const status = await backend.getStatus();
        if (!status?.readiness?.ready) {
          throw agentError("backend_unavailable", status?.readiness?.reason || "Agent Backend is not ready", { backendId: backend.backendId });
        }
        if (status?.capabilities?.session?.list !== true) {
          throw agentError("capability_unsupported", "session listing is not supported", { backendId: backend.backendId });
        }
        const singlePage = await backend.listSessions({ ...options, cwd });
        const sessions = await Promise.all(
          (Array.isArray(singlePage?.sessions) ? singlePage.sessions : [])
            .map((session) => withStoredSessionState(session, cwd)),
        );
        // 項目別cursorは合成層のカット専用の内部値。all-scopeと同様wireへは出さない。
        return {
          ...singlePage,
          sessions: sessions.map((session) => {
            const { cursor: _itemCursor, ...rest } = session;
            return rest;
          }),
        };
      }
      // all-backends scope: session.list対応の全Backendを集約する。
      // 一部Backendの失敗は他Backendの成功分を消さず、診断可能なerrorsとして返す。
      const rawCursor = String(options?.cursor || "").trim();
      const compositeCursor = rawCursor ? decodeCompositeSessionListCursor(rawCursor) : null;
      if (rawCursor && !compositeCursor) {
        throw agentError("turn_rejected", "session list cursor is invalid");
      }
      const results = await Promise.all(Array.from(registry.values(), async (backend) => {
        try {
          // 続きページでは、複合cursorに載っている(=まだ残りがある)Backendだけ照会する。
          // 出し切ったBackendを再照会すると先頭ページを永遠に再列挙してしまう。
          // 値は空文字も有効(前ページで1件も採用されなかったBackendは先頭位置のまま)。
          if (compositeCursor && !(backend.backendId in compositeCursor)) return null;
          const status = await backend.getStatus();
          if (status?.capabilities?.session?.list !== true) return null;
          if (!status?.readiness?.ready) {
            return { backendId: backend.backendId, error: agentError("backend_unavailable", status?.readiness?.reason || "Agent Backend is not ready", { backendId: backend.backendId }) };
          }
          const page = await backend.listSessions({
            ...options,
            cwd,
            backendId: backend.backendId,
            cursor: compositeCursor?.[backend.backendId] || "",
          });
          const sessions = await Promise.all(
            (Array.isArray(page?.sessions) ? page.sessions : [])
              .map((session) => withStoredSessionState(session, cwd)),
          );
          return { backendId: backend.backendId, page: { ...page, sessions } };
        } catch (error) {
          return { backendId: backend.backendId, error };
        }
      }));
      const listed = results.filter(Boolean);
      const failed = listed.filter((entry) => entry.error);
      if (listed.length > 0 && failed.length === listed.length) throw failed[0].error;
      const succeeded = listed.filter((entry) => !entry.error);
      const merged = succeeded
        .flatMap((entry) => (Array.isArray(entry.page?.sessions) ? entry.page.sessions : [])
          .map((session) => ({ backendId: entry.backendId, session })))
        // updatedAtは各Backendが正規化済みのISO 8601(UTC・固定長)なので、ordinal比較で
        // 辞書順=時系列になる。localeCompareはロケール依存の照合を通すため使わない。
        .sort((a, b) => {
          const left = String(a.session?.updatedAt || "");
          const right = String(b.session?.updatedAt || "");
          return left < right ? 1 : left > right ? -1 : 0;
        });
      // 1ページ目から「全体の新しい順トップlimit」だけを返す。Backendごとのページは
      // 時間範囲が揃わないため、単純合成だと古い項目が新しい未返却項目より先に出る。
      // カットは全項目が位置cursor(session.cursor)を持つ時だけ行い、切った分は
      // Backendごとのcursorを「実際に返した位置」までしか進めないことで次ページに回す。
      const limit = Number(options?.limit);
      const canCut = Number.isFinite(limit) && limit > 0 && merged.length > limit
        && merged.every((item) => typeof item.session?.cursor === "string" && item.session.cursor);
      const emitted = canCut ? merged.slice(0, limit) : merged;
      const nextCursors = {};
      for (const entry of succeeded) {
        const pageCursor = String(entry.page?.cursor || "").trim();
        if (!canCut) {
          if (pageCursor) nextCursors[entry.backendId] = pageCursor;
          continue;
        }
        const emittedOfBackend = emitted.filter((item) => item.backendId === entry.backendId);
        const totalOfBackend = Array.isArray(entry.page?.sessions) ? entry.page.sessions.length : 0;
        if (totalOfBackend > emittedOfBackend.length) {
          // 未返却分が残っている: 最後に返した項目の位置(1件も返していなければ現位置のまま)
          nextCursors[entry.backendId] = emittedOfBackend.length > 0
            ? String(emittedOfBackend[emittedOfBackend.length - 1].session.cursor)
            : String(compositeCursor?.[entry.backendId] || "");
        } else if (pageCursor) {
          nextCursors[entry.backendId] = pageCursor;
        }
      }
      // 一時失敗したBackendは現位置のまま複合cursorへ引き継ぎ、次ページで再試行する。
      // 引き継がないとスキップ判定(キー存在)により以降の全ページから恒久脱落する。
      for (const entry of failed) {
        nextCursors[entry.backendId] = String(compositeCursor?.[entry.backendId] || "");
      }
      const sessions = emitted.map(({ session }) => {
        const { cursor: _itemCursor, ...rest } = session;
        return rest;
      });
      return {
        sessions,
        ...(Object.keys(nextCursors).length > 0
          ? { cursor: encodeCompositeSessionListCursor(nextCursors) }
          : {}),
        ...(failed.length > 0
          ? { errors: failed.map((entry) => serializeAgentError(entry.error, entry.backendId)) }
          : {}),
      };
    },
    async listSessionSnapshot(options) {
      const requestedBackendId = String(options?.backendId || ALL_BACKENDS_SCOPE).trim()
        || ALL_BACKENDS_SCOPE;
      const selectedBackends = requestedBackendId === ALL_BACKENDS_SCOPE
        ? Array.from(registry.values())
        : [registry.get(requestedBackendId)];
      if (!selectedBackends[0]) {
        throw agentError("backend_unavailable", "Agent Backend is unavailable", {
          backendId: requestedBackendId,
        });
      }
      const requestedCwds = Array.isArray(options?.cwds) ? options.cwds : [];
      const resolvedCwds = await Promise.all(requestedCwds.map((requestedCwd) => (
        resolveCanonicalCwd(String(requestedCwd || "").trim())
      )));
      const canonicalCwds = [];
      const seenCwds = new Set();
      for (const cwd of resolvedCwds) {
        if (seenCwds.has(cwd)) continue;
        seenCwds.add(cwd);
        canonicalCwds.push(cwd);
      }
      const canonicalCwdSet = new Set(canonicalCwds);
      const listed = await Promise.all(selectedBackends.map(async (backend) => {
        try {
          const status = await backend.getStatus();
          if (status?.capabilities?.session?.list !== true) {
            if (requestedBackendId === ALL_BACKENDS_SCOPE) return null;
            throw agentError("capability_unsupported", "session listing is not supported", {
              backendId: backend.backendId,
            });
          }
          if (!status?.readiness?.ready) {
            throw agentError(
              "backend_unavailable",
              status?.readiness?.reason || "Agent Backend is not ready",
              { backendId: backend.backendId },
            );
          }
          let result;
          if (typeof backend.listSessionsForDirectories === "function") {
            result = await backend.listSessionsForDirectories({
              cwds: canonicalCwds,
              includeSubagents: options?.includeSubagents,
            });
          } else {
            const groups = await Promise.all(canonicalCwds.map(async (cwd) => {
              const sessions = [];
              let cursor = "";
              const seenCursors = new Set();
              do {
                const page = await backend.listSessions({
                  cwd,
                  limit: 200,
                  includeSubagents: options?.includeSubagents,
                  ...(cursor ? { cursor } : {}),
                });
                sessions.push(...(Array.isArray(page?.sessions) ? page.sessions : []));
                const nextCursor = String(page?.cursor || "").trim();
                if (!nextCursor) break;
                if (seenCursors.has(nextCursor)) {
                  throw agentError("protocol_error", "session list cursor did not advance", {
                    backendId: backend.backendId,
                  });
                }
                seenCursors.add(nextCursor);
                cursor = nextCursor;
              } while (cursor);
              return { cwd, sessions };
            }));
            result = { groups };
          }
          const groups = Array.isArray(result?.groups) ? result.groups : [];
          const returnedCwds = new Set();
          for (const group of groups) {
            const cwd = String(group?.cwd || "").trim();
            if (!canonicalCwdSet.has(cwd) || returnedCwds.has(cwd)
              || !Array.isArray(group?.sessions)) {
              throw agentError("protocol_error", "session snapshot returned an invalid cwd group", {
                backendId: backend.backendId,
              });
            }
            returnedCwds.add(cwd);
            for (const session of group.sessions) {
              if (session?.sessionRef?.backendId !== backend.backendId
                || !String(session?.sessionRef?.nativeSessionId || "").trim()
                || session?.canonicalCwd !== cwd) {
                throw agentError("protocol_error", "session snapshot returned an invalid session", {
                  backendId: backend.backendId,
                });
              }
            }
          }
          if (returnedCwds.size !== canonicalCwds.length) {
            throw agentError("protocol_error", "session snapshot omitted a cwd group", {
              backendId: backend.backendId,
            });
          }
          return { groups };
        } catch (error) {
          return { error };
        }
      }));
      const failure = listed.find((entry) => entry?.error);
      if (failure) throw failure.error;
      const sessionsByCwd = new Map(canonicalCwds.map((cwd) => [cwd, []]));
      for (const result of listed.filter(Boolean)) {
        for (const group of Array.isArray(result?.groups) ? result.groups : []) {
          const cwd = String(group?.cwd || "").trim();
          const sessions = sessionsByCwd.get(cwd);
          if (!sessions) continue;
          sessions.push(...await Promise.all(
            (Array.isArray(group?.sessions) ? group.sessions : [])
              .map((session) => withStoredSessionState(session, cwd)),
          ));
        }
      }
      return {
        groups: canonicalCwds.map((cwd) => ({
          cwd,
          sessions: sessionsByCwd.get(cwd).sort((a, b) => {
            const left = String(a?.updatedAt || "");
            const right = String(b?.updatedAt || "");
            return left < right ? 1 : left > right ? -1 : 0;
          }),
        })),
      };
    },
    async readHistory(options, context = {}) {
      const sessionRef = normalizeAgentSessionRef(options?.sessionRef);
      const backend = registry.get(sessionRef.backendId);
      if (!backend) throw agentError("backend_unavailable", "Agent Backend is unavailable");
      const status = await backend.getStatus();
      if (!status?.readiness?.ready) {
        throw agentError("backend_unavailable", status?.readiness?.reason || "Agent Backend is not ready", { backendId: backend.backendId });
      }
      if (status?.capabilities?.session?.history?.read !== true) {
        throw agentError("capability_unsupported", "session history is not supported", { backendId: backend.backendId });
      }
      const page = await backend.readHistory({ ...options, sessionRef });
      const canonicalCwd = await resolveNativeSessionCwd(sessionRef, backend, { reconcileIdle: true });
      const binding = await sessionStore.getBinding(sessionRef);
      return {
        ...page,
        // Stored neutral selection follows the same authority rule as session lists.
        modelId: String(binding?.modelId || page?.modelId || "").trim(),
        reasoningEffort: String(binding?.reasoningEffort || page?.reasoningEffort || "").trim(),
        sessionRef,
        canonicalCwd,
        activeRun: getActiveRun(sessionRef, context),
      };
    },
  };
  return service;
}
