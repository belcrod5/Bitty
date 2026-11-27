import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const fail = () => new Error("browser_control_unavailable");
export function validateBrowserControlTarget(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["cdpUrl", "origin", "label"].includes(key))) throw fail();
  const url = new URL(input.cdpUrl);
  if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash
    || !/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw fail();
  const origin = new URL(input.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== input.origin
    || typeof input.label !== "string" || !input.label || input.label.length > 120
    || /[\u0000-\u001f\u007f]/.test(input.label)) throw fail();
  return { cdpUrl: url.href, origin: origin.origin, label: input.label };
}

export function validBrowserControlInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input).sort().join(",");
  if (input.focusRevision !== undefined && (typeof input.focusRevision !== "string" || !/^[A-Za-z0-9:-]{1,120}$/.test(input.focusRevision))) return false;
  if (input.type === "text") return ["text,type", "focusRevision,text,type"].includes(keys) && typeof input.text === "string" && input.text.length > 0 && input.text.length <= 4096;
  if (input.type === "key") return ["key,type", "focusRevision,key,type"].includes(keys) && ["Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(input.key);
  if (!["down", "move", "up", "scroll"].includes(input.type) || !Number.isFinite(input.x) || !Number.isFinite(input.y)
    || input.x < 0 || input.x > 1 || input.y < 0 || input.y > 1) return false;
  return input.type === "scroll"
    ? keys === "deltaX,deltaY,type,x,y" && [input.deltaX, input.deltaY].every((n) => Number.isFinite(n) && Math.abs(n) <= 2000)
    : keys === "type,x,y";
}

// A page-only CDP session. Only a fixed isolated focus observer reads editable metadata; never values.
// No caller-supplied JS, console/network capture, or disk recording.
// Images go directly to the bound user device and never enter the agent's status response.
export async function prepareBrowserControl(target, { signal, timeoutMs = 5000, frameTimeoutMs = 10_000, onInvalidated, onFrame, onOrigin, onViewInvalidated, onDiagnostic, onFocus } = {}) {
  target = validateBrowserControlTarget(target);
  const socket = new WebSocket(target.cdpUrl, { followRedirects: false, maxPayload: 3 * 1024 * 1024 });
  const pending = new Map();
  let sequence = 0, frameSequence = 0;
  let stopped = false, active = false, mouseDown = false, emulatingFocus = false, rootId;
  let currentOrigin = target.origin;
  let pointer = { x: 0, y: 0 };
  let awaitingFrame = null, readingFrame = false, receivedFrame = false, frameTimer, lastViewport = null;
  let generation = 0, controlGeneration = 0, navigating = false;
  const displayedFrames = new Map();
  const focusWorld = `bitty-browser-${randomUUID()}`, focusBinding = "__bittyBrowserFocus";
  const focusContexts = new Map(), focusScripts = new Map(), focusSessions = new Set();
  let focusEpoch = 0, focusClears = 0, keyboardFocus = null;
  const focusKey = (sessionId, contextId) => `${sessionId || ""}:${contextId}`;
  const attachIframes = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }, { exclude: true }] };
  // This code runs in a private world. Only fixed editable metadata crosses the binding.
  const focusSource = `(() => {
    globalThis.__bittyFocusCleanup?.();
    let last = null, lastEditable = null, revision = 0, pointerStart = null;
    const deepActive = () => { let element = document.activeElement; while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement; return element; };
    const report = (force = false) => {
      const element = deepActive();
      if (element?.tagName === "IFRAME" || element?.tagName === "FRAME") return;
      const input = element?.tagName === "INPUT", multiline = element?.tagName === "TEXTAREA" || !!element?.isContentEditable;
      const type = input ? element.type : "text";
      const editable = document.hasFocus() && !element?.disabled && !element?.readOnly && (multiline || input && ["text", "password", "email", "number", "tel", "url", "search"].includes(type));
      if (!force && element === last && editable === lastEditable) return;
      last = element; lastEditable = editable;
      globalThis.${focusBinding}(JSON.stringify({ editable: !!editable, multiline: !!editable && multiline, kind: editable && input ? type : "text", revision: ++revision }));
    };
    const changed = () => queueMicrotask(() => report());
    const down = () => { pointerStart = deepActive(); };
    const up = () => { if (deepActive() === pointerStart) report(true); };
    document.addEventListener("focusin", changed, true); document.addEventListener("focusout", changed, true); window.addEventListener("blur", changed, true); window.addEventListener("focus", changed, true);
    document.addEventListener("pointerdown", down, true); document.addEventListener("pointerup", up, true);
    globalThis.__bittyFocusCleanup = () => { document.removeEventListener("focusin", changed, true); document.removeEventListener("focusout", changed, true); window.removeEventListener("blur", changed, true); window.removeEventListener("focus", changed, true); document.removeEventListener("pointerdown", down, true); document.removeEventListener("pointerup", up, true); delete globalThis.__bittyFocusCleanup; };
    if (document.hasFocus()) report(true);
  })()`;
  function focusLost() {
    keyboardFocus = null;
    if (active) onFocus?.({ editable: false, multiline: false, kind: "text", focusRevision: `${focusWorld}:${focusEpoch}:clear:${++focusClears}` });
  }
  function forgetFocusContext(key) {
    focusContexts.delete(key);
    if (keyboardFocus?.context === key) focusLost();
  }
  function forgetFocusSession(sessionId) {
    focusSessions.delete(sessionId); focusScripts.delete(sessionId);
    for (const [key, context] of focusContexts) if (context.sessionId === sessionId) forgetFocusContext(key);
    for (const [id, request] of pending) if (request.sessionId === sessionId) {
      clearTimeout(request.timer); pending.delete(id); request.reject(fail());
    }
  }
  async function observeFrame(frameId, sessionId) {
    const { executionContextId } = await call("Page.createIsolatedWorld", { frameId, worldName: focusWorld }, sessionId);
    if (!Number.isSafeInteger(executionContextId)) return;
    focusContexts.set(focusKey(sessionId, executionContextId), { sessionId, contextId: executionContextId });
    await call("Runtime.evaluate", { expression: focusSource, contextId: executionContextId, silent: true, returnByValue: false }, sessionId);
  }
  async function observeFocus(frameTree, sessionId) {
    if (!onFocus) return;
    const sessionKey = sessionId || "";
    await call("Target.setAutoAttach", attachIframes, sessionId);
    if (!focusScripts.has(sessionKey)) {
      await call("Runtime.enable", {}, sessionId);
      await call("Runtime.addBinding", { name: focusBinding, executionContextName: focusWorld }, sessionId);
      const result = await call("Page.addScriptToEvaluateOnNewDocument", { source: focusSource, worldName: focusWorld }, sessionId);
      focusScripts.set(sessionKey, result.identifier);
    }
    const visit = async (tree) => {
      // Out-of-process frames are observed through their own attached page session.
      await observeFrame(tree.frame.id, sessionId).catch(() => {});
      for (const child of tree.childFrames || []) await visit(child);
    };
    await visit(frameTree);
  }
  const close = (unexpected = false, reason = "connection_closed") => {
    if (stopped) return;
    stopped = true; active = false; controlGeneration++;
    clearTimeout(frameTimer); awaitingFrame = null; displayedFrames.clear(); focusLost();
    // Release held buttons even when the view disappears halfway through a drag.
    if (socket.readyState === WebSocket.OPEN) {
      releaseMouse();
      for (const { contextId, sessionId } of focusContexts.values()) socket.send(JSON.stringify({ id: ++sequence, method: "Runtime.evaluate", params: { contextId, expression: "globalThis.__bittyFocusCleanup?.()", silent: true }, ...(sessionId ? { sessionId } : {}) }));
      for (const [sessionId, identifier] of focusScripts) {
        if (identifier) socket.send(JSON.stringify({ id: ++sequence, method: "Page.removeScriptToEvaluateOnNewDocument", params: { identifier }, ...(sessionId ? { sessionId } : {}) }));
        socket.send(JSON.stringify({ id: ++sequence, method: "Runtime.removeBinding", params: { name: focusBinding }, ...(sessionId ? { sessionId } : {}) }));
      }
      if (onFocus) socket.send(JSON.stringify({ id: ++sequence, method: "Target.setAutoAttach", params: { ...attachIframes, autoAttach: false } }));
      if (emulatingFocus) { emulatingFocus = false; socket.send(JSON.stringify({ id: ++sequence, method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } })); }
      socket.send(JSON.stringify({ id: ++sequence, method: "Page.stopScreencast" }));
      socket.close();
      const timer = setTimeout(() => socket.terminate(), 500); timer.unref?.();
    } else socket.terminate();
    mouseDown = false;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(fail()); }
    pending.clear();
    signal?.removeEventListener("abort", abort);
    if (unexpected === true && !signal?.aborted) onInvalidated?.(reason);
  };
  const abort = () => close();
  signal?.addEventListener("abort", abort, { once: true });
  socket.on("error", () => close(true));
  socket.on("close", () => close(true));
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (stopped || signal?.aborted || socket.readyState !== WebSocket.OPEN) return reject(fail());
    const id = ++sequence;
    const timer = setTimeout(() => {
      if (sessionId) forgetFocusSession(sessionId);
      else { reject(fail()); close(true, "command_timeout"); }
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, sessionId });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => { if (error) close(true); });
  });
  function releaseMouse() {
    if (!mouseDown) return;
    mouseDown = false;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++sequence, method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...pointer, button: "left", buttons: 0, clickCount: 0 } }));
  }
  function resetFrames() {
    generation++; releaseMouse(); displayedFrames.clear(); lastViewport = null; receivedFrame = false; clearTimeout(frameTimer);
    if (awaitingFrame) { const { sessionId } = awaitingFrame; awaitingFrame = null; void call("Page.screencastFrameAck", { sessionId }).catch(() => close(true)); }
  }
  function waitForFrame() {
    if (active && !navigating && !receivedFrame && !awaitingFrame) {
      clearTimeout(frameTimer); frameTimer = setTimeout(() => close(true, "frame_timeout"), frameTimeoutMs);
    }
  }
  const originOf = (url) => { try { const u = new URL(url); return ["https:", "http:"].includes(u.protocol) ? u.origin : null; } catch { return null; } };
  socket.on("message", (data) => {
    if (stopped) return;
    let message;
    try { message = JSON.parse(String(data)); } catch { close(true); return; }
    const waiting = pending.get(message.id);
    if (waiting) {
      pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(fail()); else waiting.resolve(message.result);
      return;
    }
    const sessionId = message.sessionId;
    if (message.method === "Target.attachedToTarget" && active && onFocus && message.params?.targetInfo?.type === "iframe") {
      const childSession = message.params.sessionId;
      if (typeof childSession !== "string" || focusSessions.has(childSession)) return;
      focusSessions.add(childSession);
      void (async () => {
        await call("Page.enable", {}, childSession);
        const { frameTree } = await call("Page.getFrameTree", {}, childSession);
        if (active && frameTree) await observeFocus(frameTree, childSession);
      })().catch(() => {});
      return;
    }
    if (message.method === "Target.detachedFromTarget") {
      const detached = message.params?.sessionId;
      forgetFocusSession(detached);
      return;
    }
    if (sessionId && !focusSessions.has(sessionId)) return;
    if (message.method === "Runtime.executionContextCreated" && message.params?.context?.name === focusWorld) {
      const contextId = message.params.context.id;
      focusContexts.set(focusKey(sessionId, contextId), { sessionId, contextId });
    }
    if (message.method === "Runtime.executionContextDestroyed") forgetFocusContext(focusKey(sessionId, message.params?.executionContextId));
    if (message.method === "Runtime.executionContextsCleared") for (const [key, context] of focusContexts) if (context.sessionId === sessionId) forgetFocusContext(key);
    if (message.method === "Runtime.bindingCalled" && active && message.params?.name === focusBinding && focusContexts.has(focusKey(sessionId, message.params.executionContextId))) {
      try {
        if (typeof message.params.payload !== "string" || message.params.payload.length > 256) return;
        const focus = JSON.parse(message.params.payload);
        if (Object.keys(focus).sort().join(",") !== "editable,kind,multiline,revision" || typeof focus.editable !== "boolean" || typeof focus.multiline !== "boolean"
          || !["text", "password", "email", "number", "tel", "url", "search"].includes(focus.kind) || !Number.isSafeInteger(focus.revision) || focus.revision < 1) return;
        const context = focusKey(sessionId, message.params.executionContextId);
        if (!focus.editable && keyboardFocus && keyboardFocus.context !== context) return;
        const metadata = { editable: focus.editable, multiline: focus.multiline, kind: focus.kind, focusRevision: `${focusWorld}:${focusEpoch}:${message.params.executionContextId}:${focus.revision}` };
        // Prefix each context with a controller-local counter, including child sessions whose context IDs overlap.
        const prior = focusContexts.get(context);
        prior.serial ||= ++focusClears;
        metadata.focusRevision = `${focusWorld}:${focusEpoch}:${prior.serial}:${focus.revision}`;
        keyboardFocus = { ...metadata, context };
        onFocus?.(metadata);
      } catch {}
      return;
    }
    if (message.method === "Page.frameAttached" && active && onFocus) void observeFrame(message.params.frameId, sessionId).catch(() => {});
    if (sessionId) return;
    if (message.method === "Page.frameStartedNavigating" && message.params?.frameId === rootId) {
      resetFrames(); focusLost(); navigating = true; onViewInvalidated?.();
    }
    if (message.method === "Page.frameNavigated" && message.params?.frame?.id === rootId) {
      const origin = originOf(message.params.frame.url);
      if (!active || !origin) { close(true); return; }
      resetFrames(); navigating = false; onViewInvalidated?.();
      currentOrigin = origin; onOrigin?.(origin);
      waitForFrame();
    }
    if (message.method === "Page.navigatedWithinDocument" && message.params?.frameId === rootId) {
      const origin = originOf(message.params.url);
      if (!active || !origin) { close(true); return; }
      resetFrames(); navigating = false; onViewInvalidated?.();
      currentOrigin = origin; onOrigin?.(origin);
      waitForFrame();
    }
    if (message.method === "Page.frameStoppedLoading" && message.params?.frameId === rootId && navigating) {
      // A cancelled/failed navigation may keep its old document. Refuse stale input, but resume images.
      resetFrames(); navigating = false; onViewInvalidated?.();
      waitForFrame();
    }
    if (["Inspector.detached", "Inspector.targetCrashed"].includes(message.method)
      || message.method === "Page.frameDetached" && message.params?.frameId === rootId) { close(true); return; }
    if (message.method !== "Page.screencastFrame") return;
    const frame = message.params;
    if (!Number.isInteger(frame?.sessionId)) { close(true); return; }
    if (!active) { void call("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => close(true)); return; }
    // Drop surplus frames; at most one image is held by either endpoint until the app renders it.
    if (awaitingFrame || readingFrame || navigating) { void call("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => close(true)); return; }
    if (typeof frame.data !== "string" || frame.data.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) { close(true); return; }
    if (!receivedFrame) { receivedFrame = true; onDiagnostic?.("cdp_frame_received"); }
    clearTimeout(frameTimer);
    const frameGeneration = generation;
    readingFrame = true;
    void call("Page.getLayoutMetrics").then(({ cssVisualViewport }) => {
      if (!active || stopped || frameGeneration !== generation) { if (!stopped) void call("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => close(true)); return; }
      const { clientWidth: width, clientHeight: height, offsetX = 0, offsetY = 0 } = cssVisualViewport || {};
      if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 32768)
        || ![offsetX, offsetY].every(Number.isFinite)) { close(true); return; }
      const viewport = { width, height, offsetX, offsetY };
      const viewportChanged = lastViewport && (lastViewport.width !== width || lastViewport.height !== height || lastViewport.offsetX !== offsetX || lastViewport.offsetY !== offsetY);
      if (viewportChanged) {
        releaseMouse(); displayedFrames.clear();
        // The same invalidation also drops queued client input when only viewport offsets changed.
        onViewInvalidated?.(); if (stopped || !active) return;
      }
      lastViewport = viewport;
      awaitingFrame = { id: ++frameSequence, sessionId: frame.sessionId, viewport, generation };
      frameTimer = setTimeout(() => close(true, "render_ack_timeout"), frameTimeoutMs);
      onFrame?.({ frameId: awaitingFrame.id, data: frame.data, width, height });
      if (viewportChanged && keyboardFocus) { const { context: _context, ...focus } = keyboardFocus; onFocus?.(focus); }
    }).catch(() => close(true)).finally(() => { readingFrame = false; });
  });
  try {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) { close(); reject(fail()); return; }
      const timer = setTimeout(() => { close(); reject(fail()); }, timeoutMs);
      const finish = (error) => { clearTimeout(timer); socket.off("open", opened); socket.off("close", closed); error ? reject(fail()) : resolve(); };
      const opened = () => finish(); const closed = () => finish(true);
      socket.once("open", opened); socket.once("close", closed);
    });
    await call("Page.enable");
    const { frameTree } = await call("Page.getFrameTree");
    rootId = frameTree?.frame?.id;
    if (!rootId || originOf(frameTree.frame.url) !== target.origin) throw fail();
    return {
      close,
      async start() {
        if (active || stopped) throw fail();
        const startGeneration = ++controlGeneration;
        // An unopened card cannot silently follow a page that changed in the meantime.
        const { frameTree } = await call("Page.getFrameTree");
        if (stopped || startGeneration !== controlGeneration) return;
        if (frameTree?.frame?.id !== rootId || originOf(frameTree.frame.url) !== currentOrigin) throw fail();
        active = true;
        // Remote control owns page focus even while macOS considers Chrome hidden/occluded.
        emulatingFocus = true;
        await call("Emulation.setFocusEmulationEnabled", { enabled: true });
        if (!active || stopped || startGeneration !== controlGeneration) return;
        onDiagnostic?.("focus_enabled");
        await call("Page.bringToFront");
        if (!active || stopped || startGeneration !== controlGeneration) return;
        focusEpoch++; focusLost();
        await observeFocus(frameTree);
        if (!active || stopped || startGeneration !== controlGeneration) return;
        await call("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: 1280, maxHeight: 960, everyNthFrame: 1 });
        if (!active || stopped || startGeneration !== controlGeneration) return;
        onDiagnostic?.("stream_started"); waitForFrame();
      },
      async pause() {
        if (stopped) return;
        const wasActive = active;
        active = false; controlGeneration++; resetFrames(); focusLost();
        if (emulatingFocus) { emulatingFocus = false; await call("Emulation.setFocusEmulationEnabled", { enabled: false }); }
        if (!wasActive) return;
        await call("Page.stopScreencast");
      },
      async ack(frameId) {
        if (!active || awaitingFrame?.id !== frameId) return;
        const { sessionId, viewport: drawnViewport, generation: drawnGeneration } = awaitingFrame;
        if (drawnGeneration === generation) { displayedFrames.set(frameId, drawnViewport); if (displayedFrames.size > 16) displayedFrames.delete(displayedFrames.keys().next().value); }
        awaitingFrame = null; clearTimeout(frameTimer);
        await call("Page.screencastFrameAck", { sessionId });
      },
      async input(input, frameId) {
        const drawnViewport = displayedFrames.get(frameId);
        if (!active || !validBrowserControlInput(input)) throw fail();
        if (navigating || !drawnViewport) throw Object.assign(fail(), { code: "stale_frame" });
        if (input.focusRevision !== undefined && (!keyboardFocus?.editable || keyboardFocus.focusRevision !== input.focusRevision)) throw Object.assign(fail(), { code: "stale_frame" });
        if (input.type === "text") { await call("Input.insertText", { text: input.text }); return; }
        if (input.type === "key") {
          const codes = { Backspace: 8, Delete: 46, Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 };
          const params = { key: input.key, code: input.key, windowsVirtualKeyCode: codes[input.key] };
          await call("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(input.key === "Enter" ? { text: "\r" } : {}) });
          await call("Input.dispatchKeyEvent", { type: "keyUp", ...params }); return;
        }
        const x = input.x * drawnViewport.width + drawnViewport.offsetX, y = input.y * drawnViewport.height + drawnViewport.offsetY;
        if (input.type === "scroll") { await call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: input.deltaX, deltaY: input.deltaY }); return; }
        if (input.type === "down" && mouseDown || input.type === "up" && !mouseDown) throw fail();
        const nextDown = input.type === "down" || input.type === "move" && mouseDown;
        mouseDown = nextDown; pointer = { x, y };
        await call("Input.dispatchMouseEvent", { type: { down: "mousePressed", move: "mouseMoved", up: "mouseReleased" }[input.type], x, y,
          button: input.type === "move" && !mouseDown ? "none" : "left", buttons: nextDown ? 1 : 0, ...(input.type !== "move" ? { clickCount: 1 } : {}) });
      },
    };
  } catch { close(); throw fail(); }
}
