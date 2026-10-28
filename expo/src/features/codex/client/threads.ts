import {
  isThreadNotLoadedError,
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
import { ALL_BACKENDS_SCOPE, listAgentSessions, listAgentSessionsBatch, readAgentHistory } from "../../agent/client";
import { deriveAgentSessionLiveState } from "../../agent/sessionLiveState";

type ThreadListOptions = {
  runnerWebSocketManager: RunnerWebSocketManager;
  cwd?: string;
  limit?: number;
  cursor?: string;
  sourceKinds?: CodexThreadSourceKind[];
  backendId?: string;
  parentSessionIds?: string[];
  onListResponseBytes?: (bytes: number) => void;
};

export async function listCodexAppServerThreads(options: ThreadListOptions): Promise<CodexThreadListResult> {
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.min(200, Math.floor(Number(options.limit))))
    : 50;
  const cwd = String(options.cwd || "").trim();
  const cursor = String(options.cursor || "").trim();
  const sourceKinds: CodexThreadSourceKind[] = Array.isArray(options.sourceKinds) && options.sourceKinds.length > 0
    ? options.sourceKinds
    : ["cli", "vscode", "appServer", "exec"];
  const backendId = String(options.backendId || "codex");
  const includeSubagents = sourceKinds.some((kind) => String(kind).startsWith("subAgent"));
  const neutral = await listAgentSessions(options.runnerWebSocketManager, {
    backendId, cwd, cursor, limit, includeSubagents,
    ...(options.parentSessionIds ? { parentSessionIds: options.parentSessionIds } : {}),
  }, options.onListResponseBytes);
  if (!neutral) throw new Error("Selected Agent Backend is unavailable");
  return agentSessionsToThreads(neutral, cwd, sourceKinds, backendId);
}

function agentSessionsToThreads(neutral: Record<string, unknown>, cwd: string, sourceKinds: CodexThreadSourceKind[], backendId: string): CodexThreadListResult {
  const sessions = Array.isArray(neutral.sessions) ? neutral.sessions : [];
  const fallbackEntryBackendId = backendId === ALL_BACKENDS_SCOPE ? "codex" : backendId;
  return {
    data: sessions.map((raw) => {
      const item = raw && typeof raw === "object" ? raw as Record<string, any> : {};
      const entryBackendId = String(item.sessionRef?.backendId || fallbackEntryBackendId);
      const summary = item.summary;
      const hasSummary = summary && typeof summary === "object"
        && !Array.isArray(summary) && Object.prototype.hasOwnProperty.call(summary, "contextUsage")
        && (summary.contextUsage === null || (typeof summary.contextUsage === "object" && !Array.isArray(summary.contextUsage)))
        && typeof summary.modelRef === "string"
        && typeof summary.reasoningEffort === "string" && typeof summary.lastReadAt === "string";
      return {
        backendId: entryBackendId,
        threadId: String(item.sessionRef?.nativeSessionId || ""),
        parentThreadId: String(item.parentSessionRef?.nativeSessionId || ""),
        agentRole: "",
        agentDisplayName: "",
        preview: String(item.title || ""),
        modelProvider: entryBackendId,
        modelRef: String(item.modelId || ""),
        reasoningEffort: String(item.reasoningEffort || ""),
        // サーバーの実sourceKindを尊重する("acp"はapp-server由来のためappServerへ
        // 正規化)。2値へ潰すと限定sourceKinds指定やsource表示の忠実性が失われる。
        sourceKind: item.isSubagent
          ? "subAgent"
          : String(item.sourceKind || "") === "acp"
            ? "appServer"
            : String(item.sourceKind || "") || "appServer",
        cwd: String(item.canonicalCwd || cwd),
        createdAt: "",
        updatedAt: String(item.updatedAt || ""),
        lastReadAt: String(item.lastReadAt || ""),
        contextUsedPct: null,
        ...(hasSummary ? { summary } : {}),
        // read経路(activeRun→active/idle)と同じサーバー発の実行状態。
        // 欠落させると常に"unknown"となりsubagent実行中カウントが構造的に0になる。
        threadStatusType: item.isActive === true ? "active" as const : "idle" as const,
      };
    }).filter((item) => item.threadId && sourceKinds.includes(item.sourceKind as CodexThreadSourceKind)),
    nextCursor: String(neutral.cursor || ""),
    backwardsCursor: "",
    ...(Array.isArray(neutral.errors) && neutral.errors.length > 0
      ? { partialErrors: neutral.errors as CodexThreadListResult["partialErrors"] }
      : {}),
  };
}

export async function listCodexAppServerThreadsBatch(options: ThreadListOptions & { cwds: string[] }): Promise<Array<{
  cwd: string; result?: CodexThreadListResult; error?: Error;
}>> {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 5)));
  const sourceKinds: CodexThreadSourceKind[] = ["cli", "vscode", "appServer", "exec"];
  const groups = await listAgentSessionsBatch(options.runnerWebSocketManager, options.cwds, limit);
  return groups.map((group) => {
    if (group.error) return { cwd: group.cwd, error: group.error };
    if (!group.payload) return { cwd: group.cwd, error: new Error("Session batch result missing") };
    return { cwd: group.cwd, result: agentSessionsToThreads(group.payload, group.cwd, sourceKinds, ALL_BACKENDS_SCOPE) };
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
      const liveState = deriveAgentSessionLiveState(neutral.activeRun);
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
        // 履歴が持つcontext使用率(rollout token_count由来)。無ければnull。
        contextUsedPct: (() => {
          const usedPct = Number((neutral.contextUsage as Record<string, unknown> | undefined)?.usedPct);
          return Number.isFinite(usedPct) ? Math.max(0, Math.min(100, Math.round(usedPct))) : null;
        })(),
        ...liveState,
        // CodexThreadStatusType represents approval through the separate
        // waitingOnApproval field while the app runtime uses waiting_approval.
        threadStatusType: liveState.hasRunningTurn ? "active" : "idle",
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
