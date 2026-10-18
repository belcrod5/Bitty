import { act, renderHook } from "@testing-library/react-native";
import { useCodexStatusAuthController } from "./useCodexStatusAuthController";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function response(data: unknown) { return { ok: true, json: async () => data } as Response; }
const status = (text: string, fetchedAt: string, usageLimitReached = false) => ({ statusText: text, fetchedAt, usageLimitReached });
function args() {
  let listener: (message: { payload: unknown }) => void = () => {};
  const manager = { subscribe: jest.fn((_filter, callback) => { listener = callback; return () => {}; }) };
  const inputs = {
    runnerWebSocketManager: manager as unknown as RunnerWebSocketManager,
    appStateRef: { current: "active" }, auxServerBaseUrl: () => "https://runner.test", runnerToken: "token",
    codexCliStatusMinRefreshGapMs: 15000,
    codexCliStatusLastFetchedAtMsRef: { current: 0 }, codexCliStatusLastAttemptAtMsRef: { current: 0 },
    codexCliStatusRefreshInFlightRef: { current: false }, codexAuthProfilesRefreshInFlightRef: { current: false },
    setCodexCliStatusSnapshot: jest.fn(), setCodexCliStatusFetchedAtMs: jest.fn(), setCodexCliStatusLoading: jest.fn(),
    setCodexAuthProfilesSnapshot: jest.fn(), setCodexAuthProfilesLoading: jest.fn(), setCodexAuthSwitching: jest.fn(), setCodexAuthSwitchError: jest.fn(),
  };
  return { inputs, receive: (payload: unknown) => listener({ payload }) };
}
const originalFetch = global.fetch;
beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { global.fetch = originalFetch; });

test("shared quota WS updates remain visible in chat/voice and an older HTTP response cannot overwrite them", async () => {
  const { inputs, receive } = args();
  const pending = deferred<Response>();
  (global.fetch as jest.Mock).mockReturnValue(pending.promise);
  const { result } = await renderHook(() => useCodexStatusAuthController(inputs));
  let refreshing!: Promise<void>;
  await act(async () => { refreshing = result.current.refreshCodexCliStatusForWidget({ force: true }); });
  await act(async () => { receive(status("Codex の利用上限", "2026-10-10T02:00:01.000Z", true)); });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ usageLimitReached: true }));
  await act(async () => {
    pending.resolve(response(status("5h limit: 80% left", "2026-10-10T02:00:00.000Z")));
    await refreshing;
  });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenCalledTimes(1);
  expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain("force=1");
});

test("resuming immediately after a recent request reads the latest canonical quota", async () => {
  const { inputs } = args();
  inputs.codexCliStatusLastAttemptAtMsRef.current = Date.now();
  (global.fetch as jest.Mock).mockResolvedValue(response(status("limit", "2026-10-10T02:00:01.000Z", true)));
  const { result } = await renderHook(() => useCodexStatusAuthController(inputs));
  await act(async () => { await result.current.refreshCodexCliStatusForWidget({ source: "resume" }); });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenCalledWith(expect.objectContaining({ usageLimitReached: true }));
});

test("refreshing accounts uses their quota update without a second active-account request", async () => {
  const { inputs } = args();
  (global.fetch as jest.Mock).mockResolvedValue(response({
    currentAuthId: "a",
    profiles: [{ authId: "a", rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } }],
    currentUsage: status("5h limit: 80% left", "2026-10-10T02:00:01.000Z"),
  }));
  const { result } = await renderHook(() => useCodexStatusAuthController(inputs));
  await act(async () => { await result.current.refreshCodexAuthProfiles({ force: true }); });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain("/codex-auth/profiles?refresh=1");
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenCalledWith(expect.objectContaining({ statusText: "5h limit: 80% left" }));
});

test("a profiles response without canonical usage leaves a newer status untouched", async () => {
  const { inputs, receive } = args();
  (global.fetch as jest.Mock).mockResolvedValue(response({
    currentAuthId: "a", profiles: [{ authId: "a", rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } }],
  }));
  const { result } = await renderHook(() => useCodexStatusAuthController(inputs));
  await act(async () => { receive(status("5h limit: 70% left", "2026-10-10T02:00:02.000Z")); });
  await act(async () => { await result.current.refreshCodexAuthProfiles({ force: true }); });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenCalledTimes(1);
});

test("refreshing accounts falls back to the status endpoint for legacy auth", async () => {
  const { inputs } = args();
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(response({ currentAuthId: "", profiles: [] }))
    .mockResolvedValueOnce(response(status("5h limit: 80% left", "2026-10-10T02:00:01.000Z")));
  const { result } = await renderHook(() => useCodexStatusAuthController(inputs));
  await act(async () => { await result.current.refreshCodexAuthProfiles({ force: true }); });
  expect((global.fetch as jest.Mock).mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/codex-auth/profiles", "/codex-cli/status",
  ]);
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenCalledWith(expect.objectContaining({ statusText: "5h limit: 80% left" }));
});

test("an unavailable managed account does not retry the same quota read through status", async () => {
  const { inputs } = args();
  (global.fetch as jest.Mock).mockResolvedValue(response({
    currentAuthId: "a", profiles: [{ authId: "a", status: "unavailable" }],
  }));
  const { result } = await renderHook(() => useCodexStatusAuthController(inputs));
  await act(async () => { await result.current.refreshCodexAuthProfiles({ force: true }); });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain("/codex-auth/profiles?refresh=1");
});

test("account switching discards pending old reads and accepts the new account even with clock skew", async () => {
  const { inputs, receive } = args();
  const pending = deferred<Response>();
  const switchResponse = deferred<Response>();
  (global.fetch as jest.Mock).mockReturnValueOnce(pending.promise).mockReturnValueOnce(switchResponse.promise)
    .mockResolvedValueOnce(response(status("new account", "2020-01-01T00:00:00.000Z")));
  const { result } = await renderHook(() => useCodexStatusAuthController(inputs));
  let oldRead!: Promise<void>, switching!: Promise<boolean>;
  await act(async () => { oldRead = result.current.refreshCodexCliStatusForWidget({ force: true }); });
  await act(async () => { switching = result.current.switchCodexAuthProfile("new"); });
  await act(async () => { receive(status("old account", "2030-01-01T00:00:00.000Z", true)); });
  expect(inputs.setCodexCliStatusSnapshot).not.toHaveBeenCalled();
  await act(async () => { switchResponse.resolve(response({ currentAuthId: "new", profiles: [] })); await switching; });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ statusText: "new account" }));
  await act(async () => { pending.resolve(response(status("old account", "2030-01-01T00:00:00.000Z", true))); await oldRead; });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ statusText: "new account" }));
});

test("account switching discards a pending old profiles response and its compact quota", async () => {
  const { inputs } = args();
  const oldProfiles = deferred<Response>();
  (global.fetch as jest.Mock).mockReturnValueOnce(oldProfiles.promise)
    .mockResolvedValueOnce(response({ currentAuthId: "new", profiles: [{ authId: "new" }] }))
    .mockResolvedValueOnce(response(status("new account", "2020-01-01T00:00:00.000Z")));
  const { result } = await renderHook(() => useCodexStatusAuthController(inputs));
  let refreshing!: Promise<void>;
  await act(async () => { refreshing = result.current.refreshCodexAuthProfiles({ force: true }); });
  await act(async () => { await result.current.switchCodexAuthProfile("new"); });
  await act(async () => {
    oldProfiles.resolve(response({ currentAuthId: "old", profiles: [{ authId: "old" }],
      currentUsage: status("old account", "2030-01-01T00:00:00.000Z") }));
    await refreshing;
  });
  expect(inputs.setCodexAuthProfilesSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ currentAuthId: "new" }));
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ statusText: "new account" }));
});

test("recovery clears a typed-failure indicator even when percentages remain unavailable", async () => {
  const { inputs, receive } = args();
  await renderHook(() => useCodexStatusAuthController(inputs));
  await act(async () => { receive(status("利用上限", "2026-10-10T02:00:00.000Z", true)); });
  await act(async () => { receive(status("", "2026-10-10T02:00:01.000Z", false)); });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ statusText: "", usageLimitReached: false }));
});

test.each(["url", "token"])("changing Runner %s invalidates old status, profiles and subscription without blocking a new refresh", async (changed) => {
  const { inputs } = args();
  const oldStatus = deferred<Response>(), oldProfiles = deferred<Response>(), newStatus = deferred<Response>();
  (global.fetch as jest.Mock).mockReturnValueOnce(oldStatus.promise).mockReturnValueOnce(oldProfiles.promise)
    .mockReturnValueOnce(newStatus.promise);
  const hook = await renderHook(({ url, token }: { url: string; token: string }) => useCodexStatusAuthController({ ...inputs,
    auxServerBaseUrl: () => url, runnerToken: token }), {
    initialProps: { url: "https://runner.test", token: "token" },
  });
  const oldListener = (inputs.runnerWebSocketManager.subscribe as jest.Mock).mock.calls[0][1];
  let pendingStatus!: Promise<void>, pendingProfiles!: Promise<void>, pendingNew!: Promise<void>;
  await act(async () => {
    pendingStatus = hook.result.current.refreshCodexCliStatusForWidget({ force: true });
    pendingProfiles = hook.result.current.refreshCodexAuthProfiles({ force: true });
  });
  await hook.rerender({ url: changed === "url" ? "https://new-runner.test" : "https://runner.test",
    token: changed === "token" ? "new-token" : "token" });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(null);
  expect(inputs.setCodexCliStatusFetchedAtMs).toHaveBeenLastCalledWith(0);
  expect(inputs.setCodexAuthProfilesSnapshot).toHaveBeenLastCalledWith(null);
  await act(async () => { pendingNew = hook.result.current.refreshCodexCliStatusForWidget({ force: true }); });
  expect(inputs.codexCliStatusRefreshInFlightRef.current).toBe(true);
  await act(async () => {
    oldListener({ payload: status("OLD WS", "2030-01-01T00:00:00.000Z") });
    oldStatus.resolve(response(status("OLD HTTP", "2030-01-01T00:00:00.000Z")));
    oldProfiles.resolve(response({ currentAuthId: "old", profiles: [{ authId: "old" }],
      currentUsage: status("OLD PROFILE", "2030-01-01T00:00:00.000Z") }));
    await pendingStatus; await pendingProfiles;
  });
  expect(inputs.codexCliStatusRefreshInFlightRef.current).toBe(true);
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(null);
  expect(inputs.setCodexAuthProfilesSnapshot).toHaveBeenLastCalledWith(null);
  await act(async () => {
    newStatus.resolve(response(status("NEW RUNNER", "2020-01-01T00:00:00.000Z")));
    await pendingNew;
  });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ statusText: "NEW RUNNER" }));
  expect(inputs.codexCliStatusRefreshInFlightRef.current).toBe(false);
  hook.unmount();
});

test("a delayed slash read from the prior Runner returns no snapshot", async () => {
  const { inputs } = args();
  const old = deferred<Response>();
  (global.fetch as jest.Mock).mockReturnValueOnce(old.promise);
  const hook = await renderHook(({ url }: { url: string }) => useCodexStatusAuthController({ ...inputs, auxServerBaseUrl: () => url }), {
    initialProps: { url: "https://runner.test" },
  });
  let pending!: Promise<unknown>;
  await act(async () => { pending = hook.result.current.fetchRunnerCodexCliStatusForSlash(); });
  await hook.rerender({ url: "https://other.test" });
  await act(async () => { old.resolve(response(status("OLD", "2030-01-01T00:00:00.000Z"))); });
  expect(await pending).toBeNull();
  hook.unmount();
});

test("a switch response from the prior Runner cannot replace the new Runner account or flags", async () => {
  const { inputs } = args();
  const oldSwitch = deferred<Response>();
  (global.fetch as jest.Mock).mockReturnValueOnce(oldSwitch.promise).mockResolvedValueOnce(response({
    currentAuthId: "new", profiles: [{ authId: "new" }], currentUsage: status("CACHED NEW", "2020-01-01T00:00:00.000Z"),
  }));
  const hook = await renderHook(({ url }: { url: string }) => useCodexStatusAuthController({ ...inputs, auxServerBaseUrl: () => url }), {
    initialProps: { url: "https://runner.test" },
  });
  let switching!: Promise<boolean>;
  await act(async () => { switching = hook.result.current.switchCodexAuthProfile("old"); });
  await hook.rerender({ url: "https://new-runner.test" });
  await act(async () => { await hook.result.current.refreshCodexAuthProfiles(); });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ statusText: "CACHED NEW" }));
  await act(async () => { oldSwitch.resolve(response({ currentAuthId: "old", profiles: [{ authId: "old" }] })); });
  expect(await switching).toBe(false);
  expect(inputs.setCodexAuthProfilesSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ currentAuthId: "new" }));
  expect(global.fetch).toHaveBeenCalledTimes(2);
  hook.unmount();
});
