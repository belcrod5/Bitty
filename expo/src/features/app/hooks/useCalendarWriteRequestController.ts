import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { CalendarWriteConfirmation } from "../../calendar/calendarToolHandler";

export function useCalendarWriteRequestController() {
  const [request, setRequest] = useState<CalendarWriteConfirmation | null>(null);
  const resolveRef = useRef<((accepted: boolean) => void) | null>(null);
  const removeAbortListenerRef = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => {
    removeAbortListenerRef.current?.();
    removeAbortListenerRef.current = null;
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(false);
  }, []);
  const confirmWrite = useCallback((next: CalendarWriteConfirmation) => new Promise<boolean>((resolve) => {
    cancel();
    if (next.signal.aborted || AppState.currentState !== "active") {
      resolve(false);
      return;
    }
    resolveRef.current = resolve;
    setRequest(next);
    next.signal.addEventListener("abort", cancel, { once: true });
    removeAbortListenerRef.current = () => next.signal.removeEventListener("abort", cancel);
  }), [cancel]);
  const decide = useCallback((accepted: boolean) => {
    removeAbortListenerRef.current?.();
    removeAbortListenerRef.current = null;
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(accepted && AppState.currentState === "active");
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") cancel();
    });
    return () => subscription.remove();
  }, [cancel]);
  return { request, confirmWrite, decide, cancel };
}
