import { useEffect, useSyncExternalStore } from "react";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { parseCalendarToolCall, type createCalendarToolHandler } from "../../calendar/calendarToolHandler";
import { calendarError, CALENDAR_DYNAMIC_TOOLS_NAMESPACE, CALENDAR_READ_TOOL_NAMES } from "../../calendar/calendarToolSpecs";

export function useVoiceCalendar(
  manager: RunnerWebSocketManager,
  handler: ReturnType<typeof createCalendarToolHandler>,
) {
  const connected = useSyncExternalStore(manager.subscribeSnapshot,
    () => manager.getSnapshot().connected, () => manager.getSnapshot().connected);

  useEffect(() => {
    if (!connected) return;
    const pending = new Map<string, string>();
    const unsubscribeRequest = manager.subscribe({ channel: "agent", op: "voice.calendar.request" }, (message) => {
      const payload = message.payload as Record<string, unknown> | undefined;
      const params = payload?.params as Record<string, unknown> | undefined;
      const requestId = String(payload?.requestId || "");
      const operationId = String(message.operationId || "");
      const startedAtMs = payload?.startedAtMs;
      if (!requestId || !operationId || pending.has(requestId)
        || typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)
        || Date.now() >= startedAtMs + 30_000) return;
      pending.set(requestId, operationId);
      void (async () => {
        let result;
        try {
          const call = await parseCalendarToolCall({ id: requestId, method: payload?.method, params });
          if (pending.get(requestId) !== operationId) return;
          result = call?.namespace === CALENDAR_DYNAMIC_TOOLS_NAMESPACE && CALENDAR_READ_TOOL_NAMES.some((name) => name === call.tool)
            ? await handler.handle(call) : calendarError("invalid_arguments");
        } catch {
          result = calendarError("calendar_api_failed");
        }
        if (pending.get(requestId) !== operationId || Date.now() >= startedAtMs + 30_000) return;
        await manager.request({ channel: "agent", op: "voice.calendar.respond", operationId,
          payload: { requestId, result } }, { timeoutMs: 30_000 });
      })().catch(() => undefined).finally(() => {
        if (pending.get(requestId) === operationId) pending.delete(requestId);
      });
    });
    const unsubscribeResolved = manager.subscribe({ channel: "agent", op: "voice.calendar.resolved" }, (message) => {
      const requestId = String((message.payload as { requestId?: string })?.requestId || "");
      if (pending.get(requestId) === message.operationId) pending.delete(requestId);
    });
    return () => {
      unsubscribeRequest();
      unsubscribeResolved();
      pending.clear();
    };
  }, [manager, handler, connected]);
}
