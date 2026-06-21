import { useCallback, type Dispatch, type SetStateAction } from "react";
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

type UseSessionMarkReadControllerArgs = {
  markRunnerSessionRead: (
    sessionIdRaw: unknown,
    opts?: { directory?: unknown; source?: LlmSessionSource; lastReadAt?: unknown }
  ) => Promise<RunnerSessionReadResult>;
  fetchSessionHistory: (
    directoryPath: string,
    options?: {
      limit?: number;
      cursor?: string;
      includeRunnerSnapshots?: boolean;
      runnerSnapshotLimit?: number;
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
        const asyncMarkReadResult = await markRunnerSessionRead(sessionId, {
          directory,
          source,
        });
        const markedLastReadAt = String(asyncMarkReadResult?.lastReadAt || "").trim();
        if (markedLastReadAt) {
          applySessionLastReadAtByIdToDirectoryTrees(new Map([[sessionId, markedLastReadAt]]));
        }
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
  }, [applySessionLastReadAtByIdToDirectoryTrees, logSessionDiag, markRunnerSessionRead]);

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
      const markResult = await markRunnerSessionRead(sessionId, {
        source: source || "all",
        directory,
        lastReadAt: new Date(0).toISOString(),
      });
      const markedLastReadAt = String(markResult?.lastReadAt || "").trim();
      if (markedLastReadAt) {
        applySessionLastReadAtByIdToDirectoryTrees(new Map([[sessionId, markedLastReadAt]]));
      }
      showChatBottomToast("assistant", "未読にしました。");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showChatBottomToast("assistant", `未読化に失敗しました: ${message}`);
      return false;
    }
  }, [
    applySessionLastReadAtByIdToDirectoryTrees,
    markRunnerSessionRead,
    normalizedLlmDirectoryForRequest,
    showChatBottomToast,
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
      const markResult = await markRunnerSessionRead(sessionId, {
        source: source || "all",
        directory,
      });
      const markedLastReadAt = String(markResult?.lastReadAt || "").trim();
      if (markedLastReadAt) {
        applySessionLastReadAtByIdToDirectoryTrees(new Map([[sessionId, markedLastReadAt]]));
      }
      showChatBottomToast("assistant", "既読にしました。");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showChatBottomToast("assistant", `既読化に失敗しました: ${message}`);
      return false;
    }
  }, [
    applySessionLastReadAtByIdToDirectoryTrees,
    markRunnerSessionRead,
    normalizedLlmDirectoryForRequest,
    showChatBottomToast,
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
      const markResults = await Promise.all(unreadSessions.map(async (entry) => {
        const sessionId = parseOptionalSessionId(entry.sessionId);
        const result = await markRunnerSessionRead(sessionId, {
          source: entry.source || "all",
          directory,
        });
        return {
          sessionId,
          lastReadAt: String(result?.lastReadAt || "").trim(),
        };
      }));
      const lastReadAtBySessionId = new Map<string, string>();
      for (const result of markResults) {
        if (result.sessionId && result.lastReadAt) {
          lastReadAtBySessionId.set(result.sessionId, result.lastReadAt);
        }
      }
      applySessionLastReadAtByIdToDirectoryTrees(lastReadAtBySessionId);
      showChatBottomToast("assistant", `${lastReadAtBySessionId.size}件を既読にしました。`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showChatBottomToast("assistant", `一括既読化に失敗しました: ${message}`);
      return false;
    }
  }, [
    applySessionLastReadAtByIdToDirectoryTrees,
    fetchSessionHistory,
    markRunnerSessionRead,
    normalizedLlmDirectoryForRequest,
    showChatBottomToast,
  ]);

  return {
    markSessionReadAsync,
    markSessionUnread,
    markSessionRead,
    markDirectorySessionsRead,
  };
}
