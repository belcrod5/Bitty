import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { DirectorySessionTreeState, RegisteredDirectoryEntry, SessionChildTreeState } from "../components/AppDrawer";

type FetchSessionHistoryResult = {
  latestSessionId: string;
  nextCursor: string;
  entries: DirectorySessionTreeState["entries"];
};

type FetchSessionHistoryOptions = {
  limit: number;
  cursor?: string;
  includeRunnerSnapshots?: boolean;
  runnerSnapshotLimit?: number;
};

const EMPTY_SESSION_CHILD_TREE_STATE: SessionChildTreeState = {
  loading: false,
  loaded: false,
  error: "",
  entries: [],
};

type UseDirectorySessionTreeControllerArgs = {
  directorySessionsById: Record<string, DirectorySessionTreeState>;
  setDirectorySessionsById: Dispatch<SetStateAction<Record<string, DirectorySessionTreeState>>>;
  setExpandedDirectoryIds: Dispatch<SetStateAction<string[]>>;
  fetchSessionHistory: (
    directoryPath: string,
    options?: FetchSessionHistoryOptions
  ) => Promise<FetchSessionHistoryResult>;
  fetchSessionChildHistory: (
    parentSessionId: string,
    directoryPath: string,
    options?: {
      limit?: number;
      includeRunnerSnapshots?: boolean;
      runnerSnapshotLimit?: number;
    }
  ) => Promise<DirectorySessionTreeState["entries"]>;
  emptyDirectorySessionTreeState: DirectorySessionTreeState;
  directorySessionPageSize: number;
  directorySessionRunnerSnapshotLimit: number;
  directorySessionPrefetchTtlMs: number;
  directorySessionPrefetchConcurrency: number;
  drawerOpen: boolean;
  registeredDirectories: RegisteredDirectoryEntry[];
  normalizedLlmDirectoryForRequest: () => string;
};

export function useDirectorySessionTreeController({
  directorySessionsById,
  setDirectorySessionsById,
  setExpandedDirectoryIds,
  fetchSessionHistory,
  fetchSessionChildHistory,
  emptyDirectorySessionTreeState,
  directorySessionPageSize,
  directorySessionRunnerSnapshotLimit,
  directorySessionPrefetchTtlMs,
  directorySessionPrefetchConcurrency,
  drawerOpen,
  registeredDirectories,
  normalizedLlmDirectoryForRequest,
}: UseDirectorySessionTreeControllerArgs) {
  const loadDirectorySessionTree = useCallback(async (
    directoryId: string,
    directoryPath: string,
    options?: {
      force?: boolean;
      includeRunnerSnapshots?: boolean;
      runnerSnapshotLimit?: number;
    }
  ) => {
    const force = options?.force === true;
    const includeRunnerSnapshots = options?.includeRunnerSnapshots !== false;
    const runnerSnapshotLimit = Number.isFinite(Number(options?.runnerSnapshotLimit))
      ? Math.max(1, Math.min(200, Math.floor(Number(options?.runnerSnapshotLimit))))
      : directorySessionRunnerSnapshotLimit;
    const currentState = directorySessionsById[directoryId] || emptyDirectorySessionTreeState;
    if (currentState.loading) return;
    if (!force && currentState.loaded) return;
    setDirectorySessionsById((prev) => ({
      ...prev,
      [directoryId]: {
        ...(prev[directoryId] || emptyDirectorySessionTreeState),
        loading: true,
        loadingMore: false,
        error: "",
      },
    }));
    try {
      const result = await fetchSessionHistory(directoryPath, {
        limit: directorySessionPageSize,
        includeRunnerSnapshots,
        runnerSnapshotLimit,
      });
      setDirectorySessionsById((prev) => ({
        ...prev,
        [directoryId]: {
          loading: false,
          loadingMore: false,
          loaded: true,
          fetchedAtMs: Date.now(),
          error: "",
          latestSessionId: result.latestSessionId,
          nextCursor: result.nextCursor,
          hasMore: Boolean(result.nextCursor),
          entries: result.entries,
          childrenByParentId: (prev[directoryId] || emptyDirectorySessionTreeState).childrenByParentId || {},
        },
      }));
    } catch (err) {
      setDirectorySessionsById((prev) => ({
        ...prev,
        [directoryId]: {
          ...(prev[directoryId] || emptyDirectorySessionTreeState),
          loading: false,
          loadingMore: false,
          loaded: true,
          fetchedAtMs: Date.now(),
          error: err instanceof Error ? err.message : String(err),
          latestSessionId: "",
          nextCursor: "",
          hasMore: false,
          entries: [],
          childrenByParentId: {},
        },
      }));
    }
  }, [
    directorySessionPageSize,
    directorySessionRunnerSnapshotLimit,
    directorySessionsById,
    emptyDirectorySessionTreeState,
    fetchSessionHistory,
    setDirectorySessionsById,
  ]);

  const loadMoreDirectorySessionTree = useCallback(async (directoryId: string, directoryPath: string) => {
    const currentState = directorySessionsById[directoryId] || emptyDirectorySessionTreeState;
    if (currentState.loading || currentState.loadingMore || !currentState.hasMore || !currentState.nextCursor) return;
    setDirectorySessionsById((prev) => ({
      ...prev,
      [directoryId]: {
        ...(prev[directoryId] || emptyDirectorySessionTreeState),
        loadingMore: true,
        error: "",
      },
    }));
    try {
      const result = await fetchSessionHistory(directoryPath, {
        limit: directorySessionPageSize,
        cursor: currentState.nextCursor,
      });
      setDirectorySessionsById((prev) => {
        const prevState = prev[directoryId] || emptyDirectorySessionTreeState;
        const existingIds = new Set(prevState.entries.map((item) => item.sessionId));
        const appended = result.entries.filter((item) => !existingIds.has(item.sessionId));
        return {
          ...prev,
          [directoryId]: {
            ...prevState,
            loading: false,
            loadingMore: false,
            loaded: true,
            fetchedAtMs: Date.now(),
            error: "",
            latestSessionId: prevState.latestSessionId || result.latestSessionId,
            nextCursor: result.nextCursor,
            hasMore: Boolean(result.nextCursor),
            entries: [...prevState.entries, ...appended],
            childrenByParentId: prevState.childrenByParentId || {},
          },
        };
      });
    } catch (err) {
      setDirectorySessionsById((prev) => ({
        ...prev,
        [directoryId]: {
          ...(prev[directoryId] || emptyDirectorySessionTreeState),
          loadingMore: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, [
    directorySessionPageSize,
    directorySessionsById,
    emptyDirectorySessionTreeState,
    fetchSessionHistory,
    setDirectorySessionsById,
  ]);

  const loadSessionChildTree = useCallback(async (
    directoryId: string,
    directoryPath: string,
    parentSessionId: string
  ) => {
    const parentId = String(parentSessionId || "").trim();
    if (!parentId) return;
    const currentState = directorySessionsById[directoryId] || emptyDirectorySessionTreeState;
    const currentChildState = currentState.childrenByParentId?.[parentId];
    if (currentChildState?.loading) return;
    setDirectorySessionsById((prev) => {
      const prevState = prev[directoryId] || emptyDirectorySessionTreeState;
      return {
        ...prev,
        [directoryId]: {
          ...prevState,
          childrenByParentId: {
            ...(prevState.childrenByParentId || {}),
            [parentId]: {
              ...(prevState.childrenByParentId?.[parentId] || EMPTY_SESSION_CHILD_TREE_STATE),
              loading: true,
              error: "",
            },
          },
        },
      };
    });
    try {
      const entries = await fetchSessionChildHistory(parentId, directoryPath, {
        limit: 50,
        includeRunnerSnapshots: true,
        runnerSnapshotLimit: directorySessionRunnerSnapshotLimit,
      });
      setDirectorySessionsById((prev) => {
        const prevState = prev[directoryId] || emptyDirectorySessionTreeState;
        return {
          ...prev,
          [directoryId]: {
            ...prevState,
            childrenByParentId: {
              ...(prevState.childrenByParentId || {}),
              [parentId]: {
                loading: false,
                loaded: true,
                error: "",
                entries,
              },
            },
          },
        };
      });
    } catch (err) {
      setDirectorySessionsById((prev) => {
        const prevState = prev[directoryId] || emptyDirectorySessionTreeState;
        return {
          ...prev,
          [directoryId]: {
            ...prevState,
            childrenByParentId: {
              ...(prevState.childrenByParentId || {}),
              [parentId]: {
                loading: false,
                loaded: true,
                error: err instanceof Error ? err.message : String(err),
                entries: [],
              },
            },
          },
        };
      });
    }
  }, [
    directorySessionRunnerSnapshotLimit,
    directorySessionsById,
    emptyDirectorySessionTreeState,
    fetchSessionChildHistory,
    setDirectorySessionsById,
  ]);

  const toggleDirectoryExpanded = useCallback((directoryId: string, _directoryPath: string) => {
    setExpandedDirectoryIds((prev) => {
      const has = prev.includes(directoryId);
      if (has) return prev.filter((id) => id !== directoryId);
      return [...prev, directoryId];
    });
  }, [setExpandedDirectoryIds]);

  const shouldPrefetchDirectorySessionTree = useCallback((
    state: DirectorySessionTreeState | undefined,
    nowMs: number
  ) => {
    if (!state) return true;
    if (state.loading || state.loadingMore) return false;
    if (!state.loaded) return true;
    if (!Number.isFinite(state.fetchedAtMs) || state.fetchedAtMs <= 0) return true;
    return (nowMs - state.fetchedAtMs) >= directorySessionPrefetchTtlMs;
  }, [directorySessionPrefetchTtlMs]);

  const prefetchDirectorySessionTreesForDrawerOpen = useCallback(async () => {
    if (!drawerOpen) return;
    if (registeredDirectories.length <= 0) return;
    const nowMs = Date.now();
    const selectedDirectoryPath = normalizedLlmDirectoryForRequest();
    const sortedDirectories = [...registeredDirectories].sort((a, b) => {
      const aSelected = a.path === selectedDirectoryPath ? 1 : 0;
      const bSelected = b.path === selectedDirectoryPath ? 1 : 0;
      if (aSelected !== bSelected) return bSelected - aSelected;
      return a.path.localeCompare(b.path);
    });
    const targets = sortedDirectories
      .map((directory) => {
        const state = directorySessionsById[directory.id];
        const shouldPrefetch = shouldPrefetchDirectorySessionTree(state, nowMs);
        if (!shouldPrefetch) return null;
        const forceRefresh = Boolean(state?.loaded);
        return {
          directory,
          forceRefresh,
        };
      })
      .filter((item): item is {
        directory: RegisteredDirectoryEntry;
        forceRefresh: boolean;
      } => !!item);
    if (targets.length <= 0) return;

    let cursor = 0;
    const workerCount = Math.max(1, Math.min(directorySessionPrefetchConcurrency, targets.length));
    const workers = Array.from({ length: workerCount }, () => (async () => {
      while (cursor < targets.length) {
        const index = cursor;
        cursor += 1;
        const item = targets[index];
        if (!item) break;
        await loadDirectorySessionTree(item.directory.id, item.directory.path, {
          force: item.forceRefresh,
          includeRunnerSnapshots: true,
          runnerSnapshotLimit: directorySessionRunnerSnapshotLimit,
        });
      }
    })());
    await Promise.all(workers);
  }, [
    directorySessionPrefetchConcurrency,
    directorySessionRunnerSnapshotLimit,
    directorySessionsById,
    drawerOpen,
    loadDirectorySessionTree,
    normalizedLlmDirectoryForRequest,
    registeredDirectories,
    shouldPrefetchDirectorySessionTree,
  ]);

  return {
    loadDirectorySessionTree,
    loadMoreDirectorySessionTree,
    loadSessionChildTree,
    toggleDirectoryExpanded,
    prefetchDirectorySessionTreesForDrawerOpen,
  };
}
