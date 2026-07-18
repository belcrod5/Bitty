export function createRunnerWsLlmRelayIdentityIndex(options = {}) {
  const operationEntries = new Map();
  const sessionEntries = new Map();
  const getRelay = typeof options.getRelay === "function" ? options.getRelay : () => null;
  const ttlMs = Math.max(1, Number(options.ttlMs || 30 * 60 * 1000));
  const maxEntries = Math.max(1, Number(options.maxEntries || 512));
  const now = typeof options.now === "function" ? options.now : Date.now;

  const readId = (value) => String(value || "").trim();
  const readLiveRelay = (entry) => {
    const relayId = readId(entry?.relayId);
    const relay = relayId ? getRelay(relayId) : null;
    return relay && !relay.closed ? relay : null;
  };
  const sweepMap = (map, nowMs) => {
    for (const [logicalId, entry] of map.entries()) {
      const expired = Number(entry?.updatedAtMs || entry?.createdAtMs || 0) + ttlMs < nowMs;
      if (!readLiveRelay(entry) || expired) map.delete(logicalId);
    }
    if (map.size <= maxEntries) return;
    const overflow = map.size - maxEntries;
    const oldest = Array.from(map.entries())
      .sort((a, b) => Number(a[1]?.updatedAtMs || 0) - Number(b[1]?.updatedAtMs || 0))
      .slice(0, overflow);
    for (const [logicalId] of oldest) map.delete(logicalId);
  };
  const sweep = (nowMs = now()) => {
    sweepMap(operationEntries, nowMs);
    sweepMap(sessionEntries, nowMs);
  };
  const mappedRelay = (map, logicalId) => {
    const entry = map.get(logicalId) || null;
    const relay = readLiveRelay(entry);
    if (!relay && entry) map.delete(logicalId);
    return relay;
  };

  const resolveExact = (identity = {}) => {
    const operationId = readId(identity.operationId);
    const sessionId = readId(identity.sessionId);
    if (!operationId || !sessionId) {
      return { ok: false, reason: "relay_identity_required", relay: null };
    }
    sweep();
    const operationRelay = mappedRelay(operationEntries, operationId);
    const sessionRelay = mappedRelay(sessionEntries, sessionId);
    if (!operationRelay && !sessionRelay) {
      return { ok: false, reason: "relay_identity_not_found", relay: null };
    }
    if (!operationRelay || !sessionRelay || operationRelay !== sessionRelay) {
      return { ok: false, reason: "relay_identity_mismatch", relay: null };
    }
    const operationEntry = operationEntries.get(operationId);
    if (
      readId(operationEntry?.sessionId) !== sessionId
    ) {
      return { ok: false, reason: "relay_identity_mismatch", relay: null };
    }
    return { ok: true, reason: "", relay: operationRelay };
  };

  const claim = (relay, identity = {}) => {
    const relayId = readId(relay?.relayId);
    const operationId = readId(identity.operationId);
    const sessionId = readId(identity.sessionId);
    if (!relayId || relay?.closed || !operationId || !sessionId) {
      return { ok: false, reason: "relay_identity_required" };
    }
    sweep();
    const operationRelay = mappedRelay(operationEntries, operationId);
    const sessionRelay = mappedRelay(sessionEntries, sessionId);
    const operationEntry = operationEntries.get(operationId) || null;
    if (
      (operationRelay && operationRelay !== relay) ||
      (sessionRelay && sessionRelay !== relay) ||
      (operationEntry && readId(operationEntry.sessionId) !== sessionId)
    ) {
      return { ok: false, reason: "runner_ws_llm_identity_collision" };
    }
    const atMs = now();
    const remember = (map, logicalId, extra = {}) => {
      const existing = map.get(logicalId) || null;
      map.set(logicalId, {
        relayId,
        ...extra,
        createdAtMs: Number(existing?.createdAtMs || atMs),
        updatedAtMs: atMs,
      });
    };
    remember(operationEntries, operationId, { sessionId });
    remember(sessionEntries, sessionId);
    sweep();
    return { ok: true, reason: "" };
  };

  const authorizeResume = (identity = {}, options = {}) => {
    const match = resolveExact(identity);
    const relay = match.relay;
    if (!relay) return match;
    const threadId = readId(options.threadId);
    if (threadId && readId(relay.threadId) && readId(relay.threadId) !== threadId) {
      return { ok: false, reason: "relay_identity_mismatch", relay: null };
    }
    const replayAfterSeq = Math.max(0, Math.floor(Number(options.replayAfterSeq) || 0));
    if (replayAfterSeq > Number(relay.lastSeq || 0)) {
      return { ok: false, reason: "relay_seq_ahead", relay: null };
    }
    const oldestRetainedSeq = Number(relay.eventLog?.[0]?.seq || 0);
    if (oldestRetainedSeq > replayAfterSeq + 1) {
      return { ok: false, reason: "relay_event_history_gap", relay: null };
    }
    const claimed = claim(relay, identity);
    return claimed.ok
      ? { ok: true, reason: "", relay }
      : { ok: false, reason: "relay_identity_mismatch", relay: null };
  };

  const findClaimRelay = (identity = {}) => {
    const operationId = readId(identity.operationId);
    const sessionId = readId(identity.sessionId);
    if (!operationId || !sessionId) return null;
    sweep();
    return mappedRelay(operationEntries, operationId) || mappedRelay(sessionEntries, sessionId);
  };

  const has = (relay) => {
    const relayId = readId(relay?.relayId);
    if (!relayId) return false;
    sweep();
    for (const entry of operationEntries.values()) {
      if (readId(entry?.relayId) === relayId) return true;
    }
    return false;
  };
  const release = (relay) => {
    const relayId = readId(relay?.relayId);
    if (!relayId) return;
    for (const map of [operationEntries, sessionEntries]) {
      for (const [logicalId, entry] of map.entries()) {
        if (readId(entry?.relayId) === relayId) map.delete(logicalId);
      }
    }
  };

  return { authorizeResume, claim, findClaimRelay, has, release, resolveExact, sweep };
}
