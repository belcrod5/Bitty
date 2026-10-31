import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { mutateVoiceOrchestrators, getVoiceOrchestrators, subscribeVoiceOrchestrators } from "./voiceOrchestratorClient";

const full = (etag = "metadata-1", unreadCount = 0, icon = "data:image/png;base64,large") => ({
  etag, selectedId: "main", orchestrators: [{ id: "main", name: "Main", icon, unreadCount, learningUnreadCount: 0 }],
});
const counts = (etag = "metadata-1", unreadCount = 1) => ({
  etag, notModified: true, unreadCounts: [{ id: "main", unreadCount, learningUnreadCount: 2 }],
});
function fixture() {
  let snapshot = { url: "ws://runner/runner-ws", connectionOptionsGeneration: 0, generation: 1 };
  let onUpdate: (message: { payload: unknown }) => void = () => {};
  const request = jest.fn(async (_message: unknown, options?: { onResponse?: (message: any) => void }) => {
    const response = { op: "voice.orchestrators.list.result", payload: full() };
    options?.onResponse?.(response);
    return response as { op: string; payload: unknown };
  });
  const subscribe = jest.fn((_filter: unknown, handler: typeof onUpdate) => { onUpdate = handler; return () => {}; });
  const manager = { request, subscribe, getSnapshot: () => snapshot } as unknown as RunnerWebSocketManager;
  return { manager, request, subscribe, emit: (payload: unknown) => onUpdate({ payload }),
    reconnect: () => { snapshot = { ...snapshot, generation: snapshot.generation + 1 }; },
    configure: (url = snapshot.url) => { snapshot = { ...snapshot, url,
      connectionOptionsGeneration: snapshot.connectionOptionsGeneration + 1, generation: snapshot.generation + 1 }; } };
}
function deferred(op = "voice.orchestrators.list.result") {
  let resolve!: (value: { op: string; payload: unknown }) => void;
  const promise = new Promise<{ op: string; payload: unknown }>((done) => { resolve = done; });
  return { promise, resolve: (payload: unknown) => resolve({ op, payload }) };
}

test("coalesces first-load callers and revalidates retained metadata after a real reconnect", async () => {
  const f = fixture(); const first = getVoiceOrchestrators(f.manager); const second = getVoiceOrchestrators(f.manager);
  expect(first).toBe(second);
  await first;
  expect(f.request).toHaveBeenCalledTimes(1);
  f.reconnect(); f.request.mockResolvedValueOnce({ op: "voice.orchestrators.list.result", payload: counts() });
  const resumed = await getVoiceOrchestrators(f.manager);
  expect(f.request).toHaveBeenLastCalledWith({ channel: "agent", op: "voice.orchestrators.list",
    payload: { updates: "conditional", ifNoneMatch: "metadata-1" } });
  expect(resumed.orchestrators[0]).toMatchObject({ icon: full().orchestrators[0].icon, unreadCount: 1, learningUnreadCount: 2 });
});

test("keeps metadata even without a mounted consumer and applies unread-only notifications", async () => {
  const f = fixture(); const listener = jest.fn(); const unsubscribe = subscribeVoiceOrchestrators(f.manager, listener);
  const pending = deferred(); f.request.mockReturnValueOnce(pending.promise);
  const loading = getVoiceOrchestrators(f.manager); unsubscribe();
  f.emit(full("metadata-2", 3, "changed-icon")); pending.resolve(counts("metadata-2", 3));
  expect((await loading).orchestrators[0].icon).toBe("changed-icon");
  const mounted = jest.fn(); subscribeVoiceOrchestrators(f.manager, mounted);
  f.emit(counts("metadata-2", 4));
  expect(mounted.mock.calls.at(-1)?.[0].orchestrators[0]).toMatchObject({ icon: "changed-icon", unreadCount: 4 });
  expect(listener).not.toHaveBeenCalled(); expect(f.subscribe).toHaveBeenCalledTimes(1);
});

test("a delayed list cannot overwrite newer metadata, selection, deletion or counts notifications", async () => {
  const f = fixture(); await getVoiceOrchestrators(f.manager);
  const pending = deferred(); f.request.mockReturnValueOnce(pending.promise);
  const loading = getVoiceOrchestrators(f.manager);
  f.emit({ etag: "metadata-2", selectedId: "other", orchestrators: [
    { id: "other", name: "Other", icon: "new-icon", unreadCount: 7, learningUnreadCount: 0 },
  ] });
  pending.resolve(full());
  expect(await loading).toEqual({ selectedId: "other", orchestrators: [
    { id: "other", name: "Other", icon: "new-icon", unreadCount: 7, learningUnreadCount: 0 },
  ] });
  const newer = deferred(); f.request.mockReturnValueOnce(newer.promise); const reloading = getVoiceOrchestrators(f.manager);
  f.emit({ etag: "metadata-2", notModified: true, unreadCounts: [{ id: "other", unreadCount: 9, learningUnreadCount: 1 }] });
  newer.resolve({ etag: "metadata-2", notModified: true, unreadCounts: [{ id: "other", unreadCount: 8, learningUnreadCount: 0 }] });
  expect((await reloading).orchestrators[0].unreadCount).toBe(9);
});

test("revalidates changes made while disconnected, including an icon clear", async () => {
  const f = fixture(); await getVoiceOrchestrators(f.manager); f.reconnect();
  f.request.mockResolvedValueOnce({ op: "voice.orchestrators.list.result", payload: full("metadata-2", 0, "") });
  expect((await getVoiceOrchestrators(f.manager)).orchestrators[0].icon).toBe("");
});

test.each(["same-url-token-change", "url-change"])("clears cache and rejects old responses on %s", async (kind) => {
  const f = fixture(); await getVoiceOrchestrators(f.manager);
  const old = deferred(); f.request.mockReturnValueOnce(old.promise); const outdated = getVoiceOrchestrators(f.manager);
  const rejection = expect(outdated).rejects.toThrow();
  f.configure(kind === "url-change" ? "ws://different/runner-ws" : undefined);
  f.request.mockResolvedValueOnce({ op: "voice.orchestrators.list.result", payload: full("new-scope", 0, "new-scope-icon") });
  await getVoiceOrchestrators(f.manager);
  expect(f.request.mock.calls.at(-1)?.[0]).toEqual({ channel: "agent", op: "voice.orchestrators.list", payload: { updates: "conditional" } });
  old.resolve(full("old-scope")); await rejection;
});

test("an orphaned count snapshot requests full metadata once and rejects invalid selection", async () => {
  const f = fixture(); const listener = jest.fn(); subscribeVoiceOrchestrators(f.manager, listener);
  f.emit(counts()); await Promise.resolve(); await Promise.resolve();
  expect(f.request).toHaveBeenCalledWith({ channel: "agent", op: "voice.orchestrators.list", payload: { updates: "conditional" } });
  expect(listener.mock.calls[0][0].orchestrators[0].icon).toBe(full().orchestrators[0].icon);
  f.request.mockResolvedValueOnce({ op: "voice.orchestrators.list.result", payload: { ...full(), selectedId: "missing" } });
  await expect(getVoiceOrchestrators(f.manager)).rejects.toThrow();
});

test("old servers keep returning full lists without validators", async () => {
  const f = fixture(); const { etag: _etag, ...legacy } = full();
  f.request.mockResolvedValue({ op: "voice.orchestrators.list.result", payload: legacy });
  await getVoiceOrchestrators(f.manager); await getVoiceOrchestrators(f.manager);
  expect(f.request.mock.calls.at(-1)?.[0]).toEqual({ channel: "agent", op: "voice.orchestrators.list", payload: { updates: "conditional" } });
});


test("mutation results invalidate pending reads before their broadcast arrives", async () => {
  const f = fixture(); await getVoiceOrchestrators(f.manager);
  const old = deferred(); f.request.mockReturnValueOnce(old.promise); const loading = getVoiceOrchestrators(f.manager);
  f.request.mockImplementationOnce(async (_message, options) => {
    const response = { op: "voice.orchestrators.update.result", payload: full("metadata-2", 3, "edited") };
    options?.onResponse?.(response); return response;
  });
  await mutateVoiceOrchestrators(f.manager, "update", { orchestratorId: "main" });
  old.resolve(full());
  expect((await loading).orchestrators[0].icon).toBe("edited");
  f.request.mockResolvedValueOnce({ op: "voice.orchestrators.list.result", payload: counts("metadata-2", 4) });
  expect((await getVoiceOrchestrators(f.manager)).orchestrators[0].icon).toBe("edited");
});

test("missing metadata during a pending conditional read starts an independent full verification", async () => {
  const f = fixture(); await getVoiceOrchestrators(f.manager);
  const old = deferred(); f.request.mockReturnValueOnce(old.promise); const loading = getVoiceOrchestrators(f.manager);
  f.request.mockResolvedValueOnce({ op: "voice.orchestrators.list.result", payload: full("metadata-2", 7, "fresh") });
  f.emit(counts("metadata-2", 7));
  expect(f.request).toHaveBeenCalledTimes(3);
  expect(f.request.mock.calls.at(-1)?.[0]).toEqual({ channel: "agent", op: "voice.orchestrators.list", payload: { updates: "conditional" } });
  await Promise.resolve(); await Promise.resolve();
  old.resolve(full());
  expect((await loading).orchestrators[0]).toMatchObject({ icon: "fresh", unreadCount: 7 });
});


test("repeated orphaned notifications share the full verification already in progress", async () => {
  const f = fixture(); const pending = deferred(); f.request.mockReturnValueOnce(pending.promise);
  subscribeVoiceOrchestrators(f.manager, jest.fn());
  for (let i = 0; i < 10; i++) f.emit(counts("unseen"));
  expect(f.request).toHaveBeenCalledTimes(1);
  pending.resolve(full("unseen")); await Promise.resolve(); await Promise.resolve();
});


test("credential replacement retires the old metadata subscription as well as its requests", async () => {
  const f = fixture(); const listener = jest.fn(); subscribeVoiceOrchestrators(f.manager, listener);
  await getVoiceOrchestrators(f.manager);
  const oldHandler = f.subscribe.mock.calls[0][1];
  f.configure();
  f.request.mockResolvedValueOnce({ op: "voice.orchestrators.list.result", payload: full("new-scope", 1, "new") });
  await getVoiceOrchestrators(f.manager);
  oldHandler({ payload: full("old", 99, "old") });
  f.emit(counts("new-scope", 2));
  expect(listener.mock.calls.at(-1)?.[0].orchestrators[0]).toMatchObject({ icon: "new", unreadCount: 2 });
  expect(f.subscribe).toHaveBeenCalledTimes(2);
});

test.each(["url-change", "credential-change"])("an old mutation cannot poison the new source's pending read on %s", async (kind) => {
  const f = fixture(); await getVoiceOrchestrators(f.manager);
  const oldResponse = deferred("voice.orchestrators.update.result");
  f.request.mockReturnValueOnce(oldResponse.promise);
  const mutation = mutateVoiceOrchestrators(f.manager, "update", { orchestratorId: "main", name: "Edited" }).catch(() => {});
  const mutationOptions = f.request.mock.calls.at(-1)?.[1];
  const freshResponse = deferred();
  let freshRead!: ReturnType<typeof getVoiceOrchestrators>;
  queueMicrotask(() => {
    f.configure(kind === "url-change" ? "ws://different/runner-ws" : undefined);
    f.request.mockReturnValueOnce(freshResponse.promise);
    freshRead = getVoiceOrchestrators(f.manager);
  });
  queueMicrotask(() => {
    try { mutationOptions?.onResponse?.({ op: "voice.orchestrators.update.result", payload: full("old-mutation", 0, "old-mutation-icon") }); } catch {}
    oldResponse.resolve(full("old-mutation", 0, "old-mutation-icon"));
  });
  await mutation;
  freshResponse.resolve(full("new-source", 0, "new-source-icon"));
  expect((await freshRead).orchestrators[0].icon).toBe("new-source-icon");
  const mounted = jest.fn(); subscribeVoiceOrchestrators(f.manager, mounted);
  expect(mounted.mock.calls.at(-1)?.[0].orchestrators[0].icon).toBe("new-source-icon");
});

test.each(["select", "create", "update", "delete"] as const)("%s publishes a valid legacy full mutation once without a validator", async (action) => {
  const f = fixture(); await getVoiceOrchestrators(f.manager);
  const listener = jest.fn(); subscribeVoiceOrchestrators(f.manager, listener); listener.mockClear();
  const { etag: _etag, ...legacy } = full("ignored", 2, "edited");
  f.request.mockImplementationOnce(async (_message, options) => {
    const response = { op: `voice.orchestrators.${action}.result`, payload: legacy };
    options?.onResponse?.(response); return response;
  });
  await mutateVoiceOrchestrators(f.manager, action, { orchestratorId: "main" });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(legacy, true);
});

test.each([
  { op: "error", payload: { message: "保存エラー" } },
  { op: "unexpected", payload: full() },
  { op: "voice.orchestrators.update.result", payload: { ...full(), orchestratorId: "another" } },
  { op: "voice.orchestrators.update.result", payload: { ...full(), selectedId: "missing" } },
])("invalid mutation response never changes the published list: $op", async (response) => {
  const f = fixture(); await getVoiceOrchestrators(f.manager);
  const listener = jest.fn(); subscribeVoiceOrchestrators(f.manager, listener); listener.mockClear();
  f.request.mockImplementationOnce(async (_message, options) => { options?.onResponse?.(response); return response; });
  await expect(mutateVoiceOrchestrators(f.manager, "update", { orchestratorId: "main" })).rejects.toThrow();
  expect(listener).not.toHaveBeenCalled();
  const mounted = jest.fn(); subscribeVoiceOrchestrators(f.manager, mounted);
  expect(mounted.mock.calls[0][0].orchestrators[0].icon).toBe(full().orchestrators[0].icon);
});
