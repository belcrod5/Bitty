type JsonRecord = Record<string, unknown>;

export type RunnerTextFileContent = {
  path: string;
  content: string;
  totalBytes: number;
};

export async function fetchRunnerTextFileContent(params: {
  runnerUrl: string;
  runnerToken: string;
  rootDir: string;
  path: string;
  timeoutMs: number;
}): Promise<RunnerTextFileContent> {
  const baseUrl = String(params.runnerUrl || "").trim().replace(/\/$/, "");
  const token = String(params.runnerToken || "").trim();
  const targetPath = String(params.path || "").trim();
  if (!targetPath) {
    throw new Error("ファイルパスが未指定です");
  }
  if (!baseUrl || !token) {
    throw new Error("Runner URL または Runner Token が未設定です");
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(params.timeoutMs || 1));
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${baseUrl}/files/content`);
    url.searchParams.set("path", targetPath);
    if (params.rootDir) {
      url.searchParams.set("rootDir", params.rootDir);
    }
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let data: JsonRecord = {};
    try {
      data = text ? JSON.parse(text) as JsonRecord : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
    }
    return {
      path: String(data?.path || targetPath).trim(),
      content: typeof data?.content === "string" ? data.content : "",
      totalBytes: Number(data?.totalBytes || 0),
    };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "name" in err && (err as { name?: unknown }).name === "AbortError") {
      throw new Error(`request timeout (${timeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
