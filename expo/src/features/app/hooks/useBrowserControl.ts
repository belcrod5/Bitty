import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import type { VoiceTarget } from "../../appControl/voiceControl";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";

export type BrowserControlStatus = "pending" | "starting" | "active" | "completed" | "cancelled" | "expired" | "invalidated" | "failed" | "control_status_unknown";
export type BrowserControlRequest = { requestId: string; target: VoiceTarget; origin: string; label: string; createdAt: string; status: BrowserControlStatus; inputNotApplied?: boolean; inputStatusUnknown?: boolean };
export type BrowserControlFrame = { frameId: number; data: string; width: number; height: number };
export type BrowserControlFocus = { editable: boolean; multiline: boolean; kind: "text" | "password" | "email" | "number" | "tel" | "url" | "search"; focusRevision: string };
export type BrowserControlInput = { type: "text"; text: string; focusRevision?: string } | { type: "key"; key: string; focusRevision?: string }
  | { type: "down" | "move" | "up"; x: number; y: number } | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number };
const terminal = new Set<BrowserControlStatus>(["completed", "cancelled", "expired", "invalidated", "failed", "control_status_unknown"]);

function parseCard(value: unknown): BrowserControlRequest | null {
  const entry = value as BrowserControlRequest | undefined;
  if (!entry || typeof entry.requestId !== "string" || !entry.target || typeof entry.label !== "string" || typeof entry.origin !== "string"
    || !Number.isFinite(Date.parse(entry.createdAt)) || !["pending", "starting", "active", ...terminal].includes(entry.status)) return null;
  return { requestId: entry.requestId, target: entry.target, origin: entry.origin, label: entry.label, createdAt: entry.createdAt, status: entry.status,
    ...(entry.inputStatusUnknown === true ? { inputStatusUnknown: true } : {}) };
}

export function useBrowserControl(manager: RunnerWebSocketManager, onDiagnostic?: (event: string, payload: Record<string, unknown>) => void) {
  const [requests, setRequests] = useState<BrowserControlRequest[]>([]);
  const entries = useRef(new Map<string, BrowserControlRequest>());
  // Private pixels, focus and input exist only in their mounted viewer and current connection.
  const viewers = useRef(new Map<string, { frame: (frame: BrowserControlFrame | null) => void; focus?: (focus: BrowserControlFocus | null) => void }>());
  const controls = useRef(new Map<string, string>());
  const commandGenerations = useRef(new Map<string, number>());
  const displays = useRef(new Map<string, { received: boolean; rendered: boolean; timer?: ReturnType<typeof setTimeout> }>());
  const diagnostic = useRef(onDiagnostic); diagnostic.current = onDiagnostic;
  const diagnose = useCallback((requestId: string, phase: "start" | "frame_received" | "frame_rendered" | "frame_timeout" | "render_failed" | "command_failed") => {
    try { diagnostic.current?.("browser_control", { requestId, phase }); } catch {}
  }, []);
  const clearDisplay = useCallback((requestId: string) => { clearTimeout(displays.current.get(requestId)?.timer); displays.current.delete(requestId); }, []);
  type QueuedInput = { input: BrowserControlInput; frameId: number };
  const queues = useRef(new Map<string, { tail: Promise<void>; pending: QueuedInput[]; running: boolean; sequence: number }>());
  const update = useCallback((entry: BrowserControlRequest) => {
    entries.current.set(entry.requestId, entry); setRequests([...entries.current.values()]);
    if (terminal.has(entry.status) || entry.status === "pending") { viewers.current.get(entry.requestId)?.frame(null); viewers.current.get(entry.requestId)?.focus?.(null); }
    if (terminal.has(entry.status)) {
      clearDisplay(entry.requestId); controls.current.delete(entry.requestId); commandGenerations.current.delete(entry.requestId);
      const queue = queues.current.get(entry.requestId); if (queue) queue.pending = []; queues.current.delete(entry.requestId);
    }
  }, [clearDisplay]);
  const suspend = useCallback((requestId: string, uncertain = false) => {
    const entry = entries.current.get(requestId); if (!entry || terminal.has(entry.status)) return;
    const controlId = controls.current.get(requestId), queue = queues.current.get(requestId);
    commandGenerations.current.set(requestId, (commandGenerations.current.get(requestId) || 0) + 1);
    controls.current.delete(requestId); clearDisplay(requestId);
    if (queue) queue.pending = []; queues.current.delete(requestId);
    update({ ...entry, status: "pending", inputStatusUnknown: entry.inputStatusUnknown || uncertain && (queue?.sequence || 0) > 0 });
    if (controlId) { try { manager.send({ channel: "control", op: "browser.control.command", payload: { requestId, controlId, action: "pause" } }); } catch {} }
  }, [clearDisplay, manager, update]);
  const failDisplay = useCallback((requestId: string, reason: "frame_timeout" | "render_failed") => {
    const current = entries.current.get(requestId);
    if (!current || terminal.has(current.status) || !viewers.current.has(requestId)) return;
    diagnose(requestId, reason);
    if (reason === "frame_timeout") { suspend(requestId, true); return; }
    const uncertain = (queues.current.get(requestId)?.sequence || 0) > 0;
    try { manager.send({ channel: "control", op: "browser.control.command", payload: { requestId, action: "cancel" } }); } catch {}
    update({ ...current, status: uncertain ? "control_status_unknown" : "failed" });
  }, [diagnose, manager, suspend, update]);
  const command = useCallback(async (requestId: string, action: "start" | "pause" | "finish" | "cancel") => {
    const entry = entries.current.get(requestId); if (!entry || terminal.has(entry.status)) return;
    if (action === "pause") { suspend(requestId, queues.current.get(requestId)?.running); return; }
    if (action === "start" && (entry.status !== "pending" || !viewers.current.has(requestId) || AppState.currentState !== "active")) return;
    const generation = (commandGenerations.current.get(requestId) || 0) + 1;
    commandGenerations.current.set(requestId, generation);
    if (action === "start") update({ ...entry, status: "starting" });
    try {
      if (action === "start") {
        await manager.connect();
        if (commandGenerations.current.get(requestId) !== generation || !viewers.current.has(requestId) || AppState.currentState !== "active") return;
        controls.current.set(requestId, randomUUID()); queues.current.delete(requestId);
        clearDisplay(requestId); displays.current.set(requestId, { received: false, rendered: false }); diagnose(requestId, "start");
      }
      if (action === "finish") await (queues.current.get(requestId)?.tail || Promise.resolve());
      if (commandGenerations.current.get(requestId) !== generation || terminal.has(entries.current.get(requestId)?.status as BrowserControlStatus)) return;
      const controlId = controls.current.get(requestId);
      if (action !== "cancel" && !controlId) { suspend(requestId); return; }
      const response = await manager.request({ channel: "control", op: "browser.control.command", payload: { requestId, action, ...(action !== "cancel" ? { controlId } : {}) } }, { timeoutMs: 10_000 });
      const payload = response.payload as { status?: BrowserControlStatus; inputStatusUnknown?: boolean };
      const current = entries.current.get(requestId);
      if (commandGenerations.current.get(requestId) !== generation || !current || terminal.has(current.status)) return;
      const status = payload?.status;
      if (status === "pending") { suspend(requestId); return; }
      update({ ...current, status: status && (terminal.has(status) || status === "active") ? status : "control_status_unknown",
        inputStatusUnknown: current.inputStatusUnknown || payload?.inputStatusUnknown === true });
      const display = displays.current.get(requestId);
      if (action === "start" && status === "active" && display && !display.received) display.timer = setTimeout(() => {
        if (commandGenerations.current.get(requestId) === generation && entries.current.get(requestId)?.status === "active") failDisplay(requestId, "frame_timeout");
      }, 15_000);
    } catch {
      if (commandGenerations.current.get(requestId) === generation && !terminal.has(entries.current.get(requestId)?.status as BrowserControlStatus)) {
        diagnose(requestId, "command_failed"); suspend(requestId, true);
      }
    }
  }, [clearDisplay, diagnose, failDisplay, manager, suspend, update]);
  const input = useCallback((requestId: string, input: BrowserControlInput, frameId: number) => {
    const entry = entries.current.get(requestId), controlId = controls.current.get(requestId);
    if (!entry || !controlId || entry.status !== "active" || !viewers.current.has(requestId) || AppState.currentState !== "active" || !manager.getSnapshot().connected) return;
    let queue = queues.current.get(requestId);
    if (!queue) { queue = { tail: Promise.resolve(), pending: [], running: false, sequence: 0 }; queues.current.set(requestId, queue); }
    const last = queue.pending.at(-1);
    // Coalesce only pointer moves/wheels, preserving all down/up, text and key ordering.
    if (last?.input.type === "move" && input.type === "move") { last.input = input; last.frameId = frameId; }
    else if (last?.input.type === "scroll" && input.type === "scroll") {
      last.input = { ...input, deltaX: Math.max(-2000, Math.min(2000, last.input.deltaX + input.deltaX)), deltaY: Math.max(-2000, Math.min(2000, last.input.deltaY + input.deltaY)) }; last.frameId = frameId;
    } else {
      if (queue.pending.length >= 32) { suspend(requestId, true); return; }
      queue.pending.push({ input, frameId });
    }
    const currentQueue = queue;
    if (!queue.running) {
      queue.running = true;
      queue.tail = (async () => {
        while (currentQueue.pending.length) {
          const next = currentQueue.pending.shift()!;
          if (controls.current.get(requestId) !== controlId || entries.current.get(requestId)?.status !== "active" || !viewers.current.has(requestId)) { currentQueue.pending = []; break; }
          const response = await manager.request({ channel: "control", op: "browser.control.command", payload: { requestId, controlId, action: "input", frameId: next.frameId, sequence: ++currentQueue.sequence, input: next.input } }, { timeoutMs: 10_000 });
          if (controls.current.get(requestId) !== controlId) return;
          const { status, inputStatus, inputStatusUnknown } = response.payload as { status?: BrowserControlStatus; inputStatus?: string; inputStatusUnknown?: boolean };
          const current = entries.current.get(requestId);
          if (current?.status === "active" && status === "active" && (next.input.type === "text" || next.input.type === "key")) update({ ...current, inputNotApplied: inputStatus === "not_applied" });
          if (current?.status === "active" && status !== "active") {
            if (status === "pending") suspend(requestId, true);
            else update({ ...current, status: status && terminal.has(status) ? status : "control_status_unknown", inputStatusUnknown: current.inputStatusUnknown || inputStatusUnknown === true });
            currentQueue.pending = [];
          }
        }
      })().catch(() => { if (controls.current.get(requestId) === controlId) suspend(requestId, true); })
        .finally(() => { currentQueue.running = false; });
    }
    return currentQueue.tail;
  }, [manager, suspend, update]);
  const ack = useCallback((requestId: string, frameId: number) => {
    const controlId = controls.current.get(requestId);
    if (!controlId || !viewers.current.has(requestId) || !["active", "starting"].includes(entries.current.get(requestId)?.status || "")) return;
    const display = displays.current.get(requestId);
    if (display && !display.rendered) { display.rendered = true; diagnose(requestId, "frame_rendered"); }
    try { manager.send({ channel: "control", op: "browser.control.command", payload: { requestId, controlId, action: "ack", frameId } }); } catch {}
  }, [diagnose, manager]);
  const watch = useCallback((requestId: string, frame: (frame: BrowserControlFrame | null) => void, focus?: (focus: BrowserControlFocus | null) => void) => {
    if (viewers.current.has(requestId)) return null;
    const viewer = { frame, focus }; viewers.current.set(requestId, viewer);
    return () => { if (viewers.current.get(requestId) !== viewer) return; frame(null); focus?.(null); viewers.current.delete(requestId); suspend(requestId, queues.current.get(requestId)?.running); };
  }, [suspend]);
  useEffect(() => {
    let scope = manager.getSnapshot().connectionOptionsGeneration, socketGeneration = -1;
    const sync = () => { if (AppState.currentState === "active" && manager.getSnapshot().connected) { try { manager.send({ channel: "control", op: "browser.control.sync", payload: {} }); } catch {} } };
    const currentRun = (payload: { requestId?: string; controlId?: string } | undefined) => payload?.requestId && payload.controlId && controls.current.get(payload.requestId) === payload.controlId ? entries.current.get(payload.requestId) : undefined;
    const receiveCard = (value: unknown) => {
      const entry = parseCard(value); if (!entry) return;
      const current = entries.current.get(entry.requestId);
      if (current && ["starting", "active"].includes(current.status) && !terminal.has(entry.status)) return;
      // The previous Wi-Fi socket may still exist. Recover its card, never its private run.
      update({ ...entry, status: ["active", "starting"].includes(entry.status) ? "pending" : entry.status,
        inputStatusUnknown: current?.inputStatusUnknown || entry.inputStatusUnknown });
    };
    const offRequest = manager.subscribe({ channel: "control", op: "browser.control.request" }, (message) => receiveCard(message.payload));
    const offSync = manager.subscribe({ channel: "control", op: "browser.control.sync.result" }, (message) => {
      const cards = (message.payload as { requests?: unknown[] })?.requests;
      if (Array.isArray(cards) && cards.length <= 128) cards.forEach(receiveCard);
    });
    const offRegistered = manager.subscribe({ channel: "control", op: "app.control.register.result" }, sync);
    const offFrame = manager.subscribe({ channel: "control", op: "browser.control.frame" }, (message) => {
      const frame = message.payload as BrowserControlFrame & { requestId: string; controlId: string }, entry = currentRun(frame);
      if (!entry || !["starting", "active"].includes(entry.status) || AppState.currentState !== "active" || !viewers.current.has(entry.requestId)) return;
      if (!Number.isSafeInteger(frame.frameId) || frame.frameId < 1 || typeof frame.data !== "string" || frame.data.length > 2 * 1024 * 1024
        || ![frame.width, frame.height].every((n) => Number.isFinite(n) && n > 0 && n <= 32768)) { failDisplay(entry.requestId, "render_failed"); return; }
      const display = displays.current.get(entry.requestId);
      if (display && !display.received) { display.received = true; clearTimeout(display.timer); diagnose(entry.requestId, "frame_received"); }
      viewers.current.get(entry.requestId)?.frame({ frameId: frame.frameId, data: frame.data, width: frame.width, height: frame.height });
    });
    const offFocus = manager.subscribe({ channel: "control", op: "browser.control.focus" }, (message) => {
      const focus = message.payload as BrowserControlFocus & { requestId: string; controlId: string }, entry = currentRun(focus);
      if (!entry || !["starting", "active"].includes(entry.status) || AppState.currentState !== "active") return;
      if (typeof focus.editable !== "boolean" || typeof focus.multiline !== "boolean" || !["text", "password", "email", "number", "tel", "url", "search"].includes(focus.kind)
        || typeof focus.focusRevision !== "string" || !focus.focusRevision.length || focus.focusRevision.length > 128) return;
      viewers.current.get(entry.requestId)?.focus?.({ editable: focus.editable, multiline: focus.multiline, kind: focus.kind, focusRevision: focus.focusRevision });
    });
    const offViewInvalidated = manager.subscribe({ channel: "control", op: "browser.control.view_invalidated" }, (message) => {
      const entry = currentRun(message.payload as { requestId?: string; controlId?: string }); if (!entry) return;
      const queue = queues.current.get(entry.requestId);
      if (queue) { if (queue.pending.some(({ input }) => input.type === "text" || input.type === "key")) update({ ...entry, inputNotApplied: true }); queue.pending = []; }
      viewers.current.get(entry.requestId)?.frame(null); viewers.current.get(entry.requestId)?.focus?.(null);
    });
    const offOrigin = manager.subscribe({ channel: "control", op: "browser.control.origin" }, (message) => {
      const payload = message.payload as { requestId?: string; controlId?: string; origin?: string }, entry = currentRun(payload);
      if (entry && !terminal.has(entry.status) && typeof payload.origin === "string") update({ ...entry, origin: payload.origin });
    });
    const offResolved = manager.subscribe({ channel: "control", op: "browser.control.resolved" }, (message) => {
      const result = message.payload as { requestId?: string; controlId?: string; status?: BrowserControlStatus }, entry = entries.current.get(result?.requestId || "");
      if (result.controlId && controls.current.get(result.requestId || "") !== result.controlId) return;
      if (entry && result.controlId && result.status === "pending") { suspend(entry.requestId, true); return; }
      if (entry && result.status && terminal.has(result.status) && !terminal.has(entry.status)) update({ ...entry, status: result.status });
    });
    const changed = () => {
      const snapshot = manager.getSnapshot();
      if (snapshot.connectionOptionsGeneration !== scope) {
        for (const entry of entries.current.values()) suspend(entry.requestId, true);
        scope = snapshot.connectionOptionsGeneration; entries.current.clear(); setRequests([]);
      }
      if (!snapshot.connected) { for (const id of [...controls.current.keys()]) suspend(id, true); socketGeneration = -1; }
      else if (snapshot.generation !== socketGeneration) { socketGeneration = snapshot.generation; sync(); }
    };
    const offSnapshot = manager.subscribeSnapshot(changed);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") { for (const entry of entries.current.values()) if (!terminal.has(entry.status)) suspend(entry.requestId, true); }
      else sync();
    });
    changed();
    return () => {
      for (const entry of entries.current.values()) suspend(entry.requestId, true);
      offRequest(); offSync(); offRegistered(); offFrame(); offFocus(); offViewInvalidated(); offOrigin(); offResolved(); offSnapshot(); subscription.remove(); viewers.current.clear(); queues.current.clear();
    };
  }, [diagnose, failDisplay, manager, suspend, update]);
  return { requests, command, input, ack, watch, failDisplay };
}
