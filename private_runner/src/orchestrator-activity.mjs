import { randomUUID } from "node:crypto";

const TOOL_TYPES = new Set([
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView",
]);
const TOOL_LABELS = {
  commandExecution: "コマンド", fileChange: "ファイル編集", collabAgentToolCall: "サブエージェント",
  webSearch: "検索", imageView: "画像確認", mcpToolCall: "MCP ツール", dynamicToolCall: "ツール",
};
const FINISHED_FOR_MS = 1_000;
const LOOKUP_FOR_MS = 1_000;

export function createOrchestratorActivity({ broadcast = () => {}, now = () => Date.now() } = {}) {
  const instanceId = randomUUID();
  const roots = new Map();
  const descendants = new Map();
  const resolving = new Map();
  const activities = new Map();
  let revision = 0;
  let expiryTimer = null;

  function snapshot() {
    return { instanceId, revision, activities: [...activities.values()].filter((item) => item.orchestratorId).map(({
      unsubscribe, expiresAt, nativeKey, runToolKey, runKey, rootId, threadId, turnId, ...item
    }) => item) };
  }

  function changed() {
    revision++;
    try { broadcast(snapshot()); } catch {}
  }

  function scheduleExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer);
    const next = Math.min(...[...activities.values()].map((item) => item.expiresAt).filter(Number.isFinite));
    if (!Number.isFinite(next)) { expiryTimer = null; return; }
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      let removed = false;
      for (const [id, item] of activities) {
        if (item.expiresAt && item.expiresAt <= now()) { activities.delete(id); removed ||= Boolean(item.orchestratorId); }
      }
      if (removed) changed();
      scheduleExpiry();
    }, Math.max(0, next - now()));
    expiryTimer.unref?.();
  }

  async function findRoot(threadId) {
    if (roots.has(threadId)) return threadId;
    const cached = descendants.get(threadId);
    if (cached && roots.has(cached)) return cached;
    if (resolving.has(threadId)) return resolving.get(threadId);
    const task = (async () => {
      const deadline = now() + LOOKUP_FOR_MS;
      for (const { client } of roots.values()) {
        let current = threadId;
        const visited = new Set();
        for (let depth = 0; depth <= 10 && !visited.has(current) && now() < deadline; depth++) {
          visited.add(current);
          if (roots.has(current)) {
            for (const child of visited) descendants.set(child, current);
            return current;
          }
          if (depth === 10) break;
          let read;
          try { read = await client.request("thread/read", { threadId: current, includeTurns: false }, Math.max(1, deadline - now())); }
          catch { break; }
          if (read?.thread?.id !== current) break;
          const parent = read.thread.parentThreadId;
          if (typeof parent !== "string" || !parent || parent === current) break;
          current = parent;
        }
      }
      return null;
    })();
    resolving.set(threadId, task);
    try { return await task; } finally { resolving.delete(threadId); }
  }

  async function assignActor(item, caller) {
    if (!caller || !activities.has(item.id)) return;
    const rootId = await findRoot(caller);
    if (!rootId || !activities.has(item.id)) return;
    const root = roots.get(rootId);
    if (!root || item.orchestratorId === root.orchestratorId) return;
    item.orchestratorId = root.orchestratorId;
    if (item.runKey) for (const tool of activities.values()) {
      if (tool.runToolKey?.startsWith(`${item.runKey}\0`)) {
        tool.orchestratorId = root.orchestratorId;
        if (item.sessionRef) tool.sessionRef = item.sessionRef;
      }
    }
    changed();
  }

  function begin(id, { caller, sessionRef, kind, label, nativeKey, runToolKey, runKey, rootId, threadId, turnId }) {
    if (activities.has(id)) return activities.get(id);
    const item = { id, orchestratorId: roots.get(caller)?.orchestratorId || null,
      ...(sessionRef ? { sessionRef } : {}),
      kind, status: "running", label, startedAt: new Date(now()).toISOString(),
      ...(nativeKey ? { nativeKey, rootId, threadId, turnId } : {}),
      ...(runToolKey ? { runToolKey } : {}) };
    if (runKey) item.runKey = runKey;
    activities.set(id, item);
    if (item.orchestratorId) changed();
    void assignActor(item, caller).catch(() => {});
    return item;
  }

  function finish(id, status = "completed") {
    const item = activities.get(id);
    if (!item || item.expiresAt) return;
    item.status = status;
    try { item.unsubscribe?.(); } catch {}
    delete item.unsubscribe;
    item.expiresAt = now() + FINISHED_FOR_MS;
    if (item.orchestratorId) changed();
    scheduleExpiry();
  }

  function observeHttp(req, res, { kind = "http", label, sessionRef } = {}) {
    const caller = String(req.headers?.["x-bitty-display-caller"] || "").trim();
    if (!caller || typeof res.once !== "function") return;
    const id = `http:${randomUUID()}`;
    begin(id, { caller, kind, label, sessionRef });
    let ended = false;
    const end = (status) => {
      if (ended) return;
      ended = true;
      res.removeListener?.("finish", onFinish);
      res.removeListener?.("close", onClose);
      finish(id, status);
    };
    const onFinish = () => end(Number(res.statusCode) >= 400 ? "failed" : "completed");
    const onClose = () => end("interrupted");
    res.once("finish", onFinish);
    res.once("close", onClose);
  }

  function startRunRequest(caller, sessionRef) {
    if (!caller) return "";
    const id = `request:${randomUUID()}`;
    begin(id, { caller, sessionRef, kind: "run", label: sessionRef ? "会話中" : "開始中" });
    return id;
  }

  function observeRun({ runId, caller, sessionRef, service, subjectId, result, pendingId }) {
    if (!caller || !runId) return;
    const existingRun = [...activities.values()].find((candidate) => candidate.runKey === runId);
    const pending = activities.get(pendingId);
    const id = existingRun?.id || pending?.id || `run:${randomUUID()}`;
    if (pending && !existingRun) {
      pending.label = "会話中";
      pending.runKey = runId;
      if (pending.orchestratorId) changed();
    } else if (pending) {
      activities.delete(pendingId);
      if (pending.orchestratorId) changed();
    }
    const item = begin(id, { caller, sessionRef, kind: "run", label: "会話中", runKey: runId });
    if (item.unsubscribe || item.expiresAt) return;
    try {
      const subscription = service.subscribe(runId, { actionConsumerId: null, onEvent: (event) => {
        try {
          if (event.type === "session.resolved" && event.sessionRef && !item.expiresAt) {
            item.sessionRef = event.sessionRef;
            for (const tool of activities.values()) {
              if (tool.runToolKey?.startsWith(`${runId}\0`)) tool.sessionRef = event.sessionRef;
            }
            if (item.orchestratorId) changed();
          } else if (["tool.started", "tool.completed", "item.started", "item.completed"].includes(event.type)) {
            const payload = event.payload || {};
            const isTool = event.type.startsWith("tool.");
            const sourceId = String(isTool ? payload.toolCallId || "" : payload.itemId || "");
            const itemType = String(payload.itemType || "");
            if (!sourceId || (!isTool && (!TOOL_TYPES.has(itemType) || itemType === "commandExecution"))) return;
            const runToolKey = `${runId}\0${isTool ? "tool" : "item"}\0${sourceId}`;
            const label = isTool
              ? String(payload.name || "") === "exec_command" ? "コマンド" : String(payload.name || "ツール").slice(0, 80)
              : TOOL_LABELS[itemType];
            const tool = [...activities.values()].find((candidate) => candidate.runToolKey === runToolKey)
              || begin(`tool:${randomUUID()}`, { caller, sessionRef: item.sessionRef, kind: "tool", label, runToolKey });
            if (item.orchestratorId && tool.orchestratorId !== item.orchestratorId) {
              tool.orchestratorId = item.orchestratorId;
              if (item.orchestratorId) changed();
            }
            if (event.type.endsWith("completed")) {
              finish(tool.id, String(payload.status || "").toLowerCase() === "failed"
                || (Number.isFinite(payload.exitCode) && payload.exitCode !== 0) ? "failed" : "completed");
            }
          } else if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) {
            for (const tool of activities.values()) {
              if (tool.runToolKey?.startsWith(`${runId}\0`) && !tool.expiresAt) finish(tool.id, "unknown");
            }
            finish(id, event.type.slice(5));
          }
        } catch {}
      } }, { subjectId });
      item.unsubscribe = () => subscription.unsubscribe();
      if (item.expiresAt) { try { item.unsubscribe(); } catch {} delete item.unsubscribe; }
      else if (result) finish(id, result.outcome || "completed");
    } catch { finish(id, result?.outcome || "unknown"); }
  }

  function registerRoot({ threadId, orchestratorId, client }) {
    const registration = { orchestratorId, client };
    const remove = client.addNotificationListener((method, params) => {
      try {
        if (method !== "item/started" && method !== "item/completed"
          && method !== "turn/completed" && method !== "turn/interrupted") return;
        const sourceThread = String(params?.threadId || "");
        if (!sourceThread) return;
        const type = String(params?.item?.type || "");
        const itemId = String(params?.item?.id || "");
        const turnId = String(method.startsWith("turn/") ? params?.turn?.id || params?.turnId || ""
          : params?.turnId || "");
        if (!method.startsWith("turn/") && (!TOOL_TYPES.has(type) || !itemId || !turnId)) return;
        void findRoot(sourceThread).then((ownerRoot) => {
          if (ownerRoot !== threadId || roots.get(threadId) !== registration) return;
          if (method.startsWith("turn/")) {
            for (const item of activities.values()) {
              if (item.rootId === threadId && item.threadId === sourceThread && item.turnId === turnId && !item.expiresAt) {
                finish(item.id, method === "turn/interrupted" ? "interrupted" : "unknown");
              }
            }
            return;
          }
          const nativeKey = `${sourceThread}\0${turnId}\0${itemId}`;
          let found = [...activities.values()].find((item) => item.nativeKey === nativeKey);
          if (!found) {
            found = begin(`tool:${randomUUID()}`, { caller: sourceThread, kind: "tool",
              label: type === "mcpToolCall" || type === "dynamicToolCall"
                ? String(params.item.toolName || params.item.name || TOOL_LABELS[type]).slice(0, 80) : TOOL_LABELS[type],
              nativeKey, rootId: threadId, threadId: sourceThread, turnId });
          }
          if (method === "item/completed") {
            const status = String(params.item.status || "").toLowerCase();
            const exitCode = params.item.exitCode ?? params.item.exit_code;
            finish(found.id, status === "failed" || status === "declined"
              || (Number.isFinite(exitCode) && exitCode !== 0)
              ? "failed" : status === "interrupted" || status === "cancelled" ? "interrupted" : "completed");
          }
        }).catch(() => {});
      } catch {}
    });
    roots.set(threadId, registration);
    return () => {
      remove();
      if (roots.get(threadId) !== registration) return;
      roots.delete(threadId);
      for (const [child, root] of descendants) if (root === threadId) descendants.delete(child);
      for (const item of activities.values()) if (item.rootId === threadId && !item.expiresAt) finish(item.id, "unknown");
    };
  }

  return { snapshot, observeHttp, startRunRequest, observeRun, finishRunRequest: finish, registerRoot };
}
