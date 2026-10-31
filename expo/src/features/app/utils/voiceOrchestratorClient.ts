import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { VoiceOrchestrator } from "../components/VoiceOrchestratorIcon";

export type VoiceOrchestratorList = { orchestrators: VoiceOrchestrator[]; selectedId: string };
type Manager = Pick<RunnerWebSocketManager, "request" | "subscribe" | "getSnapshot">;
type State = {
  scope: string;
  revision: number;
  requestNumber: number;
  list: VoiceOrchestratorList | null;
  etag: string;
  pending?: { generation: number; etag: string; promise: Promise<VoiceOrchestratorList> };
  listeners: Set<(list: VoiceOrchestratorList, fromMutation: boolean) => void>;
  unsubscribe: () => void;
};
const states = new WeakMap<Manager, State>();
const failure = () => new Error("オーケストレーターを読み込めません。");

function stateFor(manager: Manager) {
  const snapshot = manager.getSnapshot();
  const scope = JSON.stringify([snapshot.url, snapshot.connectionOptionsGeneration]);
  let state = states.get(manager);
  if (state?.scope === scope) return state;
  if (!state) {
    state = { scope, revision: 0, requestNumber: 0, list: null, etag: "", listeners: new Set(), unsubscribe: () => {} };
    states.set(manager, state);
  } else {
    state.unsubscribe();
    state.scope = scope;
    state.revision += 1;
    state.list = null;
    state.etag = "";
    state.pending = undefined;
  }
  const current = state;
  // Keep metadata synchronized while screens unmount, but replace the source on
  // credential changes so an old connection cannot populate the new scope.
  state.unsubscribe = manager.subscribe({ channel: "agent", op: "voice.unread.changed" }, (message) => {
    if (stateFor(manager).scope !== scope) return;
    try { apply(current, message.payload); }
    catch {
      if (!(message.payload as { notModified?: unknown } | null)?.notModified) return;
      current.etag = "";
      if (current.pending && !current.pending.etag
        && current.pending.generation === manager.getSnapshot().generation) return;
      current.pending = undefined;
      void getVoiceOrchestrators(manager).catch(() => {});
      return;
    }
  });
  return state;
}

function apply(state: State, payload: unknown, fromMutation = false): VoiceOrchestratorList {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure();
  const value = payload as Record<string, unknown>;
  let list: VoiceOrchestratorList;
  if (value.notModified === true) {
    if (!state.list || !state.etag || state.etag !== value.etag || !Array.isArray(value.unreadCounts)
      || value.unreadCounts.length !== state.list.orchestrators.length) throw failure();
    const counts = new Map<string, { unreadCount: number; learningUnreadCount: number }>();
    for (const item of value.unreadCounts) {
      if (!item || typeof item.id !== "string" || counts.has(item.id)
        || !Number.isSafeInteger(item.unreadCount) || item.unreadCount < 0
        || !Number.isSafeInteger(item.learningUnreadCount) || item.learningUnreadCount < 0) throw failure();
      counts.set(item.id, item);
    }
    list = { ...state.list, orchestrators: state.list.orchestrators.map((item) => {
      const count = counts.get(item.id);
      if (!count) throw failure();
      return { ...item, unreadCount: count.unreadCount, learningUnreadCount: count.learningUnreadCount };
    }) };
  } else {
    if (!Array.isArray(value.orchestrators) || typeof value.selectedId !== "string"
      || !value.orchestrators.every((item) => item && typeof item.id === "string" && typeof item.name === "string")
      || new Set(value.orchestrators.map((item) => item.id)).size !== value.orchestrators.length
      || (value.orchestrators.length ? !value.orchestrators.some((item) => item.id === value.selectedId)
        : value.selectedId !== "")) throw failure();
    list = { selectedId: value.selectedId, orchestrators: value.orchestrators.map((item) => ({
      ...item, icon: typeof item.icon === "string" ? item.icon : "",
    })) };
  }
  state.list = list;
  state.etag = typeof value.etag === "string" ? value.etag : "";
  state.revision += 1;
  for (const listener of state.listeners) {
    try { listener(list, fromMutation); } catch { /* one observer cannot block the remaining observers */ }
  }
  return list;
}

// The metadata survives reconnects; each request still validates it and retrieves current counts.
export function getVoiceOrchestrators(manager: Manager): Promise<VoiceOrchestratorList> {
  const state = stateFor(manager);
  const generation = manager.getSnapshot().generation;
  if (state.pending && state.pending.generation === generation) return state.pending.promise;
  const scope = state.scope;
  const requestNumber = ++state.requestNumber;
  const etag = state.etag;
  const revision = state.revision;
  const task = (async () => {
    const response = await manager.request({ channel: "agent", op: "voice.orchestrators.list",
      payload: { updates: "conditional", ...(etag ? { ifNoneMatch: etag } : {}) } });
    if (stateFor(manager).scope !== scope || manager.getSnapshot().generation !== generation) throw failure();
    if (state.requestNumber !== requestNumber || revision !== state.revision) {
      if (state.list) return state.list;
      throw failure();
    }
    if (response.op !== "voice.orchestrators.list.result") throw failure();
    return apply(state, response.payload);
  })();
  state.pending = { generation, etag, promise: task };
  void task.finally(() => { if (state.pending?.promise === task) state.pending = undefined; }).catch(() => {});
  return task;
}

export function subscribeVoiceOrchestrators(manager: Manager, listener: (list: VoiceOrchestratorList, fromMutation: boolean) => void) {
  const state = stateFor(manager);
  state.listeners.add(listener);
  if (state.list) listener(state.list, false);
  return () => { state.listeners.delete(listener); };
}

// Commit mutation results at response delivery, before later notifications. An
// old source must never invalidate a fresh source's in-flight list read.
export async function mutateVoiceOrchestrators(manager: Manager,
  action: "select" | "create" | "update" | "delete", payload: Record<string, unknown>) {
  const state = stateFor(manager);
  const scope = state.scope, generation = manager.getSnapshot().generation;
  const assertCurrentSource = () => {
    if (stateFor(manager).scope !== scope || manager.getSnapshot().generation !== generation) throw failure();
  };
  const op = `voice.orchestrators.${action}`;
  await manager.request({ channel: "agent", op, payload }, { onResponse: (response) => {
    assertCurrentSource();
    const result = response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)
      ? response.payload as Record<string, unknown> : {};
    if (response.op === "error") throw new Error(String(result.message || result.code || "操作に失敗しました。"));
    if (response.op !== `${op}.result`) throw failure();
    if (payload.orchestratorId !== undefined && result.orchestratorId !== undefined
      && result.orchestratorId !== payload.orchestratorId) throw failure();
    apply(state, response.payload, true);
  } });
  assertCurrentSource();
}
