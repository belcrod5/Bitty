// アプリの外部通信 3経路(HTTP fetch / runner WS / stream-tts WS)の送受信バイト数を
// 起動からの累計で集計するシングルトンストア。計測点はホットパス(WS受信など)にあるため、
// 記録はカウンタ加算のみで通知や逐次ログは行わない。UIは必要時に getNetworkUsageSnapshot()
// を読み出す(ポーリング)。
export type NetworkUsageRoute = "runner-ws" | "stream-tts";

export type NetworkUsageHttpCategory = typeof HTTP_CATEGORIES[number];

export type NetworkUsageCounter = {
  sentBytes: number;
  receivedBytes: number;
};

export type NetworkUsageSnapshot = {
  sinceMs: number;
  http: NetworkUsageCounter;
  httpByCategory: Record<NetworkUsageHttpCategory, NetworkUsageCounter>;
  runnerWs: NetworkUsageCounter;
  runnerWsByOperation: Record<string, NetworkUsageCounter & { sentCount: number; receivedCount: number }>;
  streamTts: NetworkUsageCounter;
  totalSentBytes: number;
  totalReceivedBytes: number;
};

export const HTTP_CATEGORIES = [
  "session-messages",
  "session-summaries",
  "tts-media",
  "client-state",
  "agent-history",
  "skia-board",
  "git",
  "client-logs",
  "codex-schedules",
  "codex-status",
  "app-status",
  "file-media",
  "directories",
  "codex-auth",
  "other-origin",
  "other",
] as const;

function createCounter(): NetworkUsageCounter {
  return { sentBytes: 0, receivedBytes: 0 };
}

function createHttpCategoryCounters(): Record<NetworkUsageHttpCategory, NetworkUsageCounter> {
  return Object.fromEntries(HTTP_CATEGORIES.map((category) => [category, createCounter()])) as Record<NetworkUsageHttpCategory, NetworkUsageCounter>;
}

let sinceMs = Date.now();
let httpByCategory = createHttpCategoryCounters();
let runnerWs = createCounter();
let runnerWsByOperation: NetworkUsageSnapshot["runnerWsByOperation"] = {};
let streamTts = createCounter();

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // サロゲートペア(絵文字等)は2文字で4バイト。
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function categorizeHttpUrl(url: string, runnerOrigin?: string): NetworkUsageHttpCategory {
  let path: string;
  try {
    const parsed = new URL(url);
    if (runnerOrigin && parsed.origin !== runnerOrigin) return "other-origin";
    path = parsed.pathname;
  } catch {
    return "other";
  }
  if (path === "/session-messages") return "session-messages";
  if (path === "/session-summaries") return "session-summaries";
  if (path.startsWith("/tts-media/")) return "tts-media";
  if (path === "/client-state") return "client-state";
  if (path === "/agent/session-history" || path === "/agent/session-conversation" || path.startsWith("/agent/session-history/")) return "agent-history";
  if (path === "/skia-board" || path.startsWith("/skia-board/")) return "skia-board";
  if (path.startsWith("/git/")) return "git";
  if (path === "/client-logs") return "client-logs";
  if (path === "/codex-schedules" || path.startsWith("/codex-schedules/")) return "codex-schedules";
  if (path.startsWith("/codex-cli/")) return "codex-status";
  if (path === "/app/status-snapshot") return "app-status";
  if (path === "/files/media") return "file-media";
  if (path === "/directories") return "directories";
  if (path.startsWith("/codex-auth/")) return "codex-auth";
  return "other";
}

function addTo(counter: NetworkUsageCounter, sentBytes: number, receivedBytes: number) {
  if (Number.isFinite(sentBytes) && sentBytes > 0) counter.sentBytes += sentBytes;
  if (Number.isFinite(receivedBytes) && receivedBytes > 0) counter.receivedBytes += receivedBytes;
}

export function recordNetworkUsage(route: NetworkUsageRoute, sentBytes: number, receivedBytes: number) {
  addTo(route === "runner-ws" ? runnerWs : streamTts, sentBytes, receivedBytes);
}

// Bound both key size and cardinality; never retain IDs, request payloads or text.
export function recordRunnerWsNetworkUsage(direction: "sent" | "received", bytes: number,
  message?: { channel: string; op: string } | null) {
  if (!Number.isFinite(bytes) || bytes < 0) return;
  const channel = message?.channel || "";
  const op = message?.op || "";
  let key = ["agent", "control", "llm", "tts", "relay"].includes(channel)
    && /^[a-z][a-z0-9_.-]{0,95}$/.test(op) ? `${channel}/${op}` : "other";
  if (!runnerWsByOperation[key] && Object.keys(runnerWsByOperation).length >= 96) key = "other";
  const counter = runnerWsByOperation[key] ||= { sentBytes: 0, receivedBytes: 0, sentCount: 0, receivedCount: 0 };
  if (direction === "sent") { counter.sentBytes += bytes; counter.sentCount += 1; }
  else { counter.receivedBytes += bytes; counter.receivedCount += 1; }
  addTo(runnerWs, direction === "sent" ? bytes : 0, direction === "received" ? bytes : 0);
}

export function recordHttpNetworkUsage(url: string, sentBytes: number, receivedBytes: number, runnerOrigin?: string) {
  addTo(httpByCategory[categorizeHttpUrl(url, runnerOrigin)], sentBytes, receivedBytes);
}

export function getNetworkUsageSnapshot(): NetworkUsageSnapshot {
  const http = createCounter();
  const byCategory = createHttpCategoryCounters();
  for (const category of HTTP_CATEGORIES) {
    const counter = httpByCategory[category];
    byCategory[category] = { ...counter };
    http.sentBytes += counter.sentBytes;
    http.receivedBytes += counter.receivedBytes;
  }
  return {
    sinceMs,
    http,
    httpByCategory: byCategory,
    runnerWs: { ...runnerWs },
    runnerWsByOperation: Object.fromEntries(Object.entries(runnerWsByOperation).map(([key, value]) => [key, { ...value }])),
    streamTts: { ...streamTts },
    totalSentBytes: http.sentBytes + runnerWs.sentBytes + streamTts.sentBytes,
    totalReceivedBytes: http.receivedBytes + runnerWs.receivedBytes + streamTts.receivedBytes,
  };
}

export function resetNetworkUsage() {
  sinceMs = Date.now();
  httpByCategory = createHttpCategoryCounters();
  runnerWs = createCounter();
  runnerWsByOperation = {};
  streamTts = createCounter();
}
