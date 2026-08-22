import { useCallback, useState } from "react";
import {
  listCodexAppServerThreads,
  readCodexAppServerThread,
  type CodexThreadListEntry,
} from "../../codex/codexAppServerClient";
import type { CodexCommandExecutionInfo, CodexThreadStatusType } from "../../codex/client/types";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { parseContextUsageUsedPct } from "../utils/formatting";
import { clampContextUsedPct } from "../utils/sessionRestore";
import {
  dedupeSessionHistoryEntries,
  parseLlmSessionSource,
  parseOptionalSessionId,
} from "../utils/llmSession";
import { parseLlmDirectory } from "../utils/settingsParsers";
import { utf8ByteLength } from "../../ws/networkUsageMetrics";
import { ALL_BACKENDS_SCOPE, readAgentHistory } from "../../agent/client";

const RUNNER_SESSIONS_HTTP_TIMEOUT_MS = 12_000;
const RUNNER_SESSION_MESSAGES_HTTP_TIMEOUT_MS = 12_000;
const SESSION_HISTORY_RPC_TIMEOUT_MS = 25_000;
const SESSION_HISTORY_METADATA_GRACE_MS = 150;
const RUNNER_DIRECTORIES_HTTP_TIMEOUT_MS = 12_000;

export type DirectoryPickerEntry = {
  name: string;
  path: string;
};

export type LlmSessionSource = "acp" | "cli" | "all" | "appserver" | "vscode" | "exec" | "subagent" | "notification" | "unknown";

export type LlmSessionHistoryEntry = {
  backendId: string;
  sessionId: string;
  parentSessionId: string;
  directory: string;
  updatedAt: string;
  lastReadAt: string;
  source: LlmSessionSource;
  cwd: string;
  firstUserMessage: string;
  agentRole: string;
  agentDisplayName: string;
  contextUsedPct: number | null;
  modelRef: string;
  reasoningEffort: string;
  threadStatusType?: CodexThreadStatusType;
};

export type RunnerSessionReadResult = {
  sessionId: string;
  directory: string;
  source: string;
  lastReadAt: string;
  updated: boolean;
  acpUpdated: boolean;
  cliUpdated: boolean;
  diagnostics: Record<string, unknown> | null;
};

export type RunnerDirectoryReadResult = {
  scope: "directory";
  status: "full" | "partial" | "failed";
  directory: string;
  source: string;
  lastReadAt: string;
  selectedCount: number;
  foundCount: number;
  updatedCount: number;
  stores: Record<"acp" | "cli", {
    status: "success" | "failed" | "skipped";
    selectedCount: number;
    foundCount: number;
    updatedCount: number;
    reason?: string;
  }>;
  diagnostics: Record<string, unknown> | null;
};

export type RunnerSessionMessageRole = "user" | "assistant";
export type RunnerSessionMessage = {
  role: RunnerSessionMessageRole;
  content: string;
  at: string;
  kind?: "internal_context" | "unclassified_context" | "sidechain";
  // rollout内の永続item/call id。履歴page間の安定キーに使う。
  itemId?: string;
  // sinceCursor差分応答のみ: ペア確定で行IDが変わったとき、置換すべき旧行のitemId。
  replacesItemId?: string;
  inheritedFromParent?: boolean;
  commandExecution?: CodexCommandExecutionInfo;
};

export type RunnerSessionLiveState = {
  threadId: string;
  threadStatusType?: string;
  hasRunningTurn: boolean;
  runningTurn: {
    status: string;
    summary: string;
    startedAt: string;
    updatedAt: string;
  } | null;
};

export type RunnerSessionMessagesResult = RunnerSessionLiveState & {
  // Older on-device caches predate backend-neutral session references.
  backendId?: string;
  sourceKind: string;
  cwd: string;
  updatedAt: string;
  modelRef: string;
  reasoningEffort: string;
  latestToolLabel: string;
  messages: RunnerSessionMessage[];
  contextUsedPct: number | null;
  olderCursor: string | null;
  // 差分取得(sinceCursor)対応サーバーは全応答に付与する。null/未定義は差分不可
  // (旧サーバー)を意味し、キャッシュ側は全量挙動のままにする。
  latestCursor?: string | null;
  // sinceCursor応答のみ: limit超過の続きがあるか。
  moreAfter?: boolean;
  liveStatePromise?: Promise<RunnerSessionLiveState | null>;
};

type LlmSessionHistoryResult = {
  entries: LlmSessionHistoryEntry[];
  latestSessionId: string;
  nextCursor: string;
};

type UseLlmSessionExplorerOptions = {
  codexWsUrl: string;
  codexWsToken: string;
  runnerToken: string;
  auxServerBaseUrl: () => string;
  // Waits for the settings bootstrap, then returns the live runner HTTP
  // credentials. Session snapshot fetches use this instead of render-time
  // closures so calls fired before settings load don't run with an empty token.
  getRunnerHttpAuth: () => Promise<{ baseUrl: string; token: string }>;
  normalizedLlmDirectoryForRequest: () => string;
  defaultLlmDirectory: string;
  nearUnlimitedTimeoutMs: number;
  runnerWebSocketManager?: RunnerWebSocketManager;
  rawFallbackBackendId: string;
  onSessionDiagLog?: (event: string, payload?: Record<string, unknown>) => void;
};

type RunnerSessionSnapshot = {
  contextUsedPct: number | null;
  modelRef: string;
  reasoningEffort: string;
  latestToolLabel: string;
  lastReadAt: string;
};

type FetchSessionHistoryOptions = {
  backendId?: string;
  limit?: number;
  cursor?: string;
  includeRunnerSnapshots?: boolean;
  includeSubagents?: boolean;
};

const MAIN_THREAD_SOURCE_KINDS = ["cli", "vscode", "appServer", "exec"] as const;
const SUBAGENT_THREAD_SOURCE_KINDS = [
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
] as const;

type JsonRecord = Record<string, unknown>;

function toRunnerSessionLiveState(
  live: Awaited<ReturnType<typeof readCodexAppServerThread>>
): RunnerSessionLiveState {
  return {
    threadId: live.threadId,
    threadStatusType: live.threadStatusType || "",
    hasRunningTurn: live.hasRunningTurn === true,
    runningTurn: live.runningTurn || null,
  };
}

export function inferLatestToolLabelFromSessionMessages(dataRaw: unknown): string {
  const data = dataRaw && typeof dataRaw === "object" ? dataRaw as JsonRecord : {};
  const session = data.session && typeof data.session === "object" ? data.session as JsonRecord : {};
  const explicit = String(data.latestToolLabel || data.lastToolLabel || "").trim();
  if (explicit) return explicit;
  const messagesRaw = Array.isArray(data.messages)
    ? data.messages
    : Array.isArray(session.messages)
      ? session.messages
      : [];
  for (let i = messagesRaw.length - 1; i >= 0; i -= 1) {
    const itemRaw = messagesRaw[i];
    const item = itemRaw && typeof itemRaw === "object" ? itemRaw as JsonRecord : {};
    const content = String(item.content || item.text || "").trim();
    if (!content) continue;
    const spacedToolMatch = content.match(/^tool\s*:\s*(.+)$/i);
    if (spacedToolMatch) {
      const label = String(spacedToolMatch[1] || "").trim().split(/\s+/)[0] || "";
      if (label) return label;
    }
    const compactToolMatch = content.match(/^tool:([^\s]+)/i);
    if (compactToolMatch) {
      const label = String(compactToolMatch[1] || "").trim();
      if (label) return label;
    }
  }
  return "";
}

function buildRunnerSessionSnapshot(dataRaw: unknown): RunnerSessionSnapshot {
  const data = dataRaw && typeof dataRaw === "object" ? dataRaw as JsonRecord : {};
  return {
    contextUsedPct: parseContextUsageUsedPct(data.contextUsage),
    modelRef: String(data.modelRef || "").trim(),
    reasoningEffort: String(data.reasoningEffort || "").trim(),
    latestToolLabel: inferLatestToolLabelFromSessionMessages(data),
    lastReadAt: String(data.lastReadAt || "").trim(),
  };
}

// /session-messages 応答の実測バイト(通信量調査用)。content-length はサーバーが
// 付与しない場合があるため、サーバー報告の専用ヘッダも併記する。
function readSessionMessagesByteMeta(response: Response) {
  const responseBytesHeader = Number(response.headers?.get?.("x-session-messages-response-bytes") || 0);
  const contentLengthHeader = Number(response.headers?.get?.("content-length") || 0);
  return {
    responseBytesHeader: Number.isFinite(responseBytesHeader) ? responseBytesHeader : 0,
    contentLengthHeader: Number.isFinite(contentLengthHeader) ? contentLengthHeader : 0,
  };
}

function hasRunnerSessionSnapshotData(snapshot: RunnerSessionSnapshot) {
  return (
    snapshot.contextUsedPct !== null ||
    Boolean(snapshot.modelRef) ||
    Boolean(snapshot.reasoningEffort) ||
    Boolean(snapshot.latestToolLabel)
  );
}

export function buildLlmSessionHistoryEntry(
  item: CodexThreadListEntry,
  directory: string,
  runnerSnapshotMap: Map<string, RunnerSessionSnapshot>,
): LlmSessionHistoryEntry {
  const sessionId = parseOptionalSessionId(item.threadId);
  const snapshot = sessionId ? runnerSnapshotMap.get(sessionId) : undefined;
  return {
    backendId: String(item.backendId || "codex").trim() || "codex",
    sessionId,
    parentSessionId: parseOptionalSessionId(item.parentThreadId),
    // The thread cwd is the execution identity. `directory` is only the scope used
    // to discover the thread and may be the parent of a subagent workspace.
    directory: parseLlmDirectory(item.cwd || directory),
    updatedAt: String(item.updatedAt || item.createdAt || "").trim(),
    lastReadAt: String(snapshot?.lastReadAt || "").trim(),
    source: parseLlmSessionSource(item.sourceKind, "unknown"),
    cwd: String(item.cwd || "").trim(),
    firstUserMessage: String(item.agentDisplayName || item.preview || "").trim(),
    agentRole: String(item.agentRole || "").trim(),
    agentDisplayName: String(item.agentDisplayName || "").trim(),
    contextUsedPct: snapshot
      ? clampContextUsedPct(snapshot.contextUsedPct)
      : clampContextUsedPct(item.contextUsedPct),
    modelRef: String(snapshot?.modelRef || item.modelRef || "").trim(),
    reasoningEffort: String(snapshot?.reasoningEffort || "").trim(),
    threadStatusType: item.threadStatusType || "unknown",
  };
}

export function useLlmSessionExplorer(options: UseLlmSessionExplorerOptions) {
  const {
    codexWsUrl,
    codexWsToken,
    runnerToken,
    auxServerBaseUrl,
    getRunnerHttpAuth,
    normalizedLlmDirectoryForRequest,
    defaultLlmDirectory,
    nearUnlimitedTimeoutMs,
    runnerWebSocketManager,
    rawFallbackBackendId,
    onSessionDiagLog,
  } = options;

  const [directoryExplorerPath, setDirectoryExplorerPath] = useState(defaultLlmDirectory);
  const [directoryExplorerRootPath, setDirectoryExplorerRootPath] = useState(defaultLlmDirectory);
  const [directoryExplorerParentPath, setDirectoryExplorerParentPath] = useState("");
  const [directoryExplorerEntries, setDirectoryExplorerEntries] = useState<DirectoryPickerEntry[]>([]);
  const [directoryExplorerLoading, setDirectoryExplorerLoading] = useState(false);
  const [directoryExplorerError, setDirectoryExplorerError] = useState("");

  const emitSessionDiag = useCallback((event: string, payload: Record<string, unknown> = {}) => {
    const eventName = String(event || "").trim();
    if (!eventName) return;
    onSessionDiagLog?.(eventName, payload);
  }, [onSessionDiagLog]);

  const fetchTextWithTimeout = useCallback(async (
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<{ response: Response; text: string }> => {
    const controller = new AbortController();
    const timeoutNormalizedMs = Math.max(1000, Math.floor(timeoutMs));
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const request = fetch(url, {
        ...init,
        signal: controller.signal,
      }).then(async (response) => ({
        response,
        text: await response.text(),
      }));
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error(`request timeout (${timeoutNormalizedMs}ms)`));
        }, timeoutNormalizedMs);
      });
      return await Promise.race([request, timeout]);
    } catch (err) {
      if (err && typeof err === "object" && "name" in err && (err as { name?: unknown }).name === "AbortError") {
        throw new Error(`request timeout (${timeoutNormalizedMs}ms)`);
      }
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }, []);

  const fetchJsonWithTimeout = useCallback(async (
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<{ response: Response; data: JsonRecord }> => {
    const { response, text } = await fetchTextWithTimeout(url, init, timeoutMs);
    let data: JsonRecord = {};
    try {
      data = text ? JSON.parse(text) as JsonRecord : {};
    } catch {
      data = {};
    }
    return { response, data };
  }, [fetchTextWithTimeout]);

  const fetchRunnerSessionSnapshotMap = useCallback(async (
    directoryRaw?: unknown,
    sessionIdsRaw?: unknown[]
  ): Promise<Map<string, RunnerSessionSnapshot>> => {
    const out = new Map<string, RunnerSessionSnapshot>();
    const sessionIds = Array.from(new Set(
      (Array.isArray(sessionIdsRaw) ? sessionIdsRaw : [])
        .map(parseOptionalSessionId)
        .filter(Boolean)
    ));
    if (sessionIds.length <= 0) return out;
    const { baseUrl: targetLlmUrl, token } = await getRunnerHttpAuth();
    if (!targetLlmUrl || !token) {
      emitSessionDiag("runner_sessions_skipped_missing_auth", {
        hasUrl: Boolean(targetLlmUrl),
        hasToken: Boolean(token),
      });
      return out;
    }
    const directory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    const { response, data } = await fetchJsonWithTimeout(`${targetLlmUrl}/session-summaries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ directory, sessionIds }),
    }, RUNNER_SESSIONS_HTTP_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(String(data?.message || data?.error || `session summaries fetch failed: HTTP ${response.status}`));
    }
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    for (const itemRaw of sessions) {
      const item = itemRaw && typeof itemRaw === "object" ? itemRaw as JsonRecord : {};
      const sessionId = parseOptionalSessionId(item.sessionId);
      if (!sessionId) continue;
      out.set(sessionId, buildRunnerSessionSnapshot(item));
    }
    return out;
  }, [emitSessionDiag, fetchJsonWithTimeout, getRunnerHttpAuth, normalizedLlmDirectoryForRequest]);

  const fetchRunnerSessionSnapshot = useCallback(async (
    sessionIdRaw: unknown,
    directoryRaw?: unknown
  ): Promise<RunnerSessionSnapshot> => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) {
      return { contextUsedPct: null, modelRef: "", reasoningEffort: "", latestToolLabel: "", lastReadAt: "" };
    }
    const { baseUrl: targetLlmUrl, token } = await getRunnerHttpAuth();
    if (!targetLlmUrl || !token) {
      emitSessionDiag("runner_session_messages_skipped_missing_auth", {
        sessionId,
        hasUrl: Boolean(targetLlmUrl),
        hasToken: Boolean(token),
      });
      return { contextUsedPct: null, modelRef: "", reasoningEffort: "", latestToolLabel: "", lastReadAt: "" };
    }
    const directory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    const fetchSnapshot = async (
      includeDirectory: boolean,
      attempt: "preferred" | "fallback"
    ): Promise<RunnerSessionSnapshot | null> => {
      const startedAt = Date.now();
      const url = new URL(`${targetLlmUrl}/session-messages`);
      url.searchParams.set("sessionId", sessionId);
      url.searchParams.set("source", "all");
      url.searchParams.set("limit", "1");
      if (includeDirectory) {
        url.searchParams.set("directory", directory);
      }
      emitSessionDiag("runner_session_messages_start", {
        directory: includeDirectory ? directory : "",
        sessionId,
        attempt,
      });
      let response: Response;
      let data: JsonRecord = {};
      try {
        const result = await fetchJsonWithTimeout(url.toString(), {
          headers: {
            authorization: `Bearer ${token}`,
          },
        }, RUNNER_SESSION_MESSAGES_HTTP_TIMEOUT_MS);
        response = result.response;
        data = result.data;
      } catch (err) {
        emitSessionDiag("runner_session_messages_error", {
          directory: includeDirectory ? directory : "",
          sessionId,
          attempt,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      emitSessionDiag("runner_session_messages_done", {
        directory: includeDirectory ? directory : "",
        sessionId,
        attempt,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        status: response.status,
        ok: response.ok,
        found: data?.found === true,
        ...readSessionMessagesByteMeta(response),
      });
      if (!response.ok) return null;
      return buildRunnerSessionSnapshot(data);
    };

    const preferredSnapshot = await fetchSnapshot(true, "preferred");
    if (preferredSnapshot && hasRunnerSessionSnapshotData(preferredSnapshot)) {
      return preferredSnapshot;
    }
    if (!directory) {
      return preferredSnapshot || { contextUsedPct: null, modelRef: "", reasoningEffort: "", latestToolLabel: "", lastReadAt: "" };
    }
    const fallbackSnapshot = await fetchSnapshot(false, "fallback");
    if (fallbackSnapshot) return fallbackSnapshot;
    return preferredSnapshot || { contextUsedPct: null, modelRef: "", reasoningEffort: "", latestToolLabel: "", lastReadAt: "" };
  }, [
    emitSessionDiag,
    fetchJsonWithTimeout,
    getRunnerHttpAuth,
    normalizedLlmDirectoryForRequest,
  ]);

  const fetchRunnerSessionContextUsedPct = useCallback(async (
    sessionIdRaw: unknown,
    directoryRaw?: unknown,
    options?: { backendId?: string }
  ): Promise<number | null> => {
    // backendIdが分かる場合はBackend中立のreadHistory(contextUsage付き)を優先する。
    // legacy HTTP snapshotはCodex rollout専用で、他Backendのセッションを見つけられない。
    const backendId = String(options?.backendId || "").trim();
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (backendId && sessionId && runnerWebSocketManager) {
      const neutral = await readAgentHistory(runnerWebSocketManager, {
        backendId,
        nativeSessionId: sessionId,
        limit: 1,
      }).catch(() => null);
      const usedPct = parseContextUsageUsedPct(neutral?.contextUsage);
      if (usedPct !== null) return usedPct;
    }
    const snapshot = await fetchRunnerSessionSnapshot(sessionIdRaw, directoryRaw);
    return snapshot.contextUsedPct;
  }, [fetchRunnerSessionSnapshot, runnerWebSocketManager]);

  const fetchRunnerSessionMessages = useCallback(async (
    sessionIdRaw: unknown,
    directoryRaw?: unknown,
    options?: { backendId?: string; cursor?: string; sinceCursor?: string; skipLiveState?: boolean },
  ): Promise<RunnerSessionMessagesResult> => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) {
      throw new Error("sessionId is required");
    }
    const preferredDirectory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    const backendId = String(options?.backendId || "codex").trim() || "codex";
    const cursor = String(options?.cursor || "").trim();
    const sinceCursor = String(options?.sinceCursor || "").trim();
    if (cursor && sinceCursor) {
      throw new Error("cursor と sinceCursor は同時に指定できません");
    }
    if (runnerWebSocketManager) {
      let neutral;
      try {
        neutral = await readAgentHistory(runnerWebSocketManager, {
          backendId,
          nativeSessionId: sessionId,
          cursor: cursor || undefined,
          sinceCursor: sinceCursor || undefined,
          limit: 500,
        });
      } catch (error) {
        if (backendId !== rawFallbackBackendId) throw error;
        neutral = null;
      }
      if (neutral?.sessionRef) {
        const items = Array.isArray(neutral.items) ? neutral.items : [];
        const messages: RunnerSessionMessage[] = items.flatMap((raw) => {
          const item = raw && typeof raw === "object" ? raw as JsonRecord : {};
          const role = String(item.role || "");
          if (role !== "user" && role !== "assistant") return [];
          const blocks = Array.isArray(item.content) ? item.content as JsonRecord[] : [];
          const content = blocks
            .filter((block) => block?.type === "text" || block?.type === "reasoning")
            .map((block) => String(block.text || ""))
            .join("\n");
          const tool = blocks.find((block) => block?.type === "tool");
          if (!content && !tool) return [];
          const itemType = String(item.itemType || "");
          return [{
            role,
            content,
            at: String(item.createdAt || ""),
            // 内部注入コンテキスト(environment_context等)とsubagent会話(sidechain)は
            // 折りたたみ表示にする。
            ...(itemType === "internal_context" || itemType === "unclassified_context" || itemType === "sidechain"
              ? { kind: itemType }
              : {}),
            itemId: String(item.id || "") || undefined,
            ...(tool ? {
              commandExecution: {
                command: String(tool.inputSummary || tool.name || "tool"),
                status: String(tool.status || "") === "failed" ? "failed" as const : "completed" as const,
              },
            } : {}),
          }];
        });
        return {
          backendId: String(neutral.sessionRef && (neutral.sessionRef as JsonRecord).backendId || backendId).trim() || backendId,
          threadId: sessionId,
          sourceKind: "agent",
          cwd: parseLlmDirectory(neutral.canonicalCwd || preferredDirectory),
          updatedAt: messages.at(-1)?.at || "",
          modelRef: String(neutral.modelId || "").trim(),
          reasoningEffort: "",
          latestToolLabel: "",
          messages,
          // rollout token_count由来のcontext使用率(codex)。無いBackendはnull。
          contextUsedPct: parseContextUsageUsedPct(neutral.contextUsage),
          threadStatusType: "idle",
          hasRunningTurn: false,
          runningTurn: null,
          olderCursor: String(neutral.olderCursor || "") || null,
          latestCursor: String(neutral.newerCursor || "") || null,
          ...(sinceCursor ? { moreAfter: neutral.moreAfter === true } : {}),
        };
      }
      if (backendId !== rawFallbackBackendId) throw new Error("Selected Agent Backend is unavailable");
    }
    const { baseUrl, token } = await getRunnerHttpAuth();
    if (!baseUrl || !token) throw new Error("Aux Server URL または Runner Token が未設定です");
    const startedAt = Date.now();
    emitSessionDiag(cursor ? "runner_session_history_page_start" : "runner_session_history_restore_start", {
      sessionId,
      directory: preferredDirectory,
      hasCursor: Boolean(cursor),
      hasSinceCursor: Boolean(sinceCursor),
    });
    const targetCodexWsUrl = codexWsUrl.trim();
    const livePromise = !cursor && options?.skipLiveState !== true && targetCodexWsUrl
      ? readCodexAppServerThread({
        wsUrl: targetCodexWsUrl,
        wsToken: codexWsToken.trim(),
        threadId: sessionId,
        timeoutMs: Math.min(nearUnlimitedTimeoutMs, SESSION_HISTORY_RPC_TIMEOUT_MS),
        runnerWebSocketManager,
        backendId,
        rawFallbackBackendId,
      }).catch((error) => {
        emitSessionDiag("app_server_thread_metadata_failed", {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
      : null;
    let responseByteMeta = { responseBytesHeader: 0, contentLengthHeader: 0, bodyBytes: 0 };
    const fetchPage = async (includeDirectory: boolean) => {
      const url = new URL(`${baseUrl}/session-messages`);
      url.searchParams.set("sessionId", sessionId);
      url.searchParams.set("source", "all");
      if (cursor) url.searchParams.set("cursor", cursor);
      if (sinceCursor) url.searchParams.set("sinceCursor", sinceCursor);
      if (includeDirectory && preferredDirectory) url.searchParams.set("directory", preferredDirectory);
      const result = await fetchTextWithTimeout(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      }, RUNNER_SESSION_MESSAGES_HTTP_TIMEOUT_MS);
      responseByteMeta = {
        ...readSessionMessagesByteMeta(result.response),
        bodyBytes: result.text ? utf8ByteLength(result.text) : 0,
      };
      let data: JsonRecord = {};
      try {
        data = result.text ? JSON.parse(result.text) : {};
      } catch {}
      if (!result.response.ok) {
        const requestError = new Error(String(data?.message || data?.error || `HTTP ${result.response.status}`));
        (requestError as Error & { code?: string }).code = String(data?.error || "").trim();
        throw requestError;
      }
      if (data?.found !== true) throw new Error("session not found");
      return data;
    };
    let data: JsonRecord;
    try {
      data = await fetchPage(true);
    } catch (error) {
      // sinceCursor(差分)経路のdirectoryフォールバックはしない: 失敗はキャッシュ層が
      // 全文取得(こちらは従来どおりフォールバックあり)へ切り替える。
      if (cursor || sinceCursor || !preferredDirectory) throw error;
      data = await fetchPage(false);
    }
    const messages: RunnerSessionMessage[] = (Array.isArray(data?.messages) ? data.messages : [])
      .flatMap((raw: unknown) => {
        const item = raw && typeof raw === "object" ? raw as JsonRecord : {};
        const role = String(item.role || "").trim().toLowerCase();
        const content = String(item.content || "").trim();
        const commandRaw = item.commandExecution && typeof item.commandExecution === "object"
          ? item.commandExecution as JsonRecord
          : null;
        if ((role !== "user" && role !== "assistant") || (!content && !commandRaw)) return [];
        const commandExecution = commandRaw ? {
          command: String(commandRaw.command || "").trim(),
          status: commandRaw.status === "failed"
            ? "failed" as const
            : commandRaw.status === "running"
              ? "running" as const
              : "completed" as const,
          exitCode: Number.isFinite(Number(commandRaw.exitCode)) ? Number(commandRaw.exitCode) : null,
        } : undefined;
        if (commandRaw && !commandExecution?.command) return [];
        return [{
          role: role as RunnerSessionMessageRole,
          content,
          at: String(item.at || "").trim(),
          ...(item.kind === "internal_context" || item.kind === "unclassified_context"
            ? { kind: item.kind }
            : {}),
          itemId: String(item.itemId || "").trim() || undefined,
          replacesItemId: String(item.replacesItemId || "").trim() || undefined,
          inheritedFromParent: item.inheritedFromParent === true || undefined,
          commandExecution,
        }];
      });
    const live = livePromise
      ? await Promise.race([
        livePromise,
        new Promise<null>((resolve) => setTimeout(resolve, SESSION_HISTORY_METADATA_GRACE_MS)),
      ])
      : null;
    const liveState = live ? toRunnerSessionLiveState(live) : null;
    emitSessionDiag(cursor ? "runner_session_history_page_done" : "runner_session_history_restore_done", {
      sessionId,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      messageCount: messages.length,
      olderPageAvailable: Boolean(data?.olderCursor),
      hasSinceCursor: Boolean(sinceCursor),
      moreAfter: data?.moreAfter === true,
      diagnostics: data?.diagnostics,
      ...responseByteMeta,
    });
    return {
      backendId,
      threadId: liveState?.threadId || sessionId,
      sourceKind: String(data?.source || live?.sourceKind || "cli"),
      cwd: String(data?.cwd || live?.cwd || preferredDirectory),
      updatedAt: String(data?.updatedAt || live?.updatedAt || ""),
      modelRef: String(data?.modelRef || live?.modelProvider || ""),
      reasoningEffort: String(data?.reasoningEffort || ""),
      latestToolLabel: inferLatestToolLabelFromSessionMessages(data),
      messages,
      contextUsedPct: parseContextUsageUsedPct(data?.contextUsage) ?? live?.contextUsedPct ?? null,
      threadStatusType: liveState?.threadStatusType || "",
      hasRunningTurn: liveState?.hasRunningTurn === true,
      runningTurn: liveState?.runningTurn || null,
      olderCursor: String(data?.olderCursor || "").trim() || null,
      latestCursor: String(data?.latestCursor || "").trim() || null,
      ...(sinceCursor ? { moreAfter: data?.moreAfter === true } : {}),
      ...(!liveState && livePromise
        ? { liveStatePromise: livePromise.then((value) => value ? toRunnerSessionLiveState(value) : null) }
        : {}),
    };
  }, [
    codexWsToken,
    codexWsUrl,
    emitSessionDiag,
    fetchTextWithTimeout,
    getRunnerHttpAuth,
    nearUnlimitedTimeoutMs,
    normalizedLlmDirectoryForRequest,
    rawFallbackBackendId,
    runnerWebSocketManager,
  ]);

  // 一覧はall-backendsなので、返すのはsessionId単独ではなく{sessionId, backendId}の
  // identity。呼び出し元がbackendIdを落とすと非Codexセッションの復元が壊れる。
  const fetchLatestSessionForDirectory = useCallback(async (
    directoryRaw?: unknown
  ): Promise<{ sessionId: string; backendId: string } | null> => {
    const targetCodexWsUrl = codexWsUrl.trim();
    const directory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    if (!targetCodexWsUrl) return null;
    const listed = await listCodexAppServerThreads({
      wsUrl: targetCodexWsUrl,
      wsToken: codexWsToken.trim(),
      cwd: directory,
      limit: 1,
      sourceKinds: [...MAIN_THREAD_SOURCE_KINDS],
      timeoutMs: Math.min(nearUnlimitedTimeoutMs, SESSION_HISTORY_RPC_TIMEOUT_MS),
      runnerWebSocketManager,
      backendId: ALL_BACKENDS_SCOPE,
      rawFallbackBackendId,
    });
    const latest = listed.data[0];
    const sessionId = parseOptionalSessionId(latest?.threadId);
    if (!sessionId) return null;
    return {
      sessionId,
      backendId: String(latest?.backendId || "codex").trim() || "codex",
    };
  }, [codexWsToken, codexWsUrl, nearUnlimitedTimeoutMs, normalizedLlmDirectoryForRequest, rawFallbackBackendId, runnerWebSocketManager]);

  const loadDirectoryExplorer = useCallback(async (pathRaw?: unknown) => {
    const targetLlmUrl = auxServerBaseUrl();
    const normalizedPath = parseLlmDirectory(pathRaw ?? normalizedLlmDirectoryForRequest());
    if (!targetLlmUrl || !runnerToken.trim()) {
      setDirectoryExplorerError("Aux Server URL または Runner Token が未設定です");
      setDirectoryExplorerEntries([]);
      setDirectoryExplorerPath(normalizedPath);
      setDirectoryExplorerRootPath(defaultLlmDirectory);
      setDirectoryExplorerParentPath("");
      return;
    }
    setDirectoryExplorerLoading(true);
    setDirectoryExplorerError("");
    setDirectoryExplorerPath(normalizedPath);
    const startedAt = Date.now();
    emitSessionDiag("directory_explorer_load_start", {
      path: normalizedPath,
    });
    try {
      const url = new URL(`${targetLlmUrl}/directories`);
      url.searchParams.set("path", normalizedPath);
      const { response, data } = await fetchJsonWithTimeout(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${runnerToken.trim()}`,
        },
      }, RUNNER_DIRECTORIES_HTTP_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
      }
      const basePath = parseLlmDirectory(data?.basePath || normalizedPath);
      const rootPath = parseLlmDirectory(data?.rootPath || defaultLlmDirectory);
      const parentPath = String(data?.parentPath || "").trim();
      const directories = Array.isArray(data?.directories)
        ? data.directories
          .map((itemRaw: unknown) => {
            const item = itemRaw && typeof itemRaw === "object" ? itemRaw as JsonRecord : {};
            const name = String(item.name || "").trim();
            const path = String(item.path || "").trim();
            if (!name || !path) return null;
            return { name, path } as DirectoryPickerEntry;
          })
          .filter((item: DirectoryPickerEntry | null): item is DirectoryPickerEntry => !!item)
        : [];
      setDirectoryExplorerPath(basePath);
      setDirectoryExplorerRootPath(rootPath);
      setDirectoryExplorerParentPath(parentPath);
      setDirectoryExplorerEntries(directories);
      emitSessionDiag("directory_explorer_load_done", {
        path: basePath,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        directoryCount: directories.length,
      });
    } catch (err) {
      setDirectoryExplorerEntries([]);
      setDirectoryExplorerRootPath(defaultLlmDirectory);
      setDirectoryExplorerParentPath("");
      const message = err instanceof Error ? err.message : String(err);
      setDirectoryExplorerError(message);
      emitSessionDiag("directory_explorer_load_error", {
        path: normalizedPath,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        message,
      });
    } finally {
      setDirectoryExplorerLoading(false);
    }
  }, [
    auxServerBaseUrl,
    defaultLlmDirectory,
    emitSessionDiag,
    normalizedLlmDirectoryForRequest,
    runnerToken,
  ]);

  const openDirectoryExplorer = useCallback(() => {
    void loadDirectoryExplorer(normalizedLlmDirectoryForRequest());
  }, [loadDirectoryExplorer, normalizedLlmDirectoryForRequest]);

  const fetchSessionHistory = useCallback(async (
    directoryRaw?: unknown,
    historyOptions?: FetchSessionHistoryOptions,
  ): Promise<LlmSessionHistoryResult> => {
    const directory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    const limit = Number.isFinite(Number(historyOptions?.limit))
      ? Math.max(1, Math.min(100, Math.floor(Number(historyOptions?.limit))))
      : 80;
    const cursor = String(historyOptions?.cursor || "").trim();
    const includeRunnerSnapshots = historyOptions?.includeRunnerSnapshots !== false;
    // directory一覧は「選択中Provider」ではなく「そのdirectoryの全Backend統合」が既定。
    // 呼び出し元がbackendIdを明示した時だけ単一Backendに絞る。
    const backendId = String(historyOptions?.backendId || ALL_BACKENDS_SCOPE).trim() || ALL_BACKENDS_SCOPE;
    const targetCodexWsUrl = codexWsUrl.trim();
    if (!targetCodexWsUrl && backendId === rawFallbackBackendId) {
      throw new Error("Codex WS URL が未設定です");
    }
    const startedAt = Date.now();
    emitSessionDiag("session_history_fetch_start", {
      directory,
      backendId,
      limit,
      cursor,
      includeRunnerSnapshots,
    });
    const listed = await listCodexAppServerThreads({
      wsUrl: targetCodexWsUrl,
      wsToken: codexWsToken.trim(),
      cwd: directory,
      limit,
      cursor,
      sourceKinds: historyOptions?.includeSubagents
        ? [...MAIN_THREAD_SOURCE_KINDS, ...SUBAGENT_THREAD_SOURCE_KINDS]
        : [...MAIN_THREAD_SOURCE_KINDS],
      timeoutMs: Math.min(nearUnlimitedTimeoutMs, SESSION_HISTORY_RPC_TIMEOUT_MS),
      runnerWebSocketManager,
      backendId,
      rawFallbackBackendId,
    });
    const listedSessionIds = listed.data
      .map((item) => parseOptionalSessionId(item.threadId))
      .filter(Boolean);
    const runnerSnapshotMap = includeRunnerSnapshots
      ? await fetchRunnerSessionSnapshotMap(directory, listedSessionIds).catch((error) => {
        emitSessionDiag("runner_session_snapshot_map_failed", {
          directory,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          message: error instanceof Error ? error.message : String(error),
        });
        return new Map<string, RunnerSessionSnapshot>();
      })
      : new Map<string, RunnerSessionSnapshot>();
    const sessions = listed.data.map((item) => buildLlmSessionHistoryEntry(item, directory, runnerSnapshotMap));
    const deduped = dedupeSessionHistoryEntries(sessions);
    emitSessionDiag("session_history_fetch_done", {
      directory,
      backendId,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      threadCountRaw: sessions.length,
      threadCountDeduped: deduped.length,
      latestSessionId: sessions[0]?.sessionId || "",
      nextCursor: listed.nextCursor,
      runnerSnapshotCount: runnerSnapshotMap.size,
      ...(listed.partialErrors && listed.partialErrors.length > 0
        ? {
          partialErrorBackendIds: listed.partialErrors.map((error) => String(error?.backendId || "")),
          partialErrorCodes: listed.partialErrors.map((error) => String(error?.code || "")),
        }
        : {}),
    });
    return {
      entries: deduped,
      latestSessionId: sessions[0]?.sessionId || "",
      nextCursor: String(listed.nextCursor || "").trim(),
    };
  }, [
    codexWsToken,
    codexWsUrl,
    emitSessionDiag,
    fetchRunnerSessionSnapshotMap,
    nearUnlimitedTimeoutMs,
    normalizedLlmDirectoryForRequest,
    rawFallbackBackendId,
    runnerWebSocketManager,
  ]);

  const fetchSessionChildrenHistory = useCallback(async (
    parentSessionIdsRaw: unknown[],
    directoryRaw?: unknown,
    historyOptions?: Pick<FetchSessionHistoryOptions, "limit" | "includeRunnerSnapshots">,
  ): Promise<Record<string, LlmSessionHistoryEntry[]>> => {
    const parentSessionIds = Array.from(new Set(
      (Array.isArray(parentSessionIdsRaw) ? parentSessionIdsRaw : [])
        .map(parseOptionalSessionId)
        .filter(Boolean)
    ));
    if (parentSessionIds.length <= 0) return {};
    const parentSessionIdSet = new Set(parentSessionIds);
    const directory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    const limit = Number.isFinite(Number(historyOptions?.limit))
      ? Math.max(1, Math.min(100, Math.floor(Number(historyOptions?.limit))))
      : 50;
    const includeRunnerSnapshots = historyOptions?.includeRunnerSnapshots !== false;
    const targetCodexWsUrl = codexWsUrl.trim();
    if (!targetCodexWsUrl) {
      throw new Error("Codex WS URL が未設定です");
    }
    const startedAt = Date.now();
    emitSessionDiag("session_child_history_fetch_start", {
      directory,
      parentSessionIds,
      limit,
      includeRunnerSnapshots,
    });
    const listedThreads: CodexThreadListEntry[] = [];
    const seenThreadIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = "";
    let pageCount = 0;
    while (true) {
      const listed = await listCodexAppServerThreads({
        wsUrl: targetCodexWsUrl,
        wsToken: codexWsToken.trim(),
        cwd: directory,
        limit,
        cursor,
        sourceKinds: [...SUBAGENT_THREAD_SOURCE_KINDS],
        timeoutMs: Math.min(nearUnlimitedTimeoutMs, SESSION_HISTORY_RPC_TIMEOUT_MS),
        runnerWebSocketManager,
        backendId: ALL_BACKENDS_SCOPE,
        rawFallbackBackendId,
      });
      pageCount += 1;
      for (const item of listed.data) {
        const threadId = parseOptionalSessionId(item.threadId);
        if (!threadId || seenThreadIds.has(threadId)) continue;
        seenThreadIds.add(threadId);
        listedThreads.push(item);
      }
      const nextCursor = String(listed.nextCursor || "").trim();
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    const directChildren = listedThreads.filter((item) => (
      parentSessionIdSet.has(parseOptionalSessionId(item.parentThreadId))
    ));
    const runnerSnapshotMap = includeRunnerSnapshots
      ? await fetchRunnerSessionSnapshotMap(
        directory,
        directChildren.map((item) => parseOptionalSessionId(item.threadId)).filter(Boolean)
      ).catch((error) => {
        emitSessionDiag("runner_session_snapshot_map_failed", {
          directory,
          parentSessionIds,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          message: error instanceof Error ? error.message : String(error),
        });
        return new Map<string, RunnerSessionSnapshot>();
      })
      : new Map<string, RunnerSessionSnapshot>();
    const sessions = dedupeSessionHistoryEntries(
      directChildren.map((item) => buildLlmSessionHistoryEntry(item, directory, runnerSnapshotMap))
    );
    emitSessionDiag("session_child_history_fetch_done", {
      directory,
      parentSessionIds,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      pageCount,
      threadCountRaw: listedThreads.length,
      directChildCount: directChildren.length,
      threadCountDeduped: sessions.length,
      runnerSnapshotCount: runnerSnapshotMap.size,
    });
    return Object.fromEntries(parentSessionIds.map((parentSessionId) => [
      parentSessionId,
      sessions.filter((session) => session.parentSessionId === parentSessionId),
    ]));
  }, [
    codexWsToken,
    codexWsUrl,
    emitSessionDiag,
    fetchRunnerSessionSnapshotMap,
    nearUnlimitedTimeoutMs,
    normalizedLlmDirectoryForRequest,
    rawFallbackBackendId,
    runnerWebSocketManager,
  ]);

  const markRunnerSessionRead = useCallback(async (
    sessionIdRaw: unknown,
    opts?: { directory?: unknown; source?: LlmSessionSource; lastReadAt?: unknown },
  ): Promise<RunnerSessionReadResult> => {
    const startedAt = Date.now();
    const traceId = `mr_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) {
      return {
        sessionId: "",
        directory: "",
        source: "all",
        lastReadAt: "",
        updated: false,
        acpUpdated: false,
        cliUpdated: false,
        diagnostics: null,
      };
    }
    const { baseUrl: targetLlmUrl, token } = await getRunnerHttpAuth();
    if (!targetLlmUrl || !token) {
      throw new Error("Aux Server URL または Runner Token が未設定です");
    }
    const directory = parseLlmDirectory(opts?.directory ?? normalizedLlmDirectoryForRequest());
    const sourceRaw = String(opts?.source || "").trim().toLowerCase();
    const source = (
      sourceRaw === "acp" || sourceRaw === "cli" || sourceRaw === "all"
        ? sourceRaw
        : "all"
    );
    const requestedLastReadAt = String(opts?.lastReadAt || "").trim();
    const url = new URL(`${targetLlmUrl}/sessions/read`);
    emitSessionDiag("session_mark_read_start", {
      traceId,
      sessionId,
      directory,
      source,
      lastReadAt: requestedLastReadAt || undefined,
    });
    try {
      const { response, data } = await fetchJsonWithTimeout(url.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          directory,
          source,
          lastReadAt: requestedLastReadAt || undefined,
        }),
      }, RUNNER_SESSIONS_HTTP_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
      }
      const diagnostics = data?.diagnostics && typeof data.diagnostics === "object"
        ? data.diagnostics as Record<string, unknown>
        : null;
      const lastReadAt = String(data?.lastReadAt || "").trim();
      const updated = Boolean(data?.updated);
      const acpUpdated = Boolean(data?.acpUpdated);
      const cliUpdated = Boolean(data?.cliUpdated);
      emitSessionDiag("session_mark_read_done", {
        traceId,
        sessionId,
        directory,
        source,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        httpStatus: Number(response.status || 0),
        updated,
        acpUpdated,
        cliUpdated,
        serverDiagnostics: diagnostics || undefined,
      });
      return {
        sessionId: String(data?.sessionId || sessionId),
        directory: String(data?.directory || directory),
        source: String(data?.source || source),
        lastReadAt,
        updated,
        acpUpdated,
        cliUpdated,
        diagnostics,
      };
    } catch (err) {
      emitSessionDiag("session_mark_read_error", {
        traceId,
        sessionId,
        directory,
        source,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }, [
    emitSessionDiag,
    fetchJsonWithTimeout,
    getRunnerHttpAuth,
    normalizedLlmDirectoryForRequest,
  ]);

  const markRunnerDirectoryRead = useCallback(async (
    directoryRaw: unknown,
    opts?: { source?: LlmSessionSource; lastReadAt?: unknown },
  ): Promise<RunnerDirectoryReadResult> => {
    const { baseUrl: targetLlmUrl, token } = await getRunnerHttpAuth();
    if (!targetLlmUrl || !token) {
      throw new Error("Aux Server URL または Runner Token が未設定です");
    }
    const directory = parseLlmDirectory(directoryRaw || normalizedLlmDirectoryForRequest());
    const sourceRaw = String(opts?.source || "").trim().toLowerCase();
    const source = sourceRaw === "acp" || sourceRaw === "cli" || sourceRaw === "all"
      ? sourceRaw
      : "all";
    const requestedLastReadAt = String(opts?.lastReadAt || "").trim();
    const startedAt = Date.now();
    const url = new URL(`${targetLlmUrl}/sessions/read`);
    try {
      const { response, data } = await fetchJsonWithTimeout(url.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scope: "directory",
          directory,
          source,
          lastReadAt: requestedLastReadAt || undefined,
        }),
      }, RUNNER_SESSIONS_HTTP_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
      }
      const status = String(data?.status || "");
      if (status !== "full" && status !== "partial" && status !== "failed") {
        throw new Error("Runnerから正しい一括既読結果が返されませんでした");
      }
      const diagnostics = data?.diagnostics && typeof data.diagnostics === "object"
        ? data.diagnostics as Record<string, unknown>
        : null;
      const canonicalDirectory = String(data?.directory || directory).trim();
      emitSessionDiag("directory_mark_read_done", {
        directory: canonicalDirectory,
        source,
        status,
        selectedCount: Number(data?.selectedCount || 0),
        updatedCount: Number(data?.updatedCount || 0),
        elapsedMs: Math.max(0, Date.now() - startedAt),
        serverDiagnostics: diagnostics || undefined,
      });
      return {
        scope: "directory",
        status,
        directory: canonicalDirectory,
        source: String(data?.source || source),
        lastReadAt: String(data?.lastReadAt || "").trim(),
        selectedCount: Number(data?.selectedCount || 0),
        foundCount: Number(data?.foundCount || 0),
        updatedCount: Number(data?.updatedCount || 0),
        stores: data?.stores as RunnerDirectoryReadResult["stores"],
        diagnostics,
      };
    } catch (err) {
      emitSessionDiag("directory_mark_read_error", {
        directory,
        source,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }, [
    emitSessionDiag,
    fetchJsonWithTimeout,
    getRunnerHttpAuth,
    normalizedLlmDirectoryForRequest,
  ]);

  return {
    directoryExplorerPath,
    directoryExplorerRootPath,
    directoryExplorerParentPath,
    directoryExplorerEntries,
    directoryExplorerLoading,
    directoryExplorerError,
    fetchRunnerSessionContextUsedPct,
    fetchRunnerSessionSnapshot,
    fetchRunnerSessionMessages,
    fetchLatestSessionForDirectory,
    fetchSessionHistory,
    fetchSessionChildrenHistory,
    markRunnerSessionRead,
    markRunnerDirectoryRead,
    loadDirectoryExplorer,
    openDirectoryExplorer,
  };
}
