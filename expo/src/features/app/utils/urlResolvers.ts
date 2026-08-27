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
