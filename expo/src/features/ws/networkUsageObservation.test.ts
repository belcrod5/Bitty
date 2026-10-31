import type * as Metrics from "./networkUsageMetrics";

let metrics: typeof Metrics;
let observations: Array<{ value: Metrics.NetworkUsageIdleObservation; atBoundary: boolean }>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(100_000);
  jest.isolateModules(() => { metrics = require("./networkUsageMetrics"); });
  observations = [];
});
afterEach(() => jest.useRealTimers());
function subscribe() {
  return metrics.subscribeNetworkUsageIdleObservations((value, atBoundary) => observations.push({ value, atBoundary }));
}

test("a 60 second uninterrupted prefix has independent category and operation totals", () => {
  subscribe();
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.recordHttpNetworkUsage("https://runner/client-state", 10, 100);
  metrics.recordRunnerWsNetworkUsage("received", 200, { channel: "agent", op: "agent.ready" });
  metrics.recordNetworkUsage("stream-tts", 1, 2);
  jest.setSystemTime(159_999);
  metrics.completeNetworkUsageIdleObservation();
  expect(observations).toHaveLength(0);
  jest.setSystemTime(160_000);
  metrics.completeNetworkUsageIdleObservation();
  expect(observations).toHaveLength(1);
  const observation = observations[0].value;
  expect(observation).toMatchObject({ kind: "startup_idle", elapsedMs: 60_000, comparisonEligible: true,
    measurementScope: "bytes_recorded_during_idle_prefix", startupCompletionInferred: false,
    usage: { totalSentBytes: 11, totalReceivedBytes: 302, httpByCategory: { "client-state": { receivedBytes: 100 } },
      runnerWsByOperation: { "agent/agent.ready": { receivedBytes: 200, receivedCount: 1 } } } });
  metrics.recordRunnerWsNetworkUsage("received", 500, { channel: "agent", op: "agent.ready" });
  metrics.completeNetworkUsageIdleObservation();
  expect(observation.usage.totalReceivedBytes).toBe(302);
  expect(metrics.getNetworkUsageSnapshot().totalReceivedBytes).toBe(802);
  expect(observations).toHaveLength(1);
});

test("first input freezes the prefix before the action and delayed responses, even before a logger mounts", () => {
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.recordRunnerWsNetworkUsage("sent", 10, { channel: "agent", op: "history.read" });
  jest.setSystemTime(105_000);
  expect(metrics.captureNetworkUsageInteraction()).toBe(false);
  metrics.recordRunnerWsNetworkUsage("received", 1000, { channel: "agent", op: "history.read.result" });
  metrics.recordHttpNetworkUsage("https://runner/client-state", 50, 50);
  subscribe();
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ atBoundary: false, value: { elapsedMs: 5000,
    endReason: "user_input", comparisonEligible: false, usage: { totalSentBytes: 10, totalReceivedBytes: 0 } } });
  expect(metrics.getNetworkUsageSnapshot()).toMatchObject({ totalSentBytes: 60, totalReceivedBytes: 1050 });
});

test("background closes startup and foreground records a disjoint prefix", () => {
  subscribe();
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.recordHttpNetworkUsage("https://runner/client-state", 0, 200);
  jest.setSystemTime(110_000);
  metrics.updateNetworkUsageObservationAppState("inactive");
  metrics.recordRunnerWsNetworkUsage("received", 500, { channel: "agent", op: "event" });
  metrics.updateNetworkUsageObservationAppState("background");
  jest.setSystemTime(150_000);
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.recordRunnerWsNetworkUsage("received", 30, { channel: "agent", op: "event" });
  jest.setSystemTime(210_000);
  metrics.completeNetworkUsageIdleObservation();
  expect(observations.map(({ value }) => [value.kind, value.endReason, value.comparisonEligible, value.usage.totalReceivedBytes]))
    .toEqual([["startup_idle", "app_not_active", false, 200], ["foreground_idle", "observation_elapsed", true, 30]]);
  expect(observations[1].value.usage.runnerWsByOperation["agent/event"].receivedCount).toBe(1);
  expect(observations[1].value.usage.sinceMs).toBe(150_000);
  expect(metrics.getNetworkUsageSnapshot().totalReceivedBytes).toBe(730);
});

test("unknown initial AppState preserves startup bytes but cannot certify an uninterrupted foreground", () => {
  subscribe();
  metrics.updateNetworkUsageObservationAppState(null);
  metrics.recordHttpNetworkUsage("https://runner/client-state", 0, 100);
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.recordHttpNetworkUsage("https://runner/client-state", 0, 200);
  jest.setSystemTime(160_000);
  metrics.completeNetworkUsageIdleObservation();
  expect(observations.map(({ value }) => [value.kind, value.comparisonEligible, value.appStateVerified, value.usage.totalReceivedBytes]))
    .toEqual([["startup_idle", false, false, 300]]);
});

test("a notification or remote action arriving before active prevents a misleading idle foreground", () => {
  subscribe();
  metrics.updateNetworkUsageObservationAppState("background");
  metrics.endNetworkUsageIdleObservation("external_action");
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.recordHttpNetworkUsage("https://runner/session-messages", 0, 2000);
  jest.setSystemTime(160_000);
  metrics.completeNetworkUsageIdleObservation();
  expect(observations).toHaveLength(2);
  expect(observations[1].value).toMatchObject({ kind: "foreground_idle", endReason: "external_action",
    comparisonEligible: false, usage: { totalReceivedBytes: 0 } });
});

test("counter reset ends the old prefix before clearing and never invents another startup", () => {
  const unsubscribe = subscribe();
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.recordHttpNetworkUsage("https://runner/client-state", 0, 100);
  jest.setSystemTime(105_000);
  metrics.resetNetworkUsage();
  expect(observations[0].value).toMatchObject({ endReason: "counter_reset", comparisonEligible: false,
    usage: { totalReceivedBytes: 100 } });
  unsubscribe();
  subscribe();
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.recordHttpNetworkUsage("https://runner/client-state", 0, 200);
  jest.setSystemTime(200_000);
  metrics.completeNetworkUsageIdleObservation();
  expect(observations).toHaveLength(1);
  expect(metrics.getNetworkUsageSnapshot().totalReceivedBytes).toBe(200);
});

test("a delayed timer reports its actual duration and never claims initialization completion", () => {
  subscribe();
  metrics.updateNetworkUsageObservationAppState("active");
  jest.setSystemTime(190_000);
  metrics.completeNetworkUsageIdleObservation();
  expect(observations[0].value).toMatchObject({ elapsedMs: 90_000, requestedDurationMs: 60_000,
    endReason: "observation_elapsed", startupCompletionInferred: false });
});

test.each(["voice_input", "external_action", "send_action"] as const)("%s ends observation without retaining input data", (reason) => {
  subscribe();
  metrics.updateNetworkUsageObservationAppState("active");
  metrics.endNetworkUsageIdleObservation(reason);
  expect(observations[0].value).toMatchObject({ endReason: reason, comparisonEligible: false });
  expect(JSON.stringify(observations)).not.toMatch(/url|token|transcript|payload/);
});
