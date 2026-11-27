import { RUNNER_AUTHENTICATION } from "./runner-login-http.mjs";
import { prepareBrowserControl, validBrowserControlInput, validateBrowserControlTarget } from "./browser-control-cdp.mjs";

const failure = (code) => Object.assign(new Error(code), { code });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminal = new Set(["completed", "cancelled", "expired", "invalidated", "failed", "control_status_unknown"]);

export function createBrowserControlService({ appControl, sendEnvelope, prepare = prepareBrowserControl, now = Date.now, log } = {}) {
  const entries = new Map();
  const result = (entry) => ({ requestId: entry.id, status: entry.status });
  function diagnose(entry, phase, reason) {
    try { log?.({ requestId: entry.id, phase, elapsedMs: Math.max(0, now() - (entry.startedAt ?? now())), ...(reason ? { reason } : {}),
      ...(terminal.has(phase) ? { framesSent: entry.framesSent, renderAckCommands: entry.renderAckCommands } : {}) }); } catch {}
  }
  function send(entry, op, payload) {
    try {
      if ((entry.ws.bufferedAmount || 0) > 2 * 1024 * 1024 || sendEnvelope(entry.ws, { channel: "control", op, payload }) === false) {
        finish(entry, "expired"); return false;
      }
      return true;
    } catch { finish(entry, "expired"); return false; }
  }
  function finish(entry, status, reason) {
    if (terminal.has(entry.status)) return;
    entry.status = status; entry.finishedAt = now();
    diagnose(entry, status, reason);
    entry.controller.abort(); entry.browser?.close(); entry.browser = null;
    try { sendEnvelope(entry.ws, { channel: "control", op: "browser.control.resolved", payload: result(entry) }); } catch {}
  }
  function prune() {
    for (const [id, entry] of entries) if (entry.finishedAt && now() - entry.finishedAt >= 15 * 60_000) entries.delete(id);
  }
  async function request(subjectId, body) {
    prune();
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["requestId", "context", "target"].includes(key))
      || !uuid.test(body.requestId) || typeof body.context !== "string" || !/^ctx_[a-f0-9-]{36}$/.test(body.context)) throw failure("invalid_request");
    const target = validateBrowserControlTarget(body.target);
    const pageUrl = new URL(target.cdpUrl);
    const page = `${pageUrl.port}${pageUrl.pathname}`;
    const canonical = JSON.stringify({ context: body.context, target });
    const previous = entries.get(body.requestId);
    if (previous) {
      if (previous.subjectId !== subjectId || previous.canonical !== canonical) throw failure("request_conflict");
      return result(previous);
    }
    if (entries.size >= 128 || [...entries.values()].filter((entry) => !terminal.has(entry.status)).length >= 8
      || [...entries.values()].some((entry) => !terminal.has(entry.status) && entry.page === page)) throw failure("capacity_exceeded");
    const context = appControl.resolveActiveContext(subjectId, body.context);
    const conversation = context.origin.target;
    if (conversation.kind === "session" && !conversation.sessionRef.nativeSessionId) throw failure("session_unresolved");
    const entry = { id: body.requestId, subjectId, canonical, page, ws: context.ws, conversation,
      status: "preparing", createdAt: new Date(now()).toISOString(), controller: new AbortController(), browser: null,
      queue: Promise.resolve(), queued: 0, sequence: 0, framesSent: 0, renderAckCommands: 0 };
    entries.set(entry.id, entry);
    try {
      entry.browser = await prepare(target, { signal: entry.controller.signal,
        onInvalidated: (reason) => finish(entry, reason === "frame_timeout" && entry.sequence === 0 ? "failed" : entry.status === "active" || entry.status === "starting" ? "control_status_unknown" : "invalidated",
          ["connection_closed", "command_timeout", "frame_timeout", "render_ack_timeout"].includes(reason) ? reason : "connection_closed"),
        onDiagnostic: (phase) => { if (["focus_enabled", "stream_started", "cdp_frame_received"].includes(phase)) diagnose(entry, phase); },
        onFrame: (frame) => { if (entry.status === "active" || entry.status === "starting") {
          if (send(entry, "browser.control.frame", { requestId: entry.id, ...frame })) {
            entry.framesSent++;
            if (!entry.firstFrameSent) { entry.firstFrameSent = true; diagnose(entry, "frame_sent"); }
          }
        } },
        onViewInvalidated: () => { if (entry.status === "active" || entry.status === "starting") send(entry, "browser.control.view_invalidated", { requestId: entry.id }); },
        onOrigin: (origin) => { if (entry.status === "active" || entry.status === "starting") send(entry, "browser.control.origin", { requestId: entry.id, origin }); },
      });
      if (entry.controller.signal.aborted) { entry.browser.close(); entry.browser = null; return result(entry); }
      entry.status = "pending";
      diagnose(entry, "prepared");
      send(entry, "browser.control.request", { ...result(entry), target: entry.conversation, origin: target.origin,
        label: target.label, createdAt: entry.createdAt });
    } catch { finish(entry, "failed"); }
    return result(entry);
  }
  function getResult(subjectId, id) {
    prune(); const entry = entries.get(id);
    return !entry || entry.subjectId !== subjectId ? { requestId: id, status: "not_found" } : result(entry);
  }
  function command(ws, payload, userDevice) {
    const entry = entries.get(payload?.requestId);
    if (!userDevice || !entry || entry.ws !== ws || terminal.has(entry.status)) return Promise.resolve({ status: "request_unavailable" });
    const keys = Object.keys(payload).sort().join(",");
    const action = payload.action;
    if (action === "ack") {
      if (keys !== "action,frameId,requestId" || !Number.isSafeInteger(payload.frameId) || payload.frameId < 1) return Promise.resolve({ status: "invalid_command" });
      if (entry.status === "active" || entry.status === "starting") {
        entry.renderAckCommands++;
        if (entry.firstFrameSent && !entry.firstAck) { entry.firstAck = true; diagnose(entry, "render_ack_received"); }
        void entry.browser?.ack(payload.frameId).catch(() => finish(entry, "control_status_unknown"));
      }
      return Promise.resolve(result(entry));
    }
    if (action === "input") {
      if (keys !== "action,frameId,input,requestId,sequence" || !Number.isSafeInteger(payload.frameId) || payload.frameId < 1 || !validBrowserControlInput(payload.input)
        || !Number.isSafeInteger(payload.sequence) || payload.sequence !== entry.sequence + 1) return Promise.resolve({ status: "invalid_command" });
    } else if (!["start", "pause", "finish", "cancel"].includes(action) || keys !== "action,requestId") return Promise.resolve({ status: "invalid_command" });
    if (action === "cancel") { finish(entry, "cancelled"); return Promise.resolve(result(entry)); }
    if (action === "pause") {
      if (entry.status !== "active" && entry.status !== "starting") return Promise.resolve(result(entry));
      entry.status = "pending";
      const pause = entry.browser.pause().catch(() => finish(entry, "control_status_unknown"));
      entry.queue = entry.queue.then(() => pause);
      return pause.then(() => result(entry));
    }
    if (entry.queued >= 32) { finish(entry, "control_status_unknown"); return Promise.resolve(result(entry)); }
    if (action === "input") entry.sequence = payload.sequence;
    entry.queued++;
    const work = entry.queue.then(async () => {
      if (terminal.has(entry.status)) return result(entry);
      try {
        if (action === "finish") { finish(entry, "completed"); }
        else if (action === "start" && entry.status === "pending") {
          entry.startedAt = now(); entry.firstFrameSent = false; entry.firstAck = false; diagnose(entry, "start");
          entry.status = "starting"; await entry.browser.start();
          if (!entry.controller.signal.aborted && entry.status === "starting") entry.status = "active";
        } else if (action === "input" && entry.status === "active") await entry.browser.input(payload.input, payload.frameId);
        else return result(entry);
      } catch (error) {
        if (error?.code === "stale_frame" && action === "input") return { ...result(entry), inputStatus: "not_applied" };
        finish(entry, "control_status_unknown");
      }
      return result(entry);
    }).finally(() => { entry.queued--; });
    entry.queue = work.catch(() => {});
    return work;
  }
  return { request, getResult,
    handleMessage(ws, message, userDevice) {
      if (message.channel !== "control" || message.op !== "browser.control.command") return false;
      void command(ws, message.payload, userDevice).then((payload) => {
        // ACKs and commands return status only, never frames, text, or a browser error.
        if (message.requestId) sendEnvelope(ws, { channel: "control", op: "browser.control.command.result", requestId: message.requestId, payload });
      }).catch(() => {});
      return true;
    },
    disconnect(ws) { for (const entry of entries.values()) if (entry.ws === ws) finish(entry, entry.status === "active" || entry.status === "starting" ? "control_status_unknown" : "expired"); },
    close() { for (const entry of entries.values()) finish(entry, "cancelled"); entries.clear(); },
  };
}

// The local agent can request takeover and read its fixed status. User actions/images have no HTTP endpoint.
export function createBrowserControlHttp({ service, json, readJsonBody }) {
  return async (req, res, pathname) => {
    if (!pathname.startsWith("/browser-control/")) return false;
    if (!req[RUNNER_AUTHENTICATION]?.local) { json(res, 403, { status: "local_control_required" }); return true; }
    const subjectId = req[RUNNER_AUTHENTICATION].ownerSubjectId;
    try {
      if (req.method === "POST" && pathname === "/browser-control/requests") json(res, 200, await service.request(subjectId, await readJsonBody(req, 8192)));
      else if (req.method === "GET" && /^\/browser-control\/requests\/[a-f0-9-]{36}$/.test(pathname)) json(res, 200, service.getResult(subjectId, pathname.split("/").at(-1)));
      else json(res, 404, { status: "not_found" });
    } catch { json(res, 400, { status: "browser_control_unavailable" }); }
    return true;
  };
}
