// アプリの外部通信 3経路(HTTP fetch / runner WS / stream-tts WS)の送受信バイト数を
// 起動からの累計で集計するシングルトンストア。計測点はホットパス(WS受信など)にあるため、
// 記録はカウンタ加算のみで通知や逐次ログは行わない。UIは必要時に getNetworkUsageSnapshot()
// を読み出す(ポーリング)。
export type NetworkUsageRoute = "runner-ws" | "stream-tts";

export type NetworkUsageHttpCategory =
  | "session-messages"
  | "session-summaries"
  | "tts-media"
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

export function categorizeHttpUrl(url: string): NetworkUsageHttpCategory {
  const value = String(url || "");
  if (value.includes("/session-messages")) return "session-messages";
  if (value.includes("/session-summaries")) return "session-summaries";
  if (value.includes("/tts-media/")) return "tts-media";
  return "other";
}

function addTo(counter: NetworkUsageCounter, sentBytes: number, receivedBytes: number) {
  if (Number.isFinite(sentBytes) && sentBytes > 0) counter.sentBytes += sentBytes;
  if (Number.isFinite(receivedBytes) && receivedBytes > 0) counter.receivedBytes += receivedBytes;
}

export function recordNetworkUsage(route: NetworkUsageRoute, sentBytes: number, receivedBytes: number) {
  addTo(route === "runner-ws" ? runnerWs : streamTts, sentBytes, receivedBytes);
}

export function recordHttpNetworkUsage(url: string, sentBytes: number, receivedBytes: number) {
  addTo(httpByCategory[categorizeHttpUrl(url)], sentBytes, receivedBytes);
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
