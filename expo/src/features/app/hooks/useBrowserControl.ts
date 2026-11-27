import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { VoiceTarget } from "../../appControl/voiceControl";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";

export type BrowserControlStatus = "pending" | "starting" | "active" | "completed" | "cancelled" | "expired" | "invalidated" | "failed" | "control_status_unknown";
export type BrowserControlRequest = { requestId: string; target: VoiceTarget; origin: string; label: string; createdAt: string; status: BrowserControlStatus; inputNotApplied?: boolean };
export type BrowserControlFrame = { frameId: number; data: string; width: number; height: number };
export type BrowserControlInput = { type: "text"; text: string } | { type: "key"; key: string }
  | { type: "down" | "move" | "up"; x: number; y: number } | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number };
const terminal = new Set<BrowserControlStatus>(["completed", "cancelled", "expired", "invalidated", "failed", "control_status_unknown"]);

export function useBrowserControl(manager: RunnerWebSocketManager, onDiagnostic?: (event: string, payload: Record<string, unknown>) => void) {
  const [requests, setRequests] = useState<BrowserControlRequest[]>([]);
  const entries = useRef(new Map<string, BrowserControlRequest>());
  // Only the mounted control view receives images; no image/draft enters root state, conversation data or a response cache.
  const viewers = useRef(new Map<string, (frame: BrowserControlFrame | null) => void>());
  const commandGenerations = useRef(new Map<string, number>());
  const displays = useRef(new Map<string, { received: boolean; rendered: boolean; timer?: ReturnType<typeof setTimeout> }>());
  const diagnostic = useRef(onDiagnostic);
  diagnostic.current = onDiagnostic;
  const diagnose = useCallback((requestId: string, phase: "start" | "frame_received" | "frame_rendered" | "frame_timeout" | "render_failed" | "command_failed") => {
    try { diagnostic.current?.("browser_control", { requestId, phase }); } catch {}
  }, []);
  const clearDisplay = useCallback((requestId: string) => {
    clearTimeout(displays.current.get(requestId)?.timer); displays.current.delete(requestId);
  }, []);
  type QueuedInput = { input: BrowserControlInput; frameId: number };
  const queues = useRef(new Map<string, { tail: Promise<void>; pending: QueuedInput[]; running: boolean; sequence: number }>());
  const update = useCallback((entry: BrowserControlRequest) => {
    entries.current.set(entry.requestId, entry); setRequests([...entries.current.values()]);
    if (terminal.has(entry.status) || entry.status === "pending") viewers.current.get(entry.requestId)?.(null);
    if (terminal.has(entry.status)) { clearDisplay(entry.requestId); commandGenerations.current.delete(entry.requestId); const queue = queues.current.get(entry.requestId); if (queue) queue.pending = []; queues.current.delete(entry.requestId); }
    if (entry.status === "control_status_unknown") { try { manager.send({ channel: "control", op: "browser.control.command", payload: { requestId: entry.requestId, action: "cancel" } }); } catch {} }
  }, [clearDisplay, manager]);
  const failDisplay = useCallback((requestId: string, reason: "frame_timeout" | "render_failed") => {
    const current = entries.current.get(requestId);
    if (!current || terminal.has(current.status) || !viewers.current.has(requestId)) return;
    diagnose(requestId, reason);
    const uncertain = (queues.current.get(requestId)?.sequence || 0) > 0;
    if (!uncertain) { try { manager.send({ channel: "control", op: "browser.control.command", payload: { requestId, action: "cancel" } }); } catch {} }
    update({ ...current, status: uncertain ? "control_status_unknown" : "failed" });
  }, [diagnose, manager, update]);
  const command = useCallback(async (requestId: string, action: "start" | "pause" | "finish" | "cancel") => {
    const entry = entries.current.get(requestId);
    if (!entry || terminal.has(entry.status)) return;
    if (action === "pause" && entry.status === "pending") return;
    if (action === "pause" || action === "cancel") { clearDisplay(requestId); const queue = queues.current.get(requestId); if (queue) queue.pending = []; if (action === "pause") update({ ...entry, status: "pending" }); }
    if (action === "start") {
      if (entry.status !== "pending" || !viewers.current.has(requestId) || AppState.currentState !== "active" || !manager.getSnapshot().connected) return;
      clearDisplay(requestId); displays.current.set(requestId, { received: false, rendered: false }); diagnose(requestId, "start");
      update({ ...entry, status: "starting" });
    }
    const generation = (commandGenerations.current.get(requestId) || 0) + 1;
    commandGenerations.current.set(requestId, generation);
    try {
      if (action === "finish" || action === "start") await (queues.current.get(requestId)?.tail || Promise.resolve());
      if (commandGenerations.current.get(requestId) !== generation || terminal.has(entries.current.get(requestId)?.status as BrowserControlStatus)) return;
      const response = await manager.request({ channel: "control", op: "browser.control.command", payload: { requestId, action } }, { timeoutMs: 10_000 });
      const status = (response.payload as { status?: BrowserControlStatus })?.status;
      const current = entries.current.get(requestId);
      if (commandGenerations.current.get(requestId) !== generation || !current || terminal.has(current.status)) return;
      update({ ...current, status: status && (terminal.has(status) || status === "active" || status === "pending") ? status : "control_status_unknown" });
      const display = displays.current.get(requestId);
      if (action === "start" && status === "active" && display && !display.received) display.timer = setTimeout(() => {
        if (commandGenerations.current.get(requestId) !== generation || entries.current.get(requestId)?.status !== "active") return;
        failDisplay(requestId, "frame_timeout");
      }, 15_000);
    } catch { const current = entries.current.get(requestId); if (commandGenerations.current.get(requestId) === generation && current && !terminal.has(current.status)) { diagnose(requestId, "command_failed"); update({ ...current, status: "control_status_unknown" }); } }
  }, [clearDisplay, diagnose, failDisplay, manager, update]);
  const input = useCallback((requestId: string, input: BrowserControlInput, frameId: number) => {
    const entry = entries.current.get(requestId);
    if (!entry || entry.status !== "active" || !viewers.current.has(requestId) || AppState.currentState !== "active" || !manager.getSnapshot().connected) return;
    let queue = queues.current.get(requestId);
    if (!queue) { queue = { tail: Promise.resolve(), pending: [], running: false, sequence: 0 }; queues.current.set(requestId, queue); }
    const last = queue.pending.at(-1);
    // Gesture events can arrive much faster than a mobile network round trip. Keep the final pointer
    // position and accumulated wheel distance without reordering down/up, typing, or key presses.
    if (last?.input.type === "move" && input.type === "move") { last.input = input; last.frameId = frameId; }
    else if (last?.input.type === "scroll" && input.type === "scroll") {
      last.input = { ...input, deltaX: Math.max(-2000, Math.min(2000, last.input.deltaX + input.deltaX)), deltaY: Math.max(-2000, Math.min(2000, last.input.deltaY + input.deltaY)) }; last.frameId = frameId;
    } else {
      if (queue.pending.length >= 32) { void command(requestId, "cancel"); return; }
      queue.pending.push({ input, frameId });
    }
    const currentQueue = queue;
    if (!queue.running) {
      queue.running = true;
      queue.tail = (async () => {
        while (currentQueue.pending.length) {
          const next = currentQueue.pending.shift()!;
          if (entries.current.get(requestId)?.status !== "active" || !viewers.current.has(requestId)) { currentQueue.pending = []; break; }
          const response = await manager.request({ channel: "control", op: "browser.control.command", payload: { requestId, action: "input", frameId: next.frameId, sequence: ++currentQueue.sequence, input: next.input } }, { timeoutMs: 10_000 });
          const { status, inputStatus } = response.payload as { status?: BrowserControlStatus; inputStatus?: string };
          const current = entries.current.get(requestId);
          if (current?.status === "active" && status === "active" && (next.input.type === "text" || next.input.type === "key")) update({ ...current, inputNotApplied: inputStatus === "not_applied" });
          if (current?.status === "active" && status !== "active") { update({ ...current, status: status && terminal.has(status) ? status : "control_status_unknown" }); currentQueue.pending = []; }
        }
      })().catch(() => { const current = entries.current.get(requestId); currentQueue.pending = []; if (current && !terminal.has(current.status)) update({ ...current, status: "control_status_unknown" }); })
        .finally(() => { currentQueue.running = false; });
    }
    return currentQueue.tail;
  }, [command, manager, update]);
  const ack = useCallback((requestId: string, frameId: number) => {
    if (!viewers.current.has(requestId) || !["active", "starting"].includes(entries.current.get(requestId)?.status || "")) return;
    const display = displays.current.get(requestId);
    if (display && !display.rendered) { display.rendered = true; diagnose(requestId, "frame_rendered"); }
    try { manager.send({ channel: "control", op: "browser.control.command", payload: { requestId, action: "ack", frameId } }); } catch {}
  }, [diagnose, manager]);
  const watch = useCallback((requestId: string, listener: (frame: BrowserControlFrame | null) => void) => {
    if (viewers.current.has(requestId)) return null;
    viewers.current.set(requestId, listener);
    return () => { if (viewers.current.get(requestId) !== listener) return; listener(null); viewers.current.delete(requestId); void command(requestId, "pause"); };
  }, [command]);
  useEffect(() => {
    let scope = manager.getSnapshot().connectionOptionsGeneration;
    const expire = () => {
      for (const entry of entries.current.values()) if (!terminal.has(entry.status)) {
        update({ ...entry, status: entry.status === "active" || entry.status === "starting" ? "control_status_unknown" : "expired" });
        try { manager.send({ channel: "control", op: "browser.control.command", payload: { requestId: entry.requestId, action: "cancel" } }); } catch {}
      }
    };
    const offRequest = manager.subscribe({ channel: "control", op: "browser.control.request" }, (message) => {
      const entry = message.payload as BrowserControlRequest | undefined;
      if (!entry || typeof entry.requestId !== "string" || entries.current.has(entry.requestId) || !entry.target
        || typeof entry.label !== "string" || typeof entry.origin !== "string" || !Number.isFinite(Date.parse(entry.createdAt)) || entry.status !== "pending") return;
      update({ requestId: entry.requestId, target: entry.target, origin: entry.origin, label: entry.label, createdAt: entry.createdAt, status: "pending" });
      if (AppState.currentState !== "active" || !manager.getSnapshot().connected) expire();
    });
    const offFrame = manager.subscribe({ channel: "control", op: "browser.control.frame" }, (message) => {
      const frame = message.payload as BrowserControlFrame & { requestId: string };
      const entry = entries.current.get(frame?.requestId);
      if (!entry || !["starting", "active"].includes(entry.status) || AppState.currentState !== "active" || !viewers.current.has(entry.requestId)) return;
      if (!Number.isSafeInteger(frame.frameId) || frame.frameId < 1 || typeof frame.data !== "string" || frame.data.length > 2 * 1024 * 1024
        || ![frame.width, frame.height].every((n) => Number.isFinite(n) && n > 0 && n <= 32768)) { expire(); return; }
      const display = displays.current.get(entry.requestId);
      if (display && !display.received) { display.received = true; clearTimeout(display.timer); diagnose(entry.requestId, "frame_received"); }
      viewers.current.get(entry.requestId)?.({ frameId: frame.frameId, data: frame.data, width: frame.width, height: frame.height });
    });
    const offViewInvalidated = manager.subscribe({ channel: "control", op: "browser.control.view_invalidated" }, (message) => {
      const id = (message.payload as { requestId?: string })?.requestId;
      if (!id) return;
      const queue = queues.current.get(id); const current = entries.current.get(id);
      if (queue) { if (current && queue.pending.some(({ input }) => input.type === "text" || input.type === "key")) update({ ...current, inputNotApplied: true }); queue.pending = []; }
      viewers.current.get(id)?.(null);
    });
    const offOrigin = manager.subscribe({ channel: "control", op: "browser.control.origin" }, (message) => {
      const payload = message.payload as { requestId?: string; origin?: string };
      const entry = entries.current.get(payload?.requestId || "");
      if (entry && !terminal.has(entry.status) && typeof payload.origin === "string") update({ ...entry, origin: payload.origin });
    });
    const offResolved = manager.subscribe({ channel: "control", op: "browser.control.resolved" }, (message) => {
      const result = message.payload as { requestId?: string; status?: BrowserControlStatus };
      const entry = entries.current.get(result?.requestId || "");
      if (entry && result.status && terminal.has(result.status) && !terminal.has(entry.status)) update({ ...entry, status: result.status });
    });
    const offSnapshot = manager.subscribeSnapshot(() => {
      const snapshot = manager.getSnapshot();
      if (snapshot.connectionOptionsGeneration !== scope) {
        scope = snapshot.connectionOptionsGeneration; expire(); entries.current.clear(); queues.current.clear(); setRequests([]);
      } else if (!snapshot.connected) expire();
    });
    const subscription = AppState.addEventListener("change", (state) => { if (state !== "active") expire(); });
    return () => { expire(); offRequest(); offFrame(); offViewInvalidated(); offOrigin(); offResolved(); offSnapshot(); subscription.remove(); viewers.current.clear(); queues.current.clear(); };
  }, [diagnose, manager, update]);
  return { requests, command, input, ack, watch, failDisplay };
}
