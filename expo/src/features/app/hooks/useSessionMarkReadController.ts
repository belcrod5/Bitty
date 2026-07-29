import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DirectoryReadProgress, DirectorySessionTreeState } from "../components/AppDrawer";
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

const DIRECTORY_READ_CONCURRENCY = 4;

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
  recordSessionReadDuringFetch: (sessionId: string, lastReadAt: string) => void;
};

function runnerSessionReadTargetFound(result: RunnerSessionReadResult): boolean {
  if (result.updated || result.acpUpdated || result.cliUpdated) return true;
  const diagnostics = result.diagnostics;
  if (result.source === "cli") return diagnostics?.cliEntryFound === true;
  if (result.source === "acp") return diagnostics?.acpEntryFound === true;
  return diagnostics?.cliEntryFound === true || diagnostics?.acpEntryFound === true;
}

export function useSessionMarkReadController({
  markRunnerSessionRead,
  fetchSessionHistory,
  normalizedLlmDirectoryForRequest,
  setDirectorySessionsById,
  showChatBottomToast,
  logSessionDiag,
  recordSessionReadDuringFetch,
}: UseSessionMarkReadControllerArgs) {
  const pendingSessionReadByIdRef = useRef(new Map<string, Promise<RunnerSessionReadResult>>());
  const directoryReadInFlightPathsRef = useRef(new Set<string>());
  const [directoryReadProgressByPath, setDirectoryReadProgressByPath] = useState<
    Record<string, DirectoryReadProgress>
  >({});
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
    options: SessionReadOptions
  ) => {
    const run = async () => {
      const result = await markRunnerSessionRead(sessionId, options);
      const lastReadAt = String(result?.lastReadAt || "").trim();
      if (!lastReadAt) throw new Error("Runnerから既読日時が返されませんでした");
      if (!runnerSessionReadTargetFound(result)) {
        throw new Error("Runnerで対象セッションの既読状態を更新できませんでした");
      }
      applySessionLastReadAtByIdToDirectoryTrees(new Map([[sessionId, lastReadAt]]));
      recordSessionReadDuringFetch(sessionId, lastReadAt);
      return result;
    };
    const previous = pendingSessionReadByIdRef.current.get(sessionId);
    const promise = previous ? previous.then(run, run) : run();
    pendingSessionReadByIdRef.current.set(sessionId, promise);
    const cleanup = () => {
      if (pendingSessionReadByIdRef.current.get(sessionId) === promise) {
        pendingSessionReadByIdRef.current.delete(sessionId);
      }
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }, [
    applySessionLastReadAtByIdToDirectoryTrees,
    markRunnerSessionRead,
    recordSessionReadDuringFetch,
  ]);

  const markSessionReadAsync = useCallback(({
    sessionId,
    directory,
    source,
    perfTraceId,
    restoreRequestSeq,
  }: MarkReadParams) => {
    const markReadStartedAt = Date.now();
    void (async () => {
      try {
        const asyncMarkReadResult = await startSessionReadMutation(sessionId, {
          directory,
          source,
        });
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
      });
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
      });
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
    if (directoryReadInFlightPathsRef.current.has(directory)) return false;
    directoryReadInFlightPathsRef.current.add(directory);
    setDirectoryReadProgressByPath((prev) => ({
      ...prev,
      [directory]: { completed: 0, total: 0 },
    }));
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
      setDirectoryReadProgressByPath((prev) => ({
        ...prev,
        [directory]: { completed: 0, total: unreadSessions.length },
      }));
      let nextSessionIndex = 0;
      let completedCount = 0;
      const failures: unknown[] = [];
      const workers = Array.from({
        length: Math.min(DIRECTORY_READ_CONCURRENCY, unreadSessions.length),
      }, async () => {
        while (nextSessionIndex < unreadSessions.length) {
          const index = nextSessionIndex;
          nextSessionIndex += 1;
          const entry = unreadSessions[index];
          const sessionId = parseOptionalSessionId(entry?.sessionId);
          try {
            await startSessionReadMutation(sessionId, {
              source: "all",
              directory: parseLlmDirectory(entry?.directory || directory),
            });
            completedCount += 1;
          } catch (reason) {
            failures.push(reason);
          } finally {
            setDirectoryReadProgressByPath((prev) => {
              const current = prev[directory];
              if (!current) return prev;
              return {
                ...prev,
                [directory]: {
                  ...current,
                  completed: Math.min(current.total, current.completed + 1),
                },
              };
            });
          }
        }
      });
      await Promise.all(workers);
      if (failures.length > 0) {
        const firstFailure = failures[0];
        const message = firstFailure instanceof Error
          ? firstFailure.message
          : String(firstFailure);
        showChatBottomToast(
          "assistant",
          `${completedCount}件を既読にしました。${failures.length}件は失敗しました: ${message}`
        );
        return false;
      }
      showChatBottomToast("assistant", `${completedCount}件を既読にしました。`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showChatBottomToast("assistant", `一括既読化に失敗しました: ${message}`);
      return false;
    } finally {
      directoryReadInFlightPathsRef.current.delete(directory);
      setDirectoryReadProgressByPath((prev) => {
        if (!prev[directory]) return prev;
        const next = { ...prev };
        delete next[directory];
        return next;
      });
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
    directoryReadProgressByPath,
  };
}
