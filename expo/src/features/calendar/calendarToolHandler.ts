import * as Crypto from "expo-crypto";
import { AppState } from "react-native";
import {
  calendarError,
  type CalendarReadToolName,
  type CalendarToolName,
  type CalendarToolResult,
  type CalendarWriteToolName,
} from "./calendarToolSpecs";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listCalendars,
  searchEvents,
  updateEvent,
  getCalendarPermission,
  requestCalendarPermission,
  prepareCalendarWrite,
} from "./calendarService";
import {
  receiveCalendarWrite,
  updateCalendarWrite,
} from "./calendarWriteLedger";

type RpcId = string | number;
export type CalendarToolCall = {
  appServerRequestId: RpcId;
  callId: string;
  threadId: string;
  turnId: string;
  namespace: string | null;
  tool: CalendarToolName;
  arguments: unknown;
};

export type CalendarWriteConfirmation = {
  operation: CalendarWriteToolName;
  view: CalendarWriteConfirmationView;
  signal: AbortSignal;
};

export type CalendarWriteConfirmationView = {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string | null;
  location: string | null;
  notes: string | null;
  calendarId: string;
  lastModifiedAt: string | null;
  recurring: boolean;
  allowsModifications: boolean;
};

export type CalendarToolHandlerOptions = {
  isForeground?: () => boolean;
  confirmWrite: (request: CalendarWriteConfirmation) => Promise<boolean>;
};

function isTool(value: unknown): value is CalendarToolName {
  return typeof value === "string" && [
    "calendar_list_calendars", "calendar_search_events", "calendar_get_event",
    "calendar_create_event", "calendar_update_event", "calendar_delete_event",
  ].includes(value);
}

function canonical(value: unknown): string | null {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const parts = value.map(canonical);
    return parts.some((part) => part === null) ? null : `[${parts.join(",")}]`;
  }
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  const parts: string[] = [];
  for (const [key, child] of entries) {
    const serialized = canonical(child);
    if (serialized === null) return null;
    parts.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${parts.join(",")}}`;
}

async function hash(value: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value, { encoding: Crypto.CryptoEncoding.HEX });
}

function lengthPrefix(parts: string[]) {
  return parts.map((part) => `${new TextEncoder().encode(part).length}:${part}`).join("");
}

export async function parseCalendarToolCall(raw: unknown): Promise<CalendarToolCall | null> {
  const message = raw as Record<string, unknown>;
  const params = message?.params as Record<string, unknown>;
  if (!message || typeof message !== "object" || (typeof message.id !== "string" && typeof message.id !== "number")
    || message.method !== "item/tool/call" || !params || typeof params !== "object"
    || typeof params.callId !== "string" || typeof params.threadId !== "string" || typeof params.turnId !== "string"
    || (params.namespace !== null && typeof params.namespace !== "string") || !isTool(params.tool)) return null;
  return {
    appServerRequestId: message.id,
    callId: params.callId,
    threadId: params.threadId,
    turnId: params.turnId,
    namespace: params.namespace,
    tool: params.tool,
    arguments: params.arguments,
  };
}

export function calendarToolResponse(id: RpcId, result: CalendarToolResult<unknown>) {
  return {
    id,
    result: {
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
    },
  };
}

export function calendarDynamicToolsIncompatible(phase: "thread_start" | "tool_call_parse" | "tool_response") {
  return {
    ok: false as const,
    error: {
      code: "codex_dynamic_tools_incompatible" as const,
      message: "Dynamic Tools互換性エラーです。phaseを確認し、Bittyのcalendar tool adapterを現行schemaへ更新してください。",
      retryable: false,
      expectedContract: "calendar-dynamic-tools-v1",
      phase,
    },
  };
}

async function executeRead(tool: CalendarReadToolName, argumentsValue: unknown) {
  if (tool === "calendar_list_calendars") return listCalendars();
  if (tool === "calendar_search_events") return searchEvents(argumentsValue);
  return getEvent(argumentsValue);
}

async function executeWrite(tool: CalendarWriteToolName, argumentsValue: unknown) {
  if (tool === "calendar_create_event") return createEvent(argumentsValue);
  if (tool === "calendar_update_event") return updateEvent(argumentsValue);
  return deleteEvent(argumentsValue);
}

export function createCalendarToolHandler(options: CalendarToolHandlerOptions) {
  const inFlight = new Map<string, AbortController>();
  const foreground = () => options.isForeground?.() ?? AppState.currentState === "active";

  const cancel = (requestId: string) => {
    inFlight.get(requestId)?.abort();
  };
  const cancelAll = () => {
    for (const controller of inFlight.values()) controller.abort();
  };

  const handle = async (call: CalendarToolCall): Promise<CalendarToolResult<unknown>> => {
    if (call.namespace !== null) return calendarError("invalid_arguments");
    const serialized = canonical(call.arguments);
    if (serialized === null) return calendarError("invalid_arguments");
    const requestId = await hash(lengthPrefix([call.threadId, call.turnId, call.callId, call.tool]));
    const requestHash = await hash(serialized);
    const isWrite = call.tool.startsWith("calendar_") && ![
      "calendar_list_calendars", "calendar_search_events", "calendar_get_event",
    ].includes(call.tool);
    let permission = await getCalendarPermission();
    if (!permission.ok) {
      if (!foreground()) return calendarError("foreground_required");
      permission = await requestCalendarPermission();
    }
    if (!permission.ok) return permission;
    if (!isWrite) return executeRead(call.tool as CalendarReadToolName, call.arguments);
    if (!foreground()) return calendarError("foreground_required");
    const received = await receiveCalendarWrite(requestId, requestHash);
    if (received.kind === "conflict") return calendarError("request_conflict");
    if (received.kind === "terminal") return received.result;
    if (received.kind === "pending") return calendarError("request_cancelled");
    const controller = new AbortController();
    inFlight.set(requestId, controller);
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const prepared = await prepareCalendarWrite(call.tool as CalendarWriteToolName, call.arguments);
      if (!prepared.ok) {
        await updateCalendarWrite(requestId, "failed", prepared);
        return prepared;
      }
      const accepted = await options.confirmWrite({ operation: call.tool as CalendarWriteToolName, view: prepared.data, signal: controller.signal });
      if (!accepted || controller.signal.aborted) {
        const result = calendarError("request_cancelled");
        await updateCalendarWrite(requestId, "failed", result);
        return result;
      }
      if (!foreground()) {
        const result = calendarError("foreground_required");
        await updateCalendarWrite(requestId, "failed", result);
        return result;
      }
      await updateCalendarWrite(requestId, "executing");
      if (controller.signal.aborted || !foreground()) {
        const result = calendarError(controller.signal.aborted ? "request_cancelled" : "foreground_required");
        await updateCalendarWrite(requestId, "failed", result);
        return result;
      }
      const livePermission = await getCalendarPermission();
      if (!livePermission.ok) {
        await updateCalendarWrite(requestId, "failed", livePermission);
        return livePermission;
      }
      const result = await executeWrite(call.tool as CalendarWriteToolName, call.arguments);
      if (controller.signal.aborted) {
        const unknown = calendarError("result_unknown");
        await updateCalendarWrite(requestId, "result_unknown", unknown);
        return unknown;
      }
      await updateCalendarWrite(requestId, result.ok ? "succeeded" : "failed", result);
      return result;
    } finally {
      clearTimeout(timeout);
      inFlight.delete(requestId);
    }
  };
  return { handle, cancel, cancelAll };
}
