const SESSION_SUMMARY_BATCH_SIZE = 100;

export type RunnerSessionSummary = Record<string, unknown> & {
  sessionId: string;
  directory: string;
  cwd: string;
  updatedAt: string;
  lastReadAt: string;
  source: string;
  firstUserMessage: string;
  parentSessionId: string;
  contextUsage: unknown;
  modelRef: string;
  reasoningEffort: string;
};

export async function fetchRunnerSessionSummaries(
  auth: { baseUrl: string; token: string },
  { directory, sessionIds }: { directory: string; sessionIds: readonly string[] },
  timeoutMs: number,
): Promise<RunnerSessionSummary[]> {
  const baseUrl = String(auth.baseUrl || "").trim().replace(/\/$/, "");
  const token = String(auth.token || "").trim();
  if (!baseUrl || !token) throw new Error("Runner URL またはRunner Tokenが未設定です");
  const ids = Array.from(new Set(sessionIds.map((id) => String(id || "").trim()).filter(Boolean)));
  const results: RunnerSessionSummary[] = [];
  for (let start = 0; start < ids.length; start += SESSION_SUMMARY_BATCH_SIZE) {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const request = fetch(`${baseUrl}/session-summaries`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ directory, sessionIds: ids.slice(start, start + SESSION_SUMMARY_BATCH_SIZE) }),
        signal: controller.signal,
      }).then(async (response) => ({ response, text: await response.text() }));
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error(`request timeout (${timeoutMs}ms)`));
        }, timeoutMs);
      });
      const { response, text } = await Promise.race([request, timeout]);
      let data: Record<string, unknown> = {};
      try {
        const parsed = text ? JSON.parse(text) : {};
        data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch { /* use HTTP status */ }
      if (!response.ok) {
        throw new Error(String(data.message || data.error || `session summaries fetch failed: HTTP ${response.status}`));
      }
      for (const raw of Array.isArray(data.sessions) ? data.sessions : []) {
        const record = raw && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown> : {};
        const sessionId = String(record.sessionId || "").trim();
        if (!sessionId) continue;
        results.push({
          ...record,
          sessionId,
          directory: String(record.directory || directory),
          cwd: String(record.cwd || ""),
          updatedAt: String(record.updatedAt || ""),
          lastReadAt: String(record.lastReadAt || ""),
          source: String(record.source || ""),
          firstUserMessage: String(record.firstUserMessage || ""),
          parentSessionId: String(record.parentSessionId || ""),
          contextUsage: record.contextUsage ?? null,
          modelRef: String(record.modelRef || ""),
          reasoningEffort: String(record.reasoningEffort || ""),
        });
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
  return results;
}
