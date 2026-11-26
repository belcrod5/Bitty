import { WebSocket } from "ws";

const fail = () => new Error("browser_input_unavailable");
const inputTypes = ["text", "password", "email", "tel", "number", "search", "url"];

export function validateBrowserInputTarget(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["cdpUrl", "selector", "origin", "frameId", "label"].includes(key))) throw fail();
  const url = new URL(input.cdpUrl);
  if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash
    || !/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw fail();
  const origin = new URL(input.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== input.origin
    || typeof input.selector !== "string" || !input.selector || input.selector.length > 2048
    || typeof input.label !== "string" || !input.label || input.label.length > 120
    || /[\u0000-\u001f\u007f]/.test(input.label)
    || (input.frameId !== undefined && (typeof input.frameId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.frameId)))) throw fail();
  return { cdpUrl: url.href, selector: input.selector, origin: origin.origin, label: input.label,
    ...(input.frameId ? { frameId: input.frameId } : {}) };
}

// This connection never enables console, network, DOM snapshots or screenshots.
// Browser errors can contain field values, so only our fixed error leaves it.
export async function prepareBrowserSecretInput(target, { signal, timeoutMs = 5000 } = {}) {
  target = validateBrowserInputTarget(target);
  const socket = new WebSocket(target.cdpUrl, { followRedirects: false, maxPayload: 1024 * 1024 });
  const pending = new Map();
  let sequence = 0;
  let stopped = false;
  let invalidated = false;
  const close = () => {
    if (stopped) return;
    stopped = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(fail()); }
    pending.clear();
    socket.terminate();
    signal?.removeEventListener("abort", close);
  };
  signal?.addEventListener("abort", close, { once: true });
  socket.on("error", close);
  socket.on("close", close);
  socket.on("message", (data) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return close(); }
    if (["Page.frameNavigated", "Page.navigatedWithinDocument", "Page.frameDetached", "Runtime.executionContextsCleared"].includes(message.method)) invalidated = true;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error || message.result?.exceptionDetails) waiting.reject(fail());
    else waiting.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (stopped || signal?.aborted || socket.readyState !== WebSocket.OPEN) return reject(fail());
    const id = ++sequence;
    const timer = setTimeout(() => { close(); reject(fail()); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }), (error) => { if (error) close(); });
  });
  try {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) { close(); reject(fail()); return; }
      const timer = setTimeout(() => { close(); reject(fail()); }, timeoutMs);
      const finish = (error) => { clearTimeout(timer); socket.off("open", opened); socket.off("close", closed); error ? reject(fail()) : resolve(); };
      const opened = () => finish();
      const closed = () => finish(true);
      socket.once("open", opened);
      socket.once("close", closed);
    });
    await call("Page.enable");
    const { frameTree } = await call("Page.getFrameTree");
    function find(tree) {
      if (!target.frameId || tree.frame.id === target.frameId) return tree.frame;
      return (tree.childFrames || []).map(find).find(Boolean);
    }
    const frame = find(frameTree);
    if (!frame || new URL(frame.url).origin !== target.origin) throw fail();
    const root = { id: frameTree.frame.id, loaderId: frameTree.frame.loaderId, url: frameTree.frame.url };
    const topOrigin = new URL(root.url).origin;
    if (!/^https?:\/\//.test(topOrigin)) throw fail();
    const { executionContextId } = await call("Page.createIsolatedWorld", { frameId: frame.id, worldName: "bitty-secret-input" });
    const captured = await call("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `(() => {
        const nodes = document.querySelectorAll(${JSON.stringify(target.selector)});
        const element = nodes.length === 1 ? nodes[0] : null;
        if (!element || !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
          || (element instanceof HTMLInputElement && !${JSON.stringify(inputTypes)}.includes(element.type))
          || element.disabled || element.readOnly || !element.isConnected || element.getClientRects().length === 0
          || location.origin !== ${JSON.stringify(target.origin)}) return null;
        return { element, document, url: location.href, type: element.type, name: element.name,
          form: element.form, action: element.form?.action, id: element.id, autocomplete: element.autocomplete };
      })()`,
      silent: true,
    });
    const objectId = captured.result?.objectId;
    if (!objectId || invalidated) throw fail();
    return {
      close, topOrigin,
      async fill(value) {
        if (typeof value !== "string" || !value.length || value.length > 4096 || invalidated) throw fail();
        const current = (await call("Page.getFrameTree")).frameTree.frame;
        if (invalidated || current.id !== root.id || current.loaderId !== root.loaderId || current.url !== root.url) throw fail();
        const result = await call("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function(value, selector) {
            const e = this.element;
            if (this.document !== document || this.url !== location.href || !e.isConnected
              || e.ownerDocument !== document || document.querySelectorAll(selector).length !== 1
              || document.querySelector(selector) !== e || e.type !== this.type || e.name !== this.name
              || e.id !== this.id || e.autocomplete !== this.autocomplete || e.form !== this.form
              || e.form?.action !== this.action || e.disabled || e.readOnly || e.getClientRects().length === 0) return false;
            const prototype = e instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(e, value);
            if (e.value !== value) return false;
            e.dispatchEvent(new Event("input", { bubbles: true }));
            e.dispatchEvent(new Event("change", { bubbles: true }));
            return e.isConnected && e.value === value;
          }`,
          arguments: [{ value }, { value: target.selector }],
          returnByValue: true,
          silent: true,
        });
        if (result.result?.value !== true) throw fail();
      },
    };
  } catch {
    close();
    throw fail();
  }
}
