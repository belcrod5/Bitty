import { WebSocket } from "ws";

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
  if (input.type === "text") return keys === "text,type" && typeof input.text === "string" && input.text.length > 0 && input.text.length <= 4096;
  if (input.type === "key") return keys === "key,type" && ["Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(input.key);
  if (!["down", "move", "up", "scroll"].includes(input.type) || !Number.isFinite(input.x) || !Number.isFinite(input.y)
    || input.x < 0 || input.x > 1 || input.y < 0 || input.y > 1) return false;
  return input.type === "scroll"
    ? keys === "deltaX,deltaY,type,x,y" && [input.deltaX, input.deltaY].every((n) => Number.isFinite(n) && Math.abs(n) <= 2000)
    : keys === "type,x,y";
}

// A page-only CDP session. No DOM/value reads, arbitrary JS, console/network capture, or disk recording.
// Images go directly to the bound user device and never enter the agent's status response.
export async function prepareBrowserControl(target, { signal, timeoutMs = 5000, onInvalidated, onFrame, onOrigin, onNavigation } = {}) {
  target = validateBrowserControlTarget(target);
  const socket = new WebSocket(target.cdpUrl, { followRedirects: false, maxPayload: 3 * 1024 * 1024 });
  const pending = new Map();
  let sequence = 0, frameSequence = 0;
  let stopped = false, active = false, mouseDown = false, rootId;
  let currentOrigin = target.origin;
  let pointer = { x: 0, y: 0 };
  let awaitingFrame = null, readingFrame = false, frameTimer;
  let generation = 0, navigating = false;
  const displayedFrames = new Map();
  const close = (unexpected = false) => {
    if (stopped) return;
    stopped = true; active = false;
    clearTimeout(frameTimer); awaitingFrame = null; displayedFrames.clear();
    // Release held buttons even when the view disappears halfway through a drag.
    if (socket.readyState === WebSocket.OPEN) {
      releaseMouse();
      socket.send(JSON.stringify({ id: ++sequence, method: "Page.stopScreencast" }));
      socket.close();
      const timer = setTimeout(() => socket.terminate(), 500); timer.unref?.();
    } else socket.terminate();
    mouseDown = false;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(fail()); }
    pending.clear();
    signal?.removeEventListener("abort", abort);
    if (unexpected === true && !signal?.aborted) onInvalidated?.();
  };
  const abort = () => close();
  signal?.addEventListener("abort", abort, { once: true });
  socket.on("error", () => close(true));
  socket.on("close", () => close(true));
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (stopped || signal?.aborted || socket.readyState !== WebSocket.OPEN) return reject(fail());
    const id = ++sequence;
    const timer = setTimeout(() => { reject(fail()); close(true); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }), (error) => { if (error) close(true); });
  });
  function releaseMouse() {
    if (!mouseDown) return;
    mouseDown = false;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++sequence, method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...pointer, button: "left", buttons: 0, clickCount: 0 } }));
  }
  function resetFrames() {
    generation++; releaseMouse(); displayedFrames.clear(); clearTimeout(frameTimer);
    if (awaitingFrame) { const { sessionId } = awaitingFrame; awaitingFrame = null; void call("Page.screencastFrameAck", { sessionId }).catch(() => close(true)); }
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
    if (message.method === "Page.frameStartedNavigating" && message.params?.frameId === rootId) {
      resetFrames(); navigating = true; onNavigation?.();
    }
    if (message.method === "Page.frameNavigated" && message.params?.frame?.id === rootId) {
      const origin = originOf(message.params.frame.url);
      if (!active || !origin) { close(true); return; }
      resetFrames(); navigating = false; onNavigation?.();
      currentOrigin = origin; onOrigin?.(origin);
    }
    if (message.method === "Page.navigatedWithinDocument" && message.params?.frameId === rootId) {
      const origin = originOf(message.params.url);
      if (!active || !origin) { close(true); return; }
      resetFrames(); navigating = false; onNavigation?.();
      currentOrigin = origin; onOrigin?.(origin);
    }
    if (message.method === "Page.frameStoppedLoading" && message.params?.frameId === rootId && navigating) {
      // A cancelled/failed navigation may keep its old document. Refuse stale input, but resume images.
      resetFrames(); navigating = false; onNavigation?.();
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
    const frameGeneration = generation;
    readingFrame = true;
    void call("Page.getLayoutMetrics").then(({ cssVisualViewport }) => {
      if (!active || stopped || frameGeneration !== generation) { if (!stopped) void call("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => close(true)); return; }
      const { clientWidth: width, clientHeight: height, offsetX = 0, offsetY = 0 } = cssVisualViewport || {};
      if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 32768)
        || ![offsetX, offsetY].every(Number.isFinite)) { close(true); return; }
      const viewport = { width, height, offsetX, offsetY };
      awaitingFrame = { id: ++frameSequence, sessionId: frame.sessionId, viewport, generation };
      frameTimer = setTimeout(() => close(true), 10_000);
      onFrame?.({ frameId: awaitingFrame.id, data: frame.data, width, height });
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
        const startGeneration = generation;
        // An unopened card cannot silently follow a page that changed in the meantime.
        const { frameTree } = await call("Page.getFrameTree");
        if (stopped || startGeneration !== generation) return;
        if (frameTree?.frame?.id !== rootId || originOf(frameTree.frame.url) !== currentOrigin) throw fail();
        active = true;
        await call("Page.bringToFront");
        if (!active || stopped || startGeneration !== generation) return;
        await call("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: 1280, maxHeight: 960, everyNthFrame: 1 });
      },
      async pause() {
        if (stopped) return;
        const wasActive = active;
        active = false; resetFrames();
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
