import {
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
import { listAgentSessions, readAgentHistory } from "../../agent/client";

export async function listCodexAppServerThreads(options: {
  wsUrl: string;
  wsToken?: string;
  cwd?: string;
  limit?: number;
  cursor?: string;
  sourceKinds?: CodexThreadSourceKind[];
  timeoutMs?: number;
  runnerWebSocketManager?: RunnerWebSocketManager;
  backendId?: string;
  rawFallbackBackendId?: string;
}): Promise<CodexThreadListResult> {
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.min(200, Math.floor(Number(options.limit))))
    : 50;
  const cwd = String(options.cwd || "").trim();
  const cursor = String(options.cursor || "").trim();
  const sourceKinds = Array.isArray(options.sourceKinds) && options.sourceKinds.length > 0
    ? options.sourceKinds
    : ["cli", "vscode", "appServer", "exec"];
  if (options.runnerWebSocketManager) {
    const backendId = String(options.backendId || "codex");
    let neutral = null;
    try {
      neutral = await listAgentSessions(options.runnerWebSocketManager, { backendId, cwd, cursor, limit });
    } catch (error) {
      if (backendId !== options.rawFallbackBackendId) throw error;
    }
    if (neutral) {
      const sessions = Array.isArray(neutral.sessions) ? neutral.sessions : [];
      return {
        data: sessions.map((raw) => {
          const item = raw && typeof raw === "object" ? raw as Record<string, any> : {};
          return {
            threadId: String(item.sessionRef?.nativeSessionId || ""),
            parentThreadId: String(item.parentSessionRef?.nativeSessionId || ""),
            agentRole: "",
            agentDisplayName: "",
            preview: String(item.title || ""),
            modelProvider: String(item.modelId || backendId),
            sourceKind: item.isSubagent ? "subAgent" : "appServer",
            cwd: String(item.canonicalCwd || cwd),
            createdAt: "",
            updatedAt: String(item.updatedAt || ""),
            contextUsedPct: null,
          };
        }).filter((item) => item.threadId && sourceKinds.includes(item.sourceKind as CodexThreadSourceKind)),
        nextCursor: String(neutral.cursor || ""),
        backwardsCursor: "",
      };
    }
    if (options.backendId && backendId !== options.rawFallbackBackendId) {
      throw new Error("Selected Agent Backend is unavailable");
    }
  }
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

export async function readCodexAppServerThread(options: {
  wsUrl: string;
  wsToken?: string;
  threadId: string;
  timeoutMs?: number;
  runnerWebSocketManager?: RunnerWebSocketManager;
  backendId?: string;
  rawFallbackBackendId?: string;
}): Promise<CodexThreadReadResult> {
  const threadId = String(options.threadId || "").trim();
  if (!threadId) throw new Error("threadId is empty");
  if (options.runnerWebSocketManager) {
    const backendId = String(options.backendId || "codex");
    let neutral = null;
    try {
      neutral = await readAgentHistory(options.runnerWebSocketManager, {
        backendId, nativeSessionId: threadId, limit: 500,
      });
    } catch (error) {
      if (backendId !== options.rawFallbackBackendId) throw error;
    }
    if (neutral) {
      const items = Array.isArray(neutral.items) ? neutral.items : [];
      const messages = items.map((raw) => {
        const item = raw && typeof raw === "object" ? raw as Record<string, any> : {};
        const content = Array.isArray(item.content) ? item.content : [];
        return {
          role: item.role === "user" ? "user" as const : "assistant" as const,
          content: content
            .filter((block) => block?.type === "text" || block?.type === "reasoning")
            .map((block) => String(block.text || ""))
            .join("\n"),
          at: String(item.createdAt || ""),
          itemId: String(item.id || ""),
        };
      }).filter((message) => message.content);
      return {
        threadId,
        preview: messages.find((message) => message.role === "user")?.content || "",
        modelProvider: backendId,
        sourceKind: "appServer",
        cwd: "",
        createdAt: messages[0]?.at || "",
        updatedAt: messages.at(-1)?.at || "",
        messages,
        contextUsedPct: null,
        sessionState: "completed",
        threadStatusType: "idle",
        waitingOnApproval: false,
        latestTurnStatus: "completed",
        hasRunningTurn: false,
        runningTurn: null,
      };
    }
    if (options.backendId && backendId !== options.rawFallbackBackendId) {
      throw new Error("Selected Agent Backend is unavailable");
    }
  }
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
          includeTurns: false,
        });
        thread = extractThreadReadPayload(readResult);
      } catch (error) {
        if (!isThreadNotLoadedError(error)) {
          throw error;
        }
        const resumeResult = await rpc<Record<string, unknown>>("thread/resume", {
          threadId,
          excludeTurns: true,
        });
        thread = extractThreadReadPayload(resumeResult);
      }
      const normalized = normalizeThreadReadEntry(thread);
      if (!normalized.threadId) {
        throw new Error("thread/read did not return thread.id");
      }
      return normalized;
    },
  });
}
