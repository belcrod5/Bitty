// 設定から読み込むURL値の検証。http(s)として解釈できない値(実例: URL欄へ誤って
// 貼られたRunner token)は空文字にして捨てる。runnerUrlはUIに直接の編集欄がなく、
// 経路選択も両URL設定時しか動かないため、ここで捨てないと壊れた値が自己修復されない。
export function sanitizePersistedHttpUrl(rawUrl: unknown): string {
  const normalized = String(rawUrl || "").trim().replace(/\/$/, "");
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return normalized;
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
