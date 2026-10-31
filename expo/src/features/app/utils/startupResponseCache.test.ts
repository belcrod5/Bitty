import * as FileSystem from "expo-file-system/legacy";
import * as Crypto from "expo-crypto";
import { readRunnerResponseCache, writeRunnerResponseCache } from "./runnerResponseCache";
import { runnerConnectionIdentity, runnerResponseCacheKey } from "../../runnerWs/runnerConnectionIdentity";
import { getVoiceOrchestrators, mutateVoiceOrchestrators, subscribeVoiceOrchestrators } from "./voiceOrchestratorClient";
import { requestRunnerClientState, type RunnerClientStateCache } from "./runnerClientState";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";

const mockFiles = new Map<string, string>();
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "cache/",
  readAsStringAsync: jest.fn(async (path) => { if (!mockFiles.has(path)) throw new Error("missing"); return mockFiles.get(path); }),
  writeAsStringAsync: jest.fn(async (path, text) => { mockFiles.set(path, text); }),
  moveAsync: jest.fn(async ({ from, to }) => { mockFiles.set(to, mockFiles.get(from)!); mockFiles.delete(from); }),
  deleteAsync: jest.fn(async (path) => { mockFiles.delete(path); }),
}));
jest.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "sha256" },
  digestStringAsync: jest.fn(async (_algorithm, text) => require("node:crypto").createHash("sha256").update(text).digest("hex")),
}));
const body = { selectedId: "main", orchestrators: [{ id: "main", name: "Main", icon: "large-image", unreadCount: 0, learningUnreadCount: 0 }] };
const full = (etag = "one") => ({ ...body, etag });
const counts = (unreadCount = 7) => ({ notModified: true, etag: "one", unreadCounts: [{ id: "main", unreadCount, learningUnreadCount: 2 }] });
function voice(key = "runner-one") {
  let update: (message: any) => void = () => {};
  const request = jest.fn(async (_message: any, options?: any) => {
    const response = { op: "voice.orchestrators.list.result", payload: full() };
    options?.onResponse?.(response);
    return response as any;
  });
  const manager = { request, getResponseCacheKey: async () => key,
    getSnapshot: () => ({ url: "ws://runner/runner-ws", generation: 1, connectionOptionsGeneration: 1 }),
    subscribe: (_filter: unknown, listener: typeof update) => { update = listener; return () => {}; },
  } as unknown as RunnerWebSocketManager;
  return { manager, request, emit: (payload: unknown) => update({ payload }) };
}
const snapshot = (revision = 1) => ({ revision, titleModelId: "model", titleReasoningEffort: "low", directories: [], sessions: {}, composerHistory: ["history"], drafts: {} });
const response = (value: unknown, etag = '"state-one"', status = 200) => ({ ok: status === 200, status,
  headers: { get: () => etag }, json: async () => ({ snapshot: value }),
}) as unknown as Response;
const auth = { runnerUrl: "https://runner", runnerToken: "private-token", connectionIdentity: '["https://runner","private-token"]' };

beforeEach(() => { mockFiles.clear(); jest.clearAllMocks(); });
afterEach(() => jest.restoreAllMocks());

test("configured local/Cloudflare routes and HTTP/WS share identity; another Runner or token does not", () => {
  const id = runnerConnectionIdentity("http://local:123", "token", "http://local:123", "https://remote");
  expect(runnerConnectionIdentity("wss://remote/runner-ws", "token", "http://local:123", "https://remote")).toBe(id);
  expect(runnerConnectionIdentity("ws://local:123/runner-ws", "token", "http://local:123", "https://remote")).toBe(id);
  expect(runnerConnectionIdentity("https://other", "token", "http://local:123", "https://remote")).not.toBe(id);
  expect(runnerConnectionIdentity("https://remote", "new", "http://local:123", "https://remote")).not.toBe(id);
  expect(() => runnerConnectionIdentity("ws://%", "token")).not.toThrow();
});

test("disk cache is bounded, integrity checked, versioned and never stores the identity/token", async () => {
  const key = (await runnerResponseCacheKey(auth.connectionIdentity))!;
  await writeRunnerResponseCache("client-state", key, { etag: "one", body: snapshot() });
  expect([...mockFiles.values()].join()).not.toContain("private-token");
  expect(await readRunnerResponseCache("client-state", key)).toEqual({ etag: "one", body: snapshot() });
  expect(await readRunnerResponseCache("client-state", "different")).toBeNull();
  expect(await readRunnerResponseCache("voice-orchestrators", key)).toBeNull();
  const path = "cache/runner-client-state.json", raw = mockFiles.get(path)!;
  mockFiles.set(path, raw.replace('"revision":1', '"revision":2'));
  expect(await readRunnerResponseCache("client-state", key)).toBeNull();
  mockFiles.set(path, raw.replace('"version":1', '"version":2'));
  expect(await readRunnerResponseCache("client-state", key)).toBeNull();
  await writeRunnerResponseCache("client-state", "new-runner", { etag: "two", body: snapshot(2) });
  expect(mockFiles.size).toBe(1);
});

test("a new voice owner restores the pair but publishes only fresh server counts", async () => {
  const first = voice(); await getVoiceOrchestrators(first.manager);
  const next = voice(); let deliver!: (value: any) => void;
  next.request.mockReturnValueOnce(new Promise((resolve) => { deliver = resolve; }));
  const loaded = getVoiceOrchestrators(next.manager);
  // A disk read barrier finishes after the restore IO, before network completion.
  await readRunnerResponseCache("voice-orchestrators", "runner-one");
  for (let i = 0; i < 100 && !next.request.mock.calls.length; i++) await Promise.resolve();
  const listener = jest.fn(); subscribeVoiceOrchestrators(next.manager, listener);
  expect(listener).not.toHaveBeenCalled();
  expect(next.request.mock.calls[0][0].payload.ifNoneMatch).toBe("one");
  const writes = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls.length;
  deliver({ op: "voice.orchestrators.list.result", payload: counts(9) });
  expect((await loaded).orchestrators[0]).toMatchObject({ icon: "large-image", unreadCount: 9, learningUnreadCount: 2 });
  expect(listener).toHaveBeenCalledTimes(1);
  await readRunnerResponseCache("voice-orchestrators", "runner-one");
  expect(FileSystem.writeAsStringAsync).toHaveBeenCalledTimes(writes);
});

test("new notification during restore wins over disk and the older list response", async () => {
  await writeRunnerResponseCache("voice-orchestrators", "runner-one", { etag: "one", body });
  const read = FileSystem.readAsStringAsync as jest.Mock;
  let release!: (value: string) => void;
  read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const f = voice(); const loading = getVoiceOrchestrators(f.manager);
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  f.emit({ ...full("two"), orchestrators: [{ ...body.orchestrators[0], icon: "new", unreadCount: 11 }] });
  release(mockFiles.get("cache/runner-voice-orchestrators.json")!);
  expect((await loading).orchestrators[0]).toMatchObject({ icon: "new", unreadCount: 11 });
});

test("a completed voice mutation during restore cannot be rolled back", async () => {
  await writeRunnerResponseCache("voice-orchestrators", "runner-one", { etag: "one", body });
  const f = voice(); const loading = getVoiceOrchestrators(f.manager);
  f.request.mockImplementationOnce(async (_message, options) => {
    const result = { op: "voice.orchestrators.update.result", payload: { ...full("two"), orchestrators: [{ ...body.orchestrators[0], icon: "edited" }] } };
    options.onResponse(result); return result;
  });
  await mutateVoiceOrchestrators(f.manager, "update", { orchestratorId: "main" });
  expect((await loading).orchestrators[0].icon).toBe("edited");
});

test.each(["different-runner", "changed-token"])("voice never restores another identity: %s", async (identity) => {
  await writeRunnerResponseCache("voice-orchestrators", "runner-one", { etag: "one", body });
  const f = voice(identity); await getVoiceOrchestrators(f.manager);
  expect(f.request.mock.calls[0][0].payload.ifNoneMatch).toBeUndefined();
});

test("client-state survives a new memory cache and revalidates before returning a body", async () => {
  const fetch = jest.spyOn(global, "fetch").mockResolvedValueOnce(response(snapshot()))
    .mockResolvedValueOnce(response(undefined, '"state-one"', 304)).mockResolvedValueOnce(response(snapshot(2), '"state-two"'));
  await requestRunnerClientState({ ...auth, cache: {} });
  const cache: RunnerClientStateCache = {};
  expect(await requestRunnerClientState({ ...auth, cache })).toEqual(snapshot());
  expect((fetch.mock.calls[1][1]!.headers as any)["if-none-match"]).toBe('"state-one"');
  expect((await requestRunnerClientState({ ...auth, cache })).revision).toBe(2);
});

test("invalid persisted domain data falls back to a full client-state read", async () => {
  const key = (await runnerResponseCacheKey(auth.connectionIdentity))!;
  await writeRunnerResponseCache("client-state", key, { etag: "bad", body: { ...snapshot(), drafts: { bad: { text: "oops", updatedAt: 1 } } } });
  const fetch = jest.spyOn(global, "fetch").mockResolvedValue(response(snapshot()));
  await requestRunnerClientState({ ...auth, cache: {} });
  expect((fetch.mock.calls[0][1]!.headers as any)["if-none-match"]).toBeUndefined();
});

test("failed revalidation never exposes disk data; retry still uses its validator", async () => {
  const key = (await runnerResponseCacheKey(auth.connectionIdentity))!;
  await writeRunnerResponseCache("client-state", key, { etag: '"state-one"', body: snapshot() });
  const fetch = jest.spyOn(global, "fetch").mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response(snapshot(2)));
  const cache = {};
  await expect(requestRunnerClientState({ ...auth, cache })).rejects.toThrow("offline");
  expect((await requestRunnerClientState({ ...auth, cache })).revision).toBe(2);
  expect((fetch.mock.calls[1][1]!.headers as any)["if-none-match"]).toBe('"state-one"');
});

test("unavailable crypto or disk never prevents the authoritative read", async () => {
  (Crypto.digestStringAsync as jest.Mock).mockRejectedValueOnce(new Error("unavailable"));
  const fetch = jest.spyOn(global, "fetch").mockResolvedValue(response(snapshot()));
  expect(await requestRunnerClientState({ ...auth, cache: {} })).toEqual(snapshot());
  expect((fetch.mock.calls[0][1]!.headers as any)["if-none-match"]).toBeUndefined();
});

test("local/Cloudflare route switches reuse the same client-state pair in memory and after restart", async () => {
  const fetch = jest.spyOn(global, "fetch").mockResolvedValueOnce(response(snapshot()))
    .mockResolvedValue(response(undefined, '"state-one"', 304));
  const cache: RunnerClientStateCache = {};
  await requestRunnerClientState({ ...auth, cache });
  await requestRunnerClientState({ ...auth, runnerUrl: "http://local", cache });
  await requestRunnerClientState({ ...auth, runnerUrl: "http://local", cache: {} });
  expect(fetch.mock.calls.slice(1).map((call) => (call[1]!.headers as any)["if-none-match"])).toEqual(['"state-one"', '"state-one"']);
});

test("legacy responses without validators discard the persisted pair", async () => {
  const first = voice(); await getVoiceOrchestrators(first.manager);
  first.request.mockResolvedValueOnce({ op: "voice.orchestrators.list.result", payload: body });
  await getVoiceOrchestrators(first.manager);
  expect(await readRunnerResponseCache("voice-orchestrators", "runner-one")).toBeNull();
  const fetch = jest.spyOn(global, "fetch").mockResolvedValueOnce(response(snapshot()))
    .mockResolvedValueOnce(response(snapshot(), ""));
  const cache: RunnerClientStateCache = {};
  await requestRunnerClientState({ ...auth, cache }); await requestRunnerClientState({ ...auth, cache });
  expect(await readRunnerResponseCache("client-state", await runnerResponseCacheKey(auth.connectionIdentity))).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("client-state restoration cannot replace a newer mutation response", async () => {
  const key = (await runnerResponseCacheKey(auth.connectionIdentity))!;
  await writeRunnerResponseCache("client-state", key, { etag: '"state-one"', body: snapshot() });
  let release!: (value: string) => void;
  (FileSystem.readAsStringAsync as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const fetch = jest.spyOn(global, "fetch").mockResolvedValueOnce(response(snapshot(2), '"state-two"'))
    .mockResolvedValueOnce(response(snapshot(), '"state-one"'));
  const cache: RunnerClientStateCache = {};
  const old = requestRunnerClientState({ ...auth, cache });
  for (let i = 0; i < 100 && !release; i++) await Promise.resolve();
  await requestRunnerClientState({ ...auth, cache, operation: { type: "composer.append", text: "new" } });
  release(mockFiles.get("cache/runner-client-state.json")!);
  await old;
  expect(cache.entry?.snapshot.revision).toBe(2);
  expect(fetch.mock.calls[0][1]!.method).toBe("POST");
});

test("an invalidation cannot expose an unverified disk list through an obsolete pending read", async () => {
  await writeRunnerResponseCache("voice-orchestrators", "runner-one", { etag: "one", body });
  const f = voice(); let oldReply!: (value: any) => void, freshReply!: (value: any) => void;
  f.request.mockReturnValueOnce(new Promise((resolve) => { oldReply = resolve; }))
    .mockReturnValueOnce(new Promise((resolve) => { freshReply = resolve; }));
  const loading = getVoiceOrchestrators(f.manager);
  const rejected = expect(loading).rejects.toThrow();
  for (let i = 0; i < 100 && f.request.mock.calls.length < 1; i++) await Promise.resolve();
  f.emit({ ...counts(), etag: "two" });
  for (let i = 0; i < 100 && f.request.mock.calls.length < 2; i++) await Promise.resolve();
  oldReply({ op: "voice.orchestrators.list.result", payload: full() });
  await rejected;
  const listener = jest.fn(); subscribeVoiceOrchestrators(f.manager, listener);
  expect(listener).not.toHaveBeenCalled();
  freshReply({ op: "voice.orchestrators.list.result", payload: full("two") });
  for (let i = 0; i < 100 && !listener.mock.calls.length; i++) await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
});
