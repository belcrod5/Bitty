import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { VoiceTarget } from "../../appControl/voiceControl";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";

export type BrowserInputStatus = "pending" | "filling" | "completed" | "cancelled" | "expired" | "invalidated" | "failed" | "input_status_unknown";
export type BrowserSecretInputRequest = { requestId: string; target: VoiceTarget; destinationOrigin: string; topOrigin: string;
  label: string; createdAt: string; status: BrowserInputStatus };
const terminal = new Set<BrowserInputStatus>(["completed", "cancelled", "expired", "invalidated", "failed", "input_status_unknown"]);

export function useBrowserSecretInput(manager: RunnerWebSocketManager) {
  const [requests, setRequests] = useState<BrowserSecretInputRequest[]>([]);
  const entries = useRef(new Map<string, BrowserSecretInputRequest>());
  // Drafts live only in this process, separately from all conversation state.
  const drafts = useRef(new Map<string, string>()).current;
  const update = useCallback((entry: BrowserSecretInputRequest) => {
    entries.current.set(entry.requestId, entry);
    setRequests([...entries.current.values()]);
    if (terminal.has(entry.status)) drafts.delete(entry.requestId);
  }, [drafts]);
  const cancel = useCallback((requestId: string) => {
    const entry = entries.current.get(requestId);
    if (!entry || entry.status !== "pending") return;
    update({ ...entry, status: "cancelled" });
    try { manager.send({ channel: "control", op: "browser.input.respond", payload: { requestId, cancel: true } }); } catch {}
  }, [manager, update]);
  const submit = useCallback(async (requestId: string, value: string) => {
    const entry = entries.current.get(requestId);
    if (!entry || entry.status !== "pending" || !value.length || value.length > 4096
      || AppState.currentState !== "active" || !manager.getSnapshot().connected) return;
    update({ ...entry, status: "filling" });
    drafts.delete(requestId);
    try {
      const response = await manager.request({ channel: "control", op: "browser.input.respond", payload: { requestId, value } }, { timeoutMs: 10_000 });
      const status = (response.payload as { status?: BrowserInputStatus })?.status;
      if (entries.current.get(requestId)?.status === "filling") update({ ...entry, status: status && terminal.has(status) ? status : "input_status_unknown" });
    } catch {
      if (entries.current.get(requestId)?.status === "filling") update({ ...entry, status: "input_status_unknown" });
    }
  }, [drafts, manager, update]);
  useEffect(() => {
    let connectionScope = manager.getSnapshot().connectionOptionsGeneration;
    const expire = () => {
      drafts.clear();
      for (const entry of entries.current.values()) if (!terminal.has(entry.status)) {
        update({ ...entry, status: entry.status === "filling" ? "input_status_unknown" : "expired" });
        try { manager.send({ channel: "control", op: "browser.input.respond", payload: { requestId: entry.requestId, cancel: true } }); } catch {}
      }
    };
    const offRequest = manager.subscribe({ channel: "control", op: "browser.input.request" }, (message) => {
      const entry = message.payload as BrowserSecretInputRequest | undefined;
      if (!entry || typeof entry.requestId !== "string" || entries.current.has(entry.requestId) || !entry.target
        || typeof entry.label !== "string" || typeof entry.destinationOrigin !== "string" || typeof entry.topOrigin !== "string"
        || !Number.isFinite(Date.parse(entry.createdAt)) || entry.status !== "pending") return;
      update({ requestId: entry.requestId, target: entry.target, destinationOrigin: entry.destinationOrigin,
        topOrigin: entry.topOrigin, label: entry.label, createdAt: entry.createdAt, status: entry.status });
      if (AppState.currentState !== "active" || !manager.getSnapshot().connected) expire();
    });
    const offResolved = manager.subscribe({ channel: "control", op: "browser.input.resolved" }, (message) => {
      const result = message.payload as { requestId?: string; status?: BrowserInputStatus } | undefined;
      const entry = entries.current.get(result?.requestId || "");
      if (entry && result?.status && terminal.has(result.status) && !terminal.has(entry.status)) update({ ...entry, status: result.status });
    });
    const offSnapshot = manager.subscribeSnapshot(() => {
      const snapshot = manager.getSnapshot();
      if (snapshot.connectionOptionsGeneration !== connectionScope) {
        connectionScope = snapshot.connectionOptionsGeneration;
        entries.current.clear(); drafts.clear(); setRequests([]);
      } else if (!snapshot.connected) expire();
    });
    const subscription = AppState.addEventListener("change", (state) => { if (state !== "active") expire(); });
    return () => { offRequest(); offResolved(); offSnapshot(); subscription.remove(); drafts.clear(); };
  }, [drafts, manager, update]);
  return { requests, drafts, submit, cancel };
}
