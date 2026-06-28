export function suggestCodexWsUrlFromRunnerUrl(rawRunnerUrl: unknown): string {
  const normalizedRunnerUrl = String(rawRunnerUrl || "").trim().replace(/\/$/, "");
  if (!normalizedRunnerUrl) return "";
  try {
    const url = new URL(normalizedRunnerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/codex-ws";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function suggestRunnerWsUrlFromRunnerUrl(rawRunnerUrl: unknown): string {
  const normalizedRunnerUrl = String(rawRunnerUrl || "").trim().replace(/\/$/, "");
  if (!normalizedRunnerUrl) return "";
  try {
    const url = new URL(normalizedRunnerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/runner-ws";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function suggestRunnerUrlFromCodexWsUrl(rawCodexWsUrl: unknown): string {
  const normalizedCodexWsUrl = String(rawCodexWsUrl || "").trim();
  if (!normalizedCodexWsUrl) return "";
  try {
    const url = new URL(normalizedCodexWsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
