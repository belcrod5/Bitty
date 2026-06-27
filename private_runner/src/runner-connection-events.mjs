const MAX_HISTORY_EVENTS = 200;
const MAX_ACTIVE_CONNECTIONS = 50;
const EVENT_COALESCE_MS = 5 * 60 * 1000;

let nextSeq = 0;
const attentionEvents = [];
const allowedEvents = [];
const activeConnections = new Map();
const latestRejectionByGroupKey = new Map();
const latestAllowedByGroupKey = new Map();
let lastAllowedEvent = null;

function clampLimit(value, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function clampSeq(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function truncate(value, max = 160) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 15))}...(truncated)`;
}

function headerValue(req, name) {
  const raw = req?.headers?.[String(name).toLowerCase()];
  if (Array.isArray(raw)) return truncate(raw.join(", "));
  return truncate(raw || "");
}

function maskIp(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const parts = text.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (text.includes(":")) {
    return `${text.split(":").slice(0, 3).join(":")}::`;
  }
  return "";
}

function connectionMeta(req, opts = {}) {
  return {
    connectionId: truncate(opts.connectionId || "", 80),
    route: truncate(opts.route || "", 80),
    endpoint: truncate(opts.endpoint || "", 120),
    remoteAddress: maskIp(req?.socket?.remoteAddress || ""),
    cfConnectingIpHint: maskIp(headerValue(req, "cf-connecting-ip")),
    cfRay: truncate(headerValue(req, "cf-ray"), 80),
    cfIpCountry: truncate(headerValue(req, "cf-ipcountry"), 16),
    userAgent: truncate(headerValue(req, "user-agent"), 180),
    tokenSource: truncate(opts.tokenSource || "", 32),
    hasAuthHeaderToken: Boolean(opts.hasAuthHeaderToken),
    hasQueryToken: Boolean(opts.hasQueryToken),
    reason: truncate(opts.reason || "", 120),
    closeCode: typeof opts.closeCode === "number" ? opts.closeCode : null,
  };
}

function rejectionGroupKey(meta) {
  if (meta.type !== "connection_rejected") return "";
  return [
    meta.type,
    meta.route,
    meta.endpoint,
    meta.reason,
    meta.cfConnectingIpHint || meta.remoteAddress,
    meta.cfIpCountry,
    meta.tokenSource,
    meta.hasAuthHeaderToken ? "auth" : "no-auth",
    meta.hasQueryToken ? "query" : "no-query",
    meta.userAgent,
  ].map((value) => String(value || "")).join("|");
}

function allowedGroupKey(meta) {
  if (meta.type !== "connection_opened") return "";
  return [
    meta.type,
    meta.route,
    meta.endpoint,
    meta.cfConnectingIpHint || meta.remoteAddress,
    meta.cfIpCountry,
    meta.userAgent,
  ].map((value) => String(value || "")).join("|");
}

function createEvent(type, req, opts = {}) {
  const at = new Date().toISOString();
  return {
    seq: ++nextSeq,
    at,
    type: truncate(type || "unknown", 80),
    ...connectionMeta(req, opts),
  };
}

function trimHistory(history, latestByGroupKey) {
  if (history.length <= MAX_HISTORY_EVENTS) return;
  const removed = history.splice(0, history.length - MAX_HISTORY_EVENTS);
  for (const item of removed) {
    if (latestByGroupKey.get(item.groupKey) === item) {
      latestByGroupKey.delete(item.groupKey);
    }
  }
}

function recordGroupedHistory(history, latestByGroupKey, event, groupKey) {
  const previous = latestByGroupKey.get(groupKey);
  const previousAtMs = Date.parse(previous?.at || "");
  if (previous && Number.isFinite(previousAtMs) && Date.now() - previousAtMs <= EVENT_COALESCE_MS) {
    const firstAt = previous.firstAt || previous.at;
    const repeatCount = Math.max(2, Number(previous.repeatCount || 1) + 1);
    Object.assign(previous, event, { groupKey, firstAt, lastAt: event.at, repeatCount });
    return previous;
  }

  const summary = {
    ...event,
    groupKey,
    firstAt: event.at,
    lastAt: event.at,
    repeatCount: 1,
  };
  history.push(summary);
  latestByGroupKey.set(groupKey, summary);
  trimHistory(history, latestByGroupKey);
  return summary;
}

export function recordRunnerConnectionOpened(req, opts = {}) {
  const event = createEvent("connection_opened", req, opts);
  lastAllowedEvent = event;
  recordGroupedHistory(allowedEvents, latestAllowedByGroupKey, event, allowedGroupKey(event));
  if (event.connectionId) {
    activeConnections.set(event.connectionId, event);
    if (activeConnections.size > MAX_ACTIVE_CONNECTIONS) {
      const oldest = activeConnections.keys().next().value;
      if (oldest) activeConnections.delete(oldest);
    }
  }
  return event;
}

export function recordRunnerConnectionRejected(req, opts = {}) {
  const event = createEvent("connection_rejected", req, opts);
  return recordGroupedHistory(
    attentionEvents,
    latestRejectionByGroupKey,
    event,
    rejectionGroupKey(event)
  );
}

export function recordRunnerConnectionClosed(req, opts = {}) {
  const event = createEvent("connection_closed", req, opts);
  if (event.connectionId) {
    activeConnections.delete(event.connectionId);
  }
  return event;
}

export function recordRunnerConnectionError(req, opts = {}) {
  const event = createEvent("connection_error", req, opts);
  attentionEvents.push(event);
  trimHistory(attentionEvents, latestRejectionByGroupKey);
  if (event.connectionId) {
    activeConnections.delete(event.connectionId);
  }
  return event;
}

export function listRunnerConnectionEvents({ sinceSeq = 0, limit = 50 } = {}) {
  const minSeq = clampSeq(sinceSeq);
  const maxEvents = clampLimit(limit);
  const visible = attentionEvents
    .filter((event) => event.seq > minSeq)
    .sort((a, b) => a.seq - b.seq)
    .slice(-maxEvents);
  const visibleAllowed = allowedEvents
    .filter((event) => event.seq > minSeq)
    .sort((a, b) => a.seq - b.seq)
    .slice(-maxEvents);
  return {
    events: visible,
    allowedEvents: visibleAllowed,
    latestSeq: Math.max(nextSeq, minSeq),
    latestAllowedEvent: lastAllowedEvent,
    activeConnections: Array.from(activeConnections.values()).slice(-MAX_ACTIVE_CONNECTIONS),
    activeCount: activeConnections.size,
    fetchedAt: new Date().toISOString(),
  };
}
