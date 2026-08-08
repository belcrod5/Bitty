import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  DirectoryLoadOutcome,
  DirectorySessionSyncReason,
  DirectorySessionSyncState,
  DirectorySessionTreeState,
  RegisteredDirectoryEntry,
  SessionChildTreeState,
} from "../types/directorySessions";
import { IDLE_DIRECTORY_SESSION_SYNC } from "../types/directorySessions";

type FetchSessionHistoryResult = {
  latestSessionId: string;
  nextCursor: string;
  entries: DirectorySessionTreeState["entries"];
};

type FetchSessionHistoryOptions = {
  limit: number;
  cursor?: string;
  includeRunnerSnapshots?: boolean;
};

export type DirectoryTargetTransition =
  | { kind: "same_identity"; fromId: string; toId: string; fromPath: string; toPath: string }
  | { kind: "replace"; directoryId: string; fromPath: string; toPath: string }
  | { kind: "remove"; directoryId: string; fromPath: string };

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
    options?: { limit?: number; includeRunnerSnapshots?: boolean }
  ) => Promise<DirectorySessionTreeState["entries"]>;
  emptyDirectorySessionTreeState: DirectorySessionTreeState;
  directorySessionPageSize: number;
  directorySessionPrefetchTtlMs: number;
  directorySessionPrefetchConcurrency: number;
  registeredDirectories: RegisteredDirectoryEntry[];
  selectedDirectoryPath: string;
  // 永続設定(runner接続先・登録ディレクトリ)ロード完了前は同期サイクルを開始せず、
  // intentを保留してロード完了時にdrainする(起動直後のensureが空ターゲット・
  // 未認証状態で走って失敗確定するのを防ぐ)。既定trueで既存テスト・呼び出しに影響しない。
  bootstrapReady?: boolean;
};

type RegisteredSyncIntent = {
  mode: "ensure" | "refresh";
  reasons: Set<DirectorySessionSyncReason>;
  targetKey: string;
  targetRevision: number;
  targets: RegisteredDirectoryEntry[];
};

const EMPTY_SESSION_CHILD_TREE_STATE: SessionChildTreeState = {
  loading: false,
  loaded: false,
  error: "",
  entries: [],
};

function normalizeDirectoryPath(path: unknown) {
  return String(path || "").trim();
}

function buildTargetSnapshot(directories: RegisteredDirectoryEntry[]) {
  const targets = directories
    .map((directory) => ({
      ...directory,
      path: normalizeDirectoryPath(directory.path),
    }))
    .filter((directory) => directory.id && directory.path)
    .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  return {
    targets,
    key: targets.map((directory) => `${directory.id}\u0000${directory.path}`).join("\u0001"),
  };
}

function hasUsableTree(state: DirectorySessionTreeState | undefined) {
  return Boolean(state?.loaded && Number(state.fetchedAtMs) > 0);
}

function applyReadOverrides(
  entries: DirectorySessionTreeState["entries"],
  lastReadAtBySessionId: Map<string, string>
) {
  if (lastReadAtBySessionId.size <= 0) return entries;
  return entries.map((entry) => {
    const lastReadAt = lastReadAtBySessionId.get(entry.sessionId);
    return !lastReadAt || lastReadAt === entry.lastReadAt ? entry : { ...entry, lastReadAt };
  });
}

function rewriteTreeDirectory(
  state: DirectorySessionTreeState,
  fromPath: string,
  toPath: string
) {
  const rewriteEntries = (entries: DirectorySessionTreeState["entries"]) => entries.map((entry) => (
    normalizeDirectoryPath(entry.directory) === fromPath ? { ...entry, directory: toPath } : entry
  ));
  return {
    ...state,
    loading: false,
    refreshing: false,
    loadingMore: false,
    entries: rewriteEntries(state.entries),
    childrenByParentId: Object.fromEntries(
      Object.entries(state.childrenByParentId).map(([parentId, child]) => [
        parentId,
        { ...child, loading: false, entries: rewriteEntries(child.entries) },
      ])
    ),
  };
}

export function useDirectorySessionTreeController({
  directorySessionsById,
  setDirectorySessionsById,
  setExpandedDirectoryIds,
  fetchSessionHistory,
  fetchSessionChildHistory,
  emptyDirectorySessionTreeState,
  directorySessionPageSize,
  directorySessionPrefetchTtlMs,
  directorySessionPrefetchConcurrency,
  registeredDirectories,
  selectedDirectoryPath,
  bootstrapReady = true,
}: UseDirectorySessionTreeControllerArgs) {
  const initialTargets = buildTargetSnapshot(registeredDirectories);
  const [directorySessionSync, setDirectorySessionSync] = useState<DirectorySessionSyncState>(
    IDLE_DIRECTORY_SESSION_SYNC
  );
  const fetchSessionHistoryRef = useRef(fetchSessionHistory);
  const fetchSessionChildHistoryRef = useRef(fetchSessionChildHistory);
  fetchSessionHistoryRef.current = fetchSessionHistory;
  fetchSessionChildHistoryRef.current = fetchSessionChildHistory;
  const directorySessionsByIdRef = useRef(directorySessionsById);
  const registeredDirectoriesRef = useRef(initialTargets.targets);
  const selectedDirectoryPathRef = useRef(normalizeDirectoryPath(selectedDirectoryPath));
  selectedDirectoryPathRef.current = normalizeDirectoryPath(selectedDirectoryPath);
  const bootstrapReadyRef = useRef(bootstrapReady);
  bootstrapReadyRef.current = bootstrapReady;
  const registeredTargetKeyRef = useRef(initialTargets.key);
  const registeredDirectoryPathByIdRef = useRef(
    new Map(initialTargets.targets.map((directory) => [directory.id, directory.path]))
  );
  const targetRevisionRef = useRef(0);
  const generationByDirectoryIdRef = useRef(new Map<string, number>());
  const supersededReasonByDirectoryIdRef = useRef(
    new Map<string, "newer_request" | "path_changed" | "removed" | "identity_merged">()
  );
  const inFlightByKeyRef = useRef(new Map<string, Promise<DirectoryLoadOutcome>>());
  const refreshAfterActiveByKeyRef = useRef(new Map<string, Promise<DirectoryLoadOutcome>>());
  const readOverridesByActiveFetchRef = useRef(new Set<Map<string, string>>());
  const activeFetchCountRef = useRef(0);
  const waitingFetchesRef = useRef<Array<() => void>>([]);
  const queuedSyncIntentRef = useRef<RegisteredSyncIntent | null>(null);
  const activeSyncIntentRef = useRef<RegisteredSyncIntent | null>(null);
  const syncDrainPromiseRef = useRef<Promise<void> | null>(null);
  const nextCycleIdRef = useRef(0);
  const disposedRef = useRef(false);
  const enqueueRegisteredSyncRef = useRef<(
    mode: "ensure" | "refresh",
    reason: DirectorySessionSyncReason
  ) => Promise<void>>(async () => {});

  useEffect(() => {
    directorySessionsByIdRef.current = directorySessionsById;
  }, [directorySessionsById]);

  useEffect(() => () => {
    disposedRef.current = true;
  }, []);

  const commitTrees = useCallback((next: Record<string, DirectorySessionTreeState>) => {
    directorySessionsByIdRef.current = next;
    if (!disposedRef.current) setDirectorySessionsById(next);
  }, [setDirectorySessionsById]);

  const nextGeneration = useCallback((directoryId: string) => {
    const next = (generationByDirectoryIdRef.current.get(directoryId) || 0) + 1;
    generationByDirectoryIdRef.current.set(directoryId, next);
    return next;
  }, []);

  const applySessionLastReadAtByIdToDirectoryTrees = useCallback((
    lastReadAtBySessionId: Map<string, string>
  ) => {
    if (lastReadAtBySessionId.size <= 0) return;
    for (const readOverrides of readOverridesByActiveFetchRef.current) {
      for (const [sessionId, lastReadAt] of lastReadAtBySessionId) {
        readOverrides.set(sessionId, lastReadAt);
      }
    }
    const currentTrees = directorySessionsByIdRef.current;
    let changed = false;
    const nextTrees = Object.fromEntries(
      Object.entries(currentTrees).map(([directoryId, state]) => {
        let entryChanged = false;
        const entries = state.entries.map((entry) => {
          const lastReadAt = lastReadAtBySessionId.get(entry.sessionId);
          if (!lastReadAt || lastReadAt === entry.lastReadAt) return entry;
          entryChanged = true;
          return { ...entry, lastReadAt };
        });
        let childChanged = false;
        const childrenByParentId = Object.fromEntries(
          Object.entries(state.childrenByParentId).map(([parentId, child]) => {
            let currentChildChanged = false;
            const childEntries = child.entries.map((entry) => {
              const lastReadAt = lastReadAtBySessionId.get(entry.sessionId);
              if (!lastReadAt || lastReadAt === entry.lastReadAt) return entry;
              currentChildChanged = true;
              return { ...entry, lastReadAt };
            });
            if (currentChildChanged) childChanged = true;
            return [
              parentId,
              currentChildChanged ? { ...child, entries: childEntries } : child,
            ];
          })
        );
        if (!entryChanged && !childChanged) return [directoryId, state];
        changed = true;
        return [directoryId, { ...state, entries, childrenByParentId }];
      })
    );
    if (changed) commitTrees(nextTrees);
  }, [commitTrees]);

  const acquireFetchSlot = useCallback(async () => {
    if (activeFetchCountRef.current < directorySessionPrefetchConcurrency) {
      activeFetchCountRef.current += 1;
    } else {
      await new Promise<void>((resolve) => waitingFetchesRef.current.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waitingFetchesRef.current.shift();
      if (next) {
        next();
      } else {
        activeFetchCountRef.current = Math.max(0, activeFetchCountRef.current - 1);
      }
    };
  }, [directorySessionPrefetchConcurrency]);

  const currentSupersededOutcome = useCallback((
    directory: RegisteredDirectoryEntry,
    generation: number
  ): DirectoryLoadOutcome | null => {
    const path = normalizeDirectoryPath(directory.path);
    const registeredPath = registeredDirectoryPathByIdRef.current.get(directory.id);
    if (!registeredPath) {
      return {
        status: "superseded",
        directoryId: directory.id,
        directoryPath: path,
        reason: supersededReasonByDirectoryIdRef.current.get(directory.id) || "removed",
      };
    }
    if (registeredPath !== path) {
      return {
        status: "superseded",
        directoryId: directory.id,
        directoryPath: path,
        reason: "path_changed",
      };
    }
    if ((generationByDirectoryIdRef.current.get(directory.id) || 0) !== generation) {
      return {
        status: "superseded",
        directoryId: directory.id,
        directoryPath: path,
        reason: supersededReasonByDirectoryIdRef.current.get(directory.id) || "newer_request",
      };
    }
    return null;
  }, []);

  const loadFirstPage = useCallback((
    directory: RegisteredDirectoryEntry,
    mode: "ensure" | "refresh",
    reason: DirectorySessionSyncReason
  ): Promise<DirectoryLoadOutcome> => {
    const directoryPath = normalizeDirectoryPath(directory.path);
    const key = `${directory.id}\u0000${directoryPath}`;
    const joined = inFlightByKeyRef.current.get(key);
    if (joined) {
      if (reason !== "session_completed") return joined;
      const queued = refreshAfterActiveByKeyRef.current.get(key);
      if (queued) return queued;
      let refreshAfterActive!: Promise<DirectoryLoadOutcome>;
      refreshAfterActive = joined.then(() => {
        if (refreshAfterActiveByKeyRef.current.get(key) === refreshAfterActive) {
          refreshAfterActiveByKeyRef.current.delete(key);
        }
        return loadFirstPage(directory, "refresh", reason);
      }).finally(() => {
        if (refreshAfterActiveByKeyRef.current.get(key) === refreshAfterActive) {
          refreshAfterActiveByKeyRef.current.delete(key);
        }
      });
      refreshAfterActiveByKeyRef.current.set(key, refreshAfterActive);
      return refreshAfterActive;
    }

    const current = directorySessionsByIdRef.current[directory.id];
    if (
      mode === "ensure" &&
      hasUsableTree(current) &&
      Date.now() - Number(current?.fetchedAtMs || 0) < directorySessionPrefetchTtlMs
    ) {
      return Promise.resolve({
        status: "skipped",
        directoryId: directory.id,
        directoryPath,
        reason: "fresh",
        hasUsableData: true,
      });
    }
    if (registeredDirectoryPathByIdRef.current.get(directory.id) !== directoryPath) {
      return Promise.resolve({
        status: "skipped",
        directoryId: directory.id,
        directoryPath,
        reason: "not_registered",
        hasUsableData: false,
      });
    }

    const generation = nextGeneration(directory.id);
    supersededReasonByDirectoryIdRef.current.set(directory.id, "newer_request");
    const previous = current || emptyDirectorySessionTreeState;
    commitTrees({
      ...directorySessionsByIdRef.current,
      [directory.id]: {
        ...previous,
        loading: !hasUsableTree(previous),
        refreshing: hasUsableTree(previous),
        loadingMore: false,
        error: "",
        childrenByParentId: Object.fromEntries(
          Object.entries(previous.childrenByParentId).map(([parentId, child]) => [
            parentId,
            child.loading ? { ...child, loading: false } : child,
          ])
        ),
      },
    });
    const readOverrides = new Map<string, string>();
    readOverridesByActiveFetchRef.current.add(readOverrides);

    let request!: Promise<DirectoryLoadOutcome>;
    request = (async (): Promise<DirectoryLoadOutcome> => {
      const releaseSlot = await acquireFetchSlot();
      try {
        const beforeFetch = currentSupersededOutcome(directory, generation);
        if (beforeFetch) return beforeFetch;
        const result = await fetchSessionHistoryRef.current(directoryPath, {
          limit: directorySessionPageSize,
          includeRunnerSnapshots: true,
        });
        const superseded = currentSupersededOutcome(directory, generation);
        if (superseded) return superseded;
        const latest = directorySessionsByIdRef.current[directory.id] || previous;
        const state: DirectorySessionTreeState = {
          ...latest,
          loading: false,
          refreshing: false,
          loadingMore: false,
          loaded: true,
          fetchedAtMs: Date.now(),
          error: "",
          latestSessionId: result.latestSessionId,
          nextCursor: result.nextCursor,
          hasMore: Boolean(result.nextCursor),
          entries: applyReadOverrides(result.entries, readOverrides),
          childrenByParentId: latest.childrenByParentId || {},
        };
        commitTrees({ ...directorySessionsByIdRef.current, [directory.id]: state });
        return { status: "success", directoryId: directory.id, directoryPath, state };
      } catch (error) {
        const superseded = currentSupersededOutcome(directory, generation);
        if (superseded) return superseded;
        const latest = directorySessionsByIdRef.current[directory.id] || previous;
        const nextState: DirectorySessionTreeState = {
          ...latest,
          loading: false,
          refreshing: false,
          loadingMore: false,
          error: error instanceof Error ? error.message : String(error),
        };
        commitTrees({ ...directorySessionsByIdRef.current, [directory.id]: nextState });
        return {
          status: "failed",
          directoryId: directory.id,
          directoryPath,
          error: nextState.error,
          hasUsableData: hasUsableTree(nextState),
        };
      } finally {
        releaseSlot();
        readOverridesByActiveFetchRef.current.delete(readOverrides);
        if (inFlightByKeyRef.current.get(key) === request) inFlightByKeyRef.current.delete(key);
      }
    })();
    inFlightByKeyRef.current.set(key, request);
    return request;
  }, [
    acquireFetchSlot,
    commitTrees,
    currentSupersededOutcome,
    directorySessionPageSize,
    directorySessionPrefetchTtlMs,
    emptyDirectorySessionTreeState,
    nextGeneration,
  ]);

  const ensureDirectorySessionTree = useCallback((
    directory: RegisteredDirectoryEntry,
    reason: DirectorySessionSyncReason
  ) => loadFirstPage(directory, "ensure", reason), [loadFirstPage]);

  const refreshDirectorySessionTree = useCallback((
    directory: RegisteredDirectoryEntry,
    reason: DirectorySessionSyncReason
  ) => loadFirstPage(directory, "refresh", reason), [loadFirstPage]);

  const loadMoreDirectorySessionTree = useCallback(async (
    directoryId: string,
    directoryPathRaw: string
  ) => {
    const directoryPath = normalizeDirectoryPath(directoryPathRaw);
    const current = directorySessionsByIdRef.current[directoryId];
    if (
      !current ||
      current.loading ||
      current.refreshing ||
      current.loadingMore ||
      !current.hasMore ||
      !current.nextCursor
    ) return;
    const generation = generationByDirectoryIdRef.current.get(directoryId) || 0;
    commitTrees({
      ...directorySessionsByIdRef.current,
      [directoryId]: { ...current, loadingMore: true, error: "" },
    });
    const readOverrides = new Map<string, string>();
    readOverridesByActiveFetchRef.current.add(readOverrides);
    try {
      const result = await fetchSessionHistoryRef.current(directoryPath, {
        limit: directorySessionPageSize,
        cursor: current.nextCursor,
      });
      if (
        (generationByDirectoryIdRef.current.get(directoryId) || 0) !== generation ||
        registeredDirectoryPathByIdRef.current.get(directoryId) !== directoryPath
      ) return;
      const latest = directorySessionsByIdRef.current[directoryId] || current;
      const existingIds = new Set(latest.entries.map((entry) => entry.sessionId));
      const appended = applyReadOverrides(result.entries, readOverrides)
        .filter((entry) => !existingIds.has(entry.sessionId));
      commitTrees({
        ...directorySessionsByIdRef.current,
        [directoryId]: {
          ...latest,
          loadingMore: false,
          fetchedAtMs: Date.now(),
          error: "",
          nextCursor: result.nextCursor,
          hasMore: Boolean(result.nextCursor),
          entries: [...latest.entries, ...appended],
        },
      });
    } catch (error) {
      const latest = directorySessionsByIdRef.current[directoryId];
      if (
        !latest ||
        (generationByDirectoryIdRef.current.get(directoryId) || 0) !== generation
      ) return;
      commitTrees({
        ...directorySessionsByIdRef.current,
        [directoryId]: {
          ...latest,
          loadingMore: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      readOverridesByActiveFetchRef.current.delete(readOverrides);
    }
  }, [commitTrees, directorySessionPageSize]);

  const loadSessionChildTree = useCallback(async (
    directoryId: string,
    directoryPathRaw: string,
    parentSessionId: string
  ) => {
    const directoryPath = normalizeDirectoryPath(directoryPathRaw);
    const parentId = String(parentSessionId || "").trim();
    const current = directorySessionsByIdRef.current[directoryId];
    if (!parentId || !current || current.childrenByParentId[parentId]?.loading) return;
    const generation = generationByDirectoryIdRef.current.get(directoryId) || 0;
    commitTrees({
      ...directorySessionsByIdRef.current,
      [directoryId]: {
        ...current,
        childrenByParentId: {
          ...current.childrenByParentId,
          [parentId]: {
            ...(current.childrenByParentId[parentId] || EMPTY_SESSION_CHILD_TREE_STATE),
            loading: true,
            error: "",
          },
        },
      },
    });
    const readOverrides = new Map<string, string>();
    readOverridesByActiveFetchRef.current.add(readOverrides);
    try {
      const entries = await fetchSessionChildHistoryRef.current(parentId, directoryPath, {
        limit: 50,
        includeRunnerSnapshots: true,
      });
      if ((generationByDirectoryIdRef.current.get(directoryId) || 0) !== generation) return;
      const latest = directorySessionsByIdRef.current[directoryId];
      if (!latest) return;
      commitTrees({
        ...directorySessionsByIdRef.current,
        [directoryId]: {
          ...latest,
          childrenByParentId: {
            ...latest.childrenByParentId,
            [parentId]: {
              loading: false,
              loaded: true,
              error: "",
              entries: applyReadOverrides(entries, readOverrides),
            },
          },
        },
      });
    } catch (error) {
      const latest = directorySessionsByIdRef.current[directoryId];
      if (
        !latest ||
        (generationByDirectoryIdRef.current.get(directoryId) || 0) !== generation
      ) return;
      commitTrees({
        ...directorySessionsByIdRef.current,
        [directoryId]: {
          ...latest,
          childrenByParentId: {
            ...latest.childrenByParentId,
            [parentId]: {
              loading: false,
              loaded: true,
              error: error instanceof Error ? error.message : String(error),
              entries: [],
            },
          },
        },
      });
    } finally {
      readOverridesByActiveFetchRef.current.delete(readOverrides);
    }
  }, [commitTrees]);

  const runSyncCycle = useCallback(async (intent: RegisteredSyncIntent) => {
    const cycleId = ++nextCycleIdRef.current;
    activeSyncIntentRef.current = intent;
    const initialTrees = directorySessionsByIdRef.current;
    const phase = intent.targets.some((target) => !hasUsableTree(initialTrees[target.id]))
      ? "loading"
      : "refreshing";
    const startedAtMs = Date.now();
    const initial: DirectorySessionSyncState = {
      ...IDLE_DIRECTORY_SESSION_SYNC,
      cycleId,
      targetRevision: intent.targetRevision,
      requestedMode: intent.mode,
      phase,
      totalCount: intent.targets.length,
      pendingCount: intent.targets.length,
      progress: intent.targets.length <= 0 ? 1 : 0,
      startedAtMs,
    };
    setDirectorySessionSync(initial);
    if (intent.targets.length <= 0) {
      setDirectorySessionSync({ ...initial, phase: "complete", completedAtMs: Date.now() });
      return;
    }
    let cursor = 0;
    const workerCount = Math.min(directorySessionPrefetchConcurrency, intent.targets.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < intent.targets.length) {
        const target = intent.targets[cursor];
        cursor += 1;
        setDirectorySessionSync((current) => current.cycleId !== cycleId ? current : {
          ...current,
          pendingCount: current.pendingCount - 1,
          activeCount: current.activeCount + 1,
        });
        const outcome = await loadFirstPage(target, intent.mode, Array.from(intent.reasons)[0] || "drawer_open");
        setDirectorySessionSync((current) => {
          if (current.cycleId !== cycleId) return current;
          const succeededCount = current.succeededCount + (outcome.status === "success" ? 1 : 0);
          const skippedCount = current.skippedCount + (outcome.status === "skipped" ? 1 : 0);
          const failedCount = current.failedCount + (outcome.status === "failed" ? 1 : 0);
          const supersededCount = current.supersededCount + (outcome.status === "superseded" ? 1 : 0);
          const completedCount = succeededCount + skippedCount + failedCount + supersededCount;
          return {
            ...current,
            activeCount: current.activeCount - 1,
            succeededCount,
            skippedCount,
            failedCount,
            supersededCount,
            completedCount,
            progress: completedCount / current.totalCount,
          };
        });
      }
    });
    await Promise.all(workers);
    setDirectorySessionSync((current) => {
      if (current.cycleId !== cycleId) return current;
      const usableCountAfterCycle = intent.targets.filter((target) => (
        registeredDirectoryPathByIdRef.current.get(target.id) === target.path &&
        hasUsableTree(directorySessionsByIdRef.current[target.id])
      )).length;
      const terminalPhase = current.failedCount <= 0
        ? "complete"
        : usableCountAfterCycle > 0
          ? "partial_error"
          : "error";
      return {
        ...current,
        phase: terminalPhase,
        pendingCount: 0,
        activeCount: 0,
        usableCountAfterCycle,
        progress: 1,
        completedAtMs: Date.now(),
      };
    });
  }, [directorySessionPrefetchConcurrency, loadFirstPage]);

  const buildOrderedSyncTargets = useCallback(() => {
    const targetSnapshot = buildTargetSnapshot(registeredDirectoriesRef.current);
    const selectedPath = selectedDirectoryPathRef.current;
    const targets = [...targetSnapshot.targets].sort((a, b) => {
      const aSelected = a.path === selectedPath ? 1 : 0;
      const bSelected = b.path === selectedPath ? 1 : 0;
      return bSelected - aSelected;
    });
    return { key: targetSnapshot.key, targets };
  }, []);

  const startSyncDrain = useCallback(() => {
    // ブートストラップ前はintentを保留したまま開始しない(bootstrapReadyのeffectがdrainする)。
    if (!bootstrapReadyRef.current) return Promise.resolve();
    if (syncDrainPromiseRef.current) return syncDrainPromiseRef.current;
    let drain: Promise<void>;
    drain = (async () => {
      while (queuedSyncIntentRef.current) {
        const intent = queuedSyncIntentRef.current;
        queuedSyncIntentRef.current = null;
        // ターゲットは実行時点の登録ディレクトリで再構築する(保留中にロードされた
        // ディレクトリ・enqueue後の変更を取り込む)。
        const ordered = buildOrderedSyncTargets();
        await runSyncCycle({
          ...intent,
          targetKey: ordered.key,
          targetRevision: targetRevisionRef.current,
          targets: ordered.targets,
        });
      }
    })().finally(() => {
      activeSyncIntentRef.current = null;
      if (syncDrainPromiseRef.current === drain) syncDrainPromiseRef.current = null;
      if (queuedSyncIntentRef.current) void startSyncDrain();
    });
    syncDrainPromiseRef.current = drain;
    return drain;
  }, [buildOrderedSyncTargets, runSyncCycle]);

  const enqueueRegisteredSync = useCallback((
    mode: "ensure" | "refresh",
    reason: DirectorySessionSyncReason
  ) => {
    const targetSnapshot = buildOrderedSyncTargets();
    const active = activeSyncIntentRef.current;
    if (
      active &&
      active.targetKey === targetSnapshot.key &&
      (active.mode === "refresh" || mode === "ensure") &&
      !queuedSyncIntentRef.current
    ) {
      active.reasons.add(reason);
      return syncDrainPromiseRef.current || Promise.resolve();
    }
    const queued = queuedSyncIntentRef.current;
    queuedSyncIntentRef.current = {
      mode: queued?.mode === "refresh" || mode === "refresh" ? "refresh" : "ensure",
      reasons: new Set([...(queued?.reasons || []), reason]),
      targetKey: targetSnapshot.key,
      targetRevision: targetRevisionRef.current,
      targets: targetSnapshot.targets,
    };
    return startSyncDrain();
  }, [buildOrderedSyncTargets, startSyncDrain]);
  enqueueRegisteredSyncRef.current = enqueueRegisteredSync;

  // ブートストラップ完了時、保留中のintentをdrainする(起動前に積まれたscreen_mount等の
  // ensureがロード後の登録ディレクトリで追随する)。
  useEffect(() => {
    if (!bootstrapReady) return;
    if (queuedSyncIntentRef.current) void startSyncDrain();
  }, [bootstrapReady, startSyncDrain]);

  const ensureRegisteredDirectorySessions = useCallback((
    reason: DirectorySessionSyncReason
  ) => enqueueRegisteredSync("ensure", reason), [enqueueRegisteredSync]);

  const refreshRegisteredDirectorySessions = useCallback((
    reason: DirectorySessionSyncReason
  ) => enqueueRegisteredSync("refresh", reason), [enqueueRegisteredSync]);

  const prepareDirectorySessionTargetChange = useCallback((params: {
    nextRegisteredDirectories: RegisteredDirectoryEntry[];
    transitions: DirectoryTargetTransition[];
  }) => {
    const targetSnapshot = buildTargetSnapshot(params.nextRegisteredDirectories);
    let nextTrees = { ...directorySessionsByIdRef.current };
    for (const transition of params.transitions) {
      if (transition.kind === "same_identity") {
        const fromState = nextTrees[transition.fromId];
        const toState = nextTrees[transition.toId];
        if (!toState && fromState) {
          nextTrees[transition.toId] = rewriteTreeDirectory(
            fromState,
            normalizeDirectoryPath(transition.fromPath),
            normalizeDirectoryPath(transition.toPath)
          );
        } else if (toState) {
          nextTrees[transition.toId] = rewriteTreeDirectory(
            toState,
            normalizeDirectoryPath(transition.fromPath),
            normalizeDirectoryPath(transition.toPath)
          );
        }
        if (transition.fromId !== transition.toId) delete nextTrees[transition.fromId];
        supersededReasonByDirectoryIdRef.current.set(transition.fromId, "identity_merged");
        supersededReasonByDirectoryIdRef.current.set(transition.toId, "identity_merged");
        nextGeneration(transition.fromId);
        nextGeneration(transition.toId);
      } else {
        const directoryId = transition.directoryId;
        delete nextTrees[directoryId];
        supersededReasonByDirectoryIdRef.current.set(
          directoryId,
          transition.kind === "remove" ? "removed" : "path_changed"
        );
        nextGeneration(directoryId);
      }
    }
    registeredDirectoriesRef.current = targetSnapshot.targets;
    registeredTargetKeyRef.current = targetSnapshot.key;
    registeredDirectoryPathByIdRef.current = new Map(
      targetSnapshot.targets.map((directory) => [directory.id, directory.path])
    );
    targetRevisionRef.current += 1;
    commitTrees(nextTrees);
    void enqueueRegisteredSyncRef.current("ensure", "registered_targets_changed");
  }, [commitTrees, nextGeneration]);

  useEffect(() => {
    const nextSnapshot = buildTargetSnapshot(registeredDirectories);
    if (nextSnapshot.key === registeredTargetKeyRef.current) return;
    const previousById = new Map(
      registeredDirectoriesRef.current.map((directory) => [directory.id, directory])
    );
    const nextById = new Map(nextSnapshot.targets.map((directory) => [directory.id, directory]));
    const transitions: DirectoryTargetTransition[] = [];
    for (const previous of previousById.values()) {
      const next = nextById.get(previous.id);
      if (!next) {
        transitions.push({ kind: "remove", directoryId: previous.id, fromPath: previous.path });
      } else if (next.path !== previous.path) {
        transitions.push({
          kind: "replace",
          directoryId: previous.id,
          fromPath: previous.path,
          toPath: next.path,
        });
      }
    }
    prepareDirectorySessionTargetChange({
      nextRegisteredDirectories: nextSnapshot.targets,
      transitions,
    });
  }, [prepareDirectorySessionTargetChange, registeredDirectories]);

  const toggleDirectoryExpanded = useCallback((directoryId: string) => {
    setExpandedDirectoryIds((current) => current.includes(directoryId)
      ? current.filter((id) => id !== directoryId)
      : [...current, directoryId]);
  }, [setExpandedDirectoryIds]);

  return {
    directorySessionSync,
    ensureDirectorySessionTree,
    ensureRegisteredDirectorySessions,
    applySessionLastReadAtByIdToDirectoryTrees,
    loadMoreDirectorySessionTree,
    loadSessionChildTree,
    prepareDirectorySessionTargetChange,
    refreshDirectorySessionTree,
    refreshRegisteredDirectorySessions,
    toggleDirectoryExpanded,
  };
}
