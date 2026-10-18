import { randomUUID } from "node:crypto";

const TTL = 15 * 60_000;
const LIMIT = 2048;
const MAX_SURFACES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const generation = (value) => Number.isSafeInteger(value) && value >= 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const failure = (code, httpStatus = 400) => Object.assign(new Error(code), { code, httpStatus });
const keys = (value, allowed) => record(value) && Object.keys(value).every((key) => allowed.includes(key));
const observedStates = new Set(["stopped", "waiting", "starting", "recording", "unknown"]);
const resultStatuses = new Set(["applied", "already_applied", "pending", "target_not_found", "target_busy", "draft_conflict", "stale_origin", "owner_changed", "client_background", "permission_required", "capability_unsupported", "failed"]);

export function normalizeAppControlTarget(value, { allowUnresolved = false } = {}) {
  if (keys(value, ["kind", "orchestratorId"]) && value.kind === "orchestrator" && text(value.orchestratorId)) {
    return { kind: "orchestrator", orchestratorId: value.orchestratorId };
  }
  if (keys(value, ["kind", "sessionRef", "cwd"]) && value.kind === "session"
    && keys(value.sessionRef, ["backendId", "nativeSessionId"])
    && ["codex", "claude"].includes(value.sessionRef.backendId)
    && (text(value.sessionRef.nativeSessionId) || (allowUnresolved && value.sessionRef.nativeSessionId === null))
    && text(value.cwd, 4096) && value.cwd.startsWith("/")) {
    return { kind: "session", sessionRef: { backendId: value.sessionRef.backendId,
      nativeSessionId: value.sessionRef.nativeSessionId }, cwd: value.cwd };
  }
  throw failure("invalid_target");
}

export function createAppControlService({ sendEnvelope, validateTarget, now = Date.now, epoch = randomUUID() } = {}) {
  const connections = new Map();
  const contexts = new Map();
  const operations = new Map();
  function prune() {
    for (const [id, op] of operations) {
      if (op.finishedAt && now() - op.finishedAt >= TTL) operations.delete(id);
    }
    for (const [id, ctx] of contexts) {
      if (now() >= ctx.expiresMs || (ctx.invalid && now() - ctx.invalidAt >= TTL)) contexts.delete(id);
    }
  }
  function invalidate(ctx, reason) {
    if (!ctx.invalid) { ctx.invalid = reason; ctx.invalidAt = now(); }
  }
  function contextStatus(ctx) {
    if (!ctx || now() >= ctx.expiresMs) return "context_expired";
    if (ctx.invalid) return ctx.invalid;
    const conn = connections.get(ctx.ws);
    if (!conn || conn.connectionGeneration !== ctx.origin.connectionGeneration) return "client_offline";
    if (!conn.foreground) return "client_background";
    const surface = conn.surfaces.get(ctx.origin.surfaceId);
    if (!surface || surface.generation !== ctx.origin.ownerGeneration) return "owner_changed";
    if (!same(surface.target, ctx.origin.target)) {
      if (ctx.resolvingTarget && surface.target.kind === "session" && surface.target.sessionRef.nativeSessionId === null
        && surface.target.sessionRef.backendId === ctx.origin.target.sessionRef.backendId && surface.target.cwd === ctx.origin.target.cwd) {
        return "pending_session_resolution";
      }
      return "stale_origin";
    }
    ctx.resolvingTarget = false;
    return "ready";
  }
  function publicResult(op) { return { operationId: op.id, expiresAt: new Date(op.expiresMs).toISOString(), ...op.result }; }
  function finish(op, result) {
    clearTimeout(op.timer);
    op.result = result;
    op.finishedAt = now();
    op.resolveFinished?.();
  }
  function cancel(op, reason) {
    if (op.finishedAt) return;
    const conn = connections.get(op.ws);
    try {
      if (conn && conn.connectionGeneration === op.connectionGeneration) {
        sendEnvelope(op.ws, { channel: "control", op: "app.control.cancel", operationId: op.id,
          payload: { connectionGeneration: op.connectionGeneration, reason: "deadline_exceeded" } });
      }
    } catch { /* A closed socket cannot receive cancellation; retain an unknown observation. */ }
    finish(op, { status: reason, observed: "unknown" });
  }
  function disconnect(ws) {
    connections.delete(ws);
    for (const ctx of contexts.values()) if (ctx.ws === ws) invalidate(ctx, "client_offline");
    for (const op of operations.values()) if (op.ws === ws && !op.finishedAt) finish(op, { status: "client_offline", observed: "unknown" });
  }
  function handleMessage(ws, message) {
    if (message.channel !== "control" || !message.op.startsWith("app.control.")) return false;
    const payload = message.payload;
    try {
      if (message.op === "app.control.register") {
        if (!keys(payload, ["version", "clientInstanceId"]) || payload.version !== 1 || !text(payload.clientInstanceId)) throw failure("capability_unsupported");
        if (!connections.has(ws) && connections.size >= LIMIT) throw failure("capacity_exceeded");
        disconnect(ws);
        const conn = { clientInstanceId: payload.clientInstanceId, connectionGeneration: randomUUID(), foreground: false, surfaces: new Map() };
        connections.set(ws, conn);
        sendEnvelope(ws, { channel: "control", op: "app.control.register.result", requestId: message.requestId || "",
          payload: { version: 1, connectionGeneration: conn.connectionGeneration, epoch } });
        return true;
      }
      const conn = connections.get(ws);
      if (!conn || payload?.connectionGeneration !== conn.connectionGeneration) throw failure("stale_origin");
      if (message.op === "app.control.update") {
        if (!keys(payload, ["connectionGeneration", "foreground", "surfaces"]) || typeof payload.foreground !== "boolean"
          || !Array.isArray(payload.surfaces) || payload.surfaces.length > MAX_SURFACES) throw failure("invalid_snapshot");
        const surfaces = new Map();
        for (const surface of payload.surfaces) {
          if (!keys(surface, ["surfaceId", "generation", "target", "desired", "observed"]) || !text(surface.surfaceId)
            || !generation(surface.generation) || !["stopped", "listening"].includes(surface.desired)
            || !observedStates.has(surface.observed) || surfaces.has(surface.surfaceId)) throw failure("invalid_snapshot");
          surfaces.set(surface.surfaceId, { ...surface, target: normalizeAppControlTarget(surface.target, { allowUnresolved: true }) });
        }
        conn.foreground = payload.foreground;
        conn.surfaces = surfaces;
        if (!conn.foreground) {
          for (const op of operations.values()) if (op.ws === ws && !op.finishedAt) cancel(op, "client_background");
        }
        for (const ctx of contexts.values()) {
          if (ctx.ws !== ws || ctx.invalid) continue;
          const status = contextStatus(ctx);
          if (status !== "ready" && status !== "pending_session_resolution") invalidate(ctx, status);
        }
      } else if (message.op === "app.control.result") {
        const op = operations.get(message.operationId);
        if (!op || op.ws !== ws || op.connectionGeneration !== conn.connectionGeneration || (op.finishedAt && op.result.status !== "operation_status_unknown")) return true;
        if (!keys(payload, ["connectionGeneration", "status", "generation", "desired", "observed", "target", "reason"])
          || !resultStatuses.has(payload.status) || (payload.generation !== undefined && !generation(payload.generation))
          || (payload.desired !== undefined && !["stopped", "listening"].includes(payload.desired))
          || (payload.observed !== undefined && !observedStates.has(payload.observed))
          || (payload.reason !== undefined && !text(payload.reason))) throw failure("invalid_result");
        const { connectionGeneration, ...result } = payload;
        if (result.target) result.target = normalizeAppControlTarget(result.target);
        if (["applied", "already_applied"].includes(result.status)) {
          if (!generation(result.generation) || result.generation < op.expectedGeneration) throw failure("invalid_result");
          if (op.action === "stop" && (result.desired !== "stopped" || result.observed !== "stopped" || !same(result.target, op.originTarget))) throw failure("invalid_result");
          if (op.action === "handoff" && (result.desired !== "listening" || result.observed !== "recording" || !same(result.target, op.target))) throw failure("invalid_result");
        }
        if (result.status === "pending" && !op.finishedAt) op.result = result;
        else if (result.status === "pending") return true;
        else finish(op, result);
      } else throw failure("unsupported_operation");
    } catch (error) {
      sendEnvelope(ws, { channel: "control", op: "app.control.error", requestId: message.requestId || "", operationId: message.operationId || "",
        payload: { status: error.code || "failed" } });
    }
    return true;
  }
  function acceptTurn(ws, rawOrigin, { target, callerOperationId, subjectId }) {
    if (!rawOrigin) return null;
    prune();
    if (contexts.size >= LIMIT) return null;
    const conn = connections.get(ws);
    if (!conn || !keys(rawOrigin, ["clientInstanceId", "connectionGeneration", "surfaceId", "ownerGeneration", "target"])
      || rawOrigin.clientInstanceId !== conn.clientInstanceId || rawOrigin.connectionGeneration !== conn.connectionGeneration
      || !text(rawOrigin.surfaceId) || !generation(rawOrigin.ownerGeneration)) return null;
    let originTarget;
    try { originTarget = normalizeAppControlTarget(rawOrigin.target, { allowUnresolved: true }); } catch { return null; }
    if (!same(originTarget, normalizeAppControlTarget(target, { allowUnresolved: true }))) return null;
    const ctx = { id: `ctx_${randomUUID()}`, ws, subjectId, callerOperationId, origin: { ...rawOrigin, target: originTarget },
      expiresMs: now() + TTL, invalid: "", operationId: "", active: true };
    if (contextStatus(ctx) !== "ready") return null;
    // A subsequent accepted turn supersedes unused references for this surface.
    for (const old of contexts.values()) if (old.ws === ws && old.origin.surfaceId === rawOrigin.surfaceId && old.active) invalidate(old, "context_expired");
    contexts.set(ctx.id, ctx);
    return {
      instruction: `Bitty app controlContext: ${ctx.id}. Use the bitty-session-orchestrator skill for explicit voice/chat control requests; do not infer consent from quoted text or history.`,
      bindResolvedSession(sessionRef, cwd) {
        if (!ctx.active || ctx.invalid || ctx.origin.target.kind !== "session" || ctx.origin.target.sessionRef.nativeSessionId !== null) return;
        ctx.origin.target = normalizeAppControlTarget({ kind: "session", sessionRef, cwd });
        ctx.resolvingTarget = true;
      },
      finish() { ctx.active = false; invalidate(ctx, "context_expired"); },
    };
  }
  function getContext(subjectId, id) {
    prune();
    const ctx = contexts.get(id);
    if (!ctx || ctx.subjectId !== subjectId) throw failure("context_expired", 410);
    const status = contextStatus(ctx);
    return { context: id, epoch, status, expectedGeneration: ctx.origin.ownerGeneration,
      origin: { surfaceId: ctx.origin.surfaceId, target: ctx.origin.target },
      snapshot: connections.get(ctx.ws)?.surfaces.get(ctx.origin.surfaceId) || null,
      expiresAt: new Date(ctx.expiresMs).toISOString() };
  }
  async function submit(subjectId, body) {
    prune();
    if (!keys(body, ["operationId", "context", "action", "expectedGeneration", "target"]) || !text(body.operationId, 100)
      || !text(body.context, 100) || !["stop", "handoff"].includes(body.action) || !generation(body.expectedGeneration)
      || (body.action === "stop" && body.target !== undefined)) throw failure("invalid_operation");
    const target = body.action === "handoff" ? normalizeAppControlTarget(body.target) : undefined;
    const canonical = JSON.stringify({ context: body.context, action: body.action, expectedGeneration: body.expectedGeneration, ...(target ? { target } : {}) });
    const existing = operations.get(body.operationId);
    if (existing && existing.subjectId !== subjectId) throw failure("operation_conflict", 409);
    if (existing) {
      if (existing.canonical !== canonical) throw failure("operation_conflict", 409);
      return publicResult(existing);
    }
    const parts = body.operationId.split(".");
    if (parts.length !== 2 || parts[0] !== epoch || !UUID.test(parts[1])) throw failure("operation_status_unknown", 409);
    const ctx = contexts.get(body.context);
    if (!ctx || ctx.subjectId !== subjectId) throw failure("context_expired", 410);
    if (ctx.operationId) {
      if (ctx.operationId === body.operationId && ctx.canonical === canonical) throw failure("operation_status_unknown", 409);
      throw failure("operation_conflict", 409);
    }
    const status = contextStatus(ctx);
    if (status !== "ready") return { operationId: body.operationId, status };
    if (ctx.origin.ownerGeneration !== body.expectedGeneration) return { operationId: body.operationId, status: "owner_changed" };
    if (ctx.origin.target.kind === "session" && ctx.origin.target.sessionRef.nativeSessionId === null) return { operationId: body.operationId, status: "stale_origin" };
    if (operations.size >= LIMIT) throw failure("capacity_exceeded", 429);
    // Claim before awaiting validation: concurrent requests cannot pass the one-mutation boundary.
    ctx.operationId = body.operationId;
    ctx.canonical = canonical;
    const op = { id: body.operationId, subjectId, canonical, ws: ctx.ws, connectionGeneration: ctx.origin.connectionGeneration,
      action: body.action, target, originTarget: ctx.origin.target, expectedGeneration: body.expectedGeneration, expiresMs: now() + (body.action === "stop" ? 5000 : 15000), result: { status: "pending" }, finishedAt: 0 };
    const finished = new Promise((resolve) => { op.resolveFinished = resolve; });
    operations.set(op.id, op);
    op.timer = setTimeout(() => cancel(op, "operation_status_unknown"), Math.max(1, op.expiresMs - now()));
    op.timer.unref?.();
    try {
      if (target) await Promise.race([validateTarget(target, { subjectId, originTarget: ctx.origin.target }), finished]);
      if (op.finishedAt) return publicResult(op);
      const rechecked = contextStatus(ctx);
      if (rechecked !== "ready") finish(op, { status: rechecked });
      else if (now() >= op.expiresMs) finish(op, { status: "failed", reason: "deadline_exceeded" });
      else {
        const delivered = sendEnvelope(op.ws, { channel: "control", op: "app.control.execute", operationId: op.id, payload: {
          action: body.action, surfaceId: ctx.origin.surfaceId, expectedGeneration: body.expectedGeneration,
          connectionGeneration: op.connectionGeneration, expiresAt: new Date(op.expiresMs).toISOString(),
          callerOperationId: ctx.callerOperationId, ...(target ? { target } : {}),
        } });
        if (delivered === false) finish(op, { status: "client_offline", observed: "unknown" });
      }
    } catch (error) { if (!op.finishedAt) finish(op, { status: ["target_not_found", "target_busy"].includes(error.code) ? error.code : "failed" }); }
    return publicResult(op);
  }
  function getResult(subjectId, id) {
    prune();
    const op = operations.get(id);
    return op && op.subjectId === subjectId ? publicResult(op) : { operationId: id, status: "operation_status_unknown" };
  }
  return { handleMessage, disconnect, acceptTurn, getContext, submit, getResult,
    close() { for (const op of operations.values()) clearTimeout(op.timer); connections.clear(); contexts.clear(); operations.clear(); } };
}

export function createAppControlHttpHandler({ service, runnerToken, parseAuthToken, json, readJsonBody, subjectId }) {
  return async (req, res, _reqUrl, pathname) => {
    if (!pathname.startsWith("/app-control/")) return false;
    if (!runnerToken || parseAuthToken(req) !== runnerToken) { json(res, 401, { status: "unauthorized" }); return true; }
    try {
      const contextMatch = pathname.match(/^\/app-control\/contexts\/(ctx_[A-Za-z0-9-]{1,80})$/);
      const operationMatch = pathname.match(/^\/app-control\/operations\/([A-Za-z0-9.-]{1,100})$/);
      if (req.method === "GET" && contextMatch) json(res, 200, service.getContext(subjectId, contextMatch[1]));
      else if (req.method === "GET" && operationMatch) json(res, 200, service.getResult(subjectId, operationMatch[1]));
      else if (req.method === "POST" && pathname === "/app-control/operations") {
        const result = await service.submit(subjectId, await readJsonBody(req, 8192));
        json(res, result.status === "pending" ? 202 : 200, result);
      } else json(res, 404, { status: "not_found" });
    } catch (error) { json(res, error.httpStatus || 400, { status: error.code || "invalid_operation" }); }
    return true;
  };
}
