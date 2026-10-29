// アプリの外部通信 3経路(HTTP fetch / runner WS / stream-tts WS)の送受信バイト数を
// 起動からの累計で集計するシングルトンストア。計測点はホットパス(WS受信など)にあるため、
// 記録はカウンタ加算のみで通知や逐次ログは行わない。UIは必要時に getNetworkUsageSnapshot()
// を読み出す(ポーリング)。
export type NetworkUsageRoute = "runner-ws" | "stream-tts";

export type NetworkUsageHttpCategory =
  | "session-messages"
  | "session-summaries"
  | "tts-media"
  | "client-state"
  | "agent-history"
  | "skia-board"
  | "git"
  | "client-logs"
  | "other-origin"
  | "other";

export type NetworkUsageCounter = {
  sentBytes: number;
  receivedBytes: number;
};

export type NetworkUsageSnapshot = {
  sinceMs: number;
  http: NetworkUsageCounter;
  httpByCategory: Record<NetworkUsageHttpCategory, NetworkUsageCounter>;
  runnerWs: NetworkUsageCounter;
  streamTts: NetworkUsageCounter;
  totalSentBytes: number;
  totalReceivedBytes: number;
};

const HTTP_CATEGORIES: NetworkUsageHttpCategory[] = [
  "session-messages",
  "session-summaries",
  "tts-media",
  "client-state",
  "agent-history",
  "skia-board",
  "git",
  "client-logs",
  "other-origin",
  "other",
];

function createCounter(): NetworkUsageCounter {
  return { sentBytes: 0, receivedBytes: 0 };
}

function createHttpCategoryCounters(): Record<NetworkUsageHttpCategory, NetworkUsageCounter> {
  return {
    "session-messages": createCounter(),
    "session-summaries": createCounter(),
    "tts-media": createCounter(),
    "client-state": createCounter(),
    "agent-history": createCounter(),
    "skia-board": createCounter(),
    git: createCounter(),
    "client-logs": createCounter(),
    "other-origin": createCounter(),
    other: createCounter(),
  };
}

let sinceMs = Date.now();
let httpByCategory = createHttpCategoryCounters();
let runnerWs = createCounter();
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
  return "other";
}

function addTo(counter: NetworkUsageCounter, sentBytes: number, receivedBytes: number) {
  if (Number.isFinite(sentBytes) && sentBytes > 0) counter.sentBytes += sentBytes;
  if (Number.isFinite(receivedBytes) && receivedBytes > 0) counter.receivedBytes += receivedBytes;
}

export function recordNetworkUsage(route: NetworkUsageRoute, sentBytes: number, receivedBytes: number) {
  addTo(route === "runner-ws" ? runnerWs : streamTts, sentBytes, receivedBytes);
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
    streamTts: { ...streamTts },
    totalSentBytes: http.sentBytes + runnerWs.sentBytes + streamTts.sentBytes,
    totalReceivedBytes: http.receivedBytes + runnerWs.receivedBytes + streamTts.receivedBytes,
  };
}

export function resetNetworkUsage() {
  sinceMs = Date.now();
  httpByCategory = createHttpCategoryCounters();
  runnerWs = createCounter();
  streamTts = createCounter();
}
