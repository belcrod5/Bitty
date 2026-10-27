import { useState } from "react";
import { act, renderHook } from "@testing-library/react-native";
import { listAgentSessions } from "../../agent/client";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { DirectorySessionTreeState } from "../types/directorySessions";
import type { LlmSessionHistoryEntry } from "./useLlmSessionExplorer";
import { useDirectorySessionTreeController } from "./useDirectorySessionTreeController";

// Synthetic timing only: this experiment does not connect to a Runner or measure app startup.
const REQUEST_MS = 40;
const READY_MS = 100;
const directories = Array.from({ length: 25 }, (_, i) => ({
  id: `directory-${i}`, path: `/workspace/${i}`, displayName: `${i}`, markerColor: "none" as const,
}));
const emptyTree: DirectorySessionTreeState = {
  loading: false, refreshing: false, loadingMore: false, loaded: false, fetchedAtMs: 0,
  error: "", latestSessionId: "", nextCursor: "", hasMore: false, entries: [], childrenByParentId: {},
};
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, REQUEST_MS));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-27T00:00:00Z"));
});
afterEach(() => jest.useRealTimers());

async function runDirectoryScenario(gateOnReady: boolean) {
  const startedAt = Date.now();
  let ready = false;
  let requests = 0;
  let failures = 0;
  const fetchSessionHistory = async (directory: string) => {
    requests += 1;
    if (!ready) {
      failures += 1;
      throw new Error("runner_ws_inactive");
    }
    await delay();
    const entry: LlmSessionHistoryEntry = {
      backendId: "codex", sessionId: directory, parentSessionId: "", directory,
      updatedAt: "2026-10-27T00:00:00Z", lastReadAt: "", source: "cli", cwd: directory,
      firstUserMessage: "latest", agentRole: "", agentDisplayName: "", contextUsedPct: 12,
      modelRef: "current-model", reasoningEffort: "low",
    };
    return { latestSessionId: directory, nextCursor: "", entries: [entry] };
  };
  const { result, rerender, unmount } = await renderHook(({ wsReady }: { wsReady: boolean }) => {
    const [trees, setTrees] = useState<Record<string, DirectorySessionTreeState>>({});
    const controller = useDirectorySessionTreeController({
      directorySessionsById: trees, setDirectorySessionsById: setTrees, setExpandedDirectoryIds: () => {},
      fetchSessionHistory, fetchSessionChildrenHistory: async () => ({}),
      emptyDirectorySessionTreeState: emptyTree, directorySessionPageSize: 5,
      directorySessionPrefetchTtlMs: 60_000, directorySessionPrefetchConcurrency: 2,
      registeredDirectories: directories,
      bootstrapReady: !gateOnReady || wsReady,
    });
    return { controller, trees };
  }, { initialProps: { wsReady: false } });
  try {
    await act(async () => { await result.current.controller.ensureRegisteredDirectorySessions("screen_mount"); });
    expect(result.current.controller.directorySessionSync.phase).toBe(gateOnReady ? "idle" : "error");
    await act(async () => { await jest.advanceTimersByTimeAsync(READY_MS); });
    ready = true;
    await rerender({ wsReady: true });
    // Baseline recovery is immediate on ready; deliberately add no artificial retry penalty.
    if (!gateOnReady) await act(async () => { void result.current.controller.ensureRegisteredDirectorySessions("auth_recovery"); });
    await act(async () => { await jest.advanceTimersByTimeAsync(13 * REQUEST_MS); });
    const sync = result.current.controller.directorySessionSync;
    expect(sync).toMatchObject({ phase: "complete", succeededCount: 25, failedCount: 0 });
    return {
      requests, failures, completedMs: sync.completedAtMs - startedAt,
      entries: Object.values(result.current.trees).flatMap((tree) => tree.entries),
    };
  } finally {
    await unmount();
  }
}

test("simulation: ready gating avoids failed requests without inventing a speed gain", async () => {
  const baseline = await runDirectoryScenario(false);
  const gated = await runDirectoryScenario(true);
  expect(baseline).toMatchObject({ requests: 50, failures: 25, completedMs: 620 });
  expect(gated).toMatchObject({ requests: 25, failures: 0, completedMs: 620 });
  expect(gated.entries).toEqual(baseline.entries);
  expect(gated.entries).toHaveLength(25);
  console.info("SIMULATION ready gate", {
    assumptions: { readyMs: READY_MS, requestMs: REQUEST_MS, directories: 25, concurrency: 2 },
    baseline: { requests: baseline.requests, failures: baseline.failures, completedMs: baseline.completedMs },
    gated: { requests: gated.requests, failures: gated.failures, completedMs: gated.completedMs },
  });
});

async function runHelloScenario(shareConcurrent: boolean) {
  const startedAt = Date.now();
  let helloRequests = 0;
  let listRequests = 0;
  let backendReady = true;
  let failHello = false;
  let pendingHello: Promise<unknown> | undefined;
  const send = async (op: string) => {
    if (op === "agent.hello") helloRequests += 1;
    else listRequests += 1;
    await delay();
    if (op === "agent.hello") {
      if (failHello) throw new Error("hello unavailable");
      return { channel: "agent", op: "agent.ready", payload: {
        protocolVersion: 2, backends: [{ backendId: "codex", readiness: { ready: backendReady } }],
      } };
    }
    return { channel: "agent", op: "sessions.list.result", payload: { sessions: [{ title: "latest" }] } };
  };
  // Test-only prototype for one fixed connection; no persistent or cross-generation cache.
  const manager = { request: ({ op }: { op: string }) => {
    if (!shareConcurrent || op !== "agent.hello") return send(op);
    if (!pendingHello) pendingHello = send(op).finally(() => { pendingHello = undefined; });
    return pendingHello;
  } } as unknown as RunnerWebSocketManager;
  const list = () => listAgentSessions(manager, { backendId: "codex", cwd: "/workspace" });
  const concurrent = Promise.all([list(), list()]);
  await jest.advanceTimersByTimeAsync(2 * REQUEST_MS);
  const results = await concurrent;
  const summary = { helloRequests, listRequests, completedMs: Date.now() - startedAt };
  // A later request must observe changed readiness, rather than reuse the completed hello.
  backendReady = false;
  const later = list();
  await jest.advanceTimersByTimeAsync(REQUEST_MS);
  expect(await later).toBeNull();
  expect(helloRequests).toBe(summary.helloRequests + 1);
  expect(listRequests).toBe(2);
  // A rejected shared request must not poison subsequent attempts.
  failHello = true;
  const failure = expect(Promise.all([list(), list()])).rejects.toThrow("hello unavailable");
  await jest.advanceTimersByTimeAsync(REQUEST_MS);
  await failure;
  failHello = false;
  backendReady = true;
  const retry = list();
  await jest.advanceTimersByTimeAsync(2 * REQUEST_MS);
  expect(await retry).toEqual(results[0]);
  return { summary, results };
}

test("simulation: concurrent hello sharing reduces requests, not independent parallel latency", async () => {
  const baseline = await runHelloScenario(false);
  const shared = await runHelloScenario(true);
  expect(baseline.summary).toEqual({ helloRequests: 2, listRequests: 2, completedMs: 80 });
  expect(shared.summary).toEqual({ helloRequests: 1, listRequests: 2, completedMs: 80 });
  expect(shared.results).toEqual(baseline.results);
  console.info("SIMULATION concurrent hello", {
    assumptions: { requestMs: REQUEST_MS, simultaneousCallers: 2, independentResponses: true },
    baseline: baseline.summary, shared: shared.summary,
  });
});

function cacheExperimentEntry(directory: string, id: string, title: string): LlmSessionHistoryEntry {
  return {
    backendId: "codex", sessionId: `${directory}/${id}`, parentSessionId: "", directory,
    updatedAt: "2026-10-27T00:00:00Z", lastReadAt: "", source: "cli", cwd: directory,
    firstUserMessage: title, agentRole: "", agentDisplayName: "", contextUsedPct: 12,
    modelRef: "current-model", reasoningEffort: "low",
  };
}

async function runCacheScenario(cacheAgeMs: number | null, forceRefresh = false) {
  const startedAt = Date.now();
  let firstUsableMs: number | null = null;
  let requests = 0;
  const latest = (directory: string) => [
    cacheExperimentEntry(directory, "kept", "updated title"),
    cacheExperimentEntry(directory, "new", "new session"),
  ];
  // The cache is already hydrated at mount: disk read and Runner identity isolation are not modelled.
  const initial = cacheAgeMs === null ? {} : Object.fromEntries(directories.map((directory) => [directory.id, {
    ...emptyTree, loaded: true, fetchedAtMs: startedAt - cacheAgeMs,
    entries: [
      cacheExperimentEntry(directory.path, "kept", "old title"),
      cacheExperimentEntry(directory.path, "deleted", "deleted session"),
    ],
  }]));
  const { result, unmount } = await renderHook(() => {
    const [trees, setTrees] = useState<Record<string, DirectorySessionTreeState>>(initial);
    if (firstUsableMs === null && trees[directories[0].id]?.loaded) firstUsableMs = Date.now() - startedAt;
    const controller = useDirectorySessionTreeController({
      directorySessionsById: trees, setDirectorySessionsById: setTrees, setExpandedDirectoryIds: () => {},
      fetchSessionHistory: async (directory) => {
        requests += 1;
        await delay();
        return { latestSessionId: `${directory}/new`, nextCursor: "", entries: latest(directory) };
      },
      fetchSessionChildrenHistory: async () => ({}), emptyDirectorySessionTreeState: emptyTree,
      directorySessionPageSize: 5, directorySessionPrefetchTtlMs: 60_000,
      directorySessionPrefetchConcurrency: 2, registeredDirectories: directories, bootstrapReady: true,
    });
    return { trees, controller };
  });
  try {
    await act(async () => {
      if (forceRefresh) void result.current.controller.refreshRegisteredDirectorySessions("auth_recovery");
      else void result.current.controller.ensureRegisteredDirectorySessions("screen_mount");
    });
    const phaseDuringRequest = result.current.controller.directorySessionSync.phase;
    // Flush each response wave so the first usable render is observed separately.
    for (let wave = 0; wave < 13; wave++) {
      await act(async () => { await jest.advanceTimersByTimeAsync(REQUEST_MS); });
    }
    const sync = result.current.controller.directorySessionSync;
    expect(sync.phase).toBe("complete");
    const entries = directories.flatMap((directory) => result.current.trees[directory.id].entries);
    return {
      firstUsableMs, completedMs: sync.completedAtMs - startedAt, requests, phaseDuringRequest,
      entries, expectedLatest: directories.flatMap((directory) => latest(directory.path)),
    };
  } finally {
    await unmount();
  }
}

test("simulation: hydrated list cache displays immediately, but latest refresh still takes the same time", async () => {
  const cold = await runCacheScenario(null);
  const cachedRestart = await runCacheScenario(10 * 60_000);
  // The same stale-tree boundary represents an in-memory tree after a long suspension.
  const longResume = await runCacheScenario(10 * 60_000, true);
  for (const run of [cold, cachedRestart, longResume]) {
    expect(run).toMatchObject({ completedMs: 520, requests: 25 });
    expect(run.entries).toEqual(run.expectedLatest); // update, create and delete all reflected
  }
  expect(cold).toMatchObject({ firstUsableMs: 40, phaseDuringRequest: "loading" });
  for (const run of [cachedRestart, longResume]) {
    expect(run).toMatchObject({ firstUsableMs: 0, phaseDuringRequest: "refreshing" });
  }
  const summary = ({ firstUsableMs, completedMs, requests, phaseDuringRequest }: Awaited<ReturnType<typeof runCacheScenario>>) =>
    ({ firstUsableMs, completedMs, requests, phaseDuringRequest });
  console.info("SIMULATION list cache", {
    assumptions: { requestMs: REQUEST_MS, directories: 25, concurrency: 2, cacheAlreadyHydrated: true },
    cold: summary(cold), cachedRestart: summary(cachedRestart), longResume: summary(longResume),
  });
});

test("simulation: a TTL-only cache skips requests and misses changes until explicitly refreshed", async () => {
  const skipped = await runCacheScenario(10_000);
  expect(skipped).toMatchObject({ firstUsableMs: 0, completedMs: 0, requests: 0 });
  expect(skipped.entries).not.toEqual(skipped.expectedLatest);
  expect(skipped.entries.some((entry) => entry.sessionId.endsWith("/deleted"))).toBe(true);
  const refreshed = await runCacheScenario(10_000, true);
  expect(refreshed).toMatchObject({ firstUsableMs: 0, completedMs: 520, requests: 25 });
  expect(refreshed.entries).toEqual(refreshed.expectedLatest);
});
