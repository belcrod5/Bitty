import { setTimeout as delay } from "node:timers/promises";
import { RUNNER_AUTHENTICATION } from "./runner-login-http.mjs";
import { prepareBrowserControl, validBrowserControlInput, validateBrowserControlTarget } from "./browser-control-cdp.mjs";

const failure = (code) => Object.assign(new Error(code), { code });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminal = new Set(["completed", "cancelled", "expired", "invalidated", "failed", "control_status_unknown"]);

export function createBrowserControlService({ appControl, sendEnvelope, prepare = prepareBrowserControl, isSessionActive = () => true, now = Date.now, log } = {}) {
  const entries = new Map(), devices = new Map();
  const result = (entry) => ({ requestId: entry.id, status: entry.status, ...(entry.inputStatusUnknown ? { inputStatusUnknown: true } : {}) });
  const card = (entry) => ({ ...result(entry), target: entry.conversation, origin: entry.origin, label: entry.target.label, createdAt: entry.createdAt });
  const owns = (entry, auth) => auth?.local === false && auth.ownerSubjectId === entry.subjectId && auth.sessionId === entry.deviceSessionId && isSessionActive(entry.deviceSessionId);
  function diagnose(entry, phase, reason, run = entry.run) {
    try { log?.({ requestId: entry.id, phase, elapsedMs: Math.max(0, now() - (run?.startedAt ?? now())), ...(reason ? { reason } : {}),
      ...(terminal.has(phase) || phase === "interrupted" ? { framesSent: run?.framesSent || 0, renderAckCommands: run?.renderAckCommands || 0 } : {}) }); } catch {}
  }
  function detach(entry, uncertain = false) {
    const run = entry.run; entry.run = null;
    if (uncertain && run?.sequence) entry.inputStatusUnknown = true;
    run?.controller.abort(); run?.browser?.close();
    if (!terminal.has(entry.status)) entry.status = "pending";
    if (run && entry.status === "pending") { try { sendEnvelope(run.ws, { channel: "control", op: "browser.control.resolved", payload: { ...result(entry), controlId: run.id } }); } catch {} }
    return run;
  }
  function finish(entry, status, reason) {
    if (terminal.has(entry.status)) return;
    const run = entry.run;
    entry.status = status; entry.finishedAt = now(); diagnose(entry, status, reason, run); detach(entry);
    try { if (run) sendEnvelope(run.ws, { channel: "control", op: "browser.control.resolved", payload: { ...result(entry), controlId: run.id } }); } catch {}
  }
  function send(entry, run, op, payload) {
    if (entry.run !== run) return false;
    if (!isSessionActive(entry.deviceSessionId)) { finish(entry, "expired"); return false; }
    if (!appControl.browserConnectionReady(run.ws, entry)) { detach(entry, true); return false; }
    try {
      if ((run.ws.bufferedAmount || 0) > 2 * 1024 * 1024 || sendEnvelope(run.ws, { channel: "control", op, payload: { requestId: entry.id, controlId: run.id, ...payload } }) === false) {
        detach(entry, true); return false;
      }
      return true;
    } catch { detach(entry, true); return false; }
  }
  function prune() {
    for (const [id, entry] of entries) {
      if (!terminal.has(entry.status) && (!isSessionActive(entry.deviceSessionId) || !entry.run && now() - Date.parse(entry.createdAt) >= 24 * 60 * 60_000)) finish(entry, "expired");
      if (entry.finishedAt && now() - entry.finishedAt >= 15 * 60_000) entries.delete(id);
    }
  }
  async function request(subjectId, body) {
    prune();
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["requestId", "context", "target"].includes(key))
      || !uuid.test(body.requestId) || typeof body.context !== "string" || !/^ctx_[a-f0-9-]{36}$/.test(body.context)) throw failure("invalid_request");
    const target = validateBrowserControlTarget(body.target);
    const pageUrl = new URL(target.cdpUrl), page = `${pageUrl.port}${pageUrl.pathname}`;
    const canonical = JSON.stringify({ context: body.context, target });
    const previous = entries.get(body.requestId);
    if (previous) {
      if (previous.subjectId !== subjectId || previous.canonical !== canonical) throw failure("request_conflict");
      return result(previous);
    }
    if (entries.size >= 128 || [...entries.values()].filter((entry) => !terminal.has(entry.status)).length >= 8
      || [...entries.values()].some((entry) => !terminal.has(entry.status) && entry.page === page)) throw failure("capacity_exceeded");
    const context = appControl.resolveBrowserContext(subjectId, body.context), conversation = context.origin.target;
    if (conversation.kind === "session" && !conversation.sessionRef.nativeSessionId) throw failure("session_unresolved");
    const entry = { id: body.requestId, subjectId, deviceSessionId: context.deviceSessionId, canonical, page, conversation, target,
      origin: target.origin, status: "pending", createdAt: new Date(now()).toISOString(), run: null, inputStatusUnknown: false };
    entries.set(entry.id, entry); diagnose(entry, "prepared");
    // Card metadata is independent of a live browser or socket. A reconnect sync recovers missed delivery.
    const sockets = new Set([context.ws, ...[...devices].filter(([, auth]) => owns(entry, auth)).map(([ws]) => ws)]);
    for (const ws of sockets) { try { sendEnvelope(ws, { channel: "control", op: "browser.control.request", payload: card(entry) }); } catch {} }
    return result(entry);
  }
  function getResult(subjectId, id) {
    prune(); const entry = entries.get(id);
    return !entry || entry.subjectId !== subjectId ? { requestId: id, status: "not_found" } : result(entry);
  }
  async function start(entry, ws, controlId) {
    if (entry.run?.ws === ws && entry.run.id === controlId) return result(entry);
    // Explicit Open on the original device supersedes a stale Wi-Fi socket, never its queued input.
    if (entry.run) detach(entry, true);
    const run = { id: controlId, ws, controller: new AbortController(), browser: null, queue: Promise.resolve(), queued: 0,
      sequence: 0, framesSent: 0, renderAckCommands: 0, startedAt: now() };
    entry.run = run; entry.status = "starting"; diagnose(entry, "start");
    try {
      // A freshly reconnected socket may still be publishing its mounted chat snapshot.
      // Only this idempotent open waits; no input is retried or transferred between connections.
      const deadline = Date.now() + 5000;
      while (!appControl.browserConnectionReady(ws, entry)) {
        if (Date.now() >= deadline) { detach(entry); return result(entry); }
        await delay(25, undefined, { signal: run.controller.signal });
      }
      if (entry.run !== run) return result(entry);
      run.browser = await prepare({ ...entry.target, origin: entry.origin }, { signal: run.controller.signal,
        onInvalidated: (reason) => { if (entry.run === run) {
          diagnose(entry, "interrupted", ["connection_closed", "command_timeout", "frame_timeout", "render_ack_timeout"].includes(reason) ? reason : "connection_closed");
          detach(entry, true);
        } },
        onDiagnostic: (phase) => { if (entry.run === run && ["focus_enabled", "stream_started", "cdp_frame_received"].includes(phase)) diagnose(entry, phase); },
        onFrame: (frame) => { if (send(entry, run, "browser.control.frame", frame)) {
          run.framesSent++; if (!run.firstFrameSent) { run.firstFrameSent = true; diagnose(entry, "frame_sent"); }
        } },
        onViewInvalidated: () => send(entry, run, "browser.control.view_invalidated", {}),
        onFocus: (focus) => send(entry, run, "browser.control.focus", focus),
        onOrigin: (origin) => { if (entry.run === run) { entry.origin = origin; send(entry, run, "browser.control.origin", { origin }); } },
      });
      if (entry.run !== run) { run.browser.close(); return result(entry); }
      await run.browser.start();
      if (entry.run === run) entry.status = "active";
    } catch { if (entry.run === run) finish(entry, "failed"); }
    return result(entry);
  }
  function command(ws, payload, auth) {
    prune();
    const entry = entries.get(payload?.requestId);
    if (!entry || !owns(entry, auth) || terminal.has(entry.status)) return Promise.resolve({ status: "request_unavailable" });
    const keys = Object.keys(payload).sort().join(","), action = payload.action;
    if (action === "cancel" && keys === "action,requestId") { finish(entry, "cancelled"); return Promise.resolve(result(entry)); }
    if (!uuid.test(payload.controlId)) return Promise.resolve({ status: "invalid_command" });
    if (action === "start" && keys === "action,controlId,requestId") return start(entry, ws, payload.controlId);
    const run = entry.run;
    if (!run || run.ws !== ws || run.id !== payload.controlId) return Promise.resolve({ status: "request_unavailable" });
    if (action === "pause" && keys === "action,controlId,requestId") { detach(entry, run.queued > 0); return Promise.resolve(result(entry)); }
    if (!appControl.browserConnectionReady(ws, entry)) { detach(entry, true); return Promise.resolve(result(entry)); }
    if (action === "ack") {
      if (keys !== "action,controlId,frameId,requestId" || !Number.isSafeInteger(payload.frameId) || payload.frameId < 1) return Promise.resolve({ status: "invalid_command" });
      run.renderAckCommands++;
      if (run.firstFrameSent && !run.firstAck) { run.firstAck = true; diagnose(entry, "render_ack_received"); }
      void run.browser?.ack(payload.frameId).catch(() => { if (entry.run === run) finish(entry, "control_status_unknown"); });
      return Promise.resolve(result(entry));
    }
    if (action === "input") {
      if (keys !== "action,controlId,frameId,input,requestId,sequence" || !Number.isSafeInteger(payload.frameId) || payload.frameId < 1 || !validBrowserControlInput(payload.input)
        || !Number.isSafeInteger(payload.sequence) || payload.sequence !== run.sequence + 1) return Promise.resolve({ status: "invalid_command" });
    } else if (action !== "finish" || keys !== "action,controlId,requestId") return Promise.resolve({ status: "invalid_command" });
    if (run.queued >= 32) { detach(entry, true); return Promise.resolve(result(entry)); }
    if (action === "input") run.sequence = payload.sequence;
    run.queued++;
    const work = run.queue.then(async () => {
      if (entry.run !== run) return result(entry);
      try {
        if (action === "finish") finish(entry, "completed");
        else if (entry.status === "active") await run.browser.input(payload.input, payload.frameId);
        else return result(entry);
      } catch (error) {
        if (entry.run !== run) return result(entry);
        if (["stale_frame", "stale_focus"].includes(error?.code) && action === "input") return { ...result(entry), inputStatus: "not_applied" };
        finish(entry, "control_status_unknown");
      }
      return result(entry);
    }).finally(() => { run.queued--; });
    run.queue = work.catch(() => {}); return work;
  }
  return { request, getResult,
    handleMessage(ws, message, auth) {
      if (message.channel !== "control" || !["browser.control.command", "browser.control.sync"].includes(message.op)) return false;
      if (message.op === "browser.control.sync") {
        prune();
        const valid = auth?.local === false && typeof auth.sessionId === "string" && typeof auth.ownerSubjectId === "string";
        if (valid) devices.set(ws, auth);
        sendEnvelope(ws, { channel: "control", op: "browser.control.sync.result", requestId: message.requestId || "",
          payload: { requests: valid ? [...entries.values()].filter((entry) => owns(entry, auth)).map(card) : [] } });
      } else void command(ws, message.payload, auth).then((payload) => {
        if (message.requestId) sendEnvelope(ws, { channel: "control", op: "browser.control.command.result", requestId: message.requestId, payload });
      }).catch(() => {});
      return true;
    },
    disconnect(ws) { devices.delete(ws); for (const entry of entries.values()) if (entry.run?.ws === ws) detach(entry, true); },
    refreshConnection(ws) { for (const entry of entries.values()) if (entry.run?.ws === ws && !appControl.browserConnectionReady(ws, entry)) detach(entry, true); },
    close() { for (const entry of entries.values()) finish(entry, "cancelled"); entries.clear(); devices.clear(); },
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
