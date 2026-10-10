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

test("recovery clears a typed-failure indicator even when percentages remain unavailable", async () => {
  const { inputs, receive } = args();
  await renderHook(() => useCodexStatusAuthController(inputs));
  await act(async () => { receive(status("利用上限", "2026-10-10T02:00:00.000Z", true)); });
  await act(async () => { receive(status("", "2026-10-10T02:00:01.000Z", false)); });
  expect(inputs.setCodexCliStatusSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ statusText: "", usageLimitReached: false }));
});
