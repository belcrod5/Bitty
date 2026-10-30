import { parseLlmSessionRelationship } from "./llm-session-metadata.mjs";

// Normalize native child relationships and activity once for the neutral and
// raw adapters. Ordinary item completion says nothing about a child list.
export function createCodexSessionChildrenObserver({ resolveSession, onChanged = () => {} }) {
  const children = new Map();
  const pending = new Map();
  function changed(childId, parentId, status = "") {
    if (!childId || !parentId || childId === parentId) return;
    const previous = children.get(childId);
    const nextStatus = status || previous?.status || "";
    if (previous?.parentId === parentId && previous.status === nextStatus) return;
    children.set(childId, { parentId, status: nextStatus });
    if (previous?.parentId && previous.parentId !== parentId) onChanged({ backendId: "codex", nativeSessionId: previous.parentId });
    onChanged({ backendId: "codex", nativeSessionId: parentId });
  }
  async function observeChild(childId, status, explicitParent = "") {
    if (!childId) return;
    const token = {};
    pending.set(childId, token);
    try {
      const parentId = explicitParent || children.get(childId)?.parentId
        || (await resolveSession(childId))?.parentSessionRef?.nativeSessionId;
      // Relationship resolution may finish after a newer native state.
      if (pending.get(childId) === token) changed(childId, String(parentId || ""), status);
    } finally {
      if (pending.get(childId) === token) pending.delete(childId);
    }
  }
  return async (method, params = {}) => {
    if (method === "thread/started") {
      const thread = params.thread || {};
      const parentId = parseLlmSessionRelationship(thread).parentSessionId;
      if (parentId) await observeChild(String(thread.id || ""), "", parentId);
      return;
    }
    if ((method === "item/started" || method === "item/completed") && params.item?.type === "collabAgentToolCall") {
      const item = params.item;
      // Sending input, waiting, resuming or closing an agent does not reparent it.
      const spawnedParent = item.tool === "spawnAgent"
        ? String(item.senderThreadId || params.threadId || params.thread_id || "").trim() : "";
      const states = item.agentsStates || {};
      const receivers = new Set([...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []), ...Object.keys(states)]);
      await Promise.all([...receivers].map((childId) => observeChild(String(childId), String(states[childId]?.status || ""), spawnedParent)));
      return;
    }
    if (method !== "thread/status/changed" && method !== "turn/completed") return;
    const childId = String(params.threadId || params.thread_id || "").trim();
    const status = method === "turn/completed" ? "turnCompleted"
      : String(params.status?.type || params.status || params.thread?.status?.type || "");
    if (status) await observeChild(childId, status);
  };
}
