const runs = new Map();
const commands = new Set(["Page.enable", "Page.getFrameTree", "Page.getLayoutMetrics", "Page.bringToFront", "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck", "Page.createIsolatedWorld", "Page.addScriptToEvaluateOnNewDocument", "Page.removeScriptToEvaluateOnNewDocument", "Runtime.enable", "Runtime.addBinding", "Runtime.removeBinding", "Runtime.evaluate", "Target.setAutoAttach", "Emulation.setFocusEmulationEnabled", "Input.dispatchMouseEvent", "Input.insertText", "Input.dispatchKeyEvent"]);
const allowedEvents = new Set(["Target.attachedToTarget", "Target.detachedFromTarget", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Runtime.bindingCalled", "Page.frameAttached", "Page.frameStartedNavigating", "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.frameStoppedLoading", "Inspector.detached", "Inspector.targetCrashed", "Page.frameDetached", "Page.screencastFrame"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
let port;
const originOf = (value) => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.origin : null; } catch { return null; } };
const post = (value) => { try { port?.postMessage(value); } catch {} };
const debuggee = (run, sessionId) => ({ tabId: run.tabId, ...(sessionId ? { sessionId } : {}) });
async function stop(run) {
  if (run.stopping) return run.stopping;
  const wasAttached = run.attached;
  run.cancelled = true;
  const detach = () => {
    if (run.detaching) return run.detaching;
    run.closed = true;
    if (run.pointer) void chrome.debugger.sendCommand(debuggee(run), "Input.dispatchMouseEvent", { type: "mouseReleased", ...run.pointer, button: "left", buttons: 0, clickCount: 0 }).catch(() => {});
    void chrome.debugger.sendCommand(debuggee(run), "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    run.detaching = chrome.debugger.detach(debuggee(run)).catch(() => {}).finally(() => { if (runs.get(run.id) === run) runs.delete(run.id); });
    return run.detaching;
  };
  const cleanup = run.queue.catch(() => {}).then(async () => {
    await Promise.allSettled([...run.commands]);
    if (run.closed) return run.detaching;
    if (!run.attached) return;
    if (!wasAttached) return detach();
    const call = (method, params = {}, sessionId) => run.closed ? Promise.resolve() : chrome.debugger.sendCommand(debuggee(run, sessionId), method, params).catch(() => {});
    if (run.pointer) await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...run.pointer, button: "left", buttons: 0, clickCount: 0 });
    for (const { contextId, sessionId } of run.contexts.values()) await call("Runtime.evaluate", { contextId, expression: "globalThis.__bittyFocusCleanup?.()", silent: true }, sessionId);
    for (const [sessionId, identifier] of run.scripts) await call("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sessionId);
    for (const sessionId of run.bindings) await call("Runtime.removeBinding", { name: "__bittyBrowserFocus" }, sessionId);
    await call("Emulation.setFocusEmulationEnabled", { enabled: false });
    await call("Page.stopScreencast");
    return detach();
  });
  let timer;
  // Cancellation cannot wait forever for a renderer command. The actual detach still owns the tab until it settles.
  const forced = run.attached ? new Promise((resolve) => { timer = setTimeout(() => resolve(detach()), 1000); }) : cleanup;
  run.stopping = Promise.race([cleanup, forced]).finally(() => {
    clearTimeout(timer);
    if (!run.attached && !run.detaching && runs.get(run.id) === run) runs.delete(run.id);
  });
  return run.stopping;
}
async function receive(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "ready" || message.type === "reset") { for (const run of runs.values()) void stop(run); return; }
  if (message.type === "discover") {
    try {
      if (!uuid.test(message.id) || originOf(message.origin) !== message.origin) return;
      const targets = (await chrome.debugger.getTargets()).filter((entry) => entry.type === "page" && Number.isSafeInteger(entry.tabId) && entry.tabId > 0 && originOf(entry.url) === message.origin)
        .map((entry) => ({ targetId: entry.id, tabId: entry.tabId, origin: message.origin }));
      if (targets.length > 100) throw new Error();
      post({ type: "reply", id: message.id, ok: true, targets });
    } catch { post({ type: "reply", id: message.id, ok: false }); }
    return;
  }
  if (!uuid.test(message.controlId)) return;
  if (message.type === "attach") {
    if (!uuid.test(message.id) || typeof message.targetId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(message.targetId) || originOf(message.origin) !== message.origin) return;
    const run = { id: message.controlId, targetId: message.targetId, cancelled: false, attached: false, queue: Promise.resolve(), commands: new Set(), contexts: new Map(), worlds: new Set(), scripts: new Map(), bindings: new Set(), sessions: new Set([undefined]), pointer: null };
    const previous = [...runs.values()].filter((entry) => entry.targetId === run.targetId);
    if (runs.size >= 8 || runs.has(run.id) || previous.some((entry) => !entry.cancelled)) { post({ type: "reply", id: message.id, ok: false }); return; }
    runs.set(run.id, run);
    run.queue = (async () => {
      await Promise.all(previous.map(stop));
      if (run.cancelled) throw new Error();
      const entry = (await chrome.debugger.getTargets()).find((entry) => entry.id === run.targetId && entry.type === "page" && Number.isSafeInteger(entry.tabId) && entry.tabId > 0 && originOf(entry.url) === message.origin);
      if (!entry || run.cancelled) throw new Error();
      run.tabId = entry.tabId;
      await chrome.debugger.attach(debuggee(run), "1.3"); run.attached = true;
      if (run.cancelled) throw new Error();
      const current = (await chrome.debugger.getTargets()).find((entry) => entry.id === run.targetId);
      if (run.cancelled || !current || current.tabId !== run.tabId || originOf(current.url) !== message.origin) throw new Error();
      post({ type: "reply", id: message.id, ok: true });
    })();
    void run.queue.catch(() => { post({ type: "reply", id: message.id, ok: false }); void stop(run); });
    return;
  }
  const run = runs.get(message.controlId); if (!run) return;
  if (message.type === "detach") { void stop(run); return; }
  const packet = message.message;
  if (message.type !== "cdp" || !packet || !Number.isSafeInteger(packet.id) || packet.id < 1 || !commands.has(packet.method) || !run.sessions.has(packet.sessionId)) return;
  // CDP already orders commands; a stalled iframe must not block page frames, ACKs or input.
  const work = run.queue.catch(() => {}).then(async () => {
    if (run.cancelled) return;
    try {
      if (packet.method === "Input.dispatchMouseEvent") {
        if (packet.params?.type === "mousePressed") run.pointer = { x: packet.params.x, y: packet.params.y };
        if (packet.params?.type === "mouseMoved" && run.pointer) run.pointer = { x: packet.params.x, y: packet.params.y };
        if (packet.params?.type === "mouseReleased") run.pointer = null;
      }
      if (["Page.createIsolatedWorld", "Page.addScriptToEvaluateOnNewDocument"].includes(packet.method) && /^bitty-browser-[a-f0-9-]{36}$/.test(packet.params?.worldName)) run.worlds.add(packet.params.worldName);
      const result = await chrome.debugger.sendCommand(debuggee(run, packet.sessionId), packet.method, packet.params || {});
      if (run.cancelled || run.closed) return;
      const key = packet.sessionId || "";
      if (packet.method === "Page.addScriptToEvaluateOnNewDocument" && typeof result.identifier === "string") run.scripts.set(key, result.identifier);
      if (packet.method === "Page.removeScriptToEvaluateOnNewDocument") run.scripts.delete(key);
      if (packet.method === "Runtime.addBinding" && packet.params?.name === "__bittyBrowserFocus") run.bindings.add(key);
      if (packet.method === "Runtime.removeBinding") run.bindings.delete(key);
      if (!run.cancelled) post({ type: "cdp", controlId: run.id, message: { id: packet.id, ...(packet.sessionId ? { sessionId: packet.sessionId } : {}), result: result || {} } });
    } catch {
      if (!run.cancelled) post({ type: "cdp", controlId: run.id, message: { id: packet.id, ...(packet.sessionId ? { sessionId: packet.sessionId } : {}), error: { message: "browser_control_unavailable" } } });
    }
  });
  run.commands.add(work);
  void work.finally(() => run.commands.delete(work));
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!allowedEvents.has(method)) return;
  const run = [...runs.values()].find((entry) => entry.attached && entry.tabId === source.tabId);
  if (!run || !run.sessions.has(source.sessionId)) return;
  const key = source.sessionId || "";
  if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe" && typeof params.sessionId === "string") run.sessions.add(params.sessionId);
  if (method === "Runtime.executionContextCreated" && run.worlds.has(params.context?.name) && Number.isSafeInteger(params.context.id)) run.contexts.set(`${key}:${params.context.id}`, { contextId: params.context.id, sessionId: source.sessionId });
  if (method === "Runtime.executionContextDestroyed") run.contexts.delete(`${key}:${params.executionContextId}`);
  if (method === "Runtime.executionContextsCleared") for (const [id, context] of run.contexts) if (context.sessionId === source.sessionId) run.contexts.delete(id);
  if (method === "Target.detachedFromTarget") {
    run.sessions.delete(params.sessionId); run.scripts.delete(params.sessionId); run.bindings.delete(params.sessionId);
    for (const [id, context] of run.contexts) if (context.sessionId === params.sessionId) run.contexts.delete(id);
  }
  if (!run.cancelled) post({ type: "cdp", controlId: run.id, message: { method, params, ...(source.sessionId ? { sessionId: source.sessionId } : {}) } });
});
chrome.debugger.onDetach.addListener((source) => {
  const run = [...runs.values()].find((entry) => entry.tabId === source.tabId);
  if (!run || run.cancelled) return;
  run.attached = false; run.cancelled = true; run.closed = true; runs.delete(run.id);
  post({ type: "closed", controlId: run.id });
});
function connect() {
  if (port) return;
  port = chrome.runtime.connectNative("com.bitty.browser_control");
  port.onMessage.addListener((message) => { void receive(message); });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null; for (const run of runs.values()) void stop(run);
    setTimeout(connect, 5000);
  });
}
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
