export type DrawerConversationSearchOrder = "newest" | "oldest";

export type DrawerConversationSearchResult = {
  sessionRef: {
    backendId: string;
    nativeSessionId: string;
  };
  canonicalCwd: string;
  sessionCreatedAt?: string;
  messageId: string;
  role: "user" | "assistant";
  createdAt?: string;
  snippet: string;
  conversationCursor: string;
};

export type DrawerConversationSearchPage = {
  results: DrawerConversationSearchResult[];
  cursor: string;
  partial: boolean;
};

type RunnerRequest = {
  runnerUrl: string;
  runnerToken: string;
  signal?: AbortSignal;
};

function invalidSearchResponse(): never {
  throw new Error("検索結果の応答形式が不正です。");
}

function requiredResultText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalidSearchResponse();
  return value.trim();
}

function optionalResultText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalidSearchResponse();
  return value.trim() || undefined;
}

function normalizeSearchResult(value: unknown): DrawerConversationSearchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidSearchResponse();
  const result = value as Record<string, unknown>;
  if (!result.sessionRef || typeof result.sessionRef !== "object" || Array.isArray(result.sessionRef)) {
    return invalidSearchResponse();
  }
  const sessionRef = result.sessionRef as Record<string, unknown>;
  const role = requiredResultText(result.role).toLowerCase();
  if (role !== "user" && role !== "assistant") return invalidSearchResponse();
  const sessionCreatedAt = optionalResultText(result.sessionCreatedAt);
  const createdAt = optionalResultText(result.createdAt);
  return {
    sessionRef: {
      backendId: requiredResultText(sessionRef.backendId),
      nativeSessionId: requiredResultText(sessionRef.nativeSessionId),
    },
    canonicalCwd: requiredResultText(result.canonicalCwd),
    messageId: requiredResultText(result.messageId),
    role,
    snippet: requiredResultText(result.snippet),
    conversationCursor: requiredResultText(result.conversationCursor),
    ...(sessionCreatedAt ? { sessionCreatedAt } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

async function fetchRunnerJson(
  request: RunnerRequest,
  pathname: string,
  searchParams?: URLSearchParams,
): Promise<Record<string, unknown>> {
  const baseUrl = String(request.runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(request.runnerToken || "").trim();
  if (!baseUrl || !token) throw new Error("Runnerへ接続する設定がありません。");

  const url = new URL(`${baseUrl}${pathname}`);
  if (searchParams) url.search = searchParams.toString();
  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
    signal: request.signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorPayload = payload && typeof payload === "object"
      ? payload as { error?: { message?: unknown } | string; message?: unknown }
      : {};
    const message = typeof errorPayload.error === "object"
      ? errorPayload.error?.message
      : errorPayload.error || errorPayload.message;
    throw new Error(String(message || `検索に失敗しました (${response.status})`));
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalidSearchResponse();
  return payload as Record<string, unknown>;
}

export async function listDrawerConversationSearchDirectories(
  request: RunnerRequest,
): Promise<string[]> {
  const payload = await fetchRunnerJson(request, "/agent/workspaces");
  if (!Array.isArray(payload.workspaces)) return invalidSearchResponse();
  const directories = payload.workspaces.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalidSearchResponse();
    return requiredResultText((value as Record<string, unknown>).canonicalRoot);
  });
  return Array.from(new Set(directories));
}

export async function searchDrawerConversations(params: {
  runnerUrl: string;
  runnerToken: string;
  query: string;
  directories: string[];
  backendId: string;
  order: DrawerConversationSearchOrder;
  since?: string;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<DrawerConversationSearchPage> {
  const searchParams = new URLSearchParams();
  searchParams.set("query", params.query.trim());
  params.directories.forEach((directory) => searchParams.append("cwd", directory));
  searchParams.set("backendId", params.backendId);
  searchParams.set("limit", "10");
  searchParams.set("order", params.order);
  if (params.since) searchParams.set("since", params.since);
  if (params.cursor) searchParams.set("cursor", params.cursor);

  const payload = await fetchRunnerJson(params, "/agent/session-history/search", searchParams);
  if (!Array.isArray(payload.results)) return invalidSearchResponse();
  if (payload.cursor !== undefined && typeof payload.cursor !== "string") return invalidSearchResponse();
  if (payload.partial !== undefined && typeof payload.partial !== "boolean") return invalidSearchResponse();
  return {
    results: payload.results.map(normalizeSearchResult),
    cursor: String(payload.cursor || "").trim(),
    partial: payload.partial === true,
  };
}
