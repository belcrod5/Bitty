export function runnerHttpsOrigin(rawUrl: unknown): string {
  const value = String(rawUrl || "").trim();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
      || url.search || url.hash || /[\u0000-\u0020]/.test(value)) return "";
    return url.origin;
  } catch { return ""; }
}

export function runnerDevelopmentOrigin(rawUrl: unknown): string {
  try {
    const url = new URL(String(rawUrl || "").trim());
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch { return ""; }
}

export function persistedCloudflareRunnerUrl(settings: Record<string, unknown>): string {
  return String(settings.cloudflareRunnerUrl || settings.tunnelRunnerUrl
    || (settings.runnerUrl !== settings.localRunnerUrl ? runnerHttpsOrigin(settings.runnerUrl) : ""));
}

// All foreground/background clients consume this origin contract. A saved LAN
// selection cannot become usable before its paired native trust is installed.
export function resolveRunnerUrl({ runnerUrl, cloudflareRunnerUrl, localRunnerUrl, localReady = false }: {
  runnerUrl?: unknown; cloudflareRunnerUrl?: unknown; localRunnerUrl?: unknown; localReady?: boolean;
}): string {
  const cloudflare = runnerHttpsOrigin(cloudflareRunnerUrl);
  if (String(cloudflareRunnerUrl || "").trim() && !cloudflare) return "";
  const selected = runnerHttpsOrigin(runnerUrl);
  const local = runnerHttpsOrigin(localRunnerUrl);
  if (local && selected === local) return localReady ? local : cloudflare;
  if (cloudflare) return cloudflare;
  return selected || runnerDevelopmentOrigin(runnerUrl);
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
