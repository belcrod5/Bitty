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
  return {
    results: Array.isArray(payload?.results) ? payload.results : [],
    cursor: String(payload?.cursor || ""),
    partial: payload?.partial === true,
  };
}
