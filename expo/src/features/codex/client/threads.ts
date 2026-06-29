import {
  deriveCodexSessionStateFromSnapshot,
  isThreadNotLoadedError,
  normalizeThreadListEntry,
  normalizeThreadReadEntry,
} from "./helpers";
import { runCodexRpcSession } from "./rpcSession";
import {
  NEAR_UNLIMITED_TIMEOUT_MS,
  type CodexThreadListResult,
  type CodexThreadReadResult,
  type CodexThreadSourceKind,
} from "./types";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";

export async function listCodexAppServerThreads(options: {
  wsUrl: string;
  wsToken?: string;
  cwd?: string;
  limit?: number;
  cursor?: string;
  sourceKinds?: CodexThreadSourceKind[];
  timeoutMs?: number;
  runnerWebSocketManager?: RunnerWebSocketManager;
}): Promise<CodexThreadListResult> {
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.min(200, Math.floor(Number(options.limit))))
    : 50;
  const cwd = String(options.cwd || "").trim();
  const cursor = String(options.cursor || "").trim();
  const sourceKinds = Array.isArray(options.sourceKinds) && options.sourceKinds.length > 0
    ? options.sourceKinds
    : ["cli", "vscode", "appServer", "exec"];
  return runCodexRpcSession({
    wsUrl: options.wsUrl,
    wsToken: options.wsToken,
    timeoutMs: options.timeoutMs ?? NEAR_UNLIMITED_TIMEOUT_MS,
    clientName: "expo-ios-thread-list",
    clientTitle: "Expo iOS Thread List",
    traceId: "thread_list",
    runnerWebSocketManager: options.runnerWebSocketManager,
    run: async (rpc) => {
      const result = await rpc<Record<string, unknown>>("thread/list", {
        limit,
        sortKey: "updated_at",
        sortDirection: "desc",
        useStateDbOnly: true,
        sourceKinds,
        archived: false,
        ...(cursor ? { cursor } : {}),
        ...(cwd ? { cwd } : {}),
      });
      const itemsRaw = Array.isArray((result as any)?.data) ? ((result as any).data as unknown[]) : [];
      const data = itemsRaw
        .map((item) => normalizeThreadListEntry(item))
        .filter((item): item is NonNullable<ReturnType<typeof normalizeThreadListEntry>> => !!item);
      return {
        data,
        nextCursor: String((result as any)?.nextCursor || ""),
        backwardsCursor: String((result as any)?.backwardsCursor || ""),
      };
    },
  });
}

function extractThreadReadPayload(result: Record<string, unknown>): unknown {
  return (result as any)?.thread ?? result;
}

function extractLatestTurnPayload(result: Record<string, unknown>): unknown | null {
  const data = Array.isArray((result as any)?.data) ? ((result as any).data as unknown[]) : [];
  return data[0] || null;
}

export async function readCodexAppServerThread(options: {
  wsUrl: string;
  wsToken?: string;
  threadId: string;
  timeoutMs?: number;
  runnerWebSocketManager?: RunnerWebSocketManager;
}): Promise<CodexThreadReadResult> {
  const threadId = String(options.threadId || "").trim();
  if (!threadId) throw new Error("threadId is empty");
  return runCodexRpcSession({
    wsUrl: options.wsUrl,
    wsToken: options.wsToken,
    timeoutMs: options.timeoutMs ?? NEAR_UNLIMITED_TIMEOUT_MS,
    clientName: "expo-ios-thread-read",
    clientTitle: "Expo iOS Thread Read",
    traceId: threadId,
    threadId,
    runnerWebSocketManager: options.runnerWebSocketManager,
    run: async (rpc) => {
      let thread: unknown;
      try {
        const readResult = await rpc<Record<string, unknown>>("thread/read", {
          threadId,
          includeTurns: true,
        });
        thread = extractThreadReadPayload(readResult);
      } catch (error) {
        if (!isThreadNotLoadedError(error)) {
          throw error;
        }
        const resumeResult = await rpc<Record<string, unknown>>("thread/resume", { threadId });
        thread = extractThreadReadPayload(resumeResult);
      }
      const snapshotState = deriveCodexSessionStateFromSnapshot(thread);
      let latestTurn: unknown | null = null;
      if (snapshotState.threadStatusType === "idle" || snapshotState.threadStatusType === "notLoaded") {
        try {
          const turnsResult = await rpc<Record<string, unknown>>("thread/turns/list", {
            threadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "summary",
          });
          latestTurn = extractLatestTurnPayload(turnsResult);
        } catch {
          latestTurn = null;
        }
      }
      const normalized = normalizeThreadReadEntry(thread, {
        latestTurn: latestTurn ?? undefined,
      });
      if (!normalized.threadId) {
        throw new Error("thread/read did not return thread.id");
      }
      return normalized;
    },
  });
}
