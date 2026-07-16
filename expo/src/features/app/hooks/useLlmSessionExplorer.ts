import { useCallback, useState } from "react";
import {
  listCodexAppServerThreads,
  readCodexAppServerThread,
  type CodexThreadListEntry,
} from "../../codex/codexAppServerClient";
import type { CodexCommandExecutionInfo } from "../../codex/client/types";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { parseContextUsageUsedPct } from "../utils/formatting";
import {
  dedupeSessionHistoryEntries,
  parseLlmSessionSource,
  parseOptionalSessionId,
} from "../utils/llmSession";
import { parseLlmDirectory } from "../utils/settingsParsers";

const RUNNER_SESSIONS_HTTP_TIMEOUT_MS = 12_000;
const RUNNER_SESSION_MESSAGES_HTTP_TIMEOUT_MS = 12_000;
const RUNNER_SESSION_MESSAGES_RESTORE_TIMEOUT_MS = 25_000;
const SESSION_HISTORY_RPC_TIMEOUT_MS = 25_000;
const RUNNER_DIRECTORIES_HTTP_TIMEOUT_MS = 12_000;

export type DirectoryPickerEntry = {
  name: string;
  path: string;
};

export type LlmSessionSource = "acp" | "cli" | "all" | "appserver" | "vscode" | "exec" | "subagent" | "notification" | "unknown";

export type LlmSessionHistoryEntry = {
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

export type RunnerSessionMessageRole = "user" | "assistant";
export type RunnerSessionMessage = {
  role: RunnerSessionMessageRole;
  content: string;
  at: string;
  // Codex app-server thread item id: present when restored via thread/read,
  // absent on the aux /session-messages fallback.
  itemId?: string;
  inheritedFromParent?: boolean;
  commandExecution?: CodexCommandExecutionInfo;
};

export type RunnerSessionMessagesResult = {
  threadId: string;
  sourceKind: string;
  cwd: string;
  updatedAt: string;
  modelRef: string;
  reasoningEffort: string;
  latestToolLabel: string;
  messages: RunnerSessionMessage[];
  contextUsedPct: number | null;
  threadStatusType?: string;
  hasRunningTurn: boolean;
  runningTurn: {
    status: string;
    summary: string;
    startedAt: string;
    updatedAt: string;
  } | null;
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
  normalizedLlmDirectoryForRequest: () => string;
  defaultLlmDirectory: string;
  nearUnlimitedTimeoutMs: number;
  runnerWebSocketManager?: RunnerWebSocketManager;
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
  limit?: number;
  cursor?: string;
  includeRunnerSnapshots?: boolean;
  runnerSnapshotLimit?: number;
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

function inferLatestToolLabelFromSessionMessages(dataRaw: unknown): string {
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
    contextUsedPct: (() => {
      const value = snapshot?.contextUsedPct;
      if (typeof value !== "undefined") {
        return value === null ? null : Math.max(0, Math.min(100, Math.round(Number(value))));
      }
      return Number.isFinite(Number(item.contextUsedPct))
        ? Math.max(0, Math.min(100, Math.round(Number(item.contextUsedPct))))
        : null;
    })(),
    modelRef: String(snapshot?.modelRef || "").trim(),
    reasoningEffort: String(snapshot?.reasoningEffort || "").trim(),
  };
}

export function useLlmSessionExplorer(options: UseLlmSessionExplorerOptions) {
  const {
    codexWsUrl,
    codexWsToken,
    runnerToken,
    auxServerBaseUrl,
    normalizedLlmDirectoryForRequest,
    defaultLlmDirectory,
    nearUnlimitedTimeoutMs,
    runnerWebSocketManager,
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
    opts?: { limit?: number }
  ): Promise<Map<string, RunnerSessionSnapshot>> => {
    const out = new Map<string, RunnerSessionSnapshot>();
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) return out;
    const directory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    const sessionListLimit = Number.isFinite(Number(opts?.limit))
      ? Math.max(1, Math.min(200, Math.floor(Number(opts?.limit))))
      : 200;
    const fetchSessions = async (includeDirectory: boolean): Promise<unknown[]> => {
      const url = new URL(`${targetLlmUrl}/sessions`);
      if (includeDirectory) {
        url.searchParams.set("directory", directory);
      }
      url.searchParams.set("source", "all");
      url.searchParams.set("limit", String(sessionListLimit));
      const { response, data } = await fetchJsonWithTimeout(url.toString(), {
        headers: {
          authorization: `Bearer ${token}`,
        },
      }, RUNNER_SESSIONS_HTTP_TIMEOUT_MS);
      if (!response.ok) return [];
      return Array.isArray(data?.sessions) ? data.sessions : [];
    };
    const sessions = await fetchSessions(true);
    const scoreSnapshot = (snapshot: RunnerSessionSnapshot) => {
      let score = 0;
      if (String(snapshot.modelRef || "").trim()) score += 4;
      if (String(snapshot.reasoningEffort || "").trim()) score += 2;
      if (snapshot.contextUsedPct !== null) score += 1;
      if (String(snapshot.latestToolLabel || "").trim()) score += 1;
      return score;
    };
    for (const itemRaw of sessions) {
      const item = itemRaw && typeof itemRaw === "object" ? itemRaw as JsonRecord : {};
      const sessionId = parseOptionalSessionId(item.sessionId);
      if (!sessionId) continue;
      const candidate = buildRunnerSessionSnapshot(item);
      const current = out.get(sessionId);
      const candidateScore = scoreSnapshot(candidate);
      const currentScore = current ? scoreSnapshot(current) : -1;
      const candidateLastReadAtMs = Date.parse(String(candidate.lastReadAt || ""));
      const currentLastReadAtMs = Date.parse(String(current?.lastReadAt || ""));
      const shouldAdopt = (
        !current ||
        candidateScore > currentScore ||
        (candidateScore === currentScore && Number.isFinite(candidateLastReadAtMs) && (
          !Number.isFinite(currentLastReadAtMs) || candidateLastReadAtMs > currentLastReadAtMs
        ))
      );
      if (shouldAdopt) {
        out.set(sessionId, candidate);
      } else if (current && Number.isFinite(candidateLastReadAtMs) && (
        !Number.isFinite(currentLastReadAtMs) || candidateLastReadAtMs > currentLastReadAtMs
      )) {
        out.set(sessionId, {
          ...current,
          lastReadAt: candidate.lastReadAt,
        });
      }
    }
    return out;
  }, [auxServerBaseUrl, fetchJsonWithTimeout, normalizedLlmDirectoryForRequest, runnerToken]);

  const fetchRunnerSessionSnapshot = useCallback(async (
    sessionIdRaw: unknown,
    directoryRaw?: unknown
  ): Promise<RunnerSessionSnapshot> => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) {
      return { contextUsedPct: null, modelRef: "", reasoningEffort: "", latestToolLabel: "", lastReadAt: "" };
    }
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) {
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
    auxServerBaseUrl,
    emitSessionDiag,
    fetchJsonWithTimeout,
    normalizedLlmDirectoryForRequest,
    runnerToken,
  ]);

  const fetchRunnerSessionContextUsedPct = useCallback(async (
    sessionIdRaw: unknown,
    directoryRaw?: unknown
  ): Promise<number | null> => {
    const snapshot = await fetchRunnerSessionSnapshot(sessionIdRaw, directoryRaw);
    return snapshot.contextUsedPct;
  }, [fetchRunnerSessionSnapshot]);

  const fetchRunnerSessionMessages = useCallback(async (
    sessionIdRaw: unknown,
    directoryRaw?: unknown,
    options?: { preferCliRollout?: boolean },
  ): Promise<RunnerSessionMessagesResult> => {
    const sessionId = parseOptionalSessionId(sessionIdRaw);
    if (!sessionId) {
      throw new Error("sessionId is required");
    }
    const targetCodexWsUrl = codexWsUrl.trim();
    const preferredDirectory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    if (targetCodexWsUrl && options?.preferCliRollout !== true) {
      const appServerStartedAt = Date.now();
      try {
        emitSessionDiag("app_server_thread_restore_start", {
          sessionId,
          directory: preferredDirectory,
        });
        const restored = await readCodexAppServerThread({
          wsUrl: targetCodexWsUrl,
          wsToken: codexWsToken.trim(),
          threadId: sessionId,
          timeoutMs: Math.min(nearUnlimitedTimeoutMs, SESSION_HISTORY_RPC_TIMEOUT_MS),
          runnerWebSocketManager,
        });
        let metadataSnapshot: RunnerSessionSnapshot | null = null;
        try {
          metadataSnapshot = await fetchRunnerSessionSnapshot(sessionId, preferredDirectory);
          emitSessionDiag("app_server_thread_restore_metadata_done", {
            sessionId,
            directory: preferredDirectory,
            hasModelRef: Boolean(metadataSnapshot.modelRef),
            hasReasoningEffort: Boolean(metadataSnapshot.reasoningEffort),
            contextUsedPct: metadataSnapshot.contextUsedPct,
          });
        } catch (error) {
          emitSessionDiag("app_server_thread_restore_metadata_failed", {
            sessionId,
            directory: preferredDirectory,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        const messages = restored.messages.map((item) => ({
          role: item.role,
          content: item.content,
          at: item.at,
          itemId: item.itemId,
          commandExecution: item.commandExecution,
        }));
        const latestAssistantMessage = [...messages].reverse().find((item) => item.role === "assistant");
        emitSessionDiag("app_server_thread_restore_done", {
          sessionId,
          directory: preferredDirectory,
          elapsedMs: Math.max(0, Date.now() - appServerStartedAt),
          threadStatusType: restored.threadStatusType,
          sessionState: restored.sessionState,
          latestTurnStatus: restored.latestTurnStatus,
          waitingOnApproval: restored.waitingOnApproval,
          hasRunningTurn: restored.hasRunningTurn,
          messageCount: messages.length,
          latestAssistantChars: String(latestAssistantMessage?.content || "").length,
          latestAssistantStartsWithThinking: String(latestAssistantMessage?.content || "").startsWith("思考中..."),
          modelRef: String(metadataSnapshot?.modelRef || restored.modelProvider || "").trim(),
          reasoningEffort: String(metadataSnapshot?.reasoningEffort || "").trim(),
          contextUsedPct: restored.contextUsedPct ?? metadataSnapshot?.contextUsedPct ?? null,
        });
        return {
          threadId: restored.threadId || sessionId,
          sourceKind: restored.sourceKind || "appServer",
          cwd: restored.cwd,
          updatedAt: restored.updatedAt,
          modelRef: String(metadataSnapshot?.modelRef || restored.modelProvider || "").trim(),
          reasoningEffort: String(metadataSnapshot?.reasoningEffort || "").trim(),
          latestToolLabel: String(metadataSnapshot?.latestToolLabel || "").trim(),
          messages,
          contextUsedPct: restored.contextUsedPct ?? metadataSnapshot?.contextUsedPct ?? null,
          threadStatusType: restored.threadStatusType,
          hasRunningTurn: restored.hasRunningTurn,
          runningTurn: restored.runningTurn,
        };
      } catch (error) {
        emitSessionDiag("app_server_thread_restore_fallback", {
          sessionId,
          directory: preferredDirectory,
          elapsedMs: Math.max(0, Date.now() - appServerStartedAt),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) {
      throw new Error("Aux Server URL または Runner Token が未設定です");
    }
    const startedAt = Date.now();
    const traceId = `sm_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const fetchAttempt = async (attempt: "preferred" | "fallback_no_directory", includeDirectory: boolean) => {
      const url = new URL(`${targetLlmUrl}/session-messages`);
      url.searchParams.set("sessionId", sessionId);
      url.searchParams.set("source", "all");
      url.searchParams.set("limit", "all");
      if (includeDirectory && preferredDirectory) {
        url.searchParams.set("directory", preferredDirectory);
      }
      emitSessionDiag("runner_session_messages_restore_start", {
        traceId,
        sessionId,
        directory: includeDirectory ? preferredDirectory : "",
        attempt,
      });
      let response: Response;
      let data: JsonRecord = {};
      let rawText = "";
      const httpStartedAt = Date.now();
      const result = await fetchTextWithTimeout(url.toString(), {
        headers: {
          authorization: `Bearer ${token}`,
        },
      }, RUNNER_SESSION_MESSAGES_RESTORE_TIMEOUT_MS);
      const httpElapsedMs = Math.max(0, Date.now() - httpStartedAt);
      response = result.response;
      rawText = String(result.text || "");
      const parseStartedAt = Date.now();
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = {};
      }
      const jsonParseElapsedMs = Math.max(0, Date.now() - parseStartedAt);
      const isFound = data?.found === true;
      const ok = response.ok && isFound;
      const restoredMessagesRaw = Array.isArray((data as any)?.messages) ? ((data as any).messages as any[]) : [];
      const latestAssistantRaw = [...restoredMessagesRaw].reverse().find((item) => String(item?.role || "") === "assistant");
      emitSessionDiag("runner_session_messages_restore_done", {
        traceId,
        sessionId,
        directory: includeDirectory ? preferredDirectory : "",
        attempt,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        httpElapsedMs,
        jsonParseElapsedMs,
        httpStatus: Number(response.status || 0),
        ok: response.ok,
        found: isFound,
        responseSerializeMs: Number(response.headers.get("x-session-messages-serialize-ms") || 0),
        responseBytesHeader: Number(response.headers.get("x-session-messages-response-bytes") || 0),
        responseRouteTotalMsHeader: Number(response.headers.get("x-session-messages-route-total-ms") || 0),
        responseTextBytes: rawText.length,
        messageCount: restoredMessagesRaw.length,
        latestAssistantChars: String(latestAssistantRaw?.content || "").length,
        latestAssistantStartsWithThinking: String(latestAssistantRaw?.content || "").startsWith("思考中..."),
      });
      if (!response.ok) {
        throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
      }
      if (!ok) {
        throw new Error("session not found");
      }
      return {
        response,
        data,
        rawText,
      };
    };

    let response: Response;
    let data: JsonRecord = {};
    let rawText = "";
    let normalizeElapsedMs = 0;
    let normalizedViaAttempt: "preferred" | "fallback_no_directory" = "preferred";
    try {
      const result = await fetchAttempt("preferred", true);
      response = result.response;
      data = result.data;
      rawText = result.rawText;
    } catch (preferredError) {
      emitSessionDiag("runner_session_messages_restore_retry", {
        traceId,
        sessionId,
        preferredDirectory,
        reason: preferredError instanceof Error ? preferredError.message : String(preferredError),
      });
      const fallbackResult = await fetchAttempt("fallback_no_directory", false);
      response = fallbackResult.response;
      data = fallbackResult.data;
      rawText = fallbackResult.rawText;
      normalizedViaAttempt = "fallback_no_directory";
    }
    const normalizeStartedAt = Date.now();
    const messagesRaw = Array.isArray(data?.messages) ? data.messages : [];
    const messages: RunnerSessionMessage[] = messagesRaw
      .map((itemRaw: unknown) => {
        const item = itemRaw && typeof itemRaw === "object" ? itemRaw as JsonRecord : {};
        const role = String(item.role || "").trim().toLowerCase();
        if (role !== "user" && role !== "assistant") return null;
        const content = String(item.content || "").trim();
        if (!content) return null;
        return {
          role,
          content,
          at: String(item.at || "").trim(),
          inheritedFromParent: item.inheritedFromParent === true || undefined,
        } as RunnerSessionMessage;
      })
      .filter((item: RunnerSessionMessage | null): item is RunnerSessionMessage => !!item);
    normalizeElapsedMs = Math.max(0, Date.now() - normalizeStartedAt);
    const serverDiagnostics = data?.diagnostics && typeof data.diagnostics === "object"
      ? data.diagnostics as Record<string, unknown>
      : null;
    emitSessionDiag("runner_session_messages_restore_normalized", {
      traceId,
      sessionId,
      directory: preferredDirectory,
      resolvedByAttempt: normalizedViaAttempt,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      normalizeElapsedMs,
      httpStatus: Number(response.status || 0),
      responseTextBytes: rawText.length,
      messageCount: messages.length,
      contextUsedPct: parseContextUsageUsedPct(data?.contextUsage),
      updatedAt: String(data?.updatedAt || "").trim(),
      source: String(data?.source || "").trim(),
      serverDiagnostics: serverDiagnostics || undefined,
    });
    return {
      threadId: sessionId,
      sourceKind: "cli",
      cwd: String(data?.cwd || "").trim(),
      updatedAt: String(data?.updatedAt || "").trim(),
      modelRef: String(data?.modelRef || "").trim(),
      reasoningEffort: String(data?.reasoningEffort || "").trim(),
      latestToolLabel: inferLatestToolLabelFromSessionMessages(data),
      messages,
      contextUsedPct: parseContextUsageUsedPct(data?.contextUsage),
      threadStatusType: "",
      hasRunningTurn: false,
      runningTurn: null,
    };
  }, [
    auxServerBaseUrl,
    codexWsToken,
    codexWsUrl,
    emitSessionDiag,
    fetchRunnerSessionSnapshot,
    fetchTextWithTimeout,
    nearUnlimitedTimeoutMs,
    normalizedLlmDirectoryForRequest,
    runnerWebSocketManager,
    runnerToken,
  ]);

  const fetchLatestSessionIdForDirectory = useCallback(async (directoryRaw?: unknown) => {
    const targetCodexWsUrl = codexWsUrl.trim();
    const directory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    if (!targetCodexWsUrl) return "";
    const listed = await listCodexAppServerThreads({
      wsUrl: targetCodexWsUrl,
      wsToken: codexWsToken.trim(),
      cwd: directory,
      limit: 1,
      sourceKinds: [...MAIN_THREAD_SOURCE_KINDS],
      timeoutMs: Math.min(nearUnlimitedTimeoutMs, SESSION_HISTORY_RPC_TIMEOUT_MS),
      runnerWebSocketManager,
    });
    return parseOptionalSessionId(listed.data[0]?.threadId);
  }, [codexWsToken, codexWsUrl, nearUnlimitedTimeoutMs, normalizedLlmDirectoryForRequest, runnerWebSocketManager]);

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
    const runnerSnapshotLimit = Number.isFinite(Number(historyOptions?.runnerSnapshotLimit))
      ? Math.max(1, Math.min(200, Math.floor(Number(historyOptions?.runnerSnapshotLimit))))
      : 200;
    const targetCodexWsUrl = codexWsUrl.trim();
    if (!targetCodexWsUrl) {
      throw new Error("Codex WS URL が未設定です");
    }
    const startedAt = Date.now();
    emitSessionDiag("session_history_fetch_start", {
      directory,
      limit,
      cursor,
      includeRunnerSnapshots,
      runnerSnapshotLimit: includeRunnerSnapshots ? runnerSnapshotLimit : 0,
    });
    const listed = await listCodexAppServerThreads({
      wsUrl: targetCodexWsUrl,
      wsToken: codexWsToken.trim(),
      cwd: directory,
      limit,
      cursor,
      sourceKinds: [...MAIN_THREAD_SOURCE_KINDS],
      timeoutMs: Math.min(nearUnlimitedTimeoutMs, SESSION_HISTORY_RPC_TIMEOUT_MS),
      runnerWebSocketManager,
    });
    const runnerSnapshotMap = includeRunnerSnapshots
      ? await fetchRunnerSessionSnapshotMap(directory, { limit: runnerSnapshotLimit }).catch(() => (
        new Map<string, RunnerSessionSnapshot>()
      ))
      : new Map<string, RunnerSessionSnapshot>();
    const sessions = listed.data.map((item) => buildLlmSessionHistoryEntry(item, directory, runnerSnapshotMap));
    const deduped = dedupeSessionHistoryEntries(sessions);
    emitSessionDiag("session_history_fetch_done", {
      directory,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      threadCountRaw: sessions.length,
      threadCountDeduped: deduped.length,
      latestSessionId: sessions[0]?.sessionId || "",
      nextCursor: listed.nextCursor,
      runnerSnapshotCount: runnerSnapshotMap.size,
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
    runnerWebSocketManager,
  ]);

  const fetchSessionChildHistory = useCallback(async (
    parentSessionIdRaw: unknown,
    directoryRaw?: unknown,
    historyOptions?: Pick<FetchSessionHistoryOptions, "limit" | "includeRunnerSnapshots" | "runnerSnapshotLimit">,
  ): Promise<LlmSessionHistoryEntry[]> => {
    const parentSessionId = parseOptionalSessionId(parentSessionIdRaw);
    if (!parentSessionId) return [];
    const directory = parseLlmDirectory(directoryRaw ?? normalizedLlmDirectoryForRequest());
    const limit = Number.isFinite(Number(historyOptions?.limit))
      ? Math.max(1, Math.min(100, Math.floor(Number(historyOptions?.limit))))
      : 50;
    const includeRunnerSnapshots = historyOptions?.includeRunnerSnapshots !== false;
    const runnerSnapshotLimit = Number.isFinite(Number(historyOptions?.runnerSnapshotLimit))
      ? Math.max(1, Math.min(200, Math.floor(Number(historyOptions?.runnerSnapshotLimit))))
      : 200;
    const targetCodexWsUrl = codexWsUrl.trim();
    if (!targetCodexWsUrl) {
      throw new Error("Codex WS URL が未設定です");
    }
    const startedAt = Date.now();
    emitSessionDiag("session_child_history_fetch_start", {
      directory,
      parentSessionId,
      limit,
      includeRunnerSnapshots,
      runnerSnapshotLimit: includeRunnerSnapshots ? runnerSnapshotLimit : 0,
    });
    const listed = await listCodexAppServerThreads({
      wsUrl: targetCodexWsUrl,
      wsToken: codexWsToken.trim(),
      cwd: directory,
      limit,
      sourceKinds: [...SUBAGENT_THREAD_SOURCE_KINDS],
      timeoutMs: Math.min(nearUnlimitedTimeoutMs, SESSION_HISTORY_RPC_TIMEOUT_MS),
      runnerWebSocketManager,
    });
    const runnerSnapshotMap = includeRunnerSnapshots
      ? await fetchRunnerSessionSnapshotMap(directory, { limit: runnerSnapshotLimit }).catch(() => (
        new Map<string, RunnerSessionSnapshot>()
      ))
      : new Map<string, RunnerSessionSnapshot>();
    const directChildren = listed.data.filter(
      (item) => parseOptionalSessionId(item.parentThreadId) === parentSessionId
    );
    const sessions = dedupeSessionHistoryEntries(
      directChildren.map((item) => buildLlmSessionHistoryEntry(item, directory, runnerSnapshotMap))
    );
    emitSessionDiag("session_child_history_fetch_done", {
      directory,
      parentSessionId,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      threadCountRaw: listed.data.length,
      directChildCount: directChildren.length,
      threadCountDeduped: sessions.length,
      runnerSnapshotCount: runnerSnapshotMap.size,
    });
    return sessions;
  }, [
    codexWsToken,
    codexWsUrl,
    emitSessionDiag,
    fetchRunnerSessionSnapshotMap,
    nearUnlimitedTimeoutMs,
    normalizedLlmDirectoryForRequest,
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
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) {
      return {
        sessionId,
        directory: "",
        source: "all",
        lastReadAt: "",
        updated: false,
        acpUpdated: false,
        cliUpdated: false,
        diagnostics: null,
      };
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
    auxServerBaseUrl,
    fetchJsonWithTimeout,
    normalizedLlmDirectoryForRequest,
    runnerToken,
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
    fetchLatestSessionIdForDirectory,
    fetchSessionHistory,
    fetchSessionChildHistory,
    markRunnerSessionRead,
    loadDirectoryExplorer,
    openDirectoryExplorer,
  };
}
