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
      directorySessionRunnerSnapshotLimit: 200,
      directorySessionPrefetchTtlMs: 1,
      directorySessionPrefetchConcurrency: 1,
      drawerOpen: true,
      registeredDirectories: [],
      normalizedLlmDirectoryForRequest: () => "/workspace",
    });
    return {
      controller,
      directorySessionsById,
      markRead: () => {
        controller.recordSessionReadDuringFetch(
          "session-1",
          "2026-07-29T02:00:00.000Z"
        );
        setDirectorySessionsById((prev) => ({
          ...prev,
          workspace: {
            ...prev.workspace,
            entries: [session("2026-07-29T02:00:00.000Z")],
          },
        }));
      },
    };
  });

  let loading!: Promise<void>;
  await act(async () => {
    loading = result.current.controller.loadDirectorySessionTree(
      "workspace",
      "/workspace",
      { force: true }
    );
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
      directorySessionRunnerSnapshotLimit: 200,
      directorySessionPrefetchTtlMs: 1,
      directorySessionPrefetchConcurrency: 1,
      drawerOpen: true,
      registeredDirectories: [],
      normalizedLlmDirectoryForRequest: () => "/workspace",
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
  await act(async () => {
    result.current.controller.recordSessionReadDuringFetch(
      "page-2",
      "2026-07-29T02:00:00.000Z"
    );
  });
  await act(async () => {
    fetchResult.resolve({
      latestSessionId: "page-1",
      nextCursor: "",
      entries: [session("", "page-2")],
    });
    await loading;
  });

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
      directorySessionRunnerSnapshotLimit: 200,
      directorySessionPrefetchTtlMs: 1,
      directorySessionPrefetchConcurrency: 1,
      drawerOpen: true,
      registeredDirectories: [],
      normalizedLlmDirectoryForRequest: () => "/workspace",
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
  await act(async () => {
    result.current.controller.recordSessionReadDuringFetch(
      "child",
      "2026-07-29T02:00:00.000Z"
    );
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
    result.current.directorySessionsById.workspace.childrenByParentId.parent.entries[0]
  ).toEqual(expect.objectContaining({
    sessionId: "child",
    lastReadAt: "2026-07-29T02:00:00.000Z",
  }));
});
