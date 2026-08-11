import { useCallback, useRef, useState } from "react";
import type { DirectoryLoadOutcome, DirectoryReadProgress } from "../types/directorySessions";
import type {
  LlmSessionSource,
  RunnerDirectoryReadResult,
  RunnerSessionReadResult,
} from "./useLlmSessionExplorer";
import { parseOptionalSessionId } from "../utils/llmSession";
import { parseLlmDirectory } from "../utils/settingsParsers";

type MarkReadParams = {
  sessionId: string;
  directory: string;
  source?: LlmSessionSource;
  perfTraceId?: string;
  readTrigger?: "notification_open" | "drawer_open" | "visible_resume" | "visible_completion";
  restoreRequestSeq: number;
};

type SessionReadOptions = {
  directory?: unknown;
  source?: LlmSessionSource;
  lastReadAt?: unknown;
};

type UseSessionMarkReadControllerArgs = {
  markRunnerSessionRead: (
    sessionIdRaw: unknown,
    opts?: SessionReadOptions
  ) => Promise<RunnerSessionReadResult>;
  markRunnerDirectoryRead: (directory: unknown) => Promise<RunnerDirectoryReadResult>;
  normalizedLlmDirectoryForRequest: () => string;
  applySessionLastReadAtByIdToDirectoryTrees: (
    lastReadAtBySessionId: Map<string, string>,
    directory?: string
  ) => void;
  applyDirectoryLastReadAtToDirectoryTrees: (directory: string, lastReadAt: string) => void;
  reconcileDirectorySessionTree: (
    directory: string,
    requestedDirectory?: string
  ) => Promise<DirectoryLoadOutcome>;
  onSessionReadStateCommitted?: (result: {
    sessionId: string;
    directory: string;
    isRead: boolean;
  }) => void;
  onDirectoryReadStateCommitted?: (result: RunnerDirectoryReadResult) => Promise<void>;
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

function runnerSessionReadTargetFound(result: RunnerSessionReadResult): boolean {
  if (result.updated || result.acpUpdated || result.cliUpdated) return true;
  const diagnostics = result.diagnostics;
  if (result.source === "cli") return diagnostics?.cliEntryFound === true;
  if (result.source === "acp") return diagnostics?.acpEntryFound === true;
  return diagnostics?.cliEntryFound === true || diagnostics?.acpEntryFound === true;
}

export function useSessionMarkReadController({
  markRunnerSessionRead,
  markRunnerDirectoryRead,
  normalizedLlmDirectoryForRequest,
  applySessionLastReadAtByIdToDirectoryTrees,
  applyDirectoryLastReadAtToDirectoryTrees,
  reconcileDirectorySessionTree,
  onSessionReadStateCommitted,
  onDirectoryReadStateCommitted,
  showChatBottomToast,
  logSessionDiag,
}: UseSessionMarkReadControllerArgs) {
  const pendingSessionReadByIdRef = useRef(new Map<string, Promise<RunnerSessionReadResult>>());
  const pendingDirectoryReadsRef = useRef(new Set<Promise<RunnerDirectoryReadResult>>());
  const directoryReadInFlightPathsRef = useRef(new Set<string>());
  const [directoryReadProgressByPath, setDirectoryReadProgressByPath] = useState<
    Record<string, DirectoryReadProgress>
  >({});
  const startSessionReadMutation = useCallback((
    sessionId: string,
    options: SessionReadOptions
  ) => {
    const previousDirectoryReads = [...pendingDirectoryReadsRef.current];
    const run = async () => {
      await Promise.all(previousDirectoryReads.map((promise) => promise.then(
        () => undefined,
        () => undefined
      )));
      const result = await markRunnerSessionRead(sessionId, options);
      const lastReadAt = String(result?.lastReadAt || "").trim();
      if (!lastReadAt) throw new Error("Runnerから既読日時が返されませんでした");
      if (!runnerSessionReadTargetFound(result)) {
        throw new Error("Runnerで対象セッションの既読状態を更新できませんでした");
      }
      const directory = String(result.directory || "").trim();
      applySessionLastReadAtByIdToDirectoryTrees(new Map([[sessionId, lastReadAt]]), directory);
      onSessionReadStateCommitted?.({
        sessionId,
        directory,
        isRead: String(options.lastReadAt || "").trim() !== new Date(0).toISOString(),
      });
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
    onSessionReadStateCommitted,
  ]);

  const markSessionReadAsync = useCallback(({
    sessionId,
    directory,
    source,
    perfTraceId,
    readTrigger,
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
          readTrigger: readTrigger || "unknown",
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
          readTrigger: readTrigger || "unknown",
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
    let directoryRequest: Promise<RunnerDirectoryReadResult> | null = null;
    try {
      const previousSessionReads = [...pendingSessionReadByIdRef.current.values()];
      directoryRequest = Promise.all(previousSessionReads.map((promise) => promise.then(
        () => undefined,
        () => undefined
      ))).then(async () => {
        const result = await markRunnerDirectoryRead(directory);
        const lastReadAt = String(result.lastReadAt || "").trim();
        if (!lastReadAt) throw new Error("Runnerから既読日時が返されませんでした");
        setDirectoryReadProgressByPath((prev) => ({
          ...prev,
          [directory]: { completed: result.foundCount, total: result.selectedCount },
        }));
        let reconcileFailure = "";
        if (result.status === "full") {
          applyDirectoryLastReadAtToDirectoryTrees(result.directory, lastReadAt);
        } else {
          try {
            const outcome = await reconcileDirectorySessionTree(result.directory, directory);
            if (outcome.status !== "success") {
              reconcileFailure = outcome.status === "failed"
                ? "正本の再取得に失敗しました"
                : `正本の再取得が${outcome.status}になりました`;
            }
          } catch {
            reconcileFailure = "正本の再取得に失敗しました";
          }
        }
        await onDirectoryReadStateCommitted?.(result);
        if (reconcileFailure) throw new Error(reconcileFailure);
        return result;
      });
      pendingDirectoryReadsRef.current.add(directoryRequest);
      const result = await directoryRequest;
      if (result.status === "full") {
        showChatBottomToast("assistant", result.selectedCount > 0
          ? `${result.foundCount}件を既読にしました。`
          : "既読にするセッションはありません。");
        return true;
      }
      showChatBottomToast(
        "assistant",
        result.status === "partial"
          ? `${result.updatedCount}件を既読にしました。一部ストアの失敗後、表示を正本に再同期しました。`
          : "既読化できませんでした。表示を正本に再同期しました。"
      );
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showChatBottomToast("assistant", `一括既読処理を完了できませんでした: ${message}`);
      return false;
    } finally {
      if (directoryRequest) pendingDirectoryReadsRef.current.delete(directoryRequest);
      directoryReadInFlightPathsRef.current.delete(directory);
      setDirectoryReadProgressByPath((prev) => {
        if (!prev[directory]) return prev;
        const next = { ...prev };
        delete next[directory];
        return next;
      });
    }
  }, [
    applyDirectoryLastReadAtToDirectoryTrees,
    markRunnerDirectoryRead,
    normalizedLlmDirectoryForRequest,
    onDirectoryReadStateCommitted,
    reconcileDirectorySessionTree,
    showChatBottomToast,
  ]);

  return {
    markSessionReadAsync,
    markSessionUnread,
    markSessionRead,
    markDirectorySessionsRead,
    directoryReadProgressByPath,
  };
}
