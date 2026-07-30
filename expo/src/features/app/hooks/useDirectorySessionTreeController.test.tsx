import { useState } from "react";
import { act, renderHook } from "@testing-library/react-native";
import type { DirectorySessionTreeState } from "../components/AppDrawer";
import type { LlmSessionHistoryEntry } from "./useLlmSessionExplorer";
import { useDirectorySessionTreeController } from "./useDirectorySessionTreeController";

function session(lastReadAt = "", sessionId = "session-1"): LlmSessionHistoryEntry {
  return {
    sessionId,
    parentSessionId: "",
    directory: "/workspace",
    updatedAt: "2026-07-29T01:00:00.000Z",
    lastReadAt,
    source: "cli",
    cwd: "/workspace",
    firstUserMessage: "session",
    agentRole: "",
    agentDisplayName: "",
    contextUsedPct: null,
    modelRef: "",
    reasoningEffort: "",
  };
}

const emptyState: DirectorySessionTreeState = {
  loading: false,
  refreshing: false,
  loadingMore: false,
  loaded: false,
  fetchedAtMs: 0,
  error: "",
  latestSessionId: "",
  nextCursor: "",
  hasMore: false,
  entries: [],
  childrenByParentId: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const workspaceDirectory = {
  id: "workspace",
  path: "/workspace",
  displayName: "Workspace",
  markerColor: "none" as const,
};

function useTestController(params: {
  registeredDirectories?: typeof workspaceDirectory[];
  initialTrees?: Record<string, DirectorySessionTreeState>;
  concurrency?: number;
  fetchSessionHistory: jest.Mock;
  fetchSessionChildHistory?: jest.Mock;
  selectedDirectoryPath?: string;
}) {
  const [directorySessionsById, setDirectorySessionsById] = useState<
    Record<string, DirectorySessionTreeState>
  >(params.initialTrees || {});
  const controller = useDirectorySessionTreeController({
    directorySessionsById,
    setDirectorySessionsById,
    setExpandedDirectoryIds: jest.fn(),
    fetchSessionHistory: params.fetchSessionHistory,
    fetchSessionChildHistory: params.fetchSessionChildHistory || jest.fn(async () => []),
    emptyDirectorySessionTreeState: emptyState,
    directorySessionPageSize: 5,
    directorySessionPrefetchTtlMs: 60_000,
    directorySessionPrefetchConcurrency: params.concurrency || 2,
    registeredDirectories: params.registeredDirectories || [workspaceDirectory],
    selectedDirectoryPath: params.selectedDirectoryPath || "/workspace",
  });
  return { controller, directorySessionsById };
}

test("does not let a stale directory fetch overwrite a read mutation made while loading", async () => {
  const fetchResult = deferred<{
    latestSessionId: string;
    nextCursor: string;
    entries: LlmSessionHistoryEntry[];
  }>();
  const { result } = await renderHook(() => {
    const [directorySessionsById, setDirectorySessionsById] = useState<
      Record<string, DirectorySessionTreeState>
    >({
      workspace: {
        ...emptyState,
        loaded: true,
        entries: [session()],
      },
    });
    const controller = useDirectorySessionTreeController({
      directorySessionsById,
      setDirectorySessionsById,
      setExpandedDirectoryIds: jest.fn(),
      fetchSessionHistory: jest.fn(() => fetchResult.promise),
      fetchSessionChildHistory: jest.fn(async () => []),
      emptyDirectorySessionTreeState: emptyState,
      directorySessionPageSize: 5,
      directorySessionPrefetchTtlMs: 1,
      directorySessionPrefetchConcurrency: 1,
      registeredDirectories: [{
        id: "workspace",
        path: "/workspace",
        displayName: "Workspace",
        markerColor: "none",
      }],
      selectedDirectoryPath: "/workspace",
    });
    return {
      controller,
      directorySessionsById,
      markRead: () => {
        controller.applySessionLastReadAtByIdToDirectoryTrees(new Map([[
          "session-1",
          "2026-07-29T02:00:00.000Z",
        ]]));
      },
    };
  });

  let loading!: Promise<unknown>;
  await act(async () => {
    loading = result.current.controller.refreshDirectorySessionTree({
      id: "workspace",
      path: "/workspace",
      displayName: "Workspace",
      markerColor: "none",
    }, "manual_refresh");
    await Promise.resolve();
  });
  await act(async () => {
    result.current.markRead();
  });
  await act(async () => {
    fetchResult.resolve({
      latestSessionId: "session-1",
      nextCursor: "",
      entries: [session()],
    });
    await loading;
  });

  expect(result.current.directorySessionsById.workspace.entries[0].lastReadAt)
    .toBe("2026-07-29T02:00:00.000Z");
});

test("applies a read completed while an unknown load-more page is in flight", async () => {
  const fetchResult = deferred<{
    latestSessionId: string;
    nextCursor: string;
    entries: LlmSessionHistoryEntry[];
  }>();
  const { result } = await renderHook(() => {
    const [directorySessionsById, setDirectorySessionsById] = useState<
      Record<string, DirectorySessionTreeState>
    >({
      workspace: {
        ...emptyState,
        loaded: true,
        nextCursor: "page-2",
        hasMore: true,
        entries: [session("", "page-1")],
      },
    });
    const controller = useDirectorySessionTreeController({
      directorySessionsById,
      setDirectorySessionsById,
      setExpandedDirectoryIds: jest.fn(),
      fetchSessionHistory: jest.fn(() => fetchResult.promise),
      fetchSessionChildHistory: jest.fn(async () => []),
      emptyDirectorySessionTreeState: emptyState,
      directorySessionPageSize: 5,
      directorySessionPrefetchTtlMs: 1,
      directorySessionPrefetchConcurrency: 1,
      registeredDirectories: [{
        id: "workspace",
        path: "/workspace",
        displayName: "Workspace",
        markerColor: "none",
      }],
      selectedDirectoryPath: "/workspace",
    });
    return { controller, directorySessionsById };
  });

  let loading!: Promise<void>;
  await act(async () => {
    loading = result.current.controller.loadMoreDirectorySessionTree(
      "workspace",
      "/workspace"
    );
    await Promise.resolve();
  });
  expect(result.current.directorySessionsById.workspace.loadingMore).toBe(true);
  await act(async () => {
    result.current.controller.applySessionLastReadAtByIdToDirectoryTrees(new Map([[
      "page-2",
      "2026-07-29T02:00:00.000Z",
    ]]));
  });
  await act(async () => {
    fetchResult.resolve({
      latestSessionId: "page-1",
      nextCursor: "",
      entries: [session("", "page-2")],
    });
    await loading;
  });

  expect(result.current.directorySessionsById.workspace.loadingMore).toBe(false);
  expect(result.current.directorySessionsById.workspace.entries.map((entry) => entry.sessionId))
    .toEqual(["page-1", "page-2"]);
  expect(result.current.directorySessionsById.workspace.entries[1]).toEqual(
    expect.objectContaining({
      sessionId: "page-2",
      lastReadAt: "2026-07-29T02:00:00.000Z",
    })
  );
});

test("does not let a stale child fetch overwrite a read completed while loading", async () => {
  const childResult = deferred<LlmSessionHistoryEntry[]>();
  const parent = session("", "parent");
  const { result } = await renderHook(() => {
    const [directorySessionsById, setDirectorySessionsById] = useState<
      Record<string, DirectorySessionTreeState>
    >({
      workspace: {
        ...emptyState,
        loaded: true,
        entries: [parent],
      },
    });
    const controller = useDirectorySessionTreeController({
      directorySessionsById,
      setDirectorySessionsById,
      setExpandedDirectoryIds: jest.fn(),
      fetchSessionHistory: jest.fn(),
      fetchSessionChildHistory: jest.fn(() => childResult.promise),
      emptyDirectorySessionTreeState: emptyState,
      directorySessionPageSize: 5,
      directorySessionPrefetchTtlMs: 1,
      directorySessionPrefetchConcurrency: 1,
      registeredDirectories: [{
        id: "workspace",
        path: "/workspace",
        displayName: "Workspace",
        markerColor: "none",
      }],
      selectedDirectoryPath: "/workspace",
    });
    return { controller, directorySessionsById };
  });

  let loading!: Promise<void>;
  await act(async () => {
    loading = result.current.controller.loadSessionChildTree(
      "workspace",
      "/workspace",
      "parent"
    );
    await Promise.resolve();
  });
  expect(
    result.current.directorySessionsById.workspace.childrenByParentId.parent.loading
  ).toBe(true);
  await act(async () => {
    result.current.controller.applySessionLastReadAtByIdToDirectoryTrees(new Map([[
      "child",
      "2026-07-29T02:00:00.000Z",
    ]]));
  });
  await act(async () => {
    childResult.resolve([{
      ...session("", "child"),
      parentSessionId: "parent",
      source: "subagent",
    }]);
    await loading;
  });

  expect(
    result.current.directorySessionsById.workspace.childrenByParentId.parent.loaded
  ).toBe(true);
  expect(
    result.current.directorySessionsById.workspace.childrenByParentId.parent.entries[0]
  ).toEqual(expect.objectContaining({
    sessionId: "child",
    lastReadAt: "2026-07-29T02:00:00.000Z",
  }));
});

test("joins duplicate registered ensure requests into one fetch cycle", async () => {
  const fetchResult = deferred<{
    latestSessionId: string;
    nextCursor: string;
    entries: LlmSessionHistoryEntry[];
  }>();
  const fetchSessionHistory = jest.fn(() => fetchResult.promise);
  const { result } = await renderHook(() => useTestController({ fetchSessionHistory }));

  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = result.current.controller.ensureRegisteredDirectorySessions("drawer_open");
    second = result.current.controller.ensureRegisteredDirectorySessions("screen_mount");
    await Promise.resolve();
  });

  expect(fetchSessionHistory).toHaveBeenCalledTimes(1);
  fetchResult.resolve({
    latestSessionId: "session-1",
    nextCursor: "",
    entries: [session()],
  });
  await act(async () => {
    await Promise.all([first, second]);
  });

  expect(result.current.controller.directorySessionSync).toMatchObject({
    phase: "complete",
    totalCount: 1,
    succeededCount: 1,
    completedCount: 1,
  });
});

test("keeps shared sync actions stable while using the latest fetch implementation", async () => {
  const firstFetch = jest.fn();
  const latestFetch = jest.fn(async () => ({
    latestSessionId: "session-1",
    nextCursor: "",
    entries: [session()],
  }));
  const { result, rerender } = await renderHook<
    ReturnType<typeof useTestController>,
    { fetchSessionHistory: jest.Mock }
  >(
    ({ fetchSessionHistory }) => useTestController({ fetchSessionHistory }),
    { initialProps: { fetchSessionHistory: firstFetch } }
  );
  const initialEnsure = result.current.controller.ensureRegisteredDirectorySessions;

  await rerender({ fetchSessionHistory: latestFetch });

  expect(result.current.controller.ensureRegisteredDirectorySessions).toBe(initialEnsure);
  await act(async () => {
    await result.current.controller.ensureRegisteredDirectorySessions("screen_mount");
  });
  expect(firstFetch).not.toHaveBeenCalled();
  expect(latestFetch).toHaveBeenCalledTimes(1);
});

test("caps registered directory fetches at the shared global concurrency", async () => {
  const directories = ["one", "two", "three"].map((id) => ({
    id,
    path: `/${id}`,
    displayName: id,
    markerColor: "none" as const,
  }));
  const pendingByPath = new Map(directories.map((directory) => [
    directory.path,
    deferred<{
      latestSessionId: string;
      nextCursor: string;
      entries: LlmSessionHistoryEntry[];
    }>(),
  ]));
  let active = 0;
  let maxActive = 0;
  const fetchSessionHistory = jest.fn(async (path: string) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const value = await pendingByPath.get(path)!.promise;
    active -= 1;
    return value;
  });
  const { result } = await renderHook(() => useTestController({
    concurrency: 2,
    fetchSessionHistory,
    registeredDirectories: directories,
  }));

  let sync!: Promise<void>;
  await act(async () => {
    sync = result.current.controller.ensureRegisteredDirectorySessions("drawer_open");
    await Promise.resolve();
  });
  expect(fetchSessionHistory).toHaveBeenCalledTimes(2);
  expect(maxActive).toBe(2);

  pendingByPath.get("/one")!.resolve({
    latestSessionId: "one-session",
    nextCursor: "",
    entries: [{ ...session("", "one-session"), directory: "/one" }],
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetchSessionHistory).toHaveBeenCalledTimes(3);
  expect(maxActive).toBe(2);

  for (const path of ["/two", "/three"]) {
    pendingByPath.get(path)!.resolve({
      latestSessionId: `${path.slice(1)}-session`,
      nextCursor: "",
      entries: [],
    });
  }
  await act(async () => {
    await sync;
  });
  expect(result.current.controller.directorySessionSync).toMatchObject({
    phase: "complete",
    totalCount: 3,
    completedCount: 3,
  });
});

test("refresh preserves usable data and reports a terminal partial error", async () => {
  const fetchSessionHistory = jest.fn(async () => {
    throw new Error("runner offline");
  });
  const { result } = await renderHook(() => useTestController({
    fetchSessionHistory,
    initialTrees: {
      workspace: {
        ...emptyState,
        loaded: true,
        fetchedAtMs: 1,
        entries: [session()],
      },
    },
  }));

  await act(async () => {
    await result.current.controller.refreshRegisteredDirectorySessions("manual_refresh");
  });

  expect(result.current.directorySessionsById.workspace.entries).toHaveLength(1);
  expect(result.current.directorySessionsById.workspace).toMatchObject({
    loading: false,
    refreshing: false,
    error: "runner offline",
  });
  expect(result.current.controller.directorySessionSync).toMatchObject({
    phase: "partial_error",
    failedCount: 1,
    usableCountAfterCycle: 1,
    progress: 1,
  });
});

test("queues a refresh requested during an active ensure cycle", async () => {
  const requests: ReturnType<typeof deferred<{
    latestSessionId: string;
    nextCursor: string;
    entries: LlmSessionHistoryEntry[];
  }>>[] = [];
  const fetchSessionHistory = jest.fn(() => {
    const request = deferred<{
      latestSessionId: string;
      nextCursor: string;
      entries: LlmSessionHistoryEntry[];
    }>();
    requests.push(request);
    return request.promise;
  });
  const { result } = await renderHook(() => useTestController({ fetchSessionHistory }));

  let ensure!: Promise<void>;
  let refresh!: Promise<void>;
  await act(async () => {
    ensure = result.current.controller.ensureRegisteredDirectorySessions("drawer_open");
    refresh = result.current.controller.refreshRegisteredDirectorySessions("manual_refresh");
    await Promise.resolve();
  });
  expect(fetchSessionHistory).toHaveBeenCalledTimes(1);

  requests[0].resolve({
    latestSessionId: "session-1",
    nextCursor: "",
    entries: [session()],
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetchSessionHistory).toHaveBeenCalledTimes(2);

  requests[1].resolve({
    latestSessionId: "session-1",
    nextCursor: "",
    entries: [session()],
  });
  await act(async () => {
    await Promise.all([ensure, refresh]);
  });
  expect(result.current.controller.directorySessionSync).toMatchObject({
    cycleId: 2,
    requestedMode: "refresh",
    phase: "complete",
  });
});

test("moves and rewrites a usable tree when directory identity is canonicalized", async () => {
  const relativeDirectory = {
    id: "relative",
    path: ".",
    displayName: "Workspace",
    markerColor: "none" as const,
  };
  const canonicalDirectory = {
    ...relativeDirectory,
    id: "canonical",
    path: "/workspace",
  };
  const fetchSessionHistory = jest.fn();
  const { result } = await renderHook(() => {
    const [registeredDirectories, setRegisteredDirectories] = useState([relativeDirectory]);
    const value = useTestController({
      fetchSessionHistory,
      registeredDirectories,
      initialTrees: {
      relative: {
        ...emptyState,
        refreshing: true,
        loaded: true,
        fetchedAtMs: Date.now(),
        entries: [{ ...session(), directory: "." }],
        childrenByParentId: {
          "session-1": {
            loading: true,
            loaded: false,
            error: "",
            entries: [],
          },
        },
      },
      },
    });
    return {
      ...value,
      canonicalize: () => {
        value.controller.prepareDirectorySessionTargetChange({
          nextRegisteredDirectories: [canonicalDirectory],
          transitions: [{
            kind: "same_identity",
            fromId: "relative",
            toId: "canonical",
            fromPath: ".",
            toPath: "/workspace",
          }],
        });
        setRegisteredDirectories([canonicalDirectory]);
      },
    };
  });

  await act(async () => {
    result.current.canonicalize();
    await Promise.resolve();
  });

  expect(result.current.directorySessionsById.relative).toBeUndefined();
  expect(result.current.directorySessionsById.canonical.entries[0]).toMatchObject({
    sessionId: "session-1",
    directory: "/workspace",
  });
  expect(result.current.directorySessionsById.canonical.refreshing).toBe(false);
  expect(
    result.current.directorySessionsById.canonical.childrenByParentId["session-1"].loading
  ).toBe(false);
  expect(fetchSessionHistory).not.toHaveBeenCalled();
});

test("starts the selected directory before other registered directories", async () => {
  const directories = ["a", "b", "z"].map((id) => ({
    id,
    path: `/${id}`,
    displayName: id,
    markerColor: "none" as const,
  }));
  const selectedFetch = deferred<{
    latestSessionId: string;
    nextCursor: string;
    entries: LlmSessionHistoryEntry[];
  }>();
  const fetchSessionHistory = jest.fn((path: string) => (
    path === "/z"
      ? selectedFetch.promise
      : Promise.resolve({ latestSessionId: "", nextCursor: "", entries: [] })
  ));
  const { result } = await renderHook(() => useTestController({
    concurrency: 1,
    fetchSessionHistory,
    registeredDirectories: directories,
    selectedDirectoryPath: "/z",
  }));

  let sync!: Promise<void>;
  await act(async () => {
    sync = result.current.controller.ensureRegisteredDirectorySessions("drawer_open");
    await Promise.resolve();
  });
  expect(fetchSessionHistory.mock.calls[0]?.[0]).toBe("/z");

  selectedFetch.resolve({ latestSessionId: "", nextCursor: "", entries: [] });
  await act(async () => {
    await sync;
  });
});

test("hands a released fetch slot to its waiter before admitting a new caller", async () => {
  const directories = ["one", "two", "three", "four"].map((id) => ({
    id,
    path: `/${id}`,
    displayName: id,
    markerColor: "none" as const,
  }));
  const pendingByPath = new Map(directories.map((directory) => [
    directory.path,
    deferred<{
      latestSessionId: string;
      nextCursor: string;
      entries: LlmSessionHistoryEntry[];
    }>(),
  ]));
  let active = 0;
  let maxActive = 0;
  const fetchSessionHistory = jest.fn(async (path: string) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const value = await pendingByPath.get(path)!.promise;
    active -= 1;
    return value;
  });
  const { result } = await renderHook(() => useTestController({
    concurrency: 2,
    fetchSessionHistory,
    registeredDirectories: directories,
  }));
  const refresh = (index: number) => result.current.controller.refreshDirectorySessionTree(
    directories[index],
    "manual_refresh"
  );

  let first!: Promise<unknown>;
  let second!: Promise<unknown>;
  let third!: Promise<unknown>;
  let fourth!: Promise<unknown>;
  await act(async () => {
    first = refresh(0);
    second = refresh(1);
    third = refresh(2);
    await Promise.resolve();
  });
  expect(active).toBe(2);

  await act(async () => {
    pendingByPath.get("/one")!.resolve({
      latestSessionId: "",
      nextCursor: "",
      entries: [],
    });
    queueMicrotask(() => {
      fourth = refresh(3);
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(maxActive).toBe(2);

  for (const path of ["/two", "/three", "/four"]) {
    pendingByPath.get(path)!.resolve({
      latestSessionId: "",
      nextCursor: "",
      entries: [],
    });
  }
  await act(async () => {
    await Promise.all([first, second, third, fourth]);
  });
  expect(maxActive).toBe(2);
});

test("clears a superseded child loading state when first-page refresh starts", async () => {
  const childFetch = deferred<LlmSessionHistoryEntry[]>();
  const firstPageFetch = deferred<{
    latestSessionId: string;
    nextCursor: string;
    entries: LlmSessionHistoryEntry[];
  }>();
  const fetchSessionChildHistory = jest.fn()
    .mockImplementationOnce(() => childFetch.promise)
    .mockResolvedValueOnce([]);
  const fetchSessionHistory = jest.fn(() => firstPageFetch.promise);
  const parent = session("", "parent");
  const { result } = await renderHook(() => useTestController({
    fetchSessionHistory,
    fetchSessionChildHistory,
    initialTrees: {
      workspace: {
        ...emptyState,
        loaded: true,
        fetchedAtMs: 1,
        entries: [parent],
      },
    },
  }));

  let childLoading!: Promise<void>;
  let refresh!: Promise<unknown>;
  await act(async () => {
    childLoading = result.current.controller.loadSessionChildTree(
      "workspace",
      "/workspace",
      "parent"
    );
    await Promise.resolve();
    refresh = result.current.controller.refreshDirectorySessionTree(
      workspaceDirectory,
      "manual_refresh"
    );
    await Promise.resolve();
  });
  expect(
    result.current.directorySessionsById.workspace.childrenByParentId.parent.loading
  ).toBe(false);

  firstPageFetch.resolve({
    latestSessionId: "parent",
    nextCursor: "",
    entries: [parent],
  });
  childFetch.resolve([]);
  await act(async () => {
    await Promise.all([childLoading, refresh]);
    await result.current.controller.loadSessionChildTree(
      "workspace",
      "/workspace",
      "parent"
    );
  });
  expect(fetchSessionChildHistory).toHaveBeenCalledTimes(2);
  expect(
    result.current.directorySessionsById.workspace.childrenByParentId.parent.loading
  ).toBe(false);
});

test("keeps a read mutation when another directory fetch completes in the same batch", async () => {
  const directories = [{
    ...workspaceDirectory,
    id: "first",
    path: "/first",
  }, {
    ...workspaceDirectory,
    id: "second",
    path: "/second",
  }];
  const secondFetch = deferred<{
    latestSessionId: string;
    nextCursor: string;
    entries: LlmSessionHistoryEntry[];
  }>();
  const { result } = await renderHook(() => useTestController({
    fetchSessionHistory: jest.fn(() => secondFetch.promise),
    registeredDirectories: directories,
    initialTrees: {
      first: {
        ...emptyState,
        loaded: true,
        fetchedAtMs: 1,
        entries: [{ ...session("", "read-target"), directory: "/first" }],
      },
      second: {
        ...emptyState,
        loaded: true,
        fetchedAtMs: 1,
        entries: [{ ...session("", "other"), directory: "/second" }],
      },
    },
  }));

  let refresh!: Promise<unknown>;
  await act(async () => {
    refresh = result.current.controller.refreshDirectorySessionTree(
      directories[1],
      "manual_refresh"
    );
    await Promise.resolve();
    result.current.controller.applySessionLastReadAtByIdToDirectoryTrees(new Map([[
      "read-target",
      "2026-07-29T02:00:00.000Z",
    ]]));
    secondFetch.resolve({
      latestSessionId: "other",
      nextCursor: "",
      entries: [{ ...session("", "other"), directory: "/second" }],
    });
    await refresh;
  });

  expect(result.current.directorySessionsById.first.entries[0].lastReadAt)
    .toBe("2026-07-29T02:00:00.000Z");
});
