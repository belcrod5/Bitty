import { RUNNER_AUTHENTICATION } from "./runner-login-http.mjs";
import { prepareBrowserSecretInput, validateBrowserInputTarget } from "./browser-secret-cdp.mjs";

const failure = (code) => Object.assign(new Error(code), { code });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(["completed", "cancelled", "expired", "failed", "input_status_unknown"]);

// Only non-secret request metadata and terminal status survive a submission.
// Secret values never enter agent actions, an event ledger, or persistent storage.
export function createBrowserSecretInputService({ appControl, sendEnvelope, prepare = prepareBrowserSecretInput,
  now = Date.now, timeoutMs = 120_000 } = {}) {
  const entries = new Map();
  function result(entry) { return { requestId: entry.id, status: entry.status, expiresAt: new Date(entry.expires).toISOString() }; }
  function current(entry) {
    const context = appControl.resolveActiveContext(entry.subjectId, entry.context);
    if (context.ws !== entry.ws || JSON.stringify(context.origin) !== JSON.stringify(entry.origin)) throw failure("stale_origin");
    return context;
  }
  function finish(entry, status) {
    if (statuses.has(entry.status)) return;
    entry.status = status;
    entry.finishedAt = now();
    clearTimeout(entry.timer);
    entry.controller.abort();
    entry.browser?.close();
    entry.browser = null;
    try { sendEnvelope(entry.ws, { channel: "control", op: "browser.input.resolved", payload: result(entry) }); } catch {}
  }
  function prune() {
    for (const [id, entry] of entries) if (entry.finishedAt && now() - entry.finishedAt >= 15 * 60_000) entries.delete(id);
  }
  async function request(subjectId, body) {
    prune();
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["requestId", "context", "target"].includes(key))
      || !uuid.test(body.requestId) || typeof body.context !== "string" || !/^ctx_[a-f0-9-]{36}$/.test(body.context)) throw failure("invalid_request");
    const target = validateBrowserInputTarget(body.target);
    const canonical = JSON.stringify({ context: body.context, target });
    const previous = entries.get(body.requestId);
    if (previous) {
      if (previous.subjectId !== subjectId || previous.canonical !== canonical) throw failure("request_conflict");
      return result(previous);
    }
    if (entries.size >= 128 || [...entries.values()].filter((entry) => !statuses.has(entry.status)).length >= 8) throw failure("capacity_exceeded");
    const context = appControl.resolveActiveContext(subjectId, body.context);
    if ([...entries.values()].some((entry) => entry.ws === context.ws && !statuses.has(entry.status))) throw failure("input_busy");
    const entry = { id: body.requestId, subjectId, context: body.context, canonical, ...context,
      status: "preparing", expires: now() + timeoutMs, controller: new AbortController(), browser: null };
    entries.set(entry.id, entry);
    entry.timer = setTimeout(() => finish(entry, entry.status === "filling" ? "input_status_unknown" : "expired"), timeoutMs);
    try {
      entry.browser = await prepare(target, { signal: entry.controller.signal });
      if (entry.controller.signal.aborted) { entry.browser.close(); entry.browser = null; return result(entry); }
      current(entry);
      entry.status = "pending";
      if (sendEnvelope(entry.ws, { channel: "control", op: "browser.input.request", payload: {
        requestId: entry.id, origin: entry.origin, destinationOrigin: target.origin,
        topOrigin: entry.browser.topOrigin || target.origin,
        label: target.label, expiresAt: new Date(entry.expires).toISOString(),
      } }) === false) finish(entry, "failed");
    } catch { finish(entry, "failed"); }
    return result(entry);
  }
  function getResult(subjectId, id) {
    prune();
    const entry = entries.get(id);
    if (!entry || entry.subjectId !== subjectId) return { requestId: id, status: "not_found" };
    if (!statuses.has(entry.status)) {
      try { current(entry); } catch { finish(entry, entry.status === "filling" ? "input_status_unknown" : "cancelled"); }
    }
    return result(entry);
  }
  async function respond(ws, payload, userDevice) {
    const entry = entries.get(payload?.requestId);
    if (!userDevice || !entry || entry.ws !== ws || entry.status !== "pending") return { status: "request_unavailable" };
    try { current(entry); } catch { finish(entry, "cancelled"); return result(entry); }
    if (now() >= entry.expires) { finish(entry, "expired"); return result(entry); }
    if (!payload || Object.keys(payload).some((key) => !["requestId", "value", "cancel"].includes(key))) return { status: "invalid_response" };
    if (payload.cancel === true && payload.value === undefined) { finish(entry, "cancelled"); return result(entry); }
    if (payload.cancel !== undefined || typeof payload.value !== "string" || !payload.value.length || payload.value.length > 4096) return { status: "invalid_response" };
    entry.status = "filling";
    try {
      await entry.browser.fill(payload.value);
      if (!entry.controller.signal.aborted) finish(entry, "completed");
    } catch { finish(entry, "input_status_unknown"); }
    return result(entry);
  }
  function reconcile(ws) {
    for (const entry of entries.values()) {
      if (entry.ws !== ws || statuses.has(entry.status)) continue;
      try { current(entry); } catch { finish(entry, entry.status === "filling" ? "input_status_unknown" : "cancelled"); }
    }
  }
  return {
    request, getResult, reconcile,
    handleMessage(ws, message, userDevice) {
      if (message.channel !== "control" || message.op !== "browser.input.respond") return false;
      void respond(ws, message.payload, userDevice).then((payload) => {
        sendEnvelope(ws, { channel: "control", op: "browser.input.respond.result", requestId: message.requestId || "", payload });
      }).catch(() => {
        sendEnvelope(ws, { channel: "control", op: "browser.input.respond.result", requestId: message.requestId || "", payload: { status: "failed" } });
      });
      return true;
    },
    disconnect(ws) {
      for (const entry of entries.values()) if (entry.ws === ws) finish(entry, entry.status === "filling" ? "input_status_unknown" : "cancelled");
    },
    close() { for (const entry of entries.values()) finish(entry, entry.status === "filling" ? "input_status_unknown" : "cancelled"); entries.clear(); },
  };
}

// Agents may request a form and read status only through the local control socket.
// There is intentionally no HTTP endpoint that accepts the user's secret value.
export function createBrowserSecretInputHttp({ service, json, readJsonBody }) {
  return async (req, res, pathname) => {
    if (!pathname.startsWith("/browser-input/")) return false;
    if (!req[RUNNER_AUTHENTICATION]?.local) { json(res, 403, { status: "local_control_required" }); return true; }
    const subjectId = req[RUNNER_AUTHENTICATION].ownerSubjectId;
    try {
      if (req.method === "POST" && pathname === "/browser-input/requests") {
        json(res, 200, await service.request(subjectId, await readJsonBody(req, 8192)));
      } else if (req.method === "GET" && /^\/browser-input\/requests\/[a-f0-9-]{36}$/.test(pathname)) {
        json(res, 200, service.getResult(subjectId, pathname.split("/").at(-1)));
      } else json(res, 404, { status: "not_found" });
    } catch { json(res, 400, { status: "browser_input_unavailable" }); }
    return true;
  };
}
