function firstString(...values) {
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) return normalized;
  }
  return "";
}

export function createCodexRawSessionOwnership({
  bindSession,
  getSessionBinding,
  acquireLease,
  settleLease,
  resolveCanonicalCwd,
  makeConflictError,
  errorMessage,
  sendRpc,
  log = console,
}) {
  async function bind(relay, nativeSessionId, rawCwd, options = {}) {
    if (!nativeSessionId || !rawCwd) return;
    const canonicalCwd = await resolveCanonicalCwd(rawCwd);
    const result = await bindSession(
      { backendId: "codex", nativeSessionId },
      canonicalCwd,
      "raw",
      { reconcileCwd: options.reconcileCwd === true },
    );
    if (result?.status === "mode_conflict") throw makeConflictError("session_mode_conflict", "session is assigned to the neutral Agent transport");
    if (result?.status === "cwd_conflict") throw makeConflictError("session_cwd_mismatch", "session cwd does not match its binding");
    return canonicalCwd;
  }

  async function admit(relay, rpcPayload, params, kind = "turn") {
    if (relay.agentLeaseSettlement) await relay.agentLeaseSettlement;
    while (relay.agentBindingReconciliation) {
      const bindingReconciliation = relay.agentBindingReconciliation;
      const outcome = await bindingReconciliation;
      if (relay.agentBindingReconciliation === bindingReconciliation) {
        relay.agentBindingReconciliation = null;
      }
      if (outcome?.error) throw outcome.error;
    }
    if (relay.agentLease) throw makeConflictError("session_busy", "session already has an active raw operation");
    const nativeSessionId = firstString(rpcPayload?.params?.threadId, params.threadId, relay.threadId);
    if (!nativeSessionId) throw makeConflictError("session_not_found", "turn/start requires a resolved threadId");
    const rawCwd = firstString(rpcPayload?.params?.cwd, relay.threadCwd);
    const sessionRef = { backendId: "codex", nativeSessionId };
    const boundCwd = rawCwd || String((await getSessionBinding(sessionRef))?.canonicalCwd || "");
    if (!boundCwd) throw makeConflictError("session_not_found", "turn/start requires a resolved workspace");
    await bind(relay, nativeSessionId, boundCwd);
    const acquired = await acquireLease({
      sessionRef,
      mode: "raw",
      owner: "codex-raw-relay",
      runId: String(params.operationId || `${relay.relayId}:${kind}:${String(rpcPayload?.id ?? "notification")}`),
    });
    if (acquired?.status !== "acquired" && acquired?.status !== "existing") {
      throw makeConflictError("session_busy", "session already has an active or recovering turn");
    }
    relay.agentLease = { sessionRef, generation: acquired.lease.generation, kind };
  }

  function settle(relay, state, expectedKind = "") {
    const lease = relay?.agentLease;
    if (!lease || (expectedKind && lease.kind !== expectedKind)) return relay?.agentLeaseSettlement;
    relay.agentLease = null;
    const settlement = settleLease(lease.sessionRef, lease.generation, state).catch((error) => {
      log.warn(`[codex-ws-proxy] failed to ${state} session lease: ${errorMessage(error)}`);
    });
    relay.agentLeaseSettlement = settlement;
    void settlement.finally(() => {
      if (relay.agentLeaseSettlement === settlement) relay.agentLeaseSettlement = null;
    });
    return settlement;
  }

  function reject(relay, rpcPayload, params, error) {
    const id = rpcPayload?.id;
    if (id === undefined || id === null) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32009,
        message: errorMessage(error),
        data: { code: String(error?.apiPayload?.error || error?.code || "session_busy") },
      },
    });
    for (const subscriber of Array.from(relay.clients)) {
      sendRpc(relay, subscriber, payload, undefined, {
        responseRpcMethod: "turn/start",
        operationId: params.operationId || "",
        sessionId: params.sessionId || "",
      });
    }
  }

  function intercept(relay, rpcPayload, method, params, forward) {
    const compact = (method === "thread/compact" || method === "thread/compact/start") && params.modeAdmitted !== true;
    const turnStart = method === "turn/start" && params.leaseAdmitted !== true;
    if (!compact && !turnStart) return null;
    return (async () => {
      try {
        const kind = turnStart ? "turn" : "compact";
        await admit(relay, rpcPayload, params, kind);
        if (relay.closed) {
          settle(relay, "released", kind);
          throw makeConflictError("relay_closed", `Codex relay closed before ${method}`);
        }
        return forward(turnStart ? { ...params, leaseAdmitted: true } : { ...params, modeAdmitted: true });
      } catch (error) {
        reject(relay, rpcPayload, params, error);
        return false;
      }
    })();
  }

  return { bind, admit, intercept, settle, reject };
}
