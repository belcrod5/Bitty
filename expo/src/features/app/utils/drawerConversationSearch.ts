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
  const baseUrl = String(params.runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(params.runnerToken || "").trim();
  if (!baseUrl || !token) throw new Error("Runnerへ接続する設定がありません。");

  const url = new URL(`${baseUrl}/agent/session-history/search`);
  url.searchParams.set("query", params.query.trim());
  params.directories.forEach((directory) => url.searchParams.append("cwd", directory));
  url.searchParams.set("backendId", params.backendId);
  url.searchParams.set("limit", "10");
  url.searchParams.set("order", params.order);
  if (params.since) url.searchParams.set("since", params.since);
  if (params.cursor) url.searchParams.set("cursor", params.cursor);

  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
    signal: params.signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.error?.message || payload?.message || `検索に失敗しました (${response.status})`));
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) return invalidSearchResponse();
  if (payload.cursor !== undefined && typeof payload.cursor !== "string") return invalidSearchResponse();
  if (payload.partial !== undefined && typeof payload.partial !== "boolean") return invalidSearchResponse();
  return {
    results: payload.results.map(normalizeSearchResult),
    cursor: String(payload.cursor || "").trim(),
    partial: payload.partial === true,
  };
}
