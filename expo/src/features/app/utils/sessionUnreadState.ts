let unreadCountSyncSequence = 0;

export type UnreadSessionCountSnapshot = {
  unreadCount: number;
  directoryCounts: Array<{ directory: string; unreadCount: number }>;
};

export function notificationFailureReason(error: unknown): string {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = String(candidate.code || "").trim().toLowerCase();
  if (/^[a-z0-9_]{1,64}$/.test(code)) return code;
  const name = String(candidate.name || "").trim().toLowerCase();
  return /^[a-z0-9_]{1,64}$/.test(name) ? name : "notification_error";
}

export async function fetchUnreadSessionCounts({
  runnerUrl,
  runnerToken,
  directories,
}: {
  runnerUrl: string;
  runnerToken: string;
  directories: string[];
}): Promise<UnreadSessionCountSnapshot> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  const normalizedDirectories = Array.from(new Set(
    (Array.isArray(directories) ? directories : [])
      .map((directory) => String(directory || "").trim())
      .filter(Boolean)
  ));
  if (!baseUrl || !token) throw new Error("Runner URL またはRunner Tokenが未設定です");
  const response = await fetch(`${baseUrl}/sessions/unread-count`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ directories: normalizedDirectories }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
  }
  const unreadCount = Number(data?.unreadCount);
  if (!Number.isInteger(unreadCount) || unreadCount < 0) {
    throw new Error("Runnerから正しい未読件数が返されませんでした");
  }
  const rawDirectoryCounts = Array.isArray(data?.directoryCounts) ? data.directoryCounts : null;
  if (!rawDirectoryCounts || rawDirectoryCounts.length > normalizedDirectories.length) {
    throw new Error("Runnerから正しいディレクトリ別未読件数が返されませんでした");
  }
  const seenDirectories = new Set<string>();
  const directoryCounts: UnreadSessionCountSnapshot["directoryCounts"] = rawDirectoryCounts.map((itemRaw: unknown) => {
    const item = itemRaw && typeof itemRaw === "object" ? itemRaw as Record<string, unknown> : {};
    const directory = String(item.directory || "").trim();
    const count = Number(item.unreadCount);
    if (!directory || seenDirectories.has(directory) || !Number.isInteger(count) || count < 0) {
      throw new Error("Runnerから正しいディレクトリ別未読件数が返されませんでした");
    }
    seenDirectories.add(directory);
    return { directory, unreadCount: count };
  });
  if (directoryCounts.reduce((sum, item) => sum + item.unreadCount, 0) !== unreadCount) {
    throw new Error("Runnerの未読合計とディレクトリ別件数が一致しません");
  }
  return { unreadCount, directoryCounts };
}

export async function syncUnreadSessionCounts(
  params: Parameters<typeof fetchUnreadSessionCounts>[0]
): Promise<UnreadSessionCountSnapshot | null> {
  const sequence = ++unreadCountSyncSequence;
  const snapshot = await fetchUnreadSessionCounts(params);
  return sequence === unreadCountSyncSequence ? snapshot : null;
}

export async function fetchSessionUnreadState({
  runnerUrl,
  runnerToken,
  backendId = "codex",
  sessionId,
  directory,
}: {
  runnerUrl: string;
  runnerToken: string;
  backendId?: string;
  sessionId: string;
  directory: string;
}): Promise<{ found: boolean; unread: boolean }> {
  const baseUrl = String(runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(runnerToken || "").trim();
  if (!baseUrl || !token) throw new Error("Runner URL またはRunner Tokenが未設定です");
  const response = await fetch(`${baseUrl}/sessions/unread-state`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ backendId: String(backendId || "codex").trim() || "codex", sessionId, directory }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
  }
  return { found: data?.found === true, unread: data?.unread === true };
}
