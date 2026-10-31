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

// An idle observation measures a time prefix, not completion of every startup
// task. Responses arriving after interruption belong only to the cumulative
// counters, even when their requests were sent during the observation.
export const NETWORK_USAGE_IDLE_OBSERVATION_MS = 60_000;
export type NetworkUsageIdleEndReason = "observation_elapsed" | "user_input" | "voice_input"
  | "external_action" | "send_action" | "app_not_active" | "counter_reset";
export type NetworkUsageIdleObservation = {
  kind: "startup_idle" | "foreground_idle";
  startedAtMs: number;
  endedAtMs: number;
  elapsedMs: number;
  requestedDurationMs: number;
  endReason: NetworkUsageIdleEndReason;
  // Eligible for comparing uninterrupted idle observation intervals, not proof
  // that initialization finished or that every possible native input was seen.
  comparisonEligible: boolean;
  appStateVerified: boolean;
  measurementScope: "bytes_recorded_during_idle_prefix";
  startupCompletionInferred: false;
  usage: NetworkUsageSnapshot;
};
let observedAppState: string | null = null;
let pendingForegroundInterruption: NetworkUsageIdleEndReason | null = null;
let idleObservation: { kind: NetworkUsageIdleObservation["kind"]; startedAtMs: number; baseline: NetworkUsageSnapshot; appStateVerified: boolean | null } | null = {
  kind: "startup_idle", startedAtMs: sinceMs, baseline: getNetworkUsageSnapshot(), appStateVerified: null,
};
let idleObservationListener: ((observation: NetworkUsageIdleObservation, atBoundary: boolean) => void) | null = null;
let unreportedIdleObservation: NetworkUsageIdleObservation | null = null;

function subtractCounter(value: NetworkUsageCounter, baseline: NetworkUsageCounter): NetworkUsageCounter {
  return { sentBytes: value.sentBytes - baseline.sentBytes, receivedBytes: value.receivedBytes - baseline.receivedBytes };
}

export function endNetworkUsageIdleObservation(endReason: NetworkUsageIdleEndReason) {
  if (observedAppState !== "active" && ["user_input", "voice_input", "external_action", "send_action"].includes(endReason)) {
    pendingForegroundInterruption = endReason;
  }
  if (!idleObservation) return;
  const { kind, startedAtMs, baseline, appStateVerified } = idleObservation;
  const endedAtMs = Date.now();
  const elapsedMs = Math.max(0, endedAtMs - startedAtMs);
  const snapshot = getNetworkUsageSnapshot();
  idleObservation = null;
  const observation: NetworkUsageIdleObservation = {
    kind, startedAtMs, endedAtMs, elapsedMs, requestedDurationMs: NETWORK_USAGE_IDLE_OBSERVATION_MS, endReason,
    comparisonEligible: endReason === "observation_elapsed" && elapsedMs >= NETWORK_USAGE_IDLE_OBSERVATION_MS && observedAppState === "active" && appStateVerified === true,
    appStateVerified: appStateVerified === true,
    measurementScope: "bytes_recorded_during_idle_prefix", startupCompletionInferred: false,
    usage: {
      sinceMs: startedAtMs,
      http: subtractCounter(snapshot.http, baseline.http),
      httpByCategory: Object.fromEntries(HTTP_CATEGORIES.map((category) =>
        [category, subtractCounter(snapshot.httpByCategory[category], baseline.httpByCategory[category])])) as NetworkUsageSnapshot["httpByCategory"],
      runnerWs: subtractCounter(snapshot.runnerWs, baseline.runnerWs),
      runnerWsByOperation: Object.fromEntries(Object.entries(snapshot.runnerWsByOperation).map(([key, counter]) => {
        const previous = baseline.runnerWsByOperation[key] || { sentBytes: 0, receivedBytes: 0, sentCount: 0, receivedCount: 0 };
        return [key, { ...subtractCounter(counter, previous), sentCount: counter.sentCount - previous.sentCount, receivedCount: counter.receivedCount - previous.receivedCount }] as const;
      }).filter(([, counter]) => counter.sentCount || counter.receivedCount)),
      streamTts: subtractCounter(snapshot.streamTts, baseline.streamTts),
      totalSentBytes: snapshot.totalSentBytes - baseline.totalSentBytes,
      totalReceivedBytes: snapshot.totalReceivedBytes - baseline.totalReceivedBytes,
    },
  };
  if (idleObservationListener) {
    try { idleObservationListener(observation, true); } catch { /* diagnostics cannot interrupt input */ }
  } else {
    // Before the logging hook mounts only the startup observation can finish.
    unreportedIdleObservation = observation;
  }
}

export function subscribeNetworkUsageIdleObservations(listener: NonNullable<typeof idleObservationListener>) {
  idleObservationListener = listener;
  if (unreportedIdleObservation) {
    const observation = unreportedIdleObservation;
    unreportedIdleObservation = null;
    listener(observation, false);
  }
  return () => { if (idleObservationListener === listener) idleObservationListener = null; };
}

export function updateNetworkUsageObservationAppState(state: string | null) {
  // RN can initially report null/unknown. Keep that startup prefix, but do not
  // certify it as an uninterrupted foreground observation afterwards.
  if (!["active", "inactive", "background"].includes(state || "")) {
    if (idleObservation) idleObservation.appStateVerified = false;
    return;
  }
  const previous = observedAppState;
  observedAppState = state;
  if (idleObservation?.appStateVerified === null) idleObservation.appStateVerified = true;
  if (state !== "active") endNetworkUsageIdleObservation("app_not_active");
  else {
    if (previous !== null && previous !== "active") {
      idleObservation = { kind: "foreground_idle", startedAtMs: Date.now(), baseline: getNetworkUsageSnapshot(), appStateVerified: true };
    }
    if (pendingForegroundInterruption) {
      const reason = pendingForegroundInterruption;
      pendingForegroundInterruption = null;
      endNetworkUsageIdleObservation(reason);
    }
  }
}

export function getNetworkUsageIdleObservationDeadline() {
  return idleObservation ? idleObservation.startedAtMs + NETWORK_USAGE_IDLE_OBSERVATION_MS : null;
}

export function completeNetworkUsageIdleObservation() {
  const deadline = getNetworkUsageIdleObservationDeadline();
  if (deadline !== null && Date.now() >= deadline) endNetworkUsageIdleObservation("observation_elapsed");
}

export function captureNetworkUsageInteraction() {
  endNetworkUsageIdleObservation("user_input");
  return false; // Observe responder capture without claiming the gesture.
}

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
  endNetworkUsageIdleObservation("counter_reset");
  sinceMs = Date.now();
  httpByCategory = createHttpCategoryCounters();
  runnerWs = createCounter();
  runnerWsByOperation = {};
  streamTts = createCounter();
}
