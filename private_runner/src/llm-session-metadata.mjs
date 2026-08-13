export function parseLlmSessionRelationship(payloadRaw) {
  const payload = payloadRaw && typeof payloadRaw === "object" ? payloadRaw : {};
  const source = payload.source && typeof payload.source === "object" ? payload.source : {};
  const parentSessionId = String(payload.parent_thread_id || payload.forked_from_id || "").trim();
  return {
    isSubagent: Boolean(
      source.subagent
      || source.subAgent
      || String(payload.thread_source || "").trim().toLowerCase() === "subagent"
      || parentSessionId
    ),
    parentSessionId,
  };
}
