import { act, renderHook } from "@testing-library/react-native";
import { AppState, Linking, type AppStateStatus } from "react-native";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import {
  captureNetworkUsageInteraction,
  getNetworkUsageSnapshot,
  recordHttpNetworkUsage,
  resetNetworkUsage,
  subscribeNetworkUsageIdleObservations,
  updateNetworkUsageObservationAppState,
} from "../../ws/networkUsageMetrics";
import { useNetworkUsageLogging } from "./useNetworkUsageLogging";
import { useSessionDeepLinkNavigationController } from "./useSessionDeepLinkNavigationController";

let stateListener: (state: AppStateStatus) => void;
let linkListeners: Array<(event: { url: string }) => void>;
const manager = { getSnapshot: () => ({ pendingRequestCount: 3 }) } as RunnerWebSocketManager;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(100_000);
  resetNetworkUsage();
  updateNetworkUsageObservationAppState("background");
  updateNetworkUsageObservationAppState("active");
  subscribeNetworkUsageIdleObservations(() => {})();
  AppState.currentState = "active";
  linkListeners = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    stateListener = listener;
    return { remove: jest.fn() };
  });
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  jest.spyOn(Linking, "addEventListener").mockImplementation((_event, listener) => {
    linkListeners.push(listener);
    return { remove: jest.fn() } as unknown as ReturnType<typeof Linking.addEventListener>;
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test("logs an independent idle window at 60 seconds with operation boundaries and pending counts", async () => {
  const log = jest.fn();
  await renderHook(() => useNetworkUsageLogging(log, manager));
  recordHttpNetworkUsage("https://runner/client-state", 0, 1000);
  await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
  expect(log.mock.calls.filter(([event]) => event === "network_usage_idle_observation")).toEqual([
    ["network_usage_idle_observation", expect.objectContaining({ kind: "foreground_idle", comparisonEligible: true,
      elapsedMs: 60_000, usage: expect.objectContaining({ totalReceivedBytes: 1000 }),
      pendingHttpMeasurementsAtEnd: 0, pendingRunnerWsRequestsAtEnd: 3,
      responseAttribution: "recording_time_not_request_origin" }), { throttleMs: 0 }],
  ]);
});

test("touch closes before operation traffic and rerender never restarts the observation", async () => {
  const first = jest.fn(), latest = jest.fn();
  const rendered = await renderHook(({ log }: { log: jest.Mock }) => useNetworkUsageLogging(log, manager), { initialProps: { log: first } });
  recordHttpNetworkUsage("https://runner/client-state", 0, 500);
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  await rendered.rerender({ log: latest });
  await act(async () => { expect(captureNetworkUsageInteraction()).toBe(false); });
  recordHttpNetworkUsage("https://runner/session-messages", 0, 9000);
  await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
  expect(first).not.toHaveBeenCalled();
  expect(latest.mock.calls.filter(([event]) => event === "network_usage_idle_observation")).toEqual([
    ["network_usage_idle_observation", expect.objectContaining({ endReason: "user_input", elapsedMs: 5000,
      comparisonEligible: false, usage: expect.objectContaining({ totalReceivedBytes: 500 }) }), { throttleMs: 0 }],
  ]);
  expect(getNetworkUsageSnapshot().totalReceivedBytes).toBe(9500);
});

test("AppState closes the prefix, resumes separately and diagnostic uploads do not sustain logging", async () => {
  const log = jest.fn();
  await renderHook(() => useNetworkUsageLogging(log, manager));
  recordHttpNetworkUsage("https://runner/client-state", 0, 200);
  await act(async () => stateListener("inactive"));
  recordHttpNetworkUsage("https://runner/client-state", 0, 500);
  await act(async () => stateListener("background"));
  await act(async () => stateListener("active"));
  recordHttpNetworkUsage("https://runner/client-state", 0, 30);
  await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
  const idle = log.mock.calls.filter(([event]) => event === "network_usage_idle_observation");
  expect(idle.map(([, entry]) => [entry.endReason, entry.usage.totalReceivedBytes])).toEqual([["app_not_active", 200], ["observation_elapsed", 30]]);
  const count = log.mock.calls.length;
  recordHttpNetworkUsage("https://runner/client-logs", 8000, 99);
  await act(async () => { await jest.advanceTimersByTimeAsync(120_000); });
  expect(log.mock.calls).toHaveLength(count);
});

test("unmount cleans old timers and listeners while remount keeps the original observation deadline", async () => {
  const timeout = jest.spyOn(globalThis, "setTimeout"), interval = jest.spyOn(globalThis, "setInterval");
  const clearTimeoutSpy = jest.spyOn(globalThis, "clearTimeout"), clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");
  const original = jest.fn(), remounted = jest.fn();
  const rendered = await renderHook(() => useNetworkUsageLogging(original, manager));
  const subscription = jest.mocked(AppState.addEventListener).mock.results.at(-1)?.value;
  const deadlineTimer = timeout.mock.results[timeout.mock.calls.findIndex(([, delay]) => delay === 60_000)].value;
  const intervalTimer = interval.mock.results[0].value;
  recordHttpNetworkUsage("https://runner/client-state", 0, 100);
  await act(async () => { await jest.advanceTimersByTimeAsync(25_000); });
  await rendered.unmount();
  expect(subscription.remove).toHaveBeenCalledTimes(1);
  expect(clearTimeoutSpy).toHaveBeenCalledWith(deadlineTimer);
  expect(clearIntervalSpy).toHaveBeenCalledWith(intervalTimer);
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  recordHttpNetworkUsage("https://runner/client-state", 0, 50);
  await renderHook(() => useNetworkUsageLogging(remounted, manager));
  await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
  expect(original).not.toHaveBeenCalled();
  expect(remounted.mock.calls.filter(([event]) => event === "network_usage_idle_observation")).toEqual([
    ["network_usage_idle_observation", expect.objectContaining({ elapsedMs: 60_000, comparisonEligible: false, appStateVerified: false,
      usage: expect.objectContaining({ totalReceivedBytes: 150 }) }), { throttleMs: 0 }],
  ]);
});

test.each(["initial", "event"])("%s URL closes the idle prefix before existing navigation starts fetching", async (source) => {
  const url = "bitty://session/claude/session-1?messageId=msg_1&cwd=%2Fwork";
  if (source === "initial") jest.mocked(Linking.getInitialURL).mockResolvedValue(url);
  const log = jest.fn();
  const openSession = jest.fn(async () => {
    expect(log.mock.calls.some(([event, entry]) => event === "network_usage_idle_observation" && entry.endReason === "external_action")).toBe(true);
    recordHttpNetworkUsage("https://runner/session-messages", 0, 10_000);
    return false;
  });
  await renderHook(() => {
    useNetworkUsageLogging(log, manager);
    useSessionDeepLinkNavigationController({ settingsLoaded: true, openSession, closeDrawer: jest.fn(),
      loadOlder: jest.fn(), getMessages: () => [], setJumpTarget: jest.fn(), onNotFound: jest.fn() });
  });
  if (source === "event") await act(async () => { linkListeners.forEach((listener) => listener({ url })); });
  expect(openSession).toHaveBeenCalledTimes(1);
  const observation = log.mock.calls.find(([event]) => event === "network_usage_idle_observation")?.[1];
  expect(observation).toMatchObject({ endReason: "external_action", comparisonEligible: false, usage: { totalReceivedBytes: 0 } });
});
