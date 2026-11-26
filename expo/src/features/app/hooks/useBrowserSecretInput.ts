import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { getVoiceControl, type AppControlOrigin } from "../../appControl/voiceControl";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";

export type BrowserSecretInputRequest = {
  requestId: string;
  origin: AppControlOrigin;
  destinationOrigin: string;
  topOrigin: string;
  label: string;
  expiresAt: string;
};

export function useBrowserSecretInput(manager: RunnerWebSocketManager) {
  const [request, setRequest] = useState<BrowserSecretInputRequest | null>(null);
  const pending = useRef<BrowserSecretInputRequest | null>(null);
  const submitting = useRef(false);
  const [sending, setSending] = useState(false);
  const clear = useCallback(() => { pending.current = null; submitting.current = false; setRequest(null); setSending(false); }, []);
  const current = useCallback((next: BrowserSecretInputRequest) => AppState.currentState === "active"
    && manager.getSnapshot().connected && Date.parse(next.expiresAt) > Date.now()
    && getVoiceControl(manager).matchesOrigin(next.origin), [manager]);
  const cancel = useCallback(() => {
    const next = pending.current;
    clear();
    if (next) {
      try { manager.send({ channel: "control", op: "browser.input.respond", payload: { requestId: next.requestId, cancel: true } }); } catch {}
    }
  }, [clear, manager]);
  const submit = useCallback(async (value: string) => {
    const next = pending.current;
    if (submitting.current || !value.length || value.length > 4096) return;
    if (!next || !current(next)) { cancel(); return; }
    submitting.current = true;
    setSending(true);
    try {
      // Dedicated device channel: this must never use action.respond or chat text.
      await manager.request({ channel: "control", op: "browser.input.respond", payload: { requestId: next.requestId, value } }, { timeoutMs: 10_000 });
    } catch { /* The agent receives a fixed status from the Runner. */ }
    finally { if (pending.current === next) clear(); }
  }, [cancel, clear, current, manager]);
  useEffect(() => {
    const offRequest = manager.subscribe({ channel: "control", op: "browser.input.request" }, (message) => {
      const next = message.payload as BrowserSecretInputRequest | undefined;
      if (!next || typeof next.requestId !== "string" || typeof next.label !== "string"
        || typeof next.destinationOrigin !== "string" || typeof next.topOrigin !== "string" || !next.origin || typeof next.expiresAt !== "string") return;
      if (pending.current || !current(next)) {
        try { manager.send({ channel: "control", op: "browser.input.respond", payload: { requestId: next.requestId, cancel: true } }); } catch {}
        return;
      }
      pending.current = next;
      setRequest(next);
    });
    const offResolved = manager.subscribe({ channel: "control", op: "browser.input.resolved" }, (message) => {
      if ((message.payload as { requestId?: string })?.requestId === pending.current?.requestId) clear();
    });
    const offSnapshot = manager.subscribeSnapshot(() => {
      if (pending.current && !current(pending.current)) cancel();
    });
    const subscription = AppState.addEventListener("change", (state) => { if (state !== "active") cancel(); });
    return () => { offRequest(); offResolved(); offSnapshot(); subscription.remove(); cancel(); };
  }, [cancel, clear, current, manager]);
  useEffect(() => {
    if (!request) return;
    const timer = setInterval(() => { if (!current(request)) cancel(); }, 250);
    return () => clearInterval(timer);
  }, [request, current, cancel]);
  return { request, sending, submit, cancel };
}
