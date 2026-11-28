import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const fail = (code = "browser_extension_unavailable") => Object.assign(new Error(code), { code });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const targetId = /^[A-Za-z0-9_-]{1,200}$/;
const methods = new Set(["Page.enable", "Page.getFrameTree", "Page.getLayoutMetrics", "Page.bringToFront", "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck", "Page.createIsolatedWorld", "Page.addScriptToEvaluateOnNewDocument", "Page.removeScriptToEvaluateOnNewDocument", "Runtime.enable", "Runtime.addBinding", "Runtime.removeBinding", "Runtime.evaluate", "Target.setAutoAttach", "Emulation.setFocusEmulationEnabled", "Input.dispatchMouseEvent", "Input.insertText", "Input.dispatchKeyEvent"]);
const events = new Set(["Target.attachedToTarget", "Target.detachedFromTarget", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Runtime.bindingCalled", "Page.frameAttached", "Page.frameStartedNavigating", "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.frameStoppedLoading", "Inspector.detached", "Inspector.targetCrashed", "Page.frameDetached", "Page.screencastFrame"]);

// The extension connection is local-only. Private CDP traffic has no agent HTTP endpoint.
export function createBrowserControlExtension({ sendMessage, timeoutMs = 5000 } = {}) {
  const clients = new Map(), requests = new Map(), controls = new Map();
  function send(client, payload) {
    if (!clients.has(client.ws) || (client.ws.bufferedAmount || 0) > 1024 * 1024) throw fail();
    if (sendMessage(client.ws, payload) === false) throw fail();
  }
  function clientFor(subjectId, browserId) {
    const matches = [...clients.values()].filter((client) => client.subjectId === subjectId && (!browserId || client.id === browserId));
    if (matches.length !== 1) throw fail(matches.length ? "browser_extension_ambiguous" : browserId ? "browser_extension_connection_changed" : "browser_extension_not_connected");
    return matches[0];
  }
  function request(client, payload) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { requests.delete(id); reject(fail("browser_extension_timeout")); }, timeoutMs);
      requests.set(id, { client, resolve, reject, timer });
      try { send(client, { ...payload, id }); } catch (error) { clearTimeout(timer); requests.delete(id); reject(error); }
    });
  }
  function disconnect(ws) {
    const client = clients.get(ws); if (!client) return;
    clients.delete(ws);
    for (const [id, pending] of requests) if (pending.client === client) {
      clearTimeout(pending.timer); requests.delete(id); pending.reject(fail());
    }
    for (const control of [...controls.values()]) if (control.client === client) control.socket.terminate();
  }
  const service = {
    async discover(subjectId, origin) {
      let url; try { url = new URL(origin); } catch { throw fail(); }
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw fail();
      const client = clientFor(subjectId), reply = await request(client, { type: "discover", origin });
      if (!Array.isArray(reply.targets) || reply.targets.length > 100) throw fail();
      const targets = reply.targets.map((entry) => {
        if (typeof entry?.targetId !== "string" || !targetId.test(entry.targetId) || !Number.isSafeInteger(entry.tabId) || entry.tabId < 1 || entry.origin !== origin) throw fail();
        return { targetId: entry.targetId, tabId: entry.tabId, origin };
      });
      return { browserId: client.id, targets };
    },
    open(subjectId, target) {
      const client = clientFor(subjectId, target.browserId), id = randomUUID();
      const socket = new EventEmitter(); socket.readyState = 0;
      const control = { client, socket }; controls.set(id, control);
      const closed = (notify) => {
        if (socket.readyState === 3) return;
        socket.readyState = 3; controls.delete(id);
        if (notify) { try { send(client, { type: "detach", controlId: id }); } catch {} }
        socket.emit("close");
      };
      socket.close = () => closed(true); socket.terminate = () => closed(true);
      socket.send = (text, callback) => {
        try {
          if (socket.readyState !== 1 || Buffer.byteLength(text) > 128 * 1024) throw fail();
          const message = JSON.parse(text);
          if (!Number.isSafeInteger(message.id) || message.id < 1 || !methods.has(message.method)
            || Object.keys(message).some((key) => !["id", "method", "params", "sessionId"].includes(key))) throw fail();
          send(client, { type: "cdp", controlId: id, message }); callback?.();
        } catch (error) { callback?.(error); closed(true); }
      };
      queueMicrotask(() => {
        if (socket.readyState !== 0) return;
        void request(client, { type: "attach", controlId: id, targetId: target.targetId, origin: target.origin }).then(() => {
          if (socket.readyState !== 0) { try { send(client, { type: "detach", controlId: id }); } catch {} return; }
          socket.readyState = 1; socket.emit("open");
        }).catch(() => closed(true));
      });
      return socket;
    },
    connect(ws, auth) {
      if (auth?.local !== true || typeof auth.ownerSubjectId !== "string") { ws.close(1008, "local_control_required"); return; }
      ws.on("error", () => disconnect(ws)); ws.once("close", () => disconnect(ws));
      ws.on("message", (raw, binary) => {
        try {
          if (binary || Buffer.byteLength(raw) > 3 * 1024 * 1024) throw fail();
          service.handleMessage(ws, JSON.parse(String(raw)), auth);
        } catch { disconnect(ws); ws.close(1008, "browser_extension_invalid_message"); }
      });
    },
    handleMessage(ws, payload, auth) {
      if (auth?.local !== true || typeof auth.ownerSubjectId !== "string") return true;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
      if (payload.type === "hello" && payload.version === 1) {
        if (!clients.has(ws)) clients.set(ws, { ws, id: randomUUID(), subjectId: auth.ownerSubjectId });
        try { send(clients.get(ws), { type: "ready" }); } catch { disconnect(ws); }
        return true;
      }
      const client = clients.get(ws); if (!client || client.subjectId !== auth.ownerSubjectId) return true;
      if (payload.type === "reply" && uuid.test(payload.id)) {
        const pending = requests.get(payload.id);
        if (!pending || pending.client !== client) return true;
        clearTimeout(pending.timer); requests.delete(payload.id);
        if (payload.ok === true) pending.resolve(payload); else pending.reject(fail());
      } else if (["cdp", "closed"].includes(payload.type) && uuid.test(payload.controlId)) {
        const control = controls.get(payload.controlId);
        if (!control || control.client !== client) return true;
        if (payload.type === "closed") { control.socket.terminate(); return true; }
        const packet = payload.message;
        if (control.socket.readyState !== 1 || !packet || typeof packet !== "object" || Array.isArray(packet)) return true;
        if (Number.isSafeInteger(packet.id) && !packet.method || !packet.id && events.has(packet.method)) {
          const text = JSON.stringify(packet);
          if (Buffer.byteLength(text) <= 3 * 1024 * 1024) control.socket.emit("message", text);
          else control.socket.terminate();
        }
      }
      return true;
    },
    disconnect,
    close() { for (const ws of [...clients.keys()]) disconnect(ws); },
  };
  return service;
}
