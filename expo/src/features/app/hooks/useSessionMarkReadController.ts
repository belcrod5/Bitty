import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { DirectorySessionTreeState } from "../components/AppDrawer";
import type { LlmSessionSource, RunnerSessionReadResult } from "./useLlmSessionExplorer";
import { isLlmSessionUnread, parseOptionalSessionId } from "../utils/llmSession";
import { parseLlmDirectory } from "../utils/settingsParsers";

type MarkReadParams = {
  sessionId: string;
  directory: string;
  source?: LlmSessionSource;
  perfTraceId?: string;
  restoreRequestSeq: number;
};

type SessionReadOptions = {
  directory?: unknown;
  source?: LlmSessionSource;
  lastReadAt?: unknown;
};

type SessionReadMutation = {
  promise: Promise<RunnerSessionReadResult>;
};

type RetainedDirectoryReadResult = {
  order: number;
  replaced: boolean;
};

type UseSessionMarkReadControllerArgs = {
  markRunnerSessionRead: (
    sessionIdRaw: unknown,
    opts?: SessionReadOptions
  ) => Promise<RunnerSessionReadResult>;
  fetchSessionHistory: (
    directoryPath: string,
    options?: {
      limit?: number;
      cursor?: string;
      includeRunnerSnapshots?: boolean;
      runnerSnapshotLimit?: number;
      includeSubagents?: boolean;
    }
  ) => Promise<{
    latestSessionId: string;
    nextCursor: string;
    entries: DirectorySessionTreeState["entries"];
  }>;
  normalizedLlmDirectoryForRequest: () => string;
  setDirectorySessionsById: Dispatch<SetStateAction<Record<string, DirectorySessionTreeState>>>;
  showChatBottomToast: (role: "user" | "assistant", rawText: string) => void;
  logSessionDiag: (
    event: string,
    payload?: Record<string, unknown>,
    options?: {
      detailed?: boolean;
      throttleMs?: number;
      throttleKey?: string;
    }
  ) => void;
};

export function useSessionMarkReadController({
  markRunnerSessionRead,
  fetchSessionHistory,
  normalizedLlmDirectoryForRequest,
  setDirectorySessionsById,
  showChatBottomToast,
  logSessionDiag,
}: UseSessionMarkReadControllerArgs) {
  const pendingSessionReadMutationByIdRef = useRef(new Map<string, SessionReadMutation>());
  const sessionReadMutationOrderRef = useRef(0);
  const retainedDirectoryReadResultsByIdRef = useRef(
    new Map<string, Set<RetainedDirectoryReadResult>>()
  );
  const applySessionLastReadAtByIdToDirectoryTrees = useCallback((
    lastReadAtBySessionId: Map<string, string>
  ) => {
    if (lastReadAtBySessionId.size <= 0) return;
    setDirectorySessionsById((prev) => {
      let changed = false;
      const next: Record<string, DirectorySessionTreeState> = {};
      for (const [dirId, state] of Object.entries(prev)) {
        let entryChanged = false;
        const nextEntries = state.entries.map((entry) => {
          const markedLastReadAt = lastReadAtBySessionId.get(entry.sessionId);
          if (!markedLastReadAt || entry.lastReadAt === markedLastReadAt) return entry;
          entryChanged = true;
          return {
            ...entry,
            lastReadAt: markedLastReadAt,
          };
        });
        let childChanged = false;
        const nextChildrenByParentId = Object.fromEntries(
          Object.entries(state.childrenByParentId || {}).map(([parentId, childState]) => {
            let currentChildChanged = false;
            const nextChildEntries = childState.entries.map((entry) => {
              const markedLastReadAt = lastReadAtBySessionId.get(entry.sessionId);
              if (!markedLastReadAt || entry.lastReadAt === markedLastReadAt) return entry;
              currentChildChanged = true;
              return {
                ...entry,
                lastReadAt: markedLastReadAt,
              };
            });
            if (currentChildChanged) childChanged = true;
            return [
              parentId,
              currentChildChanged ? { ...childState, entries: nextChildEntries } : childState,
            ];
          })
        );
        if (entryChanged || childChanged) {
          changed = true;
          next[dirId] = {
            ...state,
            entries: nextEntries,
            childrenByParentId: nextChildrenByParentId,
          };
        } else {
          next[dirId] = state;
        }
      }
      return changed ? next : prev;
    });
  }, [setDirectorySessionsById]);

  const startSessionReadMutation = useCallback((
    sessionId: string,
    options: SessionReadOptions,
    currentDirectoryResult?: RetainedDirectoryReadResult
  ): SessionReadMutation => {
    const previous = pendingSessionReadMutationByIdRef.current.get(sessionId);
    sessionReadMutationOrderRef.current += 1;
    const mutationOrder = sessionReadMutationOrderRef.current;
    if (currentDirectoryResult) currentDirectoryResult.order = mutationOrder;
    const run = async () => {
      const result = await markRunnerSessionRead(sessionId, options);
      const markedLastReadAt = String(result?.lastReadAt || "").trim();
      if (markedLastReadAt) {
        applySessionLastReadAtByIdToDirectoryTrees(new Map([[sessionId, markedLastReadAt]]));
      }
      for (const retainedResult of retainedDirectoryReadResultsByIdRef.current.get(sessionId) || []) {
        if (retainedResult.order < mutationOrder) retainedResult.replaced = true;
      }
      return result;
    };
    const promise = previous
      ? previous.promise.then(run, run)
      : run();
    const mutation: SessionReadMutation = {
      promise,
    };
    pendingSessionReadMutationByIdRef.current.set(sessionId, mutation);
    const cleanup = () => {
      if (pendingSessionReadMutationByIdRef.current.get(sessionId) === mutation) {
        pendingSessionReadMutationByIdRef.current.delete(sessionId);
      }
    };
    void mutation.promise.then(cleanup, cleanup);
    return mutation;
  }, [applySessionLastReadAtByIdToDirectoryTrees, markRunnerSessionRead]);

  const markSessionReadAsync = useCallback(({
    sessionId,
    directory,
    source,
    perfTraceId,
    restoreRequestSeq,
  }: MarkReadParams) => {
    const markReadStartedAt = Date.now();
    const mutation = startSessionReadMutation(sessionId, {
      directory,
      source,
    });
    void (async () => {
      try {
        const asyncMarkReadResult = await mutation.promise;
        logSessionDiag("session_open_perf_mark_read_async_done", {
          traceId: perfTraceId || undefined,
          sessionId,
          elapsedMs: Math.max(0, Date.now() - markReadStartedAt),
          updated: asyncMarkReadResult?.updated === true,
          acpUpdated: asyncMarkReadResult?.acpUpdated === true,
          cliUpdated: asyncMarkReadResult?.cliUpdated === true,
          diagnostics: asyncMarkReadResult?.diagnostics,
        }, {
          detailed: true,
          throttleMs: 0,
          throttleKey: `session_open_perf_mark_read_async_done:${sessionId}:${restoreRequestSeq}`,
        });
      } catch (err) {
        logSessionDiag("session_open_perf_mark_read_async_error", {
          traceId: perfTraceId || undefined,
          sessionId,
          elapsedMs: Math.max(0, Date.now() - markReadStartedAt),
          message: err instanceof Error ? err.message : String(err),
        }, {
          detailed: true,
          throttleMs: 0,
          throttleKey: `session_open_perf_mark_read_async_error:${sessionId}:${restoreRequestSeq}`,
        });
      }
    })();
  }, [logSessionDiag, startSessionReadMutation]);

  const markSessionUnread = useCallback(async ({
    sessionId: sessionIdRaw,
    source,
    directory: directoryRaw,
  }: {
    sessionId: string;
    source?: LlmSessionSource;
    directory?: string;
  }) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return false;
    const directory = parseLlmDirectory(directoryRaw || normalizedLlmDirectoryForRequest());
    try {
      await startSessionReadMutation(sessionId, {
        source: source || "all",
        directory,
        lastReadAt: new Date(0).toISOString(),
      }).promise;
      showChatBottomToast("assistant", "未読にしました。");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showChatBottomToast("assistant", `未読化に失敗しました: ${message}`);
      return false;
    }
  }, [
    normalizedLlmDirectoryForRequest,
    showChatBottomToast,
    startSessionReadMutation,
  ]);

  const markSessionRead = useCallback(async ({
    sessionId: sessionIdRaw,
    source,
    directory: directoryRaw,
  }: {
    sessionId: string;
    source?: LlmSessionSource;
    directory?: string;
  }) => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) return false;
    const directory = parseLlmDirectory(directoryRaw || normalizedLlmDirectoryForRequest());
    try {
      await startSessionReadMutation(sessionId, {
        source: source || "all",
        directory,
      }).promise;
      showChatBottomToast("assistant", "既読にしました。");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showChatBottomToast("assistant", `既読化に失敗しました: ${message}`);
      return false;
    }
  }, [
    normalizedLlmDirectoryForRequest,
    showChatBottomToast,
    startSessionReadMutation,
  ]);

  const markDirectorySessionsRead = useCallback(async ({
    directory: directoryRaw,
  }: {
    directory: string;
  }) => {
    const directory = parseLlmDirectory(directoryRaw || normalizedLlmDirectoryForRequest());
    try {
      const sessionsById = new Map<string, DirectorySessionTreeState["entries"][number]>();
      let cursor = "";
      const seenCursors = new Set<string>();
      do {
        if (cursor) seenCursors.add(cursor);
        const result = await fetchSessionHistory(directory, {
          limit: 100,
          cursor,
          includeRunnerSnapshots: true,
          runnerSnapshotLimit: 200,
          includeSubagents: true,
        });
        for (const entry of result.entries) {
          const sessionId = parseOptionalSessionId(entry.sessionId);
          if (!sessionId || sessionsById.has(sessionId)) continue;
          sessionsById.set(sessionId, entry);
        }
        const nextCursor = String(result.nextCursor || "").trim();
        cursor = nextCursor && !seenCursors.has(nextCursor) ? nextCursor : "";
      } while (cursor);

      const unreadSessions = [...sessionsById.values()].filter((entry) => (
        parseOptionalSessionId(entry.sessionId) && isLlmSessionUnread(entry)
      ));
      if (unreadSessions.length <= 0) {
        showChatBottomToast("assistant", "既読にする未読セッションはありません。");
        return true;
      }
      const batchMutations = unreadSessions.map((entry) => {
        const sessionId = parseOptionalSessionId(entry.sessionId);
        const retainedResult: RetainedDirectoryReadResult = { order: 0, replaced: false };
        const retainedResults = retainedDirectoryReadResultsByIdRef.current.get(sessionId)
          || new Set<RetainedDirectoryReadResult>();
        retainedResults.add(retainedResult);
        retainedDirectoryReadResultsByIdRef.current.set(sessionId, retainedResults);
        const mutation = startSessionReadMutation(sessionId, {
          source: entry.source || "all",
          directory,
        }, retainedResult);
        return { sessionId, mutation, retainedResult };
      });
      try {
        const markResults = await Promise.allSettled(batchMutations.map(async ({
          sessionId,
          mutation,
          retainedResult,
        }) => {
          const result = await mutation.promise;
          return {
            sessionId,
            lastReadAt: String(result?.lastReadAt || "").trim(),
            retainedResult,
          };
        }));
        const completedCount = markResults.filter((result) => (
          result.status === "fulfilled" &&
          Boolean(result.value.sessionId && result.value.lastReadAt) &&
          !result.value.retainedResult.replaced
        )).length;
        const failedResult = markResults.find((result) => result.status === "rejected");
        if (failedResult?.status === "rejected") {
          const failedCount = markResults.filter((result) => result.status === "rejected").length;
          const message = failedResult.reason instanceof Error
            ? failedResult.reason.message
            : String(failedResult.reason);
          if (completedCount > 0) {
            showChatBottomToast(
              "assistant",
              `${completedCount}件を既読にしました。${failedCount}件は失敗しました: ${message}`
            );
          } else {
            showChatBottomToast("assistant", `一括既読化に失敗しました: ${message}`);
          }
          return false;
        }
        if (completedCount > 0) {
          showChatBottomToast("assistant", `${completedCount}件を既読にしました。`);
        }
        return true;
      } finally {
        for (const { sessionId, retainedResult } of batchMutations) {
          const retainedResults = retainedDirectoryReadResultsByIdRef.current.get(sessionId);
          retainedResults?.delete(retainedResult);
          if (retainedResults?.size === 0) {
            retainedDirectoryReadResultsByIdRef.current.delete(sessionId);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showChatBottomToast("assistant", `一括既読化に失敗しました: ${message}`);
      return false;
    }
  }, [
    fetchSessionHistory,
    normalizedLlmDirectoryForRequest,
    showChatBottomToast,
    startSessionReadMutation,
  ]);

  return {
    markSessionReadAsync,
    markSessionUnread,
    markSessionRead,
    markDirectorySessionsRead,
  };
}
